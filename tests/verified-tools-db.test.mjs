import test, {before,after} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {PGlite} from '@electric-sql/pglite'
const db=new PGlite(),ids=Array.from({length:3},()=>crypto.randomUUID())
async function user(i,sql,args=[]){await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${ids[i]}',false)`);try{return await db.query(sql,args)}finally{await db.exec('reset role')}}
async function backend(sql,args=[]){await db.exec('set role service_role');try{return await db.query(sql,args)}finally{await db.exec('reset role')}}
before(async()=>{
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create schema storage; create schema realtime;
    create table auth.users(id uuid primary key,email varchar(255),raw_user_meta_data jsonb default '{}',last_sign_in_at timestamptz,email_confirmed_at timestamptz);
    create table auth.sessions(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,owner_id text,metadata jsonb default '{}',created_at timestamptz default now()); alter table storage.objects enable row level security;
    create table realtime.messages(id bigint,extension text); alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
    grant usage on schema auth,storage,realtime to anon,authenticated,service_role;
    grant select,insert,delete on storage.objects to authenticated; grant select,insert on realtime.messages to authenticated;
    create publication supabase_realtime;`)
  for(const file of ['001_synapse.sql','003_study_refinements.sql','004_reviewer_accounts.sql','006_system_maintenance.sql','007_admin_email_type.sql','008_guided_generation.sql','009_seeds_and_custom_cards.sql','010_automatic_study.sql','011_generation_reliability.sql','012_generation_queue.sql','014_safe_database_cleanup.sql','015_generation_refinement.sql','017_generation_performance.sql','018_streaming_generation.sql','019_rich_note_capacity.sql','020_learning_tools_and_cleanup.sql','021_ai_study_tools.sql','022_verified_study_tools.sql']) await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'))
  for(const [i,id] of ids.entries()) await db.query('insert into auth.users(id,email,email_confirmed_at,last_sign_in_at) values($1,$2,now(),now())',[id,i===0?'rcgsynapse@gmail.com':`checked${i}@example.com`])
  await db.query('insert into private.app_admins(user_id) values($1) on conflict do nothing',[ids[0]])
})
after(async()=>db.close())
async function folder(){return (await user(0,"select * from public.create_folder('Connections')")).rows[0]}
async function asset(fid,kind,data=[],content=''){
 return (await user(0,"insert into public.study_assets(folder_id,kind,title,created_by,data,content,content_format) values($1,$2,$3,$4,$5,$6,'html') returning *",[fid,kind,'My '+kind,ids[0],JSON.stringify(data),content])).rows[0]
}
const draft={cards:[{highlight_id:'h1',front:'What does FIFO mean?',back:'First in first out.',evidence:{source:'reviewer',quote:'FIFO means first in first out.'}}]}
const checks=[{id:'h1',supported:true,reason:''}]
async function cleanQueue(){await db.exec("delete from private.generation_queue;update private.generation_capacity set cooldown_until=null")}
async function source(){const f=await folder();return asset(f.id,'note',[],'<p><mark>FIFO</mark> means first in first out. A queue removes the earliest arrival.</p>')}
async function enqueue(note,user=0){return (await backend('select public.enqueue_study_tool($1,$2,$3,$4,$5) result',[ids[user],crypto.randomUUID(),note.id,'highlights',JSON.stringify(['FIFO'])])).rows[0].result.task}
async function claim(){const q=(await backend('select public.claim_generation_task() result')).rows[0].result;assert.ok(q);const started=(await backend('select public.start_generation_task($1,$2) result',[q.id,q.lease_token])).rows[0].result;assert.ok(started);return started}
async function checkpoint(q,value=draft){return backend('select public.checkpoint_study_tool($1,$2,$3)',[q.id,q.lease_token,JSON.stringify(value)])}
async function review(q,values=checks){return (await backend('select public.review_study_tool($1,$2,$3) result',[q.id,q.lease_token,JSON.stringify(values)])).rows[0].result}
async function ready(note){await enqueue(note);await checkpoint(await claim());const q=await claim();await review(q);return (await user(0,'select public.read_study_tool($1,$2,$3) result',[note.id,'highlights',JSON.stringify(['FIFO'])])).rows[0].result}

test('Drafts checkpoint privately, the next lease checks source support, and only checked results enter the cache',async()=>{
 await cleanQueue();const note=await source(),task=await enqueue(note),generation=await claim()
 await checkpoint(generation)
 let row=(await db.query('select * from private.generation_queue where id=$1',[task.id])).rows[0]
 assert.equal(row.status,'queued');assert.equal(row.tool_phase,'checking');assert.deepEqual(row.tool_draft,draft)
 const pending=(await user(0,'select public.read_study_tool_task($1) result',[task.id])).rows[0].result
 assert.equal(pending.output,null);assert.equal(pending.task.tool_phase,'checking');assert.equal(pending.task.tool_draft,undefined);assert.equal(pending.task.lease_token,undefined)
 await assert.rejects(backend('select public.complete_study_tool($1,$2,$3)',[generation.id,generation.lease_token,JSON.stringify(draft)]),/lease expired/)
 const verification=await claim();assert.notEqual(verification.lease_token,generation.lease_token)
 await assert.rejects(backend('select public.complete_study_tool($1,$2,$3)',[verification.id,verification.lease_token,JSON.stringify(draft)]),/requires source verification/)
 const generated=await review(verification);assert.deepEqual(generated.verification,{version:2,checked_items:1})
 const cached=(await user(0,'select public.read_study_tool($1,$2,$3) result',[note.id,'highlights',JSON.stringify(['FIFO'])])).rows[0].result
 assert.equal(cached.fingerprint.length,32);assert.deepEqual(cached.output,generated)
 row=(await db.query('select * from private.generation_queue where id=$1',[task.id])).rows[0]
 assert.equal(row.status,'completed');assert.equal(row.tool_draft,null)
 const runs=(await db.query('select tool_phase,is_retry,outcome from private.generation_runs where task_id=$1 order by reserved_at',[task.id])).rows
 assert.deepEqual(runs.map(r=>r.tool_phase),['generating','checking']);assert.ok(runs.every(r=>!r.is_retry));assert.ok(runs.every(r=>r.outcome==='saved'))
 const metrics=(await user(0,'select public.admin_generation_performance() result')).rows[0].result
 assert.ok(metrics.stages.some(s=>s.stage==='highlights_generating'));assert.ok(metrics.stages.some(s=>s.stage==='highlights_checking'))
})
test('A genuine quote does not bypass a negative semantic verdict; unsupported drafts get bounded corrections',async()=>{
 await cleanQueue();const note=await source(),task=await enqueue(note)
 const wrong={cards:[{...draft.cards[0],back:'Last in first out.'}]}
 for(let round=0;round<3;round++){
  await checkpoint(await claim(),wrong)
  const checking=await claim(),result=await review(checking,[{id:'h1',supported:false,reason:'The answer reverses the FIFO ordering stated by the source.'}])
  if(round<2){assert.equal(result.revising,true);const row=(await db.query('select * from private.generation_queue where id=$1',[task.id])).rows[0];assert.equal(row.tool_phase,'generating');assert.equal(row.tool_revisions,round+1);assert.equal(row.tool_draft,null);assert.match(row.tool_feedback[0].reason,/reverses/)}
  else assert.equal(result.needs_context,true)
 }
 const row=(await db.query('select * from private.generation_queue where id=$1',[task.id])).rows[0]
 assert.equal(row.status,'paused');assert.equal(row.pause_reason,'source');assert.equal(row.auto_resume_at,null);assert.equal(row.tool_draft,null)
 assert.equal((await user(0,'select public.read_study_tool($1,$2,$3) result',[note.id,'highlights',JSON.stringify(['FIFO'])])).rows[0].result.output,null)
})
test('Checking resumes its saved draft after throttling, and changed sources or revoked access cannot be published',async()=>{
 await cleanQueue();const note=await source();await enqueue(note);await checkpoint(await claim());let q=await claim()
 await backend("select public.defer_generation_task($1,$2,'Gemini quota exceeded (429)',5,'Waiting for AI capacity',true)",[q.id,q.lease_token])
 await db.exec("update private.generation_queue set available_at=now();update private.generation_capacity set cooldown_until=null")
 q=await claim();const resumed=(await backend('select public.claim_study_tool($1,$2) result',[q.id,q.lease_token])).rows[0].result
 assert.equal(resumed.tool_phase,'checking');assert.deepEqual(resumed.draft,draft)
 const runs=(await db.query('select tool_phase,is_retry from private.generation_runs where task_id=$1 order by reserved_at',[q.id])).rows
 assert.equal(runs.at(-1).is_retry,true)
 await user(0,"update public.study_assets set content='<p>A new explanation about queues, with changed source context.</p>' where id=$1",[note.id])
 await assert.rejects(review(q),/Reviewer changed/)
 await cleanQueue();const shared=await source()
 await db.query("insert into public.folder_members(folder_id,user_id,role) values($1,$2,'editor')",[shared.folder_id,ids[1]])
 await enqueue(shared,1);await checkpoint(await claim());q=await claim()
 await db.query("update public.folder_members set role='viewer' where folder_id=$1 and user_id=$2",[shared.folder_id,ids[1]])
 await assert.rejects(review(q),/Editor access/)
})
test('Verification IDs and booleans are strict and browser roles cannot checkpoint or forge checked results',async()=>{
 await cleanQueue();const note=await source();await enqueue(note);const first=await claim()
 await assert.rejects(user(0,'select public.checkpoint_study_tool($1,$2,$3)',[first.id,first.lease_token,JSON.stringify(draft)]),/permission denied/)
 await checkpoint(first);const q=await claim()
 for(const invalid of [[],[{id:'made-up',supported:true,reason:''}],[{id:'h1',supported:'true',reason:''}]])await assert.rejects(review(q,invalid),/Verify every|Invalid study tool/)
 await assert.rejects(user(0,'select public.review_study_tool($1,$2,$3)',[q.id,q.lease_token,JSON.stringify(checks)]),/permission denied/)
 await assert.rejects(user(0,'select * from private.highlight_card_saves'),/permission denied/)
 await review(q)
})
test('Repeated highlight saves create one deck or one append, keep review schedules, and reject stale generation context',async()=>{
 await cleanQueue();const note=await source(),result=await ready(note),request=crypto.randomUUID(),cards=JSON.stringify([{front:'What does FIFO mean?',back:'First in first out.'}])
 const args=[request,note.id,'My checked cards',cards,null,JSON.stringify(['FIFO']),result.fingerprint]
 const save=(values=args)=>user(0,'select * from public.save_highlight_cards_v2($1,$2,$3,$4,$5,$6,$7)',values)
 const first=(await save()).rows[0],retried=(await save()).rows[0]
 assert.equal(first.id,retried.id);assert.equal(retried.data.length,1);assert.equal((await db.query("select count(*)::int n from public.study_assets where folder_id=$1 and is_custom",[note.folder_id])).rows[0].n,1)
 await user(0,'select public.review_card($1,0,3)',[first.id]);const cardId=first.data[0].id
 const appendArgs=[crypto.randomUUID(),note.id,'Unused',cards,first.id,JSON.stringify(['FIFO']),result.fingerprint]
 const appended=(await save(appendArgs)).rows[0];assert.equal(appended.data.length,2);assert.equal((await save(appendArgs)).rows[0].data.length,2);assert.equal(appended.data[0].id,cardId)
 assert.equal((await db.query('select count(*)::int n from public.flashcard_progress where asset_id=$1',[first.id])).rows[0].n,1)
 await assert.rejects(save([...args.slice(0,2),'Changed title',...args.slice(3)]),/new save request ID/)
 await user(0,"update public.study_assets set content='<p>The reviewer was revised after those cards were prepared.</p>' where id=$1",[note.id])
 await assert.rejects(save([crypto.randomUUID(),...args.slice(1)]),/Reviewer changed/)
 assert.equal((await save()).rows[0].id,first.id,'Recovering a previously committed save does not create cards from stale source')
 await assert.rejects(user(1,'select * from public.save_highlight_cards_v2($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),...args.slice(1)]),/Editor access/)
 await db.exec("update private.highlight_card_saves set created_at=now()-interval '31 days'")
 const pruned=(await backend('select public.prune_maintenance_records() result')).rows[0].result
 assert.ok(pruned.jobs>=2);assert.equal((await db.query('select count(*)::int n from private.highlight_card_saves')).rows[0].n,0)
 assert.equal((await db.query('select jsonb_array_length(data) n from public.study_assets where id=$1',[first.id])).rows[0].n,2)
})

test('Concept maps check every node and directed edge, and a reviewer without material_id still has one active source task',async()=>{
 await cleanQueue();const note=await source()
 const high=await enqueue(note)
 const map=(await backend('select public.enqueue_study_tool($1,$2,$3,$4) result',[ids[0],crypto.randomUUID(),note.id,'connections'])).rows[0].result.task
 const first=await claim();assert.equal(first.id,high.id)
 assert.equal((await backend('select public.claim_generation_task() result')).rows[0].result,null,'An unbound reviewer has the same per-source guard as a material')
 await checkpoint(first)
 const generation=await claim();assert.equal(generation.id,map.id,'The older queued request keeps FIFO priority between phases')
 const graph={nodes:[{id:'c1',label:'Queue',body:'A structure that removes the earliest arrival.',evidence:{source:'reviewer',quote:'A queue removes the earliest arrival.'}},{id:'c2',label:'FIFO',body:'First in first out.',evidence:{source:'reviewer',quote:'FIFO means first in first out.'}}],edges:[{from:'c1',to:'c2',label:'uses',explanation:'The queue processes arrivals in their order.',evidence:{source:'reviewer',quote:'FIFO means first in first out. A queue removes the earliest arrival.'}}]}
 await checkpoint(generation,graph);const highChecking=await claim();assert.equal(highChecking.id,high.id);await review(highChecking);const verification=await claim()
 await assert.rejects(review(verification,[{id:'node:c1',supported:true,reason:''},{id:'node:c2',supported:true,reason:''}]),/Verify every/)
 const approved=await review(verification,[{id:'node:c1',supported:true,reason:''},{id:'node:c2',supported:true,reason:''},{id:'edge:1',supported:true,reason:''}])
 assert.equal(approved.verification.checked_items,3)
 assert.equal((await db.query("select count(*)::int n from private.generation_queue where status='processing'")).rows[0].n,0)
})
