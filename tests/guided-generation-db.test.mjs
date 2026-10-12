import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
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
  const scan=await rpc('claim_material_analysis',[m.id,ids[0]])
  await rpc('finish_material_analysis',[m.id,ids[0],scan.token,JSON.stringify({title:'Queue methods',source_text:'A queue uses FIFO ordering. Enqueue adds at the rear and dequeue removes at the front.',topics:[{id:'topic-1',title:'Queue operations',description:'FIFO and operations',card_count:4,quiz_count:6}]})])
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
  for(const file of ['001_synapse.sql','003_study_refinements.sql','004_reviewer_accounts.sql','006_system_maintenance.sql','007_admin_email_type.sql','008_guided_generation.sql']) await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'))
  for(const [i,id] of ids.entries()) await db.query('insert into auth.users(id,email,email_confirmed_at,last_sign_in_at) values($1,$2,now(),now())',[id,`guided${i}@example.com`])
})
beforeEach(async()=>{await db.exec('delete from private.ai_usage')})
after(async()=>db.close())
test('Only authorized editors can scan, generate, read metadata, or create custom decks',async()=>{
  const m=await material()
  await assert.rejects(rpc('claim_material_generation',[m.id,ids[1],'deck','{}']),/Editor access/)
  await assert.rejects(user(1,'select public.material_generation_info($1)',[m.id]),/unavailable/)
  await assert.rejects(user(0,'select public.claim_material_generation($1,$2,$3,$4)',[m.id,ids[0],'note','{}']),/permission denied/)
  await assert.rejects(user(0,'select source_text from public.study_materials'),/permission denied/)
  await assert.rejects(backend('select public.claim_generation($1,$2)',[m.doc,ids[0]]),/permission denied/)
  await db.query("insert into public.folder_members(folder_id,user_id,role) values($1,$2,'viewer')",[m.folder.id,ids[1]])
  await assert.rejects(user(1,'select public.create_manual_deck($1,$2,$3)',[m.folder.id,'Custom','[{"front":"A","back":"B"}]']),/Editor access/)
  const metadata=(await user(1,'select public.material_generation_info($1) as value',[m.id])).rows[0].value
  assert.equal(metadata.topics.length,1);assert.equal(metadata.source_text,undefined)
})
test('Cached topic scans spend no requests; exact topic totals and manual quantities are enforced before claiming',async()=>{
  const m=await material(), initial=(await db.query('select requests from private.ai_usage where user_id=$1',[ids[0]])).rows[0].requests
  assert.equal((await rpc('claim_material_analysis',[m.id,ids[0]])).cached,true)
  assert.equal((await db.query('select requests from private.ai_usage where user_id=$1',[ids[0]])).rows[0].requests,initial)
  for(const opts of [{workflow:'manual'},{workflow:'manual',total:12},{workflow:'manual',total:10,true_false:4,multiple_choice:4,short_answer:4},{workflow:'topic',topic_id:'invented'}]) await assert.rejects(rpc('claim_material_generation',[m.id,ids[0],'quiz',JSON.stringify(opts)]),/Choose|add up|extracted/)
  const claim=await rpc('claim_material_generation',[m.id,ids[0],'quiz',JSON.stringify({workflow:'topic',topic_id:'topic-1',total:30,true_false:30})])
  assert.deepEqual([claim.options.total,claim.options.true_false,claim.options.multiple_choice,claim.options.short_answer],[6,2,2,2])
  const quiz=Array.from({length:6},(_,i)=>({type:['true_false','multiple_choice','short_answer'][i%3],question:'Question '+i,answer:'A',options:[],accepted_answers:[],explanation:'Explanation',coverage_key:'queue:facet_'+i}))
  const bad=structuredClone(quiz);bad[0].type='short_answer'
  await assert.rejects(rpc('complete_material_generation',[claim.job_id,ids[0],JSON.stringify({quiz:bad})]),/distribution/)
  const saved=await rpc('complete_material_generation',[claim.job_id,ids[0],JSON.stringify({quiz})])
  assert.equal(saved.data.length,6);assert.equal(saved.set_number,1)
})
test('Five reviewer/quiz and ten flashcard attempts include failures, block concurrency, and survive deleting a set',async()=>{
  const m=await material()
  for(const [kind,limit] of [['note',5],['quiz',5],['deck',10]]) {
    await db.exec('delete from private.ai_usage')
    const opts=kind==='note'?{}:{workflow:'topic',topic_id:'topic-1'}
    for(let i=0;i<limit;i++) {
      const claim=await rpc('claim_material_generation',[m.id,ids[0],kind,JSON.stringify(opts)])
      assert.equal(claim.attempt,i+1)
      await assert.rejects(rpc('claim_material_generation',[m.id,ids[0],kind,JSON.stringify(opts)]),/already generating/)
      if(kind==='note'&&i===0) {
        const asset=await rpc('complete_material_generation',[claim.job_id,ids[0],'{"notes":"A comprehensive explanation of queue operations."}'])
        await user(0,'delete from public.study_assets where id=$1',[asset.id])
      } else await rpc('fail_material_generation',[claim.job_id,ids[0],'Provider failed'])
    }
    await assert.rejects(rpc('claim_material_generation',[m.id,ids[0],kind,JSON.stringify(opts)]),/Generation limit reached/)
  }
  assert.deepEqual((await user(0,'select public.material_generation_info($1) as value',[m.id])).rows[0].value.usage,{note:5,deck:10,quiz:5})
})
test('Daily allowance denial rolls back a per-material claim instead of spending a generation attempt',async()=>{
  const m=await material()
  await db.query('update private.ai_usage set requests=20 where user_id=$1',[ids[0]])
  await assert.rejects(rpc('claim_material_generation',[m.id,ids[0],'note','{}']),/Daily limit reached/)
  assert.equal((await user(0,'select public.material_generation_info($1) as value',[m.id])).rows[0].value.usage.note,0)
  assert.equal((await db.query('select requests from private.ai_usage where user_id=$1',[ids[0]])).rows[0].requests,20)
})
test('The same re-uploaded bytes in a space reuse histories, topics, and limits',async()=>{
  const m=await material(), claim=await rpc('claim_material_generation',[m.id,ids[0],'note','{}'])
  await rpc('fail_material_generation',[claim.job_id,ids[0],'Network error'])
  const doc=crypto.randomUUID()
  await user(0,'insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) values($1,$2,$3,$4,$5,$6,$7)',[doc,m.folder.id,ids[0],'new-name.txt',m.folder.id+'/'+ids[0]+'/'+doc+'.txt','text/plain',30])
  assert.equal((await rpc('bind_generation_source',[doc,ids[0],m.hash])).id,m.id)
  assert.equal((await rpc('claim_material_analysis',[m.id,ids[0]])).cached,true)
  assert.equal((await user(0,'select public.material_generation_info($1) as value',[m.id])).rows[0].value.usage.note,1)
})
test('Duplicate questions and coverage keys fail atomically and remain blocked after the earlier set is deleted',async()=>{
  const m=await material(), opts=JSON.stringify({workflow:'topic',topic_id:'topic-1'})
  const cards=Array.from({length:4},(_,i)=>({front:'Define queue facet '+i,back:'Definition '+i,coverage_key:'queue:facet_'+i}))
  let claim=await rpc('claim_material_generation',[m.id,ids[0],'deck',opts])
  const saved=await rpc('complete_material_generation',[claim.job_id,ids[0],JSON.stringify({flashcards:cards})])
  await user(0,'delete from public.study_assets where id=$1',[saved.id])
  claim=await rpc('claim_material_generation',[m.id,ids[0],'deck',opts])
  const repeated=structuredClone(cards);repeated[0].front='DEFINE QUEUE FACET 0!';repeated[0].coverage_key='a:new_key'
  await assert.rejects(rpc('complete_material_generation',[claim.job_id,ids[0],JSON.stringify({flashcards:repeated})]),/repeated/)
  repeated[0].front='Different wording';repeated[0].coverage_key='queue:facet_0'
  await assert.rejects(rpc('complete_material_generation',[claim.job_id,ids[0],JSON.stringify({flashcards:repeated})]),/repeated/)
  assert.equal((await db.query("select count(*) as n from private.material_history where material_id=$1 and kind='deck'",[m.id])).rows[0].n,4)
})
test('Maintenance prunes temporary jobs while preserving source counters, questions, and saved sets',async()=>{
  const m=await material(), claim=await rpc('claim_material_generation',[m.id,ids[0],'note','{}'])
  const saved=await rpc('complete_material_generation',[claim.job_id,ids[0],'{"notes":"The complete saved reviewer remains after its job record is pruned."}'])
  await db.query("update private.material_jobs set created_at=now()-interval '31 days' where id=$1",[claim.job_id])
  const result=await rpc('prune_maintenance_records',[])
  assert.equal(result.old_generation_jobs,1)
  assert.equal((await user(0,'select public.material_generation_info($1) as value',[m.id])).rows[0].value.usage.note,1)
  assert.equal((await db.query('select count(*) as n from private.material_history where material_id=$1',[m.id])).rows[0].n,1)
  assert.equal((await db.query('select count(*) as n from public.study_assets where id=$1',[saved.id])).rows[0].n,1)
})
test('Manual decks spend no AI requests and both metadata and bucket accept at most 20 MB',async()=>{
  const m=await material(), before=(await db.query('select requests from private.ai_usage where user_id=$1',[ids[0]])).rows[0].requests
  const deck=(await user(0,'select to_jsonb(public.create_manual_deck($1,$2,$3)) as value',[m.folder.id,' My cards ','[{"front":"What is FIFO?","back":"First in, first out."}]'])).rows[0].value
  assert.equal(deck.title,'My cards');assert.equal(deck.material_id,null)
  assert.equal((await db.query('select requests from private.ai_usage where user_id=$1',[ids[0]])).rows[0].requests,before)
  await assert.rejects(user(0,'select public.create_manual_deck($1,$2,$3)',[m.folder.id,'Cards','[{"front":"No answer","back":""}]']),/question and answer/)
  await db.query('update public.document_files set size_bytes=20971520 where id=$1',[m.doc])
  await assert.rejects(db.query('update public.document_files set size_bytes=20971521 where id=$1',[m.doc]),/size_bytes_check/)
  assert.equal(Number((await db.query("select file_size_limit from storage.buckets where id='study-files'")).rows[0].file_size_limit),20971520)
  await db.query('delete from auth.users where id=$1',[ids[0]])
  assert.equal((await db.query('select count(*) as n from public.study_materials')).rows[0].n,0)
  assert.equal((await db.query('select count(*) as n from private.material_history')).rows[0].n,0)
})
