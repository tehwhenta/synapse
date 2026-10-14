import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
const db = new PGlite()
const ids = Array.from({length:6},(_,i) => `${String(i+1).repeat(8)}-${String(i+1).repeat(4)}-4${String(i+1).repeat(3)}-8${String(i+1).repeat(3)}-${String(i+1).repeat(12)}`)
let shared, note
async function user(index,sql,args=[]) { await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${ids[index]}',false)`); try { return await db.query(sql,args) } finally { await db.exec('reset role') } }
async function backend(sql,args=[]) { await db.exec('set role service_role'); try { return await db.query(sql,args) } finally { await db.exec('reset role') } }
before(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create schema storage; create schema realtime;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create table auth.sessions(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),updated_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,owner_id text); alter table storage.objects enable row level security;
    create table realtime.messages(id bigint,extension text); alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
    grant usage on schema auth,storage,realtime to anon,authenticated,service_role;
    grant select,insert,delete on storage.objects to authenticated; grant select,insert on realtime.messages to authenticated;
    create publication supabase_realtime;`)
  for (const file of ['001_synapse.sql','003_study_refinements.sql','004_reviewer_accounts.sql']) await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'))
  for (const [index,id] of ids.entries()) await db.query('insert into auth.users(id,email) values($1,$2)',[id,`person${index}@example.com`])
  shared=(await user(0,"select * from public.create_folder('Shared subject')")).rows[0]
  await db.query("insert into public.folder_members(folder_id,user_id,role) values($1,$2,'editor'),($1,$3,'viewer'),($1,$4,'editor')",[shared.id,ids[1],ids[2],ids[3]])
  note=(await user(0,"insert into public.study_assets(folder_id,kind,title,content,created_by) values($1,'note','Existing notes','Useful source',$2) returning *",[shared.id,ids[0]])).rows[0]
})
after(async () => db.close())

test('Reviewer drawings preserve existing notes, enforce editor access, and reject unsafe or malformed data',async () => {
  assert.deepEqual(note.annotations,[])
  const strokes=[{id:'stroke-1',anchor:'paragraph-1',color:'#2563eb',width:3,points:[[0,0],[1,1]]}]
  await user(1,'update public.study_assets set annotations=$2 where id=$1',[note.id,JSON.stringify(strokes)])
  assert.deepEqual((await user(2,'select annotations from public.study_assets where id=$1',[note.id])).rows[0].annotations,strokes)
  assert.equal((await user(2,'update public.study_assets set annotations=$2 where id=$1 returning id',[note.id,'[]'])).rows.length,0)
  for (const bad of [{...strokes[0],color:'url(javascript:alert(1))'},{...strokes[0],points:[[0,0],[2,1]]},{...strokes[0],width:100},{...strokes[0],points:'not-an-array'}]) await assert.rejects(user(1,'update public.study_assets set annotations=$2 where id=$1',[note.id,JSON.stringify([bad])]),/check constraint/)
})
test('Deletion is caller-scoped, waits 48 hours, blocks stale access, and a new sign-in restores the account',async () => {
  const session=(await db.query('insert into auth.sessions(user_id) values($1) returning id',[ids[0]])).rows[0]
  const request=(await user(0,'select public.request_account_deletion() as data')).rows[0].data
  const row=(await db.query('select * from private.account_deletions where user_id=$1',[ids[0]])).rows[0]
  assert.equal(new Date(row.delete_after)-new Date(row.requested_at),48*60*60*1000)
  assert.equal((await user(0,'select public.request_account_deletion() as data')).rows[0].data.delete_after,request.delete_after)
  assert.equal((await backend('select * from public.claim_due_account_deletions()')).rows.length,0)
  assert.equal((await user(0,'select * from public.folders')).rows.length,0)
  assert.equal((await user(1,'select * from public.study_assets where id=$1',[note.id])).rows.length,0)
  await assert.rejects(user(1,'select * from private.account_deletions'),/permission denied/)
  assert.equal((await user(1,'select public.account_deletion_status() as data')).rows[0].data,null)
  await db.query('update auth.sessions set updated_at=now() where id=$1',[session.id])
  assert.ok((await user(0,'select public.account_deletion_status() as data')).rows[0].data)
  await db.query('insert into auth.sessions(user_id) values($1)',[ids[0]])
  assert.equal((await user(0,'select public.account_deletion_status() as data')).rows[0].data,null)
  assert.equal((await user(1,'select * from public.study_assets where id=$1',[note.id])).rows.length,1)
})
test('Expired requests require a valid worker lease and storage cleanup before relational/Auth deletion',async () => {
  const id=ids[3], own=(await user(3,"select * from public.create_folder('Delete my space')")).rows[0]
  const doc=crypto.randomUUID(),path=`${shared.id}/${id}/${doc}.txt`,peerDoc=crypto.randomUUID(),peerPath=`${own.id}/${ids[1]}/${peerDoc}.txt`
  for (const [docId,folder,u,storagePath] of [[doc,shared.id,id,path],[peerDoc,own.id,ids[1],peerPath]]) await db.query("insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) values($1,$2,$3,'source.txt',$4,'text/plain',40)",[docId,folder,u,storagePath])
  await db.query("insert into public.study_assets(folder_id,document_id,kind,title,content,created_by) values($1,$2,'note','Peer generated from my source','Notes',$3)",[shared.id,doc,ids[1]])
  await db.query("insert into public.study_assets(folder_id,kind,title,content,created_by) values($1,'note','My shared note','Notes',$2)",[shared.id,id])
  await db.query("insert into public.study_sessions(folder_id,user_id,duration_seconds) values($1,$2,60)",[shared.id,id])
  await db.query("insert into public.study_messages(folder_id,user_id,body) values($1,$2,'My private contribution')",[shared.id,id])
  await db.query("insert into public.folder_invitations(folder_id,token_hash,email,role) values($1,'email-bound','person3@example.com','viewer')",[shared.id])
  for (const [bucket,name,owner] of [['study-files',path,id],['study-files',peerPath,ids[1]],['profile-photos',id+'/photo.png',id]]) await db.query('insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)',[bucket,name,owner])
  await user(3,'select public.request_account_deletion()')
  await db.query("update private.account_deletions set requested_at=now()-interval '49 hours',delete_after=now()-interval '1 hour' where user_id=$1",[id])
  await db.query('insert into auth.sessions(user_id) values($1)',[id])
  await assert.rejects(user(3,'select public.cancel_account_deletion()'),/period has ended/)
  await assert.rejects(user(0,'select * from public.claim_due_account_deletions()'),/permission denied/)
  const claim=(await backend('select * from public.claim_due_account_deletions()')).rows[0]
  assert.equal(claim.user_id,id)
  assert.equal((await backend('select * from public.claim_due_account_deletions()')).rows.length,0)
  await assert.rejects(backend('select public.prepare_account_deletion($1,$2)',[id,crypto.randomUUID()]),/claim is missing/)
  const objects=(await backend('select * from public.account_storage_deletions($1,$2)',[id,claim.claim_token])).rows
  assert.equal(objects.length,3)
  await assert.rejects(backend('select public.prepare_account_deletion($1,$2)',[id,claim.claim_token]),/storage objects first/)
  assert.equal((await db.query('select * from public.profiles where id=$1',[id])).rows.length,1)
  // Local fixture models confirmed Storage API removal. Production code uses .storage.remove().
  for (const object of objects) await db.query('delete from storage.objects where bucket_id=$1 and name=$2',[object.bucket_id,object.name])
  await backend('select public.prepare_account_deletion($1,$2)',[id,claim.claim_token])
  await db.query('delete from auth.users where id=$1',[id])
  for (const [table,column] of [['profiles','id'],['folder_members','user_id'],['study_messages','user_id'],['study_sessions','user_id'],['document_files','uploaded_by'],['study_assets','created_by']]) assert.equal((await db.query(`select count(*) as count from public.${table} where ${column}=$1`,[id])).rows[0].count,0)
  assert.equal((await db.query('select * from private.account_deletions where user_id=$1',[id])).rows.length,0)
  assert.equal((await db.query('select * from auth.sessions where user_id=$1',[id])).rows.length,0)
  assert.equal((await db.query('select * from public.folders where id=$1',[own.id])).rows.length,0)
  assert.equal((await db.query("select * from public.folder_invitations where email='person3@example.com'")).rows.length,0)
  assert.equal((await db.query('select * from public.study_assets where id=$1',[note.id])).rows.length,1)
  assert.equal((await db.query('select * from auth.users where id=$1',[ids[1]])).rows.length,1)
})

test('Rich-note capacity upgrade accepts complete formatted notes without relaxing Markdown limits or permissions',async()=>{
 const html='<p>'+('Detailed notes. '.repeat(5000))+'</p>'
 assert.ok(html.length>60000)
 const insert='insert into public.study_assets(folder_id,kind,title,content,content_format,created_by) values($1,\'note\',\'Long notes\',$2,$3,$4) returning id,content'
 await assert.rejects(user(0,insert,[shared.id,html,'html',ids[0]]),/study_assets_content_check/)
 await db.exec(readFileSync(new URL('../supabase/migrations/019_rich_note_capacity.sql',import.meta.url),'utf8'))
 const row=(await user(0,insert,[shared.id,html,'html',ids[0]])).rows[0]
 assert.equal(row.content,html)
 const edge='<p>'+('🙂'.repeat(239993))+'</p>'
 assert.equal([...edge].length,240000)
 await user(0,'update public.study_assets set content=$1 where id=$2',[edge,row.id])
 await assert.rejects(user(0,'update public.study_assets set content=$1 where id=$2',[edge+'x',row.id]),/study_assets_content_check/)
 await assert.rejects(user(0,insert,[shared.id,'x'.repeat(60001),'markdown',ids[0]]),/study_assets_content_check/)
 await assert.rejects(user(2,insert,[shared.id,html,'html',ids[2]]),/row-level security/)
 assert.equal((await db.query("select relrowsecurity from pg_class where oid='public.study_assets'::regclass")).rows[0].relrowsecurity,true)
})
