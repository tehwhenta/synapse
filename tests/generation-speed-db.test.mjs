import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const db=new PGlite(), ids=Array.from({length:3},()=>crypto.randomUUID())
async function user(i,sql,args=[]) { await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${ids[i]}',false)`); try { return await db.query(sql,args) } finally { await db.exec('reset role') } }
async function backend(sql,args=[]) { await db.exec('set role service_role'); try { return await db.query(sql,args) } finally { await db.exec('reset role') } }
const rpc=async(name,args)=> (await backend(`select to_jsonb(public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})) as value`,args)).rows[0].value
let fingerprint=0
async function material() {
  const folder=(await user(0,"select * from public.create_folder('Guided study')")).rows[0]
  const doc=crypto.randomUUID()
  await user(0,'insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) values($1,$2,$3,$4,$5,$6,$7)',[doc,folder.id,ids[0],'notes.txt',folder.id+'/'+ids[0]+'/'+doc+'.txt','text/plain',30])
  const hash=(++fingerprint).toString(16).padStart(64,'0')
  const m=await rpc('bind_generation_source',[doc,ids[0],hash])
  const scan=await rpc('claim_auto_source',[m.id,ids[0]])
  await rpc('retain_auto_source',[m.id,ids[0],'A queue uses FIFO ordering. Enqueue adds at the rear and dequeue removes at the front.',scan.token])
  return {folder,doc,id:m.id,hash}
}
before(async()=>{
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create schema storage; create schema realtime;
    create table auth.users(id uuid primary key,email varchar(255),raw_user_meta_data jsonb default '{}',last_sign_in_at timestamptz,email_confirmed_at timestamptz);
    create table auth.sessions(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,owner_id text,metadata jsonb default '{}'); alter table storage.objects enable row level security;
    create table realtime.messages(id bigint,extension text); alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
    grant usage on schema auth,storage,realtime to anon,authenticated,service_role;
    grant select,insert,delete on storage.objects to authenticated; grant select,insert on realtime.messages to authenticated;
    create publication supabase_realtime;`)
  for(const file of ['001_synapse.sql','003_study_refinements.sql','004_reviewer_accounts.sql','006_system_maintenance.sql','007_admin_email_type.sql','008_guided_generation.sql','009_seeds_and_custom_cards.sql','010_automatic_study.sql','011_generation_reliability.sql','012_generation_queue.sql','014_safe_database_cleanup.sql','015_generation_refinement.sql']) await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'))
  for(const [i,id] of ids.entries()) await db.query('insert into auth.users(id,email,email_confirmed_at,last_sign_in_at) values($1,$2,now(),now())',[id,`guided${i}@example.com`])
})
beforeEach(async()=>{await db.exec('delete from private.ai_usage;delete from private.seed_usage')})
after(async()=>db.close())



test('Cached source goes straight to the requested or missing format, keeping truthful progress',async()=>{
 const m=await material(),q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null])
 assert.equal(q.stage,'note');assert.equal(q.progress,0)
 const task=await rpc('claim_generation_task',[]);await rpc('claim_queued_source',[q.id,task.lease_token,m.id]);await rpc('claim_queued_generation',[q.id,task.lease_token,m.id])
 const asset=await rpc('complete_queued_generation',[q.id,task.lease_token,JSON.stringify({notes:'# Foundations\nComplete readable source-based notes.'})])
 const snapshot=(await user(0,'select public.my_generation_tasks() as jobs')).rows[0].jobs.find(t=>t.id===q.id)
 assert.equal(snapshot.progress,33);assert.equal(snapshot.stage,'deck')
 await db.exec("update private.generation_queue set status='completed',lease_token=null,lease_until=null where status in('queued','processing')")
 const refresh=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),null,asset.id,null]);assert.equal(refresh.stage,'note')
 assert.equal((await rpc('claim_generation_task',[])).stage,'note')
 await db.exec("update private.generation_queue set status='completed',lease_token=null,lease_until=null where status in('queued','processing')")
})

test('Temporary pauses and interrupted workers resume automatically; invalid source/access/exhaustion never loop',async()=>{
 const m=await material(),q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null])
 let task=await rpc('claim_generation_task',[])
 await rpc('defer_generation_task',[q.id,task.lease_token,'Worker timed out',null,'Taking a pause',false])
 let row=(await db.query('select * from private.generation_queue where id=$1',[q.id])).rows[0];assert.equal(row.pause_reason,'temporary');assert.ok(row.auto_resume_at)
 await db.query('update private.generation_queue set auto_resume_at=now() where id=$1',[q.id])
 task=await rpc('claim_generation_task',[]);assert.equal(task.id,q.id);assert.equal(task.attempts,1);assert.equal(task.recovery_cycles,1)
 await db.query("update private.generation_queue set lease_until=now()-interval '1 second',attempts=5 where id=$1",[q.id])
 assert.equal(await rpc('claim_generation_task',[]),null)
 row=(await db.query('select * from private.generation_queue where id=$1',[q.id])).rows[0];assert.equal(row.status,'paused');assert.ok(row.auto_resume_at)
 for(const [error,reason] of [['This file cannot be read','source'],['Editor access required','access'],['No fresh questions','exhausted']]){
  await db.query('update private.generation_queue set auto_resume_at=now() where id=$1',[q.id]);task=await rpc('claim_generation_task',[])
  await rpc('defer_generation_task',[q.id,task.lease_token,error,null,'Stopped',false])
  row=(await db.query('select * from private.generation_queue where id=$1',[q.id])).rows[0];assert.equal(row.pause_reason,reason);assert.equal(row.auto_resume_at,null)
  await db.query("update private.generation_queue set status='queued',attempts=0,available_at=now() where id=$1",[q.id])
 }
 await db.exec("update private.generation_queue set status='completed',lease_token=null,lease_until=null where status in('queued','processing')")
})

test('Configuration recovery is automatic but paced; active-account and lifetime budgets remain enforced',async()=>{
 const m=await material(),q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null]),task=await rpc('claim_generation_task',[])
 await rpc('defer_generation_task',[q.id,task.lease_token,'Gemini request failed (400 INVALID_ARGUMENT).',null,'Service problem',true])
 const row=(await db.query('select * from private.generation_queue where id=$1',[q.id])).rows[0]
 assert.equal(row.pause_reason,'service');assert.ok(new Date(row.auto_resume_at)-Date.now()>14*60000)
 assert.equal(await rpc('claim_generation_task',[]),null)
 await db.exec('update private.generation_capacity set cooldown_until=null');await db.query("update private.generation_queue set auto_resume_at=now(),created_at=now()-interval '25 hours' where id=$1",[q.id])
 assert.equal(await rpc('claim_generation_task',[]),null)
 assert.equal((await db.query('select auto_resume_at from private.generation_queue where id=$1',[q.id])).rows[0].auto_resume_at,null)
})

test('Warm continuation has a new exclusive lease, observes global capacity and cannot save from an old token',async()=>{
 const m=await material()
 await db.query("update public.study_materials set source_text='' where id=$1",[m.id])
 const q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,'A queue preserves FIFO ordering and operations.'])
 const task=await rpc('claim_generation_task',[]);assert.equal(task.stage,'prepare')
 await rpc('claim_queued_source',[q.id,task.lease_token,m.id]);await rpc('retain_queued_source',[q.id,task.lease_token,'A queue preserves FIFO ordering and operations.']);await rpc('finish_generation_prepare',[q.id,task.lease_token])
 const next=await rpc('continue_generation_task',[q.id,task.lease_token]);assert.equal(next.stage,'note');assert.notEqual(next.lease_token,task.lease_token);assert.equal(next.worker_started,true)
 assert.equal(await rpc('continue_generation_task',[q.id,task.lease_token]),null)
 await assert.rejects(rpc('claim_queued_generation',[q.id,task.lease_token,m.id]),/lease expired/)
 await assert.rejects(user(0,'select public.continue_generation_task($1,$2)',[q.id,next.lease_token]),/permission denied/)
 await db.exec("update private.generation_queue set status='completed',lease_token=null,lease_until=null where status in('queued','processing')")
})

test('Persistent temporary failures stop truthfully after the automatic recovery budget',async()=>{
 const m=await material(),q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null])
 await db.query('update private.generation_queue set recovery_cycles=3 where id=$1',[q.id])
 const task=await rpc('claim_generation_task',[])
 await rpc('defer_generation_task',[q.id,task.lease_token,'Persistent incomplete output',null,'Will continue automatically',false])
 const row=(await db.query('select * from private.generation_queue where id=$1',[q.id])).rows[0]
 assert.equal(row.auto_resume_at,null);assert.doesNotMatch(row.message,/will continue|taking a short pause/i);assert.match(row.message,/Automatic recovery could not finish/)
})

test('Recoverable pauses count as pending work and a repeated upload cannot reset their cooldown',async()=>{
 const m=await material(),q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null]),task=await rpc('claim_generation_task',[])
 await rpc('defer_generation_task',[q.id,task.lease_token,'Temporary failure',null,'Pause',false])
 const repeated=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null]);assert.equal(repeated.status,'paused');assert.ok(repeated.auto_resume_at)
 for(let n=0;n<2;n++){
  const doc=crypto.randomUUID()
  await user(0,'insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) values($1,$2,$3,$4,$5,$6,$7)',[doc,m.folder.id,ids[0],'notes.txt',m.folder.id+'/'+ids[0]+'/'+doc+'.txt','text/plain',30])
  await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),doc,null,null])
 }
 const extra=crypto.randomUUID();await user(0,'insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) values($1,$2,$3,$4,$5,$6,$7)',[extra,m.folder.id,ids[0],'notes.txt',m.folder.id+'/'+ids[0]+'/'+extra+'.txt','text/plain',30])
 await assert.rejects(rpc('enqueue_generation',[ids[0],crypto.randomUUID(),extra,null,null]),/three materials/)
 await db.exec("update private.generation_queue set status='completed',lease_token=null,lease_until=null,auto_resume_at=null where status in('queued','processing') or auto_resume_at is not null")
})

test('Faster scheduler replaces its named job with a seconds interval and bounded history cleanup',async()=>{
 await db.exec(`create schema vault;create schema cron;
 create table vault.decrypted_secrets(name text,decrypted_secret text);insert into vault.decrypted_secrets values('synapse_project_url','https://mock.supabase.co'),('synapse_cron_secret','test-secret');
 create table cron.jobs(name text primary key,schedule text,command text);
 create function cron.schedule(name text,schedule text,command text) returns bigint language sql as $$ insert into cron.jobs values(name,schedule,command) on conflict(name) do update set schedule=excluded.schedule,command=excluded.command returning 1::bigint $$;
 insert into cron.jobs values('synapse-generation-queue','* * * * *','old command');`)
 const script=readFileSync(new URL('../supabase/migrations/016_faster_generation_schedule.sql',import.meta.url),'utf8');await db.exec(script);await db.exec(script)
 const rows=(await db.query('select * from cron.jobs')).rows
 assert.equal(rows.length,2);assert.equal(rows.find(j=>j.name==='synapse-generation-queue').schedule,'15 seconds')
 const prune=rows.find(j=>j.name==='synapse-generation-history-prune').command;assert.match(prune,/7 days/);assert.match(prune,/limit 10000/);assert.match(prune,/synapse-generation-queue/)
})
