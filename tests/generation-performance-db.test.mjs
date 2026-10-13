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
async function material(owner=0) {
  const folder=(await user(owner,"select * from public.create_folder('Guided study')")).rows[0]
  const doc=crypto.randomUUID()
  await user(owner,'insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) values($1,$2,$3,$4,$5,$6,$7)',[doc,folder.id,ids[owner],'notes.txt',folder.id+'/'+ids[owner]+'/'+doc+'.txt','text/plain',30])
  const hash=(++fingerprint).toString(16).padStart(64,'0')
  const m=await rpc('bind_generation_source',[doc,ids[owner],hash])
  const scan=await rpc('claim_auto_source',[m.id,ids[owner]])
  await rpc('retain_auto_source',[m.id,ids[owner],'A queue uses FIFO ordering. Enqueue adds at the rear and dequeue removes at the front.',scan.token])
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
  for(const file of ['001_synapse.sql','003_study_refinements.sql','004_reviewer_accounts.sql','006_system_maintenance.sql','007_admin_email_type.sql','008_guided_generation.sql','009_seeds_and_custom_cards.sql','010_automatic_study.sql','011_generation_reliability.sql','012_generation_queue.sql','014_safe_database_cleanup.sql','015_generation_refinement.sql','017_generation_performance.sql']) await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'))
  for(const [i,id] of ids.entries()) await db.query('insert into auth.users(id,email,email_confirmed_at,last_sign_in_at) values($1,$2,now(),now())',[id,`guided${i}@example.com`])
})
beforeEach(async()=>{await db.exec("delete from private.generation_queue;delete from private.generation_runs;update private.material_jobs set status='failed' where status='processing';update private.generation_capacity set cooldown_until=null")})
after(async()=>db.close())

test('Three global slots favor waiting users and never reserve more than two slots for one account',async()=>{
 const sources=[]
 for(const owner of [0,0,0,1,2]){
  const m=await material(owner),q=await rpc('enqueue_generation',[ids[owner],crypto.randomUUID(),m.doc,null,null]);sources.push({owner,m,q})
 }
 const reserved=(await Promise.all(Array.from({length:15},()=>rpc('claim_generation_task',[])))).filter(Boolean)
 assert.equal(reserved.length,3);assert.equal(new Set(reserved.map(t=>t.user_id)).size,3)
 assert.equal((await db.query("select count(*)::int n from private.generation_queue where status='queued'")).rows[0].n,2)
 const active=(await db.query("select user_id,count(*)::int n from private.generation_queue where status='processing' group by user_id")).rows
 assert.ok(active.every(a=>a.n<=2));assert.equal(active.reduce((sum,a)=>sum+a.n,0),3)
})

test('Two different spaces for the same user generate concurrently, with a third slot available to another user',async()=>{
 const materials=await Promise.all([material(0),material(0),material(0)])
 for(const m of materials)await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null])
 const first=await rpc('claim_generation_task',[]),second=await rpc('claim_generation_task',[])
 assert.notEqual(first.folder_id,second.folder_id);assert.equal(first.user_id,second.user_id)
 assert.equal(await rpc('claim_generation_task',[]),null)
 for(const task of [first,second])await rpc('claim_queued_generation',[task.id,task.lease_token,task.material_id])
 await assert.rejects(rpc('claim_auto_generation',[materials[2].id,ids[0],'note',false]),/parallel study tasks/)
 const another=await material(1);await rpc('enqueue_generation',[ids[1],crypto.randomUUID(),another.doc,null,null])
 const third=await rpc('claim_generation_task',[]);assert.equal(third.user_id,ids[1])
 await rpc('claim_queued_generation',[third.id,third.lease_token,third.material_id])
 assert.equal((await db.query("select count(*)::int n from private.material_jobs where status='processing'")).rows[0].n,3)
 assert.equal(await rpc('claim_generation_task',[]),null)
})

test('Shared editors cannot generate two jobs for the same material, even when formats or accounts differ',async()=>{
 const m=await material(0)
 await db.query("insert into public.folder_members(folder_id,user_id,role) values($1,$2,'editor')",[m.folder.id,ids[1]])
 const doc=crypto.randomUUID();await db.query('insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes,material_id) values($1,$2,$3,$4,$5,$6,$7,$8)',[doc,m.folder.id,ids[1],'copy.txt',m.folder.id+'/'+ids[1]+'/'+doc+'.txt','text/plain',30,m.id])
 const q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null]);await rpc('enqueue_generation',[ids[1],crypto.randomUUID(),doc,null,null])
 const task=await rpc('claim_generation_task',[]);assert.equal(task.id,q.id)
 assert.equal(await rpc('claim_generation_task',[]),null)
 await rpc('claim_queued_generation',[task.id,task.lease_token,m.id])
 await assert.rejects(rpc('claim_auto_generation',[m.id,ids[1],'quiz',false]),/already generating/)
})

test('Warm continuation reserves a fresh lease and respects waiting users, source serialization and capacity',async()=>{
 const m=await material(0),q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null])
 await db.query("update private.generation_queue set stage='prepare' where id=$1",[q.id])
 const task=await rpc('claim_generation_task',[]);await rpc('start_generation_task',[q.id,task.lease_token]);await rpc('claim_queued_source',[q.id,task.lease_token,m.id])
 const nextUser=await material(1);await rpc('enqueue_generation',[ids[1],crypto.randomUUID(),nextUser.doc,null,null])
 await rpc('finish_generation_prepare',[q.id,task.lease_token])
 assert.equal(await rpc('continue_generation_task',[q.id,task.lease_token]),null,'Waiting users receive their first slot before a warm continuation')
 const other=await rpc('claim_generation_task',[]);assert.equal(other.user_id,ids[1])
 const warm=await rpc('continue_generation_task',[q.id,task.lease_token]);assert.equal(warm.stage,'note');assert.notEqual(warm.lease_token,task.lease_token);assert.equal(warm.worker_started,true)
 await assert.rejects(rpc('claim_queued_generation',[q.id,task.lease_token,m.id]),/lease expired/)
 assert.equal(await rpc('continue_generation_task',[q.id,task.lease_token]),null)
 const runs=(await db.query('select * from private.generation_runs where task_id=$1 order by reserved_at',[q.id])).rows
 assert.equal(runs.length,2);assert.equal(runs[0].outcome,'saved');assert.ok(runs[1].started_at)
})

const measured={source_read_ms:20,gemini_ms:900,save_ms:15,validation_ms:3,gemini_calls:2,draft_retries:1,provider_retries:0,source_cached:true,source_chars:100,output_chars:200,input_tokens:140,output_tokens:80,thought_tokens:0,model:'gemini-3.5-flash-lite'}
test('Browser intake timings share admission, cannot override earlier measurements, and never control capacity',async()=>{
 const m=await material(),request=crypto.randomUUID(),intake=JSON.stringify({read_ms:125.2,upload_ms:500})
 const q=await rpc('enqueue_generation',[ids[0],request,m.doc,null,null,intake])
 await rpc('enqueue_generation',[ids[0],request,m.doc,null,null,JSON.stringify({read_ms:800,upload_ms:1000})])
 const row=(await db.query('select * from private.generation_queue where id=$1',[q.id])).rows[0];assert.equal(row.client_read_ms,125);assert.equal(row.client_upload_ms,500)
 assert.ok(!('client_read_ms' in q));assert.ok(!('client_upload_ms' in q))
 const other=await material();const malformed=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),other.doc,null,null,JSON.stringify({read_ms:-1,upload_ms:'bad'})])
 assert.equal(malformed.status,'queued','Bad optional diagnostics cannot reject legitimate study work')
 await assert.rejects(user(0,'select public.enqueue_generation($1,$2,$3,$4,$5,$6)',[ids[0],crypto.randomUUID(),m.doc,null,null,intake]),/permission denied/)
 assert.equal((await db.query('select max_parallel from private.generation_capacity')).rows[0].max_parallel,3)
})
test('Database lifecycle timings and worker reports are private, idempotent and safe after the next lease starts',async()=>{
 const m=await material(),q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null])
 await db.query("update private.generation_queue set updated_at=now()-interval '12 seconds',waiting_since=now()-interval '12 seconds' where id=$1",[q.id])
 const task=await rpc('claim_generation_task',[])
 await db.query("update private.generation_runs set reserved_at=clock_timestamp()-interval '0.7 seconds' where lease_token=$1",[task.lease_token])
 assert.equal(await rpc('record_generation_metrics',[q.id,task.lease_token,JSON.stringify(measured)]),false,'Undelivered tickets cannot submit a report')
 await rpc('start_generation_task',[q.id,task.lease_token]);await rpc('claim_queued_generation',[q.id,task.lease_token,m.id])
 await rpc('complete_queued_generation',[q.id,task.lease_token,JSON.stringify({notes:'# Complete source-based reviewer\nFIFO ordering and operations.'})])
 const next=await rpc('continue_generation_task',[q.id,task.lease_token]);assert.equal(next.stage,'deck')
 assert.equal(await rpc('record_generation_metrics',[q.id,task.lease_token,JSON.stringify(measured)]),true)
 assert.equal(await rpc('record_generation_metrics',[q.id,task.lease_token,JSON.stringify({...measured,gemini_calls:10})]),false)
 assert.equal(await rpc('record_generation_metrics',[crypto.randomUUID(),next.lease_token,JSON.stringify(measured)]),false)
 const saved=(await db.query('select * from private.generation_runs where lease_token=$1',[task.lease_token])).rows[0]
 assert.ok(saved.queue_wait_ms>=12000);assert.ok(saved.dispatch_wait_ms>=700);assert.equal(saved.gemini_calls,2);assert.equal(saved.outcome,'saved')
 assert.equal((await db.query('select lease_token from private.generation_queue where id=$1',[q.id])).rows[0].lease_token,next.lease_token)
 await assert.rejects(user(0,'select * from private.generation_runs'),/permission denied/)
 await assert.rejects(user(0,'select public.record_generation_metrics($1,$2,$3)',[q.id,next.lease_token,JSON.stringify(measured)]),/permission denied/)
 await assert.rejects(user(1,'select public.admin_generation_performance()'),/Admin access/)
 await db.query('insert into private.app_admins(user_id) values($1) on conflict do nothing',[ids[0]])
 const report=(await user(0,'select public.admin_generation_performance() as v')).rows[0].v
 assert.deepEqual(report.capacity,{overall:3,per_user:2});assert.equal(report.totals.measured,1);assert.equal(report.totals.draft_retries,1);assert.equal(report.totals.input_tokens,140)
 assert.ok(!JSON.stringify(report).includes(task.lease_token));assert.equal(report.recent.length,2)
})

test('Killed workers close their timing row without fabricated provider timings and recover automatically',async()=>{
 const m=await material(),q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null]),task=await rpc('claim_generation_task',[])
 await db.query("update private.generation_queue set lease_until=now()-interval '1 second' where id=$1",[q.id])
 assert.equal(await rpc('claim_generation_task',[]),null)
 const row=(await db.query('select * from private.generation_runs where lease_token=$1',[task.lease_token])).rows[0]
 assert.equal(row.outcome,'abandoned');assert.equal(row.gemini_ms,null);assert.ok(row.ended_at)
 const queued=(await db.query('select * from private.generation_queue where id=$1',[q.id])).rows[0];assert.equal(queued.status,'queued')
})

test('Automatic recovery keeps its waiting time and retry count when the stage attempt counter resets',async()=>{
 const m=await material(),q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null]),task=await rpc('claim_generation_task',[])
 await rpc('start_generation_task',[q.id,task.lease_token])
 await rpc('defer_generation_task',[q.id,task.lease_token,'Temporary service interruption',null,'Pause',false])
 await db.query("update private.generation_queue set waiting_since=clock_timestamp()-interval '3 minutes',auto_resume_at=clock_timestamp()-interval '1 second' where id=$1",[q.id])
 const recovered=await rpc('claim_generation_task',[]);assert.equal(recovered.id,q.id);assert.equal(recovered.attempts,1)
 const run=(await db.query('select * from private.generation_runs where lease_token=$1',[recovered.lease_token])).rows[0]
 assert.equal(run.is_retry,true);assert.ok(run.queue_wait_ms>=180000,'Two-minute automatic pauses must remain visible in queue timings')
})

test('Timing cleanup is bounded and preserves live work, sources and learning history',async()=>{
 const m=await material(),q=await rpc('enqueue_generation',[ids[0],crypto.randomUUID(),m.doc,null,null])
 await db.query("insert into private.generation_runs(lease_token,task_id,stage,attempt,reserved_at,outcome) select gen_random_uuid(),$1,'note',1,now()-interval '15 days','saved' from generate_series(1,1002)",[q.id])
 await db.query("insert into private.generation_runs(lease_token,task_id,stage,attempt,reserved_at,outcome) values(gen_random_uuid(),$1,'prepare',1,now()-interval '15 days','running')",[q.id])
 const report=(await user(0,'select public.admin_cleanup_preview() as v')).rows[0].v;assert.equal(report.timings,1001)
 const clean=(await user(0,'select public.admin_clean_records($1) as v',[['timings']])).rows[0].v;assert.equal(clean.timings,1000)
 assert.equal((await db.query('select count(*)::int n from private.generation_runs')).rows[0].n,3)
 assert.equal((await db.query('select source_text from public.study_materials where id=$1',[m.id])).rows[0].source_text.length>20,true)
 assert.equal((await db.query('select status from private.generation_queue where id=$1',[q.id])).rows[0].status,'queued')
})

test('Three overlapping worker requests complete two uploads for one user and one for another without duplicate sets',async()=>{
 const old={Deno:globalThis.Deno,fetch:globalThis.fetch,info:console.info}
 const bundle=await build({entryPoints:[fileURLToPath(new URL('../supabase/functions/generate-study/queue.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral'})
 const {runQueuedGeneration}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
 const materials=[]
 for(const [index,owner] of [0,0,1].entries()){
  const m=await material(owner);materials.push(m)
  await db.query('update public.study_materials set source_text=$2 where id=$1',[m.id,`Source_${index}: A queue preserves FIFO order. Enqueue adds at the rear; dequeue removes the front.`])
  await rpc('enqueue_generation',[ids[owner],crypto.randomUUID(),m.doc,null,null])
 }
 const tickets=[];for(let i=0;i<3;i++)tickets.push(await rpc('claim_generation_task',[]))
 assert.equal(tickets.filter(t=>t.user_id===ids[0]).length,2)
 let active=0,peak=0,firstCalls=0,release;const ready=new Promise(resolve=>release=resolve)
 const client={rpc:async(name,args={})=>{
  try{const entries=Object.entries(args),result=await backend('select to_jsonb(public.'+name+'('+entries.map(([key],i)=>key+'=>$'+(i+1)).join(',')+')) value',entries.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));return {data:result.rows[0].value}}
  catch(error){return {error:{message:error.message}}}
 }}
 globalThis.Deno={env:{get:key=>key==='GEMINI_API_KEY'?'simulation-key':'gemini-3.5-flash-lite'}};console.info=()=>{}
 globalThis.fetch=async(_url,request)=>{
  const payload=JSON.parse(request.body),index=payload.contents[0].parts[0].text.match(/Source_(\d)/)[1],prompt=payload.systemInstruction.parts[0].text
  active++;peak=Math.max(peak,active);firstCalls++
  try{
   if(firstCalls<=3){if(firstCalls===3)release();await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Parallel request admission stalled')),1500))])}
   const output=payload.generationConfig.responseMimeType==='text/plain'?`# Source ${index}\nFIFO keeps earlier arrivals first. Enqueue inserts at the rear and dequeue removes the front.`:prompt.includes('"flashcards"')?{flashcards:[{front:`What preserves the arrival order in Source_${index}?`,back:'Rear insertion and front removal preserve FIFO.',coverage_key:'queue:explain_fifo'}]}:{quiz:[{type:'short_answer',question:`Name the front removal operation in Source_${index}.`,answer:'Dequeue',options:[],accepted_answers:[],explanation:'Dequeue removes the oldest item from the front.',coverage_key:'queue:identify_dequeue'}]}
   return Response.json({usageMetadata:{promptTokenCount:100,candidatesTokenCount:60,thoughtsTokenCount:0},candidates:[{finishReason:'STOP',content:{parts:[{text:typeof output==='string'?output:JSON.stringify(output)}]}}]})
  }finally{active--}
 }
 try{
  await Promise.all(tickets.map(task=>runQueuedGeneration(client,{task_id:task.id,lease_token:task.lease_token})))
  for(let i=0;i<10;i++){
   const task=await rpc('claim_generation_task',[]);if(!task)break
   await runQueuedGeneration(client,{task_id:task.id,lease_token:task.lease_token})
  }
  assert.equal(peak,3,'Gemini IO overlaps across different materials; database locks are not held during it')
  for(const m of materials){assert.equal((await db.query('select count(*)::int n from public.study_assets where material_id=$1',[m.id])).rows[0].n,3);assert.equal((await db.query('select status from public.document_files where id=$1',[m.doc])).rows[0].status,'ready')}
  assert.equal((await db.query("select count(*)::int n from private.generation_queue where status<>'completed'")).rows[0].n,0)
  const report=(await user(0,'select public.admin_generation_performance() as v')).rows[0].v
  assert.equal(report.totals.measured,9);assert.equal(report.totals.draft_retries,0);assert.equal(report.totals.worker_retries,0);assert.equal(report.totals.input_tokens,900)
 }finally{console.info=old.info;for(const key of ['Deno','fetch']){if(old[key]===undefined)delete globalThis[key];else globalThis[key]=old[key]}}
})



