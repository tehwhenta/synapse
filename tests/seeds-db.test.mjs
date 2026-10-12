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
  await rpc('finish_material_analysis',[m.id,ids[0],scan.token,JSON.stringify({title:'Queue methods',source_text:'A queue uses FIFO ordering. Enqueue adds at the rear and dequeue removes at the front.',topics:[{id:'topic-1',title:'Queue operations',description:'FIFO and operations',card_count:10,quiz_count:12,concepts:Array.from({length:80},(_,i)=>({id:'topic-1:concept-'+(i+1),label:'Distinct queue facet '+i,covered_by:[]}))}]})])
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
  for(const file of ['001_synapse.sql','003_study_refinements.sql','004_reviewer_accounts.sql','006_system_maintenance.sql','007_admin_email_type.sql','008_guided_generation.sql','009_seeds_and_custom_cards.sql']) await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'))
  for(const [i,id] of ids.entries()) await db.query('insert into auth.users(id,email,email_confirmed_at,last_sign_in_at) values($1,$2,now(),now())',[id,`guided${i}@example.com`])
})
beforeEach(async()=>{await db.exec('delete from private.ai_usage;delete from private.seed_usage')})
after(async()=>db.close())
const balance=async(i=0)=>(await user(i,'select public.my_seed_balance() as value')).rows[0].value
test('Each account gets 30 Seeds; 30 claimed generations can spend them, failures count, and the 31st is blocked',async()=>{
 const m=await material();assert.equal((await balance()).remaining,30);assert.equal((await balance(1)).remaining,30)
 for(let i=0;i<30;i++) {const claim=await rpc('claim_material_generation',[m.id,ids[0],'note','{}']);await rpc('fail_material_generation',[claim.job_id,ids[0],'Provider failed']);assert.equal((await balance()).remaining,29-i)}
 await assert.rejects(rpc('claim_material_generation',[m.id,ids[0],'note','{}']),/No Seeds left/)
 assert.equal((await balance(1)).remaining,30)
 await assert.rejects(user(0,'update private.seed_usage set spent=0'),/permission denied/)
})
test('The Philippine midnight boundary resets the allowance without a cron or client clock',async()=>{
 const m=await material()
 await db.exec("create or replace function private.seed_day() returns date language sql stable set search_path='' as $$ select (timestamptz '2026-10-12 15:59:59+00' at time zone 'Asia/Manila')::date $$")
 const claim=await rpc('claim_material_generation',[m.id,ids[0],'note','{}']);await rpc('fail_material_generation',[claim.job_id,ids[0],'Failure'])
 assert.equal((await balance()).remaining,29);assert.equal(new Date((await balance()).reset_at).toISOString(),'2026-10-12T16:00:00.000Z')
 await db.exec("create or replace function private.seed_day() returns date language sql stable set search_path='' as $$ select (timestamptz '2026-10-12 16:00:00+00' at time zone 'Asia/Manila')::date $$")
 assert.equal((await balance()).remaining,30)
 await db.exec("create or replace function private.seed_day() returns date language sql stable set search_path='' as $$ select (now() at time zone 'Asia/Manila')::date $$")
})
test('Validation, permission, and overlapping-request denials do not spend Seeds',async()=>{
 const m=await material()
 await assert.rejects(rpc('claim_material_generation',[m.id,ids[1],'note','{}']),/Editor access/)
 await assert.rejects(rpc('claim_material_generation',[m.id,ids[0],'quiz','{"workflow":"manual","total":10,"true_false":9,"multiple_choice":9,"short_answer":9}']),/add up/)
 assert.equal((await balance()).remaining,30)
 const claim=await rpc('claim_material_generation',[m.id,ids[0],'note','{}'])
 await assert.rejects(rpc('claim_material_generation',[m.id,ids[0],'note','{}']),/already generating/)
 assert.equal((await balance()).remaining,29);await rpc('fail_material_generation',[claim.job_id,ids[0],'Cancelled'])
})
test('Upload metadata cannot point the privileged generation handler at another folder path',async()=>{
 const m=await material(),doc=crypto.randomUUID()
 await assert.rejects(user(0,'insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) values($1,$2,$3,$4,$5,$6,$7)',[doc,m.folder.id,ids[0],'fake.txt',crypto.randomUUID()+'/'+ids[0]+'/'+doc+'.txt','text/plain',30]),/document_files_check/)
 const source=await rpc('generation_source',[m.doc,ids[0]]);assert.equal(source.document.id,m.doc)
})
test('Reviewer coverage prevents another redundant reviewer but leaves flashcards and quizzes available',async()=>{
 const m=await material(),claim=await rpc('claim_material_generation',[m.id,ids[0],'note','{}'])
 await assert.rejects(rpc('complete_material_generation',[claim.job_id,ids[0],JSON.stringify({notes:'Complete notes',covered_concepts:['invented-id']})]),/coverage/)
 const a=await rpc('complete_material_generation',[claim.job_id,ids[0],JSON.stringify({notes:'A complete explanation of every source concept.',covered_concepts:claim.options.concept_ids})])
 await assert.rejects(rpc('claim_material_generation',[m.id,ids[0],'note','{}']),/covered everything/)
 assert.equal((await balance()).remaining,29)
 const info=(await user(0,'select public.material_generation_info($1) as value',[m.id])).rows[0].value
 assert.equal(info.remaining.note,0);assert.equal(info.remaining.deck,80);assert.equal(info.exhausted,false)
 await user(0,'delete from public.study_assets where id=$1',[a.id])
 await assert.rejects(rpc('claim_material_generation',[m.id,ids[0],'note','{}']),/covered everything/)
})
test('Only inventoried unspent concepts can be saved; rejected sets do not partially mark coverage',async()=>{
 const m=await material(),claim=await rpc('claim_material_generation',[m.id,ids[0],'deck','{"workflow":"manual","total":10}'])
 const cards=claim.concepts.slice(0,10).map((c,i)=>({front:'Question facet '+String.fromCharCode(97+i),back:'Answer '+i,concept_id:c.id}))
 const bad=structuredClone(cards);bad[1].concept_id='invented'
 await assert.rejects(rpc('complete_material_generation',[claim.job_id,ids[0],JSON.stringify({flashcards:bad})]),/invented/)
 assert.equal((await db.query('select count(*) as n from private.material_coverage where material_id=$1',[m.id])).rows[0].n,0)
 const a=await rpc('complete_material_generation',[claim.job_id,ids[0],JSON.stringify({flashcards:cards})])
 await user(0,'delete from public.study_assets where id=$1',[a.id])
 const next=await rpc('claim_material_generation',[m.id,ids[0],'deck','{"workflow":"topic","topic_id":"topic-1"}'])
 assert.equal(next.concepts.some(c=>cards.some(old=>old.concept_id===c.id)),false)
 assert.equal(next.options.total,10)
})
test('Custom edits reset only the changed card; deletion remaps remaining schedules for every user',async()=>{
 const m=await material()
 await db.query("insert into public.folder_members(folder_id,user_id,role) values($1,$2,'viewer')",[m.folder.id,ids[1]])
 const a=(await user(0,'select to_jsonb(public.create_manual_deck($1,$2,$3)) as value',[m.folder.id,'Custom cards',JSON.stringify([{front:'First?',back:'First.'},{front:'Second?',back:'Second.'},{front:'Third?',back:'Third.'}])])).rows[0].value
 assert.equal(a.is_custom,true);assert.ok(a.data.every(c=>c.id));assert.equal((await balance()).remaining,30)
 for(const i of [0,1])for(const index of [0,1,2])await user(i,'select public.review_card($1,$2,3)',[a.id,index])
 await assert.rejects(user(1,'select public.update_custom_card($1,$2,$3,$4,false)',[a.id,a.data[1].id,'Changed?','Changed.']),/Editor access/)
 await assert.rejects(user(0,'update public.study_assets set data=$2 where id=$1',[a.id,'[]']),/permission denied/)
 let result=(await user(0,'select public.update_custom_card($1,$2,$3,$4,false) as value',[a.id,a.data[1].id,'Changed question?','Changed answer.'])).rows[0].value
 assert.equal(result.asset.data[1].front,'Changed question?')
 assert.equal((await db.query('select count(*) as n from public.flashcard_progress where asset_id=$1 and card_index=1',[a.id])).rows[0].n,0)
 for(const i of [0,1])await user(i,'select public.review_card($1,1,3)',[a.id])
 result=(await user(0,'select public.update_custom_card($1,$2,null,null,true) as value',[a.id,a.data[0].id])).rows[0].value
 assert.equal(result.asset.data.length,2);assert.equal(result.asset.data[0].id,a.data[1].id)
 const rows=(await db.query('select user_id,card_index from public.flashcard_progress where asset_id=$1 order by user_id,card_index',[a.id])).rows
 assert.deepEqual(rows.map(r=>r.card_index),[0,1,0,1])
 await user(0,'select public.update_custom_card($1,$2,null,null,true)',[a.id,a.data[1].id])
 const last=(await user(0,'select public.update_custom_card($1,$2,null,null,true) as value',[a.id,a.data[2].id])).rows[0].value
 assert.equal(last.deleted_deck,true);assert.equal((await db.query('select count(*) as n from public.flashcard_progress where asset_id=$1',[a.id])).rows[0].n,0)
 assert.equal((await balance()).remaining,30)
})
test('Finishing every usable format closes a file before charging; re-uploading or deleting sets does not reopen coverage',async()=>{
 const m=await material()
 let claim=await rpc('claim_material_generation',[m.id,ids[0],'note','{}'])
 await rpc('complete_material_generation',[claim.job_id,ids[0],JSON.stringify({notes:'All source concepts explained in full.',covered_concepts:claim.options.concept_ids})])
 for(let set=0;set<8;set++) {
  claim=await rpc('claim_material_generation',[m.id,ids[0],'deck','{"workflow":"manual","total":10}'])
  const flashcards=claim.concepts.slice(0,10).map((c,i)=>({front:`Deck item ${set}-${i}`,back:'Source answer.',concept_id:c.id}))
  await rpc('complete_material_generation',[claim.job_id,ids[0],JSON.stringify({flashcards})])
 }
 for(let set=0;set<4;set++) {
  claim=await rpc('claim_material_generation',[m.id,ids[0],'quiz','{"workflow":"manual","total":20,"true_false":7,"multiple_choice":7,"short_answer":6}'])
  const quiz=claim.concepts.slice(0,20).map((c,i)=>({type:i<7?'true_false':i<14?'multiple_choice':'short_answer',question:`Quiz item ${set}-${i}`,answer:'A',options:[],accepted_answers:[],explanation:'Source explanation.',concept_id:c.id}))
  await rpc('complete_material_generation',[claim.job_id,ids[0],JSON.stringify({quiz})])
 }
 assert.equal((await balance()).remaining,17)
 const info=(await user(0,'select public.material_generation_info($1) as value',[m.id])).rows[0].value
 assert.equal(info.exhausted,true);assert.deepEqual(info.remaining,{note:0,deck:0,quiz:0})
 await user(0,'delete from public.study_assets where material_id=$1',[m.id])
 for(const kind of ['note','deck','quiz'])await assert.rejects(rpc('claim_material_generation',[m.id,ids[0],kind,kind==='note'?'{}':'{"workflow":"topic","topic_id":"topic-1"}']),/covered everything/)
 assert.equal((await balance()).remaining,17)
 assert.equal((await rpc('bind_generation_source',[m.doc,ids[0],m.hash])).id,m.id)
 assert.equal((await user(0,'select public.material_generation_info($1) as value',[m.id])).rows[0].value.exhausted,true)
})
