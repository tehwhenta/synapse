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
  for(const file of ['001_synapse.sql','003_study_refinements.sql','004_reviewer_accounts.sql','006_system_maintenance.sql','007_admin_email_type.sql','008_guided_generation.sql','009_seeds_and_custom_cards.sql','010_automatic_study.sql']) await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'))
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
