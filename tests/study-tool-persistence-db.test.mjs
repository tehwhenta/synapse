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

test('Migration preserves checked cache results as materials and repeated writes do not duplicate cards',async()=>{
 await cleanQueue();const note=await source();await ready(note)
 assert.equal((await db.query("select count(*)::int n from public.study_assets where kind='deck'")).rows[0].n,0)
 await db.exec(readFileSync(new URL('../supabase/migrations/023_persist_study_tools.sql',import.meta.url),'utf8'))
 let assets=(await user(0,'select * from public.list_latest_assets($1)',[note.folder_id])).rows
 const deck=assets.find(a=>a.kind==='deck');assert.ok(deck);assert.equal(deck.is_custom,true);assert.equal(deck.data[0].front,draft.cards[0].front);assert.ok(deck.data[0].id)
 await db.exec('update private.study_tool_results set output=output')
 assets=(await user(0,'select * from public.list_latest_assets($1)',[note.folder_id])).rows
 assert.equal(assets.filter(a=>a.kind==='deck').length,1);assert.deepEqual(assets.find(a=>a.id===deck.id).data,deck.data)
})

test('Verified highlights save without a client, remain after source deletion, and respect RLS',async()=>{
 await cleanQueue();const note=await source();await ready(note)
 let assets=(await user(0,'select * from public.list_latest_assets($1)',[note.folder_id])).rows
 const deck=assets.find(a=>a.kind==='deck');assert.ok(deck);assert.equal(deck.document_id,null);assert.equal(deck.material_id,null)
 assert.equal((await user(1,'select * from public.study_assets where id=$1',[deck.id])).rows.length,0)
 await assert.rejects(user(1,'select * from private.study_tool_assets'),/permission denied/)
 await user(0,'delete from public.study_assets where id=$1',[note.id])
 assets=(await user(0,'select * from public.list_latest_assets($1)',[note.folder_id])).rows
 assert.equal(assets.length,1);assert.equal(assets[0].id,deck.id)
})

test('A fully checked concept map becomes a reopenable material in the same completion transaction',async()=>{
 await cleanQueue();const note=await source()
 const graph={nodes:[{id:'c1',label:'Queue',body:'A queue uses FIFO.',evidence:{source:'reviewer',quote:'A queue removes the earliest arrival.'}},{id:'c2',label:'FIFO',body:'First in first out.',evidence:{source:'reviewer',quote:'FIFO'}}],edges:[{from:'c1',to:'c2',label:'uses',explanation:'The oldest arrival is removed first.',evidence:{source:'reviewer',quote:'A queue removes the earliest arrival.'}}]}
 await backend('select public.enqueue_study_tool($1,$2,$3,$4,$5)',[ids[0],crypto.randomUUID(),note.id,'connections','[]'])
 await checkpoint(await claim(),graph);const task=await claim()
 assert.equal((await user(0,'select * from public.list_latest_assets($1)',[note.folder_id])).rows.length,1)
 const output=await review(task,[{id:'node:c1',supported:true,reason:''},{id:'node:c2',supported:true,reason:''},{id:'edge:1',supported:true,reason:''}])
 let assets=(await user(0,'select * from public.list_latest_assets($1)',[note.folder_id])).rows
 const map=assets.find(a=>a.kind==='concept');assert.ok(map);assert.deepEqual(map.data,[output]);assert.equal(map.is_custom,false)
 assert.equal((await db.query('select status from private.generation_queue where id=$1',[task.id])).rows[0].status,'completed')
 await db.exec("update private.study_tool_results set output=output where tool='connections'")
 assets=(await user(0,'select * from public.list_latest_assets($1)',[note.folder_id])).rows
 assert.equal(assets.filter(a=>a.kind==='concept').length,1)
})

test('Unsupported drafts never publish a dashboard deck',async()=>{
 await cleanQueue();const note=await source();await enqueue(note);await checkpoint(await claim())
 await review(await claim(),[{id:'h1',supported:false,reason:'The supplied answer is not supported.'}])
 const assets=(await user(0,'select * from public.list_latest_assets($1)',[note.folder_id])).rows
 assert.deepEqual(assets.map(a=>a.id),[note.id])
})
