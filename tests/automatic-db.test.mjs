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

const cards=(prefix='first',count=4)=>({flashcards:Array.from({length:count},(_,i)=>({front:prefix+' distinctive question '+i,back:'A source-supported answer.',coverage_key:prefix+':facet_'+i}))})
const quiz=()=>({quiz:[{type:'true_false',question:'Is a queue FIFO?',options:['True','False'],answer:'True',accepted_answers:[],explanation:'Oldest items are removed first.',coverage_key:'queue:fifo'},...Array.from({length:4},(_,i)=>({type:'short_answer',question:'Name source operation '+i,options:[],answer:'Enqueue',accepted_answers:[],explanation:'Adds an item at the rear.',coverage_key:'queue:operation_'+i}))]})
async function save(m,kind,output,initial=true) {const job=await rpc('claim_auto_generation',[m.id,ids[0],kind,initial]);return rpc('complete_auto_generation',[job.job_id,ids[0],JSON.stringify(output)])}
test('Source preparation recovers old failed scans without a topic inventory, and service calls retain editor permissions',async()=>{
 const m=await material()
 await db.query("update public.study_materials set source_text='',analysis_status='failed',analysis_attempts=3 where id=$1",[m.id])
 const scan=await rpc('claim_auto_source',[m.id,ids[0]]);assert.equal(scan.cached,false)
 await assert.rejects(rpc('claim_auto_source',[m.id,ids[0]]),/already being prepared/)
 await assert.rejects(rpc('retain_auto_source',[m.id,ids[0],'Valid text about queues and their FIFO structure.',crypto.randomUUID()]),/expired/)
 await rpc('retain_auto_source',[m.id,ids[0],'Valid text about queues and their FIFO structure.',scan.token])
 assert.equal((await rpc('claim_auto_source',[m.id,ids[0]])).cached,true)
 await assert.rejects(rpc('claim_auto_generation',[m.id,ids[1],'note',false]),/Editor access/)
 await assert.rejects(user(0,'select public.claim_auto_generation($1,$2,$3,$4)',[m.id,ids[0],'note',false]),/permission denied/)
 await assert.rejects(user(0,'select public.my_seed_balance()'),/permission denied/)
})
test('An upload saves all three AI-sized formats, marks the document ready, and resumes without duplicates or Seed charges',async()=>{
 const m=await material()
 await db.query('insert into private.seed_usage values($1,private.seed_day(),30)',[ids[0]])
 const note=await save(m,'note',{notes:'# Comprehensive reviewer\nPrecise terminology and full explanations.'})
 const deck=await save(m,'deck',cards())
 const practice=await save(m,'quiz',quiz())
 assert.equal(deck.data.length,4);assert.equal(practice.data.length,5)
 assert.equal((await db.query('select status from public.document_files where id=$1',[m.doc])).rows[0].status,'ready')
 const before=(await db.query('select count(*)::int n from private.material_jobs where material_id=$1',[m.id])).rows[0].n
 for(const [kind,asset] of [['note',note],['deck',deck],['quiz',practice]])assert.equal((await rpc('claim_auto_generation',[m.id,ids[0],kind,true])).existing_asset_id,asset.id)
 assert.equal((await db.query('select count(*)::int n from private.material_jobs where material_id=$1',[m.id])).rows[0].n,before)
 assert.equal((await db.query('select spent from private.seed_usage where user_id=$1',[ids[0]])).rows[0].spent,30)
})
test('One-click refresh appends fresh numbered sets, blocks repeated facets atomically, and keeps old sets and progress',async()=>{
 const m=await material(),first=await save(m,'deck',cards())
 await user(0,"select public.review_card($1,0,3)",[first.id])
 const job=await rpc('claim_auto_generation',[m.id,ids[0],'deck',false])
 assert.equal(job.previous.length,4)
 const mixed=cards('new');mixed.flashcards[1]=cards().flashcards[1]
 await assert.rejects(rpc('complete_auto_generation',[job.job_id,ids[0],JSON.stringify(mixed)]),/repeated/)
 assert.equal((await db.query('select count(*)::int n from private.material_history where material_id=$1',[m.id])).rows[0].n,4)
 await rpc('fail_material_generation',[job.job_id,ids[0],'Duplicate rejected'])
 const second=await save(m,'deck',cards('second',6),false)
 assert.equal(second.series_id,first.series_id);assert.equal(second.set_number,2);assert.equal(second.data.length,6)
 assert.equal((await db.query('select count(*)::int n from public.study_assets where material_id=$1',[m.id])).rows[0].n,2)
 assert.equal((await db.query('select count(*)::int n from public.flashcard_progress where asset_id=$1',[first.id])).rows[0].n,1)
})
test('Simultaneous work is denied, malformed answers cannot be saved, and custom card management remains available',async()=>{
 const m=await material(),job=await rpc('claim_auto_generation',[m.id,ids[0],'quiz',false])
 await assert.rejects(rpc('claim_auto_generation',[m.id,ids[0],'note',false]),/already generating/)
 const bad=quiz();bad.quiz[0].answer='Unknown'
 await assert.rejects(rpc('complete_auto_generation',[job.job_id,ids[0],JSON.stringify(bad)]),/True\/False answer/)
 await rpc('fail_material_generation',[job.job_id,ids[0],'Invalid output'])
 const custom=(await user(0,'select to_jsonb(public.create_manual_deck($1,$2,$3)) as deck',[m.folder.id,'My cards',JSON.stringify([{front:'My own question',back:'My own answer'}])])).rows[0].deck
 const result=(await user(0,'select public.update_custom_card($1,$2,$3,$4,false) as value',[custom.id,custom.data[0].id,'Edited question','Edited answer'])).rows[0].value
 assert.equal(result.asset.data[0].front,'Edited question')
})

test('The reliability migration supports six consecutive numbered sets per format and valid small sets',async()=>{
 const m=await material()
 for(const kind of ['note','deck','quiz']){
  const variants=[]
  for(let n=1;n<=6;n++){
   const claim=await rpc('claim_auto_generation',[m.id,ids[0],kind,n===1])
   assert.equal(claim.options.set_number,n);variants.push(claim.options.variant)
   const output=kind==='note'?{notes:'# Treatment '+n+'\nDetailed source-supported explanation '+n+'.'}:kind==='deck'?cards('treatment-'+n,1):{quiz:[{type:'short_answer',question:'Distinct reasoning task '+n,options:[],answer:'Enqueue',accepted_answers:[],explanation:'It inserts an item at the rear.',coverage_key:'queue:reasoning_'+n}]}
   const result=await rpc('complete_auto_generation',[claim.job_id,ids[0],JSON.stringify(output)])
   assert.equal(result.set_number,n)
   assert.equal(result.generation_options.set_number,n)
  }
  assert.equal(new Set(variants).size,6)
 }
 assert.equal((await db.query('select count(*)::int n from public.study_assets where material_id=$1',[m.id])).rows[0].n,18)
 assert.equal((await db.query('select status from public.document_files where id=$1',[m.doc])).rows[0].status,'ready')
})

test('Rejected draft transactions roll back completely and the same generation claim can save a corrected draft',async()=>{
 const m=await material(),first=await save(m,'deck',cards('original',1))
 const job=await rpc('claim_auto_generation',[m.id,ids[0],'deck',false])
 const bad=cards('replacement',2);bad.flashcards[1]=cards('original',1).flashcards[0]
 await assert.rejects(rpc('complete_auto_generation',[job.job_id,ids[0],JSON.stringify(bad)]),/repeated/)
 assert.equal((await db.query('select count(*)::int n from private.material_history where material_id=$1',[m.id])).rows[0].n,1)
 assert.equal((await db.query('select status from private.material_jobs where id=$1',[job.job_id])).rows[0].status,'processing')
 const corrected=await rpc('complete_auto_generation',[job.job_id,ids[0],JSON.stringify(cards('corrected',2))])
 assert.equal(corrected.set_number,2);assert.equal(corrected.series_id,first.series_id)
 assert.equal((await db.query('select count(*)::int n from private.material_history where material_id=$1',[m.id])).rows[0].n,3)
 await assert.rejects(rpc('complete_auto_generation',[job.job_id,ids[0],JSON.stringify(cards('again',1))]),/missing or expired/)
})

test('Full deployed handler: first upload plus five consecutive Generate actions for all formats recover alternating AI defects',async()=>{
 const m=await material(),old={Deno:globalThis.Deno,fetch:globalThis.fetch,__synapseReliableClient:globalThis.__synapseReliableClient}
 const source='A queue preserves FIFO ordering. Enqueue adds at the rear, dequeue removes at the front, and peek reads the front without removal. A stack preserves LIFO ordering: push adds at the top and pop removes the top. A bounded container checks capacity before insertion and emptiness before removal. Insertion sort grows a sorted prefix by inserting the next element into its correct position. It is stable when equal items keep their relative order.'
 const pdf=new Blob(['%PDF-1.7 mock provider input'],{type:'application/pdf'})
 await db.query("update public.study_materials set source_text='',source_hash=null where id=$1",[m.id])
 await db.query("update public.document_files set mime_type='application/pdf',size_bytes=$2,status='processing' where id=$1",[m.doc,pdf.size])
 let handler,current=null,scanDrafts=0,claimCount=0,draftCount=0,downloads=0,permanent=false,quizThrottled=false
 const outputs={note:[],deck:[],quiz:[]},callCounts=[],env={SUPABASE_URL:'https://mock.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'mock-server-only',GEMINI_API_KEY:'mock-only',ALLOWED_ORIGINS:'http://localhost:5173',CRON_SECRET:'test-worker-secret-long'}
 const rows=[
  [ ['What is FIFO ordering?','The earliest remaining arrival is removed first.','queue:fifo_definition'],['What does a stack pop remove?','The top item.','stack:pop_definition'],['What is a sorted prefix?','The leading part of the array already in sorted order.','sort:prefix_definition'] ],
  [ ['Enqueue A then B, remove once and enqueue C. Which item is now at the front?','B remains the front after A is removed.','queue:trace_interleaved_operations'],['Push X then Y and pop once. Which item becomes the top?','X becomes the top after Y is removed.','stack:trace_remaining_top'],['Insert 2 into the sorted prefix [1,4]. What is the result?','[1,2,4].','sort:insert_into_prefix'] ],
  [ ['Compare the removal order of a queue and stack after inserting A then B.','The queue removes A before B; the stack removes B before A.','queue:compare_queue_stack_order'],['How does peek differ from pop in its effect on a stack?','Peek reads the top while pop removes it.','stack:compare_peek_pop'],['How do stability and sorted order differ?','Sorted order arranges values; stability also preserves the relative order of equal values.','sort:compare_stability_order'] ],
  [ ['A student dequeues B first after enqueueing A then B. What rule did the student violate?','FIFO requires A to leave first.','queue:diagnose_wrong_front'],['Someone removes the bottom item using pop. What is the error?','Pop must remove the accessible top item.','stack:diagnose_bottom_removal'],['A sort reverses two equal items. Which property is lost?','Stability.','sort:diagnose_equal_item_reversal'] ],
  [ ['Why does adding C at the rear leave A at the front of a queue containing A then B?','Rear insertion preserves the arrival order of the remaining earlier items.','queue:reason_rear_insertion_preserves_front'],['When undoing the most recent action first, why is LIFO useful?','It makes the latest stored action the first available for removal.','stack:apply_lifo_undo'],['Why would preserving the arrival order of equal records require a stable sort?','Stability retains the original relative order of equal values.','sort:apply_stability_equal_records'] ],
  [ ['Explain how rear insertion and front removal together establish FIFO.','New arrivals follow existing items; removal always selects the earliest remaining item.','queue:justify_two_operation_invariant'],['Which boundary must a pop check, and why?','Emptiness: a removal requires an existing top item.','stack:justify_pop_empty_check'],['Why does inserting into the sorted prefix grow that prefix by one element?','The next element is placed correctly among the previously sorted elements.','sort:justify_prefix_growth'] ],
 ]
 const noteTreatments=[
  'Foundations: define each operation and compare arrival order with removal order. Queue operations act at opposite ends; stack operations act at the same accessible top. Insertion sort extends the sorted prefix rather than reordering an unrelated part of the sequence.',
  'Worked applications: enqueue A then B, remove A, then enqueue C. The queue now has B followed by C. Push X then Y into a stack and pop Y; X is left at the top. Insert 2 into [1,4] to obtain [1,2,4], extending the sorted prefix by one.',
  'Connections: both queue and stack support insertion and removal, but their accessible positions produce different orderings. Peek differs from removal because it leaves the number of stored items unchanged. Sorting by value and preserving equal-item order answer different questions.',
  'Error diagnosis: taking B before A from a queue reverses the required arrival order. Removing the bottom instead of the top violates the stack operation. Reversing equal records destroys sorting stability even when the resulting values are still ordered.',
  'Transfer: a waiting-line illustration uses FIFO to keep earlier arrivals accessible first, while an undo illustration uses LIFO to reach the latest stored action. Stable sorting is useful when equal records must retain their previous relative order; no additional sorting rule is needed.',
  'Justification and synthesis: rear insertion leaves earlier queue arrivals in front, so front removal maintains FIFO. Stack removal instead selects the latest top. The empty check answers whether removal is possible; the capacity check answers whether another insertion is possible. Correct insertion into the sorted prefix preserves its order.',
 ]
 const client={auth:{getUser:async token=>({data:{user:token==='valid'?{id:ids[0]}:null},error:null})},storage:{from:()=>({download:async()=>{downloads++;return {data:pdf,error:null}}})},from:table=>{
  let id,values
  const query={select(){return this},eq(key,value){if(key==='id')id=value;return this},update(value){values=value;return this},async single(){return {data:(await backend('select * from public.'+table+' where id=$1',[id])).rows[0],error:null}},then(resolve,reject){return backend('update public.document_files set status=$2,error_message=$3 where id=$1',[id,values.status,values.error_message]).then(value=>resolve({data:value.rows,error:null}),reject)}}
  return query
 },rpc:async(name,args={})=>{
  try{
   const entries=Object.entries(args)
   const result=await backend('select to_jsonb(public.'+name+'('+entries.map(([key],i)=>key+'=>$'+(i+1)).join(',')+')) value',entries.map(([,value])=>value&&typeof value==='object'?JSON.stringify(value):value))
   const value=result.rows[0].value
   if(name==='claim_queued_generation'&&!value.existing_asset_id){claimCount++;draftCount=0;current={kind:value.kind,claim:value}}
   return {data:value,error:null}
  }catch(error){return {data:null,error:{message:error.message}}}
 }}
 globalThis.__synapseReliableClient=()=>client
 globalThis.Deno={env:{get:key=>env[key]},serve:fn=>handler=fn}
 globalThis.fetch=async(_url,request)=>{
  const payload=JSON.parse(request.body),prompt=payload.systemInstruction.parts[0].text
  if(permanent){draftCount++;return Response.json({error:{status:'INVALID_ARGUMENT',message:'Mock configuration error.'}},{status:400})}
  if(!current){
   scanDrafts++
   if(scanDrafts===1)return Response.json({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'Partial extraction'}]}}]})
   assert.match(prompt,/DRAFT REVISION/)
   return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:source}]}}]})
  }
  if(current.kind==='quiz' && current.claim.options.set_number===1 && !quizThrottled){quizThrottled=true;return Response.json({error:{status:'RESOURCE_EXHAUSTED',message:'Temporary per-minute limit'}},{status:429})}
  draftCount++
  const {kind,claim}=current,n=claim.options.set_number
  assert.ok(prompt.includes(claim.options.variant));assert.ok(prompt.includes('saved set '+n))
  if(draftCount===1){
   if(kind==='note')return Response.json({candidates:[{finishReason:n===1?'MAX_TOKENS':'STOP',content:{parts:[{text:n===1?'Partial reviewer':outputs.note[0]}]}}]})
   if(kind==='quiz'&&n===1)return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"quiz":['}]}}]})
   const bad=n===1?{flashcards:[{front:'Incomplete card with no answer.'}]}:outputs[kind][0]
   return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(bad)}]}}]})
  }
  assert.equal(draftCount,2);assert.match(prompt,/DRAFT REVISION/)
  const items=rows[n-1]
  const output=kind==='note'?'# '+claim.options.variant+'\n\n## Key terms\n'+source+'\n\n## Study treatment\n'+noteTreatments[n-1]:kind==='deck'?{flashcards:items.map(([front,back,coverage_key])=>({front,back,coverage_key}))}:{quiz:items.map(([question,answer,coverage_key])=>({type:'short_answer',question,answer,options:[],accepted_answers:[],explanation:answer,coverage_key}))}
  outputs[kind].push(output)
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:typeof output==='string'?output:JSON.stringify(output)}]}}]})
 }
 try{
  const bundle=await build({entryPoints:[fileURLToPath(new URL('../supabase/dashboard/generate-study.ts',import.meta.url))],bundle:true,write:false,platform:'neutral',format:'esm',external:['npm:*']})
  await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text.replace(/^import.*from "npm:.*";$/m,'const createClient=globalThis.__synapseReliableClient;')).toString('base64'))
  const request=body=>new Request('https://mock/generate-study',{method:'POST',headers:{Origin:'http://localhost:5173',Authorization:'Bearer valid','Content-Type':'application/json'},body:JSON.stringify(body)})
  await db.exec('update private.generation_capacity set scheduler_ready=true')
  const work=async()=>{
   const task=await rpc('claim_generation_task',[]);assert.ok(task)
   const response=await handler(new Request('https://mock/generate-study',{method:'POST',headers:{'x-cron-secret':env.CRON_SECRET,'Content-Type':'application/json'},body:JSON.stringify({task_id:task.id,lease_token:task.lease_token})}))
   assert.equal(response.status,200,JSON.stringify(await response.json()))
   return task
  }
  const enqueue=async target=>{
   const response=await handler(request({action:'enqueue',request_id:crypto.randomUUID(),...target}))
   assert.equal(response.status,202);return (await response.json()).task
  }
  const initial=await enqueue({document_id:m.doc})
  await work();assert.equal(scanDrafts,2);assert.equal(downloads,1)
  const first={}
  for(const kind of ['note','deck','quiz']){
   await work()
   if(kind==='quiz'){
    const waiting=(await db.query('select status,stage,completed_kinds from private.generation_queue where id=$1',[initial.id])).rows[0]
    assert.equal(waiting.status,'queued');assert.equal(waiting.stage,'quiz');assert.deepEqual(waiting.completed_kinds,['note','deck'])
    assert.equal((await db.query('select count(*)::int n from public.study_assets where material_id=$1',[m.id])).rows[0].n,2)
    await db.exec('update private.generation_capacity set cooldown_until=null');await db.query('update private.generation_queue set available_at=now() where id=$1',[initial.id])
    await work()
   }
   const asset=(await db.query('select * from public.study_assets where material_id=$1 and kind=$2',[m.id,kind])).rows[0]
   assert.equal(asset.set_number,1);first[kind]=asset.id;callCounts.push(draftCount)
  }
  assert.equal((await db.query('select status from private.generation_queue where id=$1',[initial.id])).rows[0].status,'completed')
  await user(0,'select public.review_card($1,0,3)',[first.deck])
  for(let click=1;click<=5;click++)for(const kind of ['note','deck','quiz']){
   const queued=await enqueue({asset_id:first[kind]})
   await work();await work()
   const task=(await db.query('select * from private.generation_queue where id=$1',[queued.id])).rows[0]
   assert.equal(task.status,'completed',kind+', click '+click+': '+task.last_error)
   const asset=(await db.query('select set_number from public.study_assets where id=$1',[task.result_asset_id])).rows[0]
   assert.equal(asset.set_number,click+1);callCounts.push(draftCount)
  }
  assert.equal(claimCount,19);assert.deepEqual(callCounts,Array(18).fill(2));assert.equal(downloads,1)
  assert.equal((await db.query('select count(*)::int n from public.study_assets where material_id=$1',[m.id])).rows[0].n,18)
  assert.equal((await db.query("select count(*)::int n from private.material_jobs where material_id=$1 and status='completed'",[m.id])).rows[0].n,18)
  assert.equal((await db.query('select count(*)::int n from public.flashcard_progress where asset_id=$1',[first.deck])).rows[0].n,1)
  assert.equal((await db.query('select status from public.document_files where id=$1',[m.doc])).rows[0].status,'ready')
  // Configuration failures remain clear and do not burn three provider calls.
  permanent=true
  const paused=await enqueue({asset_id:first.deck});await work();await work()
  const rejected=(await db.query('select status,message,last_error from private.generation_queue where id=$1',[paused.id])).rows[0]
  assert.equal(rejected.status,'paused');assert.match(rejected.last_error,/400 INVALID_ARGUMENT/)
  assert.match(rejected.message,/app owner/)
  assert.equal(draftCount,1)
  assert.equal((await db.query('select count(*)::int n from public.study_assets where material_id=$1',[m.id])).rows[0].n,18)
 }finally{for(const [key,value] of Object.entries(old)){if(value===undefined)delete globalThis[key];else globalThis[key]=value}}
})
