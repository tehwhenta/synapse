import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()
const users = { owner: '11111111-1111-4111-8111-111111111111', editor: '22222222-2222-4222-8222-222222222222', viewer: '33333333-3333-4333-8333-333333333333', outsider: '44444444-4444-4444-8444-444444444444' }
let folder, quiz, deck, token
async function asUser(user, sql, args = []) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${users[user]}',false);`)
  try { return await db.query(sql, args) } finally { await db.exec('reset role;') }
}
before(async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema realtime;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;
    create table realtime.messages(id bigint,extension text);
    alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
    grant usage on schema auth,storage,realtime to anon,authenticated,service_role;
    grant select,insert,delete on storage.objects to authenticated;
    grant select,insert on realtime.messages to authenticated;
    create publication supabase_realtime;
  `)
  await db.exec(readFileSync(new URL('../supabase/migrations/001_synapse.sql', import.meta.url), 'utf8'))
  for (const [name, id] of Object.entries(users)) await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)', [id, `${name}@example.com`, JSON.stringify({ display_name: name })])
  folder = (await asUser('owner', "select * from public.create_folder('Data Structures')" )).rows[0]
  await db.query('insert into public.folder_members(folder_id,user_id,role) values($1,$2,$3),($1,$4,$5)', [folder.id, users.editor, 'editor', users.viewer, 'viewer'])
  quiz = (await db.query("insert into public.study_assets(folder_id,kind,title,data,created_by) values($1,'quiz','BST quiz',$2,$3) returning *", [folder.id, JSON.stringify([{ type:'multiple_choice',question:'BFS structure?',options:['Queue','Stack'],answer:'Queue',accepted_answers:[],explanation:'FIFO.' }, { type:'short_answer',question:'Sorted traversal?',options:[],answer:'inorder',accepted_answers:['in-order'],explanation:'Left root right.' }]), users.owner])).rows[0]
  deck = (await db.query("insert into public.study_assets(folder_id,kind,title,data,created_by) values($1,'deck','Deck',$2,$3) returning *", [folder.id, JSON.stringify([{ front:'BFS?',back:'Queue' }]), users.owner])).rows[0]
})
after(async () => { await db.close() })

test('RLS: owner/editor/viewer see a shared folder; outsider and anon cannot', async () => {
  for (const role of ['owner','editor','viewer']) assert.equal((await asUser(role,'select * from public.folders')).rows.length,1)
  assert.equal((await asUser('outsider','select * from public.folders')).rows.length,0)
  await db.exec('set role anon;')
  try { await assert.rejects(db.query('select * from public.study_assets'),/permission denied/) } finally { await db.exec('reset role') }
})
test('Viewer cannot insert/edit materials and editor can; identity fields cannot be rewritten', async () => {
  await assert.rejects(asUser('viewer',"insert into public.study_assets(folder_id,kind,title,content,created_by) values($1,'note','Forbidden','x',$2)",[folder.id,users.viewer]),/row-level security/)
  await asUser('editor',"insert into public.study_assets(folder_id,kind,title,content,created_by) values($1,'note','Allowed','x',$2)",[folder.id,users.editor])
  const updated = await asUser('viewer',"update public.study_assets set content='tampered' where id=$1 returning id",[quiz.id])
  assert.equal(updated.rows.length,0)
  await assert.rejects(asUser('owner','update public.folders set owner_id=$1 where id=$2',[users.outsider,folder.id]),/permission denied/)
  await assert.rejects(asUser('editor',"update public.study_assets set folder_id=gen_random_uuid() where id=$1",[quiz.id]),/permission denied/)
  await assert.rejects(asUser('editor',"update public.folder_members set role='editor' where user_id=$1",[users.viewer]),/permission denied/)
})
test('Profiles are visible only to peers; email is not in the exposed profile table', async () => {
  assert.equal((await asUser('outsider','select * from public.profiles')).rows.length,1)
  assert.equal((await asUser('viewer','select * from public.profiles')).rows.length,3)
  await assert.rejects(asUser('viewer','select email from public.profiles'),/does not exist/)
})
test('Invites: owner-only creation, email binding, single use, expiry and role checks', async () => {
  await assert.rejects(asUser('editor','select public.create_invitation($1)',[folder.id]),/owner/)
  token = (await asUser('owner',"select public.create_invitation($1,'viewer','outsider@example.com') as token",[folder.id])).rows[0].token
  assert.equal(token.length,64)
  await assert.rejects(asUser('viewer','select public.accept_invitation($1)',[token]),/different email/)
  assert.equal((await asUser('outsider','select public.accept_invitation($1) as id',[token])).rows[0].id,folder.id)
  await assert.rejects(asUser('outsider','select public.accept_invitation($1)',[token]),/already used/)
  await asUser('owner','select public.update_member($1,$2,null)',[folder.id,users.outsider])
  assert.equal((await asUser('outsider','select * from public.folders')).rows.length,0)
  const expired = (await asUser('owner',"select public.create_invitation($1) as token",[folder.id])).rows[0].token
  await db.exec("update public.folder_invitations set expires_at=now()-interval '1 minute' where accepted_at is null")
  await assert.rejects(asUser('outsider','select public.accept_invitation($1)',[expired]),/expired/)
})
test('Quiz scores come from DB answers; results are private and synonyms accepted', async () => {
  const result=(await asUser('viewer','select public.submit_quiz($1,$2) as result',[quiz.id,JSON.stringify([' Queue ','IN-ORDER'])])).rows[0].result
  assert.equal(result.correct,2); assert.equal(result.total,2)
  await assert.rejects(asUser('viewer','select public.submit_quiz($1,$2)',[quiz.id,'[]']),/Answer every/)
  await assert.rejects(asUser('outsider','select public.submit_quiz($1,$2)',[quiz.id,'["Queue","inorder"]']),/unavailable/)
  assert.equal((await asUser('owner','select * from public.quiz_attempts')).rows.length,0)
  assert.equal((await asUser('viewer','select * from public.quiz_attempts')).rows.length,1)
  await assert.rejects(asUser('viewer','insert into public.quiz_attempts(asset_id,user_id,correct,total,answers) values($1,$2,100,100,$3)',[quiz.id,users.viewer,'[]']),/permission denied/)
})
test('Card reviews schedule next dates, reset on Again, reject invalid indices', async () => {
  for(let i=0;i<3;i++) await asUser('viewer','select public.review_card($1,0,3)',[deck.id])
  const row=(await asUser('viewer','select * from public.flashcard_progress')).rows[0]
  assert.equal(row.repetitions,3); assert.ok(row.interval_days>=3); assert.ok(new Date(row.due_at)>new Date())
  await asUser('viewer','select public.review_card($1,0,1)',[deck.id])
  assert.equal((await asUser('viewer','select * from public.flashcard_progress')).rows[0].repetitions,0)
  await assert.rejects(asUser('viewer','select public.review_card($1,10,3)',[deck.id]),/Invalid/)
})
test('Private Storage and private Realtime are scoped to folder membership', async () => {
  const docId='55555555-5555-4555-8555-555555555555'; const path=`${folder.id}/${users.editor}/${docId}.txt`
  await asUser('editor',"insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) values($1,$2,$3,'notes.txt',$4,'text/plain',100)",[docId,folder.id,users.editor,path])
  await asUser('editor',"insert into storage.objects(bucket_id,name) values('study-files',$1)",[path])
  await assert.rejects(asUser('viewer',"insert into storage.objects(bucket_id,name) values('study-files',$1)",[path]),/row-level security/)
  assert.equal((await asUser('viewer','select * from storage.objects')).rows.length,1)
  assert.equal((await asUser('outsider','select * from storage.objects')).rows.length,0)
  await db.query("select set_config('realtime.topic',$1,false)",[`folder:${folder.id}`])
  await asUser('viewer',"insert into realtime.messages(id,extension) values(1,'presence')")
  await assert.rejects(asUser('outsider',"insert into realtime.messages(id,extension) values(2,'broadcast')"),/row-level security/)
  await db.query("select set_config('realtime.topic','folder:not-a-uuid',false)")
  await assert.rejects(asUser('viewer',"insert into realtime.messages(id,extension) values(3,'broadcast')"),/row-level security/)
})
test('AI generation is backend-only, editor-authorized and claimed once; persistence is atomic', async () => {
  const docId='66666666-6666-4666-8666-666666666666'; const path=`${folder.id}/${users.owner}/${docId}.txt`
  await asUser('owner',"insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) values($1,$2,$3,'notes.txt',$4,'text/plain',100)",[docId,folder.id,users.owner,path])
  await assert.rejects(asUser('owner','select public.claim_generation($1,$2)',[docId,users.owner]),/permission denied/)
  await assert.rejects(db.query('select public.claim_generation($1,$2)',[docId,users.viewer]),/Editor access/)
  await db.query('select public.claim_generation($1,$2)',[docId,users.owner])
  await assert.rejects(db.query('select public.claim_generation($1,$2)',[docId,users.owner]),/already processing/)
  const output={title:'BST',source_text:'Source text',notes:'# BST notes',flashcards:[{front:'BST',back:'Tree'}],quiz:[{question:'Tree?',answer:'Yes'}]}
  await db.query('select public.complete_generation($1,$2,$3)',[docId,users.owner,JSON.stringify(output)])
  assert.equal((await db.query('select status from public.document_files where id=$1',[docId])).rows[0].status,'ready')
  assert.equal((await db.query('select count(*)::int as count from public.study_assets where document_id=$1',[docId])).rows[0].count,3)
  await assert.rejects(db.query('select public.complete_generation($1,$2,$3)',[docId,users.owner,JSON.stringify(output)]),/claim is missing/)
})
test('Lifetime progress RPC is caller-scoped and does not allow another user ID', async () => {
  await asUser('viewer','select public.log_study_session($1,120)',[folder.id])
  const viewer=(await asUser('viewer',"select public.my_progress_stats('Asia/Manila') as stats")).rows[0].stats
  assert.equal(viewer.quizzes,1);assert.equal(viewer.minutes,2);assert.equal(viewer.streak,1)
  const owner=(await asUser('owner',"select public.my_progress_stats('Asia/Manila') as stats")).rows[0].stats
  assert.equal(owner.quizzes,0);assert.equal(owner.minutes,0)
  await assert.rejects(asUser('outsider','select public.log_study_session($1,120)',[folder.id]),/unavailable/)
})
test('AI failures cannot save partial materials; expired files and daily spending caps are enforced', async () => {
  const add=async()=>{const id=crypto.randomUUID();await db.query("insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) values($1,$2,$3,'notes.txt',$4,'text/plain',100)",[id,folder.id,users.owner,`${folder.id}/${users.owner}/${id}.txt`]);return id}
  const expired=await add();await db.query("update public.document_files set expires_at=now()-interval '1 minute' where id=$1",[expired]);await assert.rejects(db.query('select public.claim_generation($1,$2)',[expired,users.owner]),/expired/)
  const bad=await add();await db.query('select public.claim_generation($1,$2)',[bad,users.owner])
  await assert.rejects(db.query('select public.complete_generation($1,$2,$3)',[bad,users.owner,JSON.stringify({title:'Bad',flashcards:[],quiz:[]})]),/null/)
  assert.equal((await db.query('select count(*)::int as count from public.study_assets where document_id=$1',[bad])).rows[0].count,0)
  assert.equal((await db.query('select status from public.document_files where id=$1',[bad])).rows[0].status,'processing')
  // Owner made two earlier claims in this test file. Fill the remaining 18 quota slots.
  for(let i=0;i<18;i++)await db.query('select public.claim_generation($1,$2)',[await add(),users.owner])
  const limited=await add();await assert.rejects(db.query('select public.claim_generation($1,$2)',[limited,users.owner]),/Daily limit/)
  assert.equal((await db.query('select status from public.document_files where id=$1',[limited])).rows[0].status,'uploaded')
})
