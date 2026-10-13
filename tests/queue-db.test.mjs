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
  for(const file of ['001_synapse.sql','003_study_refinements.sql','004_reviewer_accounts.sql','006_system_maintenance.sql','007_admin_email_type.sql','008_guided_generation.sql','009_seeds_and_custom_cards.sql','010_automatic_study.sql','011_generation_reliability.sql','012_generation_queue.sql','014_safe_database_cleanup.sql']) await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'))
  for(const [i,id] of ids.entries()) await db.query('insert into auth.users(id,email,email_confirmed_at,last_sign_in_at) values($1,$2,now(),now())',[id,`guided${i}@example.com`])
})
beforeEach(async()=>{await db.exec('delete from private.ai_usage;delete from private.seed_usage')})
after(async()=>db.close())


test('Queue migrations install and jobs save each upload stage atomically',async()=>{
 const m=await material(),request=crypto.randomUUID()
 const q=await rpc('enqueue_generation',[ids[0],request,m.doc,null,null])
 assert.equal(q.status,'queued')
 assert.equal((await rpc('enqueue_generation',[ids[0],request,m.doc,null,null])).id,q.id)
 for(const stage of ['prepare','note','deck','quiz']){
  const task=await rpc('claim_generation_task',[]);assert.equal(task.id,q.id);assert.equal(task.stage,stage)
  assert.ok(await rpc('start_generation_task',[task.id,task.lease_token]));assert.equal(await rpc('start_generation_task',[task.id,task.lease_token]),null)
  await rpc('claim_queued_source',[q.id,task.lease_token,m.id])
  if(stage==='prepare')await rpc('finish_generation_prepare',[q.id,task.lease_token])
  else {
   await rpc('claim_queued_generation',[q.id,task.lease_token,m.id])
   const output=stage==='note'?{notes:'# Queue foundations\nA complete source-supported explanation.'}:stage==='deck'?{flashcards:[{front:'Which operation inserts at the rear?',back:'Enqueue',coverage_key:'queue:insert'}]}:{quiz:[{type:'short_answer',question:'What removes the oldest item?',answer:'Dequeue',options:[],accepted_answers:[],explanation:'FIFO removes the front.',coverage_key:'queue:removal'}]}
   await rpc('complete_queued_generation',[q.id,task.lease_token,JSON.stringify(output)])
   // A lost save response or duplicate delivery cannot save another set.
   await rpc('defer_generation_task',[q.id,task.lease_token,'Lost HTTP response',15,'Continuing',false])
   await assert.rejects(rpc('complete_queued_generation',[q.id,task.lease_token,JSON.stringify(output)]),/lease expired/)
  }
 }
 const done=(await db.query('select * from private.generation_queue where id=$1',[q.id])).rows[0]
 assert.equal(done.status,'completed');assert.deepEqual(done.completed_kinds,['note','deck','quiz'])
 assert.equal((await db.query('select count(*)::int n from public.study_assets where material_id=$1',[m.id])).rows[0].n,3)
 assert.equal((await db.query('select status from public.document_files where id=$1',[m.doc])).rows[0].status,'ready')
})

test('Third-stage failures requeue only the missing quiz; leases fence off old workers',async()=>{
 const m=await material(),q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null])
 await db.query("update private.generation_queue set stage='quiz',completed_kinds=array['note','deck'] where id=$1",[q.id])
 let task=await rpc('claim_generation_task',[])
 await rpc('claim_queued_source',[q.id,task.lease_token,m.id])
 const claim=await rpc('claim_queued_generation',[q.id,task.lease_token,m.id])
 await rpc('defer_generation_task',[q.id,task.lease_token,'Provider temporarily busy',60,'Waiting for capacity',true])
 assert.equal((await db.query('select status from private.material_jobs where id=$1',[claim.job_id])).rows[0].status,'failed')
 assert.equal(await rpc('claim_generation_task',[]),null)
 await db.exec('update private.generation_capacity set cooldown_until=null');await db.query('update private.generation_queue set available_at=now() where id=$1',[q.id])
 const second=await rpc('claim_generation_task',[]);assert.equal(second.stage,'quiz');assert.equal(second.attempts,2)
 await assert.rejects(rpc('claim_queued_generation',[q.id,task.lease_token,m.id]),/lease expired/)
 await rpc('claim_queued_source',[q.id,second.lease_token,m.id]);await rpc('claim_queued_generation',[q.id,second.lease_token,m.id])
 await db.query("update private.generation_queue set lease_until=now()-interval '1 second' where id=$1",[q.id])
 task=await rpc('claim_generation_task',[]);assert.equal(task.id,q.id);assert.equal(task.attempts,3)
 await assert.rejects(rpc('finish_generation_prepare',[q.id,second.lease_token]),/lease expired/)
 await rpc('defer_generation_task',[q.id,task.lease_token,'Stopped test',null,'Paused',false])
})

test('Multiple users queue independently with a hard concurrency cap and one running task per user',async()=>{
 const tasks=[]
 for(let i=0;i<3;i++){
  const folder=(await user(i,"select * from public.create_folder('Concurrent source')")).rows[0]
  for(let n=0;n<2;n++){
   const doc=crypto.randomUUID()
   await user(i,'insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) values($1,$2,$3,$4,$5,$6,$7)',[doc,folder.id,ids[i],'queues.txt',folder.id+'/'+ids[i]+'/'+doc+'.txt','text/plain',30])
   tasks.push(await rpc('enqueue_generation',[ids[i],crypto.randomUUID(),doc,null,null]))
  }
 }
 const claimed=await Promise.all(Array.from({length:12},()=>rpc('claim_generation_task',[])))
 const live=claimed.filter(Boolean);assert.equal(live.length,2);assert.equal(new Set(live.map(t=>t.user_id)).size,2)
 const active=(await db.query("select count(*)::int n from private.generation_queue where status='processing'")).rows[0].n;assert.equal(active,2)
 assert.equal((await db.query("select count(*)::int n from private.generation_queue where status='queued'")).rows[0].n,4)
 await db.exec("update private.generation_queue set status='completed',lease_token=null,lease_until=null where status in('queued','processing')")
})

test('Queue status is private, requests deduplicate, and permission loss blocks saving',async()=>{
 const m=await material(),q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null])
 await assert.rejects(rpc('enqueue_generation',[ids[1],crypto.randomUUID(),m.doc,null,null]),/Editor access/)
 await assert.rejects(user(0,'select * from private.generation_queue'),/permission denied/)
 await assert.rejects(user(0,'select public.claim_generation_task()'),/permission denied/)
 assert.equal((await user(1,'select public.my_generation_tasks() as jobs')).rows[0].jobs.some(t=>t.id===q.id),false)
 const snapshot=(await user(0,'select public.my_generation_tasks() as jobs')).rows[0].jobs.find(t=>t.id===q.id)
 for(const key of ['lease_token','source_text','last_error','user_id'])assert.equal(key in snapshot,false)
 await user(0,"insert into public.folder_members(folder_id,user_id,role) values($1,$2,'editor')",[m.folder.id,ids[1]]).catch(async()=>{await db.query("insert into public.folder_members(folder_id,user_id,role) values($1,$2,'editor')",[m.folder.id,ids[1]])})
 assert.equal((await rpc('enqueue_generation',[ids[1],crypto.randomUUID(),m.doc,null,null])).id,q.id)
 const task=await rpc('claim_generation_task',[]);await rpc('claim_queued_source',[task.id,task.lease_token,m.id])
 await user(0,'select public.request_account_deletion()')
 await assert.rejects(rpc('finish_generation_prepare',[task.id,task.lease_token]),/Editor access/)
 await user(0,'select public.cancel_account_deletion()')
 await rpc('defer_generation_task',[task.id,task.lease_token,'Stopped test',null,'Paused',false])
})

test('Technical cleanup is admin-only, bounded, and preserves sources, history and live jobs',async()=>{
 await db.query('insert into private.app_admins(user_id) values($1)',[ids[0]])
 const m=await material(),q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null])
 const task=await rpc('claim_generation_task',[]);await rpc('claim_queued_source',[task.id,task.lease_token,m.id])
 await db.query("update private.generation_queue set created_at=now()-interval '40 days',updated_at=now()-interval '40 days' where id=$1",[q.id])
 await db.query("insert into public.activity_events(folder_id,user_id,message,created_at) select $1,$2,'Old technical feed',now()-interval '100 days' from generate_series(1,1002)",[m.folder.id,ids[0]])
 await db.query("insert into private.seed_usage(user_id,usage_date,spent) values($1,current_date-90,30),($1,current_date,30)",[ids[0]])
 await db.query("update public.document_files set purged_at=now(),extracted_text=(select source_text from public.study_materials where id=$2) where id=$1",[m.doc,m.id])
 const original=(await db.query('select source_text from public.study_materials where id=$1',[m.id])).rows[0].source_text
 await assert.rejects(user(1,'select public.admin_cleanup_preview()'),/Admin access/)
 await assert.rejects(user(1,'select public.admin_clean_records($1)',[['jobs']]),/Admin access/)
 const preview=(await user(0,'select public.admin_cleanup_preview() as result')).rows[0].result
 assert.equal(preview.activity,1001);assert.equal(preview.duplicate_text,1)
 const result=(await user(0,'select public.admin_clean_records($1) as result',[['activity','jobs','usage','duplicate_text']])).rows[0].result
 assert.equal(result.activity,1000);assert.equal(result.usage,1);assert.equal(result.duplicate_text,1)
 assert.equal((await db.query('select source_text from public.study_materials where id=$1',[m.id])).rows[0].source_text,original)
 assert.equal((await db.query('select status from private.generation_queue where id=$1',[q.id])).rows[0].status,'processing')
 assert.equal((await db.query('select count(*)::int n from private.seed_usage')).rows[0].n,1)
 await rpc('defer_generation_task',[task.id,task.lease_token,'Configuration fixed later',null,'Paused',false])
 assert.equal((await user(0,'select public.admin_resume_generation($1) as n',[[q.id]])).rows[0].n,1)
})

test('Source-hash merging cannot cascade-delete a queued re-upload',async()=>{
 await db.exec("update private.generation_queue set status='completed',lease_token=null,lease_until=null where status in('queued','processing')")
 const m=await material(),doc=crypto.randomUUID(),old=crypto.randomUUID()
 await db.query("insert into public.study_materials(id,folder_id,created_by,title) values($1,$2,$3,'Old upload')",[old,m.folder.id,ids[0]])
 await db.query('insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes,material_id) values($1,$2,$3,$4,$5,$6,$7,$8)',[doc,m.folder.id,ids[0],'queues.txt',m.folder.id+'/'+ids[0]+'/'+doc+'.txt','text/plain',30,old])
 const q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),doc,null,null]),ticket=await rpc('claim_generation_task',[])
 const bound=await rpc('bind_generation_source',[doc,ids[0],m.hash]);assert.equal(bound.id,m.id)
 assert.equal((await db.query('select id from private.generation_queue where id=$1',[q.id])).rows.length,1)
 await rpc('claim_queued_source',[q.id,ticket.lease_token,m.id]);await rpc('finish_generation_prepare',[q.id,ticket.lease_token])
 await db.exec("update private.generation_queue set status='completed',lease_token=null,lease_until=null where status in('queued','processing')")
})

test('Scheduler reserves worker tickets before dispatch, enforces capacity, and reuses its named cron schedule',async()=>{
 await db.exec(`create schema vault;create schema net;create schema cron;
  create table vault.decrypted_secrets(name text,decrypted_secret text);
  insert into vault.decrypted_secrets values('synapse_project_url','https://mock.supabase.co'),('synapse_cron_secret','fake-secret-with-32-characters');
  create table net.requests(id bigserial primary key,url text,headers jsonb,body jsonb,timeout_milliseconds integer);
  create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$ insert into net.requests(url,headers,body,timeout_milliseconds) values(url,headers,body,timeout_milliseconds) returning id $$;
  create table cron.jobs(name text primary key,schedule text,command text);
  create function cron.schedule(name text,schedule text,command text) returns bigint language sql as $$ insert into cron.jobs values(name,schedule,command) on conflict(name) do update set schedule=excluded.schedule,command=excluded.command returning 1::bigint $$;`)
 const schedule=readFileSync(new URL('../supabase/migrations/013_generation_schedule.sql',import.meta.url),'utf8').replace(/^create extension.*;$/gm,'')
 await db.exec(schedule);await db.exec(schedule)
 assert.equal((await db.query('select count(*)::int n from cron.jobs')).rows[0].n,1)
 await assert.rejects(user(0,'select public.dispatch_generation_queue()'),/permission denied/)
 for(let i=0;i<3;i++){
  const folder=(await user(i,"select * from public.create_folder('Scheduler load')")).rows[0],doc=crypto.randomUUID()
  await user(i,'insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) values($1,$2,$3,$4,$5,$6,$7)',[doc,folder.id,ids[i],'notes.txt',folder.id+'/'+ids[i]+'/'+doc+'.txt','text/plain',30])
  await rpc('enqueue_generation',[ids[i],crypto.randomUUID(),doc,null,null])
 }
 assert.equal(await rpc('dispatch_generation_queue',[]),2);assert.equal(await rpc('dispatch_generation_queue',[]),0)
 const tickets=(await db.query('select * from net.requests')).rows
 assert.equal(tickets.length,2)
 for(const ticket of tickets){assert.match(ticket.url,/functions\/v1\/generate-study$/);assert.equal(ticket.timeout_milliseconds,140000);assert.ok(ticket.headers['x-cron-secret']);assert.ok(await rpc('start_generation_task',[ticket.body.task_id,ticket.body.lease_token]));assert.equal(await rpc('start_generation_task',[ticket.body.task_id,ticket.body.lease_token]),null)}
 await db.exec("update private.generation_queue set lease_until=now()-interval '1 second' where status='processing'")
 assert.equal(await rpc('dispatch_generation_queue',[]),2,'Cron recovers reserved work even if HTTP delivery died')
})
