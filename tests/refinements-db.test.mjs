import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
const db = new PGlite()
const ids = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444']
let folder, documentId, original, second
async function user(index,sql,args = []) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${ids[index]}',false)`)
  try { return await db.query(sql,args) } finally { await db.exec('reset role') }
}
async function backend(sql,args = []) { await db.exec('set role service_role'); try { return await db.query(sql,args) } finally { await db.exec('reset role') } }
before(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create schema storage; create schema realtime;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text); alter table storage.objects enable row level security;
    create table realtime.messages(id bigint,extension text); alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
    grant usage on schema auth,storage,realtime to anon,authenticated,service_role;
    grant select,insert,delete on storage.objects to authenticated; grant select,insert on realtime.messages to authenticated;
    create publication supabase_realtime;`)
  await db.exec(readFileSync(new URL('../supabase/migrations/001_synapse.sql',import.meta.url),'utf8'))
  for (const [index,id] of ids.entries()) await db.query('insert into auth.users(id,email) values($1,$2)',[id,`person${index}@example.com`])
  folder = (await user(0,"select * from public.create_folder('Existing subject')")).rows[0]
  await db.query("insert into public.folder_members(folder_id,user_id,role) values($1,$2,'editor'),($1,$3,'viewer')",[folder.id,ids[1],ids[2]])
  documentId = crypto.randomUUID()
  await db.query("insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes,status,extracted_text,purged_at,expires_at) values($1,$2,$3,'chapter.txt',$4,'text/plain',100,'ready','A queue uses first-in-first-out ordering.',now(),now()-interval '1 day')",[documentId,folder.id,ids[0],`${folder.id}/${ids[0]}/${documentId}.txt`])
  original = (await db.query("insert into public.study_assets(folder_id,document_id,kind,title,data,created_by) values($1,$2,'deck','My renamed deck',$3,$4) returning *",[folder.id,documentId,JSON.stringify([{front:'What is FIFO?',back:'First in first out.'},{front:'Which structure is FIFO?',back:'A queue.'},{front:'Where is a queue item removed?',back:'The front.'}]),ids[0]])).rows[0]
  await user(2,'select public.review_card($1,0,3)',[original.id])
  await db.exec(readFileSync(new URL('../supabase/migrations/003_study_refinements.sql',import.meta.url),'utf8'))
  original = (await db.query('select * from public.study_assets where id=$1',[original.id])).rows[0]
})
after(async () => db.close())

test('Upgrade keeps existing assets and progress; sets and formatting default safely',async () => {
  assert.equal(original.set_number,1); assert.equal(original.content_format,'markdown'); assert.ok(original.series_id)
  assert.equal((await user(2,'select * from public.flashcard_progress where asset_id=$1',[original.id])).rows.length,1)
  const bucket = (await db.query("select * from storage.buckets where id='profile-photos'")).rows[0]
  assert.equal(bucket.public,false); assert.equal(Number(bucket.file_size_limit),2097152)
})
test('Refresh is backend-only and editor-authorized, using source after raw-file expiry',async () => {
  await assert.rejects(user(0,'select public.claim_asset_refresh($1,$2)',[original.id,ids[0]]),/permission denied/)
  for (const index of [2,3]) await assert.rejects(backend('select public.claim_asset_refresh($1,$2)',[original.id,ids[index]]),/Editor access/)
  const claim = (await backend('select public.claim_asset_refresh($1,$2) as job',[original.id,ids[1]])).rows[0].job
  assert.equal(claim.source_text,'A queue uses first-in-first-out ordering.'); assert.equal(claim.set_number,2); assert.equal(claim.previous.length,3)
  await assert.rejects(backend('select public.claim_asset_refresh($1,$2)',[original.id,ids[0]]),/already refreshing/)
  await assert.rejects(backend('select public.complete_asset_refresh($1,$2,$3)',[claim.job_id,ids[0],'{}']),/claim is missing/)
  await assert.rejects(backend('select public.complete_asset_refresh($1,$2,$3)',[claim.job_id,ids[1],'{"flashcards":[]}']),/incomplete/)
  const output = {flashcards:[{front:'What does a queue preserve?',back:'Arrival order.'},{front:'How are items added to a queue?',back:'By enqueueing at the rear.'},{front:'What happens when a queue is empty?',back:'There is no item to dequeue.'}]}
  second = (await backend('select * from public.complete_asset_refresh($1,$2,$3)',[claim.job_id,ids[1],JSON.stringify(output)])).rows[0]
  assert.equal(second.title,'My renamed deck'); assert.equal(second.set_number,2); assert.equal(second.series_id,original.series_id)
  assert.deepEqual((await user(2,'select * from public.list_asset_sets($1)',[original.series_id])).rows.map(a=>a.id),[original.id,second.id])
  assert.equal((await user(2,'select * from public.flashcard_progress where asset_id=$1',[original.id])).rows.length,1)
  assert.equal((await user(2,'select * from public.flashcard_progress where asset_id=$1',[second.id])).rows.length,0)
  await assert.rejects(backend('select public.complete_asset_refresh($1,$2,$3)',[claim.job_id,ids[1],JSON.stringify(output)]),/claim is missing/)
})
test('Latest-series pagination and historical sets respect folder RLS',async () => {
  const latest = (await user(2,'select * from public.list_latest_assets($1)',[folder.id])).rows
  assert.equal(latest.length,1); assert.equal(latest[0].id,second.id)
  assert.equal((await user(3,'select * from public.list_asset_sets($1)',[original.series_id])).rows.length,0)
  assert.equal((await user(3,'select * from public.list_latest_assets($1)',[folder.id])).rows.length,0)
  assert.equal((await user(2,'select * from public.list_latest_assets($1,1,31)',[folder.id])).rows.length,0)
  await assert.rejects(user(1,'update public.study_assets set set_number=100 where id=$1',[second.id]),/permission denied/)
  await assert.rejects(user(1,'update public.study_assets set series_id=gen_random_uuid() where id=$1',[second.id]),/permission denied/)
})
test('Titles and rich notes are editable by editors, with viewer edits blocked',async () => {
  await user(1,"update public.study_assets set title='Easy to find' where id=$1",[second.id])
  assert.equal((await user(2,"update public.study_assets set title='Tampered' where id=$1 returning id",[second.id])).rows.length,0)
  const note = (await user(1,"insert into public.study_assets(folder_id,kind,title,content,content_format,created_by) values($1,'note','Formatted','<p><strong>Term</strong>: definition</p>','html',$2) returning *",[folder.id,ids[1]])).rows[0]
  assert.equal(note.content_format,'html')
  await user(1,"update public.study_assets set content='<p><u>Edited</u></p>' where id=$1",[note.id])
  const claim = (await backend('select public.claim_asset_refresh($1,$2) as job',[note.id,ids[1]])).rows[0].job
  assert.equal(claim.source_format,'html'); assert.match(claim.source_text,/<u>Edited/)
  await backend('select public.fail_asset_refresh($1,$2)',[claim.job_id,ids[1]])
  const retry = (await backend('select public.claim_asset_refresh($1,$2) as job',[note.id,ids[1]])).rows[0].job
  assert.equal(retry.set_number,2)
  await backend('select public.fail_asset_refresh($1,$2)',[retry.job_id,ids[1]])
})
test('Private profile photos are owned uploads visible only to shared peers',async () => {
  const path = `${ids[0]}/photo.jpg`
  await user(0,"insert into storage.objects(bucket_id,name) values('profile-photos',$1)",[path])
  await user(0,'update public.profiles set avatar_path=$1 where id=$2',[path,ids[0]])
  assert.equal((await user(2,"select * from storage.objects where bucket_id='profile-photos'")).rows.length,1)
  assert.equal((await user(3,"select * from storage.objects where bucket_id='profile-photos'")).rows.length,0)
  await assert.rejects(user(1,"insert into storage.objects(bucket_id,name) values('profile-photos',$1)",[path]),/row-level security/)
  await assert.rejects(user(0,'update public.profiles set avatar_path=$1 where id=$2',[`${ids[1]}/photo.jpg`,ids[0]]),/check constraint/)
  await assert.rejects(user(0,"insert into storage.objects(bucket_id,name) values('profile-photos',$1)",[`${ids[0]}/unsafe.svg`]),/row-level security/)
  assert.equal((await user(1,"delete from storage.objects where bucket_id='profile-photos' returning name")).rows.length,0)
})
test('Space deletion is owner-only; cascades all sets/progress and queues surviving raw files',async () => {
  const rawId = crypto.randomUUID(), path = `${folder.id}/${ids[1]}/${rawId}.txt`
  await user(1,"insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) values($1,$2,$3,'file.txt',$4,'text/plain',100)",[rawId,folder.id,ids[1],path])
  await user(1,"insert into storage.objects(bucket_id,name) values('study-files',$1)",[path])
  for (const index of [1,2,3]) await assert.rejects(user(index,'select public.delete_folder($1)',[folder.id]),/owner/)
  await user(0,'select public.delete_folder($1)',[folder.id])
  for (const table of ['folders','study_assets','document_files','folder_members']) assert.equal((await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n,0)
  assert.equal((await db.query('select count(*)::int as n from public.flashcard_progress')).rows[0].n,0)
  const queued = (await backend('select * from public.pending_storage_deletions()')).rows
  assert.deepEqual(queued,[{storage_path:path}])
  await assert.rejects(user(0,'select * from public.pending_storage_deletions()'),/permission denied/)
  await backend('select public.finish_storage_deletions($1)',[[path]])
  assert.equal((await backend('select * from public.pending_storage_deletions()')).rows.length,0)
})
