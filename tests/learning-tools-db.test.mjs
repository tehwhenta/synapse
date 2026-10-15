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
  for(const file of ['001_synapse.sql','003_study_refinements.sql','004_reviewer_accounts.sql','006_system_maintenance.sql','007_admin_email_type.sql','008_guided_generation.sql','009_seeds_and_custom_cards.sql','010_automatic_study.sql','011_generation_reliability.sql','012_generation_queue.sql','014_safe_database_cleanup.sql','015_generation_refinement.sql','017_generation_performance.sql','018_streaming_generation.sql','019_rich_note_capacity.sql','020_learning_tools_and_cleanup.sql','021_ai_study_tools.sql']) await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'))
  for(const [i,id] of ids.entries()) await db.query('insert into auth.users(id,email,email_confirmed_at,last_sign_in_at) values($1,$2,now(),now())',[id,`guided${i}@example.com`])
})
after(async()=>db.close())
async function folder(){return (await user(0,"select * from public.create_folder('Connections')")).rows[0]}
async function asset(fid,kind,data=[],content=''){
 return (await user(0,"insert into public.study_assets(folder_id,kind,title,created_by,data,content,content_format) values($1,$2,$3,$4,$5,$6,'html') returning *",[fid,kind,'My '+kind,ids[0],JSON.stringify(data),content])).rows[0]
}
const quiz=[{type:'short_answer',question:'What does FIFO mean?',answer:'First in first out',accepted_answers:['FIFO'],options:[],explanation:'The first arrival is removed first.'},{type:'true_false',question:'A stack uses FIFO.',answer:'False',accepted_answers:[],options:['True','False'],explanation:'A stack uses LIFO.'}]
async function lease(){await db.exec("update private.maintenance_state set running_until=null,last_started_at=null");return (await backend('select public.begin_maintenance_run() as token')).rows[0].token}

test('Mistakes capture server-graded wrong answers atomically, deduplicate repeats and stay private after source deletion',async()=>{
 const f=await folder(),q=await asset(f.id,'quiz',quiz)
 await user(0,'select public.submit_quiz($1,$2)',[q.id,JSON.stringify(['Wrong','False'])])
 let rows=(await user(0,'select * from public.mistake_items')).rows
 assert.equal(rows.length,1);assert.equal(rows[0].answer,quiz[0].answer);assert.equal(rows[0].user_answer,'Wrong')
 await user(0,'update public.mistake_items set mastered_at=now() where id=$1',[rows[0].id])
 await user(0,'select public.submit_quiz($1,$2)',[q.id,JSON.stringify(['Wrong again','False'])])
 rows=(await user(0,'select * from public.mistake_items')).rows
 assert.equal(rows.length,1);assert.equal(rows[0].misses,2);assert.equal(rows[0].mastered_at,null)
 assert.equal((await user(1,'select * from public.mistake_items')).rows.length,0)
 assert.equal((await user(1,'update public.mistake_items set mastered_at=now() where id=$1 returning *',[rows[0].id])).rows.length,0)
 await assert.rejects(user(0,"update public.mistake_items set answer='Forged' where id=$1",[rows[0].id]),/permission denied/)
 await user(0,'delete from public.study_assets where id=$1',[q.id])
 const kept=(await user(0,'select * from public.mistake_items where id=$1',[rows[0].id])).rows[0]
 assert.equal(kept.asset_id,null);assert.equal(kept.question,quiz[0].question)
})
test('Existing quiz attempts import once without overwriting a newer mastered state, and account deletion cascades private mistakes',async()=>{
 const f=await folder(),q=await asset(f.id,'quiz',quiz)
 await db.query('insert into public.quiz_attempts(asset_id,user_id,correct,total,answers) values($1,$2,1,2,$3)',[q.id,ids[0],JSON.stringify(['Legacy wrong','False'])])
 const first=(await user(0,'select * from public.my_mistakes()')).rows
 const found=first.find(m=>m.asset_id===q.id);assert.ok(found)
 await user(0,'update public.mistake_items set mastered_at=now() where id=$1',[found.id])
 const second=(await user(0,'select * from public.my_mistakes()')).rows;assert.ok(!second.some(m=>m.id===found.id))
 assert.equal((await user(0,'select * from public.my_mistakes(true)')).rows.find(m=>m.id===found.id).misses,1)
 assert.equal((await user(1,'select * from public.my_mistakes()')).rows.length,0)
})
test("Highlight cards create and append only to the author's custom deck while preserving existing card IDs and schedules",async()=>{
 const f=await folder(),note=await asset(f.id,'note',[],'<p><mark>FIFO</mark> is a queue rule.</p>')
 const cards=JSON.stringify([{front:'What is FIFO?',back:'First in first out'}])
 const created=(await user(0,'select * from public.save_highlight_cards($1,$2,$3)',[note.id,'Highlight deck',cards])).rows[0]
 assert.equal(created.is_custom,true);assert.equal(created.data.length,1);const id=created.data[0].id
 await user(0,'select public.review_card($1,0,3)',[created.id])
 const appended=(await user(0,'select * from public.save_highlight_cards($1,$2,$3,$4)',[note.id,'Unused title',cards,created.id])).rows[0]
 assert.equal(appended.data.length,2);assert.equal(appended.data[0].id,id)
 assert.equal((await db.query('select count(*)::int n from public.flashcard_progress where asset_id=$1',[created.id])).rows[0].n,1)
 const ai=await asset(f.id,'deck',[{front:'AI Q',back:'AI A'}]);await db.query('update public.study_assets set is_custom=false where id=$1',[ai.id])
 await assert.rejects(user(0,'select public.save_highlight_cards($1,$2,$3,$4)',[note.id,'Bad target',cards,ai.id]),/own custom deck/)
 await db.query("insert into public.folder_members(folder_id,user_id,role) values($1,$2,'viewer')",[f.id,ids[1]])
 await assert.rejects(user(1,'select public.save_highlight_cards($1,$2,$3)',[note.id,'Forbidden',cards]),/Editor access/)
})
test('Cleanup claims only old unreferenced app objects and blocks races until a verified worker finishes',async()=>{
 const f=await folder(),photoPath=ids[0]+'/current.png'
 await user(0,'update public.profiles set avatar_path=$1 where id=$2',[photoPath,ids[0]])
 const doc=crypto.randomUUID(),docPath=f.id+'/'+ids[0]+'/'+doc+'.txt'
 await user(0,"insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) values($1,$2,$3,'notes.txt',$4,'text/plain',20)",[doc,f.id,ids[0],docPath])
 const orphan=ids[0]+'/abandoned.png'
 for(const [bucket,path,days]of [['profile-photos',photoPath,2],['study-files',docPath,2],['profile-photos',orphan,2],['study-files','abandoned/source.txt',2],['profile-photos',ids[0]+'/recent.png',0],['other','leave-alone',2]])await db.query("insert into storage.objects(bucket_id,name,owner_id,created_at) values($1,$2,$3,now()-($4::text||' days')::interval)",[bucket,path,ids[0],days])
 const token=await lease(),claims=(await backend('select * from public.claim_orphan_storage($1)',[token])).rows
 assert.equal(claims.length,2);assert.ok(!claims.some(c=>c.storage_path===photoPath||c.storage_path===docPath))
 await assert.rejects(user(0,'update public.profiles set avatar_path=$1 where id=$2',[orphan,ids[0]]),/being cleaned/)
 await assert.rejects(user(0,"insert into storage.objects(bucket_id,name,owner_id) values('profile-photos',$1,$2)",[orphan,ids[0]]),/row-level security/)
 await assert.rejects(user(0,'select * from public.claim_orphan_storage($1)',[token]),/permission denied/)
 await assert.rejects(backend('select public.finish_orphan_storage($1,$2)',[crypto.randomUUID(),claims.map(c=>c.claim_id)]),/lease expired/)
 const next=await lease(),reclaimed=(await backend('select * from public.claim_orphan_storage($1)',[next])).rows
 assert.equal((await backend('select public.finish_orphan_storage($1,$2) as n',[next,claims.map(c=>c.claim_id)])).rows[0].n,0,'Old claim IDs cannot clear a new reservation')
 // The fixture models Storage API removal; production never deletes storage metadata with SQL.
 await db.query('delete from storage.objects where id=any($1)',[reclaimed.map(c=>c.object_id)])
 assert.equal((await backend('select public.finish_orphan_storage($1,$2) as n',[next,reclaimed.map(c=>c.claim_id)])).rows[0].n,2)
 assert.equal((await db.query("select file_size_limit from storage.buckets where id='profile-photos'")).rows[0].file_size_limit,10485760)
})

test('Expired file cleanup protects live generation leases but does not keep abandoned processing rows forever',async()=>{
 const f=await folder(),doc=crypto.randomUUID(),path=f.id+'/'+ids[0]+'/'+doc+'.txt'
 await user(0,"insert into public.document_files(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) values($1,$2,$3,'expired.txt',$4,'text/plain',20)",[doc,f.id,ids[0],path])
 await db.query("update public.document_files set expires_at=now()-interval '1 day' where id=$1",[doc])
 await db.query("insert into private.generation_queue(user_id,request_id,folder_id,document_id,status,stage,lease_token,lease_until,worker_started) values($1,$2,$3,$4,'processing','prepare',$5,now()+interval '3 minutes',true)",[ids[0],crypto.randomUUID(),f.id,doc,crypto.randomUUID()])
 const token=await lease()
 assert.ok(!(await backend('select * from public.expired_storage_files($1)',[token])).rows.some(d=>d.id===doc))
 await db.query("update private.generation_queue set lease_until=now()-interval '1 second' where document_id=$1",[doc])
 assert.ok((await backend('select * from public.expired_storage_files($1)',[token])).rows.some(d=>d.id===doc))
})


test('AI tool jobs share global/user capacity, cache only fenced complete results, and cannot take over ordinary regeneration',async()=>{
 await db.exec("delete from private.generation_queue;update private.generation_capacity set cooldown_until=null")
 const f=await folder(),n1=await asset(f.id,'note',[],'<p>FIFO means first in first out. A queue removes the first arrival.</p>'),n2=await asset(f.id,'note',[],'<p>A stack uses last in first out and removes its latest arrival.</p>')
 const request=crypto.randomUUID(),selection=JSON.stringify(['FIFO'])
 const first=(await backend('select public.enqueue_study_tool($1,$2,$3,$4,$5) result',[ids[0],request,n1.id,'highlights',selection])).rows[0].result
 const repeated=(await backend('select public.enqueue_study_tool($1,$2,$3,$4,$5) result',[ids[0],request,n1.id,'highlights',selection])).rows[0].result
 assert.equal(first.task.id,repeated.task.id)
 const normal=(await backend('select public.enqueue_generation($1,$2,null,$3,null) result',[ids[0],crypto.randomUUID(),n1.id])).rows[0].result
 assert.notEqual(normal.id,first.task.id,'Regeneration is a separate job from highlight tools')
 const graph=(await backend('select public.enqueue_study_tool($1,$2,$3,$4) result',[ids[0],crypto.randomUUID(),n2.id,'connections'])).rows[0].result
 await assert.rejects(backend('select public.enqueue_study_tool($1,$2,$3,$4) result',[ids[0],crypto.randomUUID(),n1.id,'connections']),/three materials/)
 const running=[]
 for(let i=0;i<3;i++){const q=(await backend('select public.claim_generation_task() task')).rows[0].task;if(q)running.push(q)}
 assert.equal(running.length,2,'Ordinary and tool jobs share the two-per-user cap')
 assert.equal((await backend('select public.claim_generation_task() task')).rows[0].task,null)
 const f2=(await user(1,"select * from public.create_folder('Other user')")).rows[0]
 const own=(await user(1,"insert into public.study_assets(folder_id,kind,title,created_by,content,content_format) values($1,'note','Other source',$2,'A graph contains vertices and edges connecting them.','markdown') returning *",[f2.id,ids[1]])).rows[0]
 await backend('select public.enqueue_study_tool($1,$2,$3,$4)',[ids[1],crypto.randomUUID(),own.id,'connections'])
 const third=(await backend('select public.claim_generation_task() task')).rows[0].task
 assert.equal(third.user_id,ids[1]);assert.equal((await db.query("select count(*)::int n from private.generation_queue where status='processing'")).rows[0].n,3)
 assert.equal((await backend('select public.claim_generation_task() task')).rows[0].task,null,'Both kinds together respect the global three-worker cap')
 const worker=running.find(q=>q.id===first.task.id);assert.ok(worker)
 await backend('select public.start_generation_task($1,$2)',[worker.id,worker.lease_token])
 const claim=(await backend('select public.claim_study_tool($1,$2) result',[worker.id,worker.lease_token])).rows[0].result
 assert.equal(claim.tool,'highlights');assert.equal(claim.content,n1.content)
 const generated={cards:[{highlight_id:'h1',front:'What does FIFO mean?',back:'First in first out.',evidence:{source:'reviewer',quote:'FIFO means first in first out.'}}]}
 await assert.rejects(backend('select public.complete_study_tool($1,$2,$3)',[worker.id,crypto.randomUUID(),JSON.stringify(generated)]),/lease expired/)
 await backend('select public.complete_study_tool($1,$2,$3)',[worker.id,worker.lease_token,JSON.stringify(generated)])
 const cached=(await user(0,'select public.read_study_tool($1,$2,$3) result',[n1.id,'highlights',selection])).rows[0].result
 assert.deepEqual(cached.output,generated)
 const served=(await backend('select public.enqueue_study_tool($1,$2,$3,$4,$5) result',[ids[0],crypto.randomUUID(),n1.id,'highlights',selection])).rows[0].result
 assert.deepEqual(served.output,generated);assert.equal(served.task,undefined,'A cached read does not reserve a worker')
 const receipt=(await user(0,'select public.read_study_tool_task($1) result',[worker.id])).rows[0].result
 assert.deepEqual(receipt.output,generated);assert.equal(receipt.task.lease_token,undefined);assert.equal(receipt.task.tool_input,undefined)
 const ordinary=(await user(0,'select public.my_generation_tasks($1) result',[f.id])).rows[0].result
 assert.ok(ordinary.some(q=>q.id===normal.id));assert.ok(!ordinary.some(q=>q.id===first.task.id||q.id===graph.task.id))
 assert.equal((await db.query('select count(*)::int n from public.study_assets where folder_id=$1',[f.id])).rows[0].n,2,'AI previews do not overwrite or create study sets')
 await user(0,"update public.study_assets set title='Renamed without rewriting' where id=$1",[n1.id])
 assert.deepEqual((await user(0,'select public.read_study_tool($1,$2,$3) result',[n1.id,'highlights',selection])).rows[0].result.output,generated,'Renaming alone does not spend AI usage')
 await user(0,"update public.study_assets set content='<p>FIFO now has a revised explanation.</p>' where id=$1",[n1.id])
 assert.equal((await db.query('select count(*)::int n from private.study_tool_results where asset_id=$1',[n1.id])).rows[0].n,0)
 assert.equal((await user(0,'select public.read_study_tool($1,$2,$3) result',[n1.id,'highlights',selection])).rows[0].result.output,null)

})
test('Tool results and admission check access, reviewer changes invalidate cache and stale workers cannot publish',async()=>{
 await db.exec("delete from private.generation_queue;update private.generation_capacity set cooldown_until=null")
 const f=await folder(),n=await asset(f.id,'note',[],'<p>A queue uses FIFO. First in first out keeps arrival order.</p>')
 await assert.rejects(user(1,'select public.read_study_tool($1,$2)',[n.id,'connections']),/access required/)
 await assert.rejects(user(0,'select public.enqueue_study_tool($1,$2,$3,$4)',[ids[0],crypto.randomUUID(),n.id,'connections']),/permission denied/)
 await assert.rejects(backend('select public.enqueue_study_tool($1,$2,$3,$4)',[ids[1],crypto.randomUUID(),n.id,'connections']),/Editor access/)
 const q=(await backend('select public.enqueue_study_tool($1,$2,$3,$4) result',[ids[0],crypto.randomUUID(),n.id,'connections'])).rows[0].result.task
 const worker=(await backend('select public.claim_generation_task() task')).rows[0].task
 const output={nodes:[{id:'c1',label:'Queue'},{id:'c2',label:'FIFO'}],edges:[{from:'c1',to:'c2',label:'uses'}]}
 await user(0,"update public.study_assets set content='<p>A queue is now defined with more precise FIFO details.</p>' where id=$1",[n.id])
 await assert.rejects(backend('select public.claim_study_tool($1,$2)',[q.id,worker.lease_token]),/Reviewer changed/)
 await assert.rejects(backend('select public.complete_study_tool($1,$2,$3)',[q.id,worker.lease_token,JSON.stringify(output)]),/Reviewer changed/)
 const cache=(await user(0,'select public.read_study_tool($1,$2)',[n.id,'connections'])).rows[0].read_study_tool
 assert.equal(cache.output,null)
 await assert.rejects(user(0,'select public.read_study_tool_task($1)',[q.id]),/Reviewer changed/)
 await assert.rejects(backend('select public.enqueue_study_tool($1,$2,$3,$4,$5)',[ids[0],crypto.randomUUID(),n.id,'highlights',JSON.stringify([''])]),/Each highlight/)
 assert.equal((await db.query("select private.generation_pause_reason('Reviewer changed. Save and reopen') reason")).rows[0].reason,'source')
})
