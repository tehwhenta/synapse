import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
const db = new PGlite()
const ids = Array.from({ length: 7 }, () => crypto.randomUUID())
async function user(i, sql, args = []) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${ids[i]}',false)`)
  try { return await db.query(sql,args) } finally { await db.exec('reset role') }
}
async function backend(sql,args=[]) { await db.exec('set role service_role'); try { return await db.query(sql,args) } finally { await db.exec('reset role') } }
before(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create schema storage; create schema realtime;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',last_sign_in_at timestamptz,email_confirmed_at timestamptz);
    create table auth.sessions(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,owner_id text,metadata jsonb default '{}'); alter table storage.objects enable row level security;
    create table realtime.messages(id bigint,extension text); alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
    grant usage on schema auth,storage,realtime to anon,authenticated,service_role;
    grant select,insert,delete on storage.objects to authenticated; grant select,insert on realtime.messages to authenticated;
    create publication supabase_realtime;`)
  for (const file of ['001_synapse.sql','003_study_refinements.sql','004_reviewer_accounts.sql']) await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'))
  for (const [i,id] of ids.entries()) await db.query("insert into auth.users(id,email,email_confirmed_at,last_sign_in_at) values($1,$2,now(),now()-interval '120 days')",[id,i===0?'rcgsynapse@gmail.com':`student${i}@example.com`])
  await db.exec(readFileSync(new URL('../supabase/migrations/006_system_maintenance.sql',import.meta.url),'utf8'))
  await db.query("update public.profiles set created_at=now()-interval '120 days',last_active_at=now()-interval '120 days' where id<>$1",[ids[0]])
})
after(async () => db.close())

test('Admin access binds a confirmed UUID and cannot be gained through email or user metadata',async () => {
  assert.equal((await user(0,'select public.is_app_admin() as ok')).rows[0].ok,true)
  assert.equal((await user(1,'select public.is_app_admin() as ok')).rows[0].ok,false)
  await db.query("update auth.users set email='new-admin-address@example.com' where id=$1",[ids[0]])
  await db.query("update auth.users set email='rcgsynapse@gmail.com',raw_user_meta_data=$2 where id=$1",[ids[1],JSON.stringify({role:'admin'})])
  assert.equal((await user(1,'select public.is_app_admin() as ok')).rows[0].ok,false)
  assert.equal((await user(0,'select public.is_app_admin() as ok')).rows[0].ok,true)
  await db.query("update auth.users set email='student1@example.com' where id=$1",[ids[1]])
  await assert.rejects(user(1,'insert into private.app_admins(user_id) values($1)',[ids[1]]),/permission denied/)
  await assert.rejects(user(0,'select public.request_account_deletion()'),/Admin accounts are protected/)
})
test('Maintenance data and server cleanup functions reject ordinary users and anonymous access',async () => {
  for (const query of ['select public.admin_system_summary()','select * from public.admin_inactive_accounts()','select public.admin_schedule_inactive_accounts($1)', 'select public.admin_cancel_inactive_account($1)']) {
    const params=query.includes('cancel')?[ids[2]]:query.includes('$1')?[[ids[2]]]:[]
    await assert.rejects(user(1,query,params),/Admin access required/)
  }
  await assert.rejects(user(0,'select public.begin_maintenance_run()'),/permission denied/)
  await assert.rejects(user(1,'select public.is_app_admin_user($1)',[ids[0]]),/permission denied/)
  await db.exec('set role anon')
  try { await assert.rejects(db.query('select public.admin_system_summary()'),/permission denied/) } finally { await db.exec('reset role') }
})
test('Server activity cannot be supplied by a client, is throttled, and never deletes study data',async () => {
  await user(1,'select public.mark_app_activity()')
  const stamp=(await db.query('select last_active_at from public.profiles where id=$1',[ids[1]])).rows[0].last_active_at
  assert.ok(Date.now()-new Date(stamp).getTime()<10000)
  await user(1,'select public.mark_app_activity()')
  assert.equal(String((await db.query('select last_active_at from public.profiles where id=$1',[ids[1]])).rows[0].last_active_at),String(stamp))
  await assert.rejects(user(1,"update public.profiles set last_active_at=now()+interval '100 years' where id=$1",[ids[1]]),/permission denied/)
  assert.equal((await db.query('select count(*) as n from private.account_deletions')).rows[0].n,0)
})
test('Inactive scheduling rechecks eligibility, protects admins, and provides a seven-day recovery period',async () => {
  const candidates=(await user(0,'select * from public.admin_inactive_accounts()')).rows
  assert.equal(candidates.some(a=>a.user_id===ids[0]||a.user_id===ids[1]),false)
  await assert.rejects(user(0,'select public.admin_schedule_inactive_accounts($1,1)',[[ids[2]]]),/Select 1 to 25/)
  await assert.rejects(user(0,'select public.admin_schedule_inactive_accounts($1,90)',[Array(26).fill(ids[2])]),/Select 1 to 25/)
  const scheduled=(await user(0,'select public.admin_schedule_inactive_accounts($1,90) as result',[[ids[0],ids[1],ids[2]]])).rows[0].result
  assert.equal(scheduled.scheduled,1);assert.equal(scheduled.skipped,2)
  assert.ok(new Date(scheduled.delete_after).getTime()-Date.now()>6.9*86400000)
  const request=(await db.query('select * from private.account_deletions where user_id=$1',[ids[2]])).rows[0]
  assert.equal(request.reason,'inactive')
  assert.equal((await backend('select public.account_is_active($1) as ok',[ids[2]])).rows[0].ok,true)
  assert.equal((await backend('select * from public.claim_due_account_deletions()')).rows.length,0)
})
test('Returning to the app or a new sign-in cancels inactive cleanup; a stale account list cannot remove it',async () => {
  await user(2,'select public.mark_app_activity()')
  assert.equal((await db.query('select * from private.account_deletions where user_id=$1',[ids[2]])).rows.length,0)
  assert.equal((await user(0,'select public.admin_schedule_inactive_accounts($1) as result',[[ids[2]]])).rows[0].result.scheduled,0)
  await user(0,'select public.admin_schedule_inactive_accounts($1)',[[ids[3]]])
  await db.query('insert into auth.sessions(user_id) values($1)',[ids[3]])
  assert.equal((await db.query('select * from private.account_deletions where user_id=$1',[ids[3]])).rows.length,0)
  await user(0,'select public.admin_schedule_inactive_accounts($1)',[[ids[4]]])
  assert.equal((await user(0,'select public.admin_cancel_inactive_account($1) as ok',[ids[4]])).rows[0].ok,true)
  await user(4,'select public.request_account_deletion()')
  assert.equal((await user(0,'select public.admin_cancel_inactive_account($1) as ok',[ids[4]])).rows[0].ok,false)
  await user(4,'select public.mark_app_activity()')
  assert.equal((await db.query('select reason from private.account_deletions where user_id=$1',[ids[4]])).rows[0].reason,'self')
  await user(4,'select public.cancel_account_deletion()')
})
test('After a recovery deadline, activity cannot cancel deletion; worker claims are exclusive and skip admins',async () => {
  await user(0,'select public.admin_schedule_inactive_accounts($1)',[[ids[5]]])
  await db.query("update private.account_deletions set requested_at=now()-interval '8 days',delete_after=now()-interval '1 day' where user_id=$1",[ids[5]])
  await user(5,'select public.mark_app_activity()')
  assert.equal((await backend('select public.account_is_active($1) as ok',[ids[5]])).rows[0].ok,false)
  await db.query("insert into private.account_deletions(user_id,requested_at,delete_after) values($1,now()-interval '3 days',now()-interval '1 day')",[ids[0]])
  const claims=(await backend('select * from public.claim_due_account_deletions()')).rows
  assert.equal(claims.length,1);assert.equal(claims[0].user_id,ids[5])
  assert.equal((await backend('select * from public.claim_due_account_deletions()')).rows.length,0)
  await db.query('delete from private.account_deletions where user_id=$1',[ids[0]])
})
test('Inactive cleanup protects active shared spaces, including collaborators who return after scheduling',async () => {
  const folder=(await user(6,"select * from public.create_folder('Active group')")).rows[0]
  await db.query("insert into public.folder_members(folder_id,user_id,role) values($1,$2,'viewer')",[folder.id,ids[1]])
  assert.equal((await user(0,'select * from public.admin_inactive_accounts()')).rows.some(a=>a.user_id===ids[6]),false)
  assert.equal((await user(0,'select public.admin_schedule_inactive_accounts($1) as result',[[ids[6]]])).rows[0].result.scheduled,0)
  await db.query("update public.profiles set last_active_at=now()-interval '120 days' where id=$1",[ids[1]])
  assert.equal((await user(0,'select public.admin_schedule_inactive_accounts($1) as result',[[ids[6]]])).rows[0].result.scheduled,1)
  await db.query("update private.account_deletions set requested_at=now()-interval '8 days',delete_after=now()-interval '1 day' where user_id=$1",[ids[6]])
  await user(1,'select public.mark_app_activity()')
  await backend('select * from public.claim_due_account_deletions()')
  assert.equal((await db.query('select * from private.account_deletions where user_id=$1',[ids[6]])).rows.length,0)
  assert.equal((await db.query('select * from public.folders where id=$1',[folder.id])).rows.length,1)
})
test('Cleanup lease prevents overlapping workers and the summary contains totals without study contents',async () => {
  const token=(await backend('select public.begin_maintenance_run($1) as token',[ids[0]])).rows[0].token
  assert.ok(token)
  assert.equal((await backend('select public.begin_maintenance_run() as token')).rows[0].token,null)
  await backend('select public.finish_maintenance_run($1,$2)',[crypto.randomUUID(),JSON.stringify({purged:999})])
  assert.equal((await db.query('select result from private.maintenance_state')).rows[0].result,null)
  await backend('select public.finish_maintenance_run($1,$2)',[token,JSON.stringify({purged:2,errors:[]})])
  const summary=(await user(0,'select public.admin_system_summary() as summary')).rows[0].summary
  assert.equal(summary.users,7);assert.equal(summary.cleanup.result.purged,2)
  assert.ok(Number(summary.database_bytes)>0)
  assert.equal('emails' in summary,false);assert.equal('study_content' in summary,false)
})
test('Pruning removes old technical records while preserving invitations in use and all study content',async () => {
  const folder=(await user(0,"select * from public.create_folder('Preserved space')")).rows[0]
  await user(0,"insert into public.study_assets(folder_id,kind,title,content,created_by) values($1,'note','Kept reviewer','Kept source',$2)",[folder.id,ids[0]])
  await user(0,"insert into public.study_messages(folder_id,user_id,body) values($1,$2,'Kept chat')",[folder.id,ids[0]])
  await db.query("insert into public.folder_invitations(folder_id,token_hash,role,expires_at) values($1,'old-token','viewer',now()-interval '40 days'),($1,'live-token','viewer',now()+interval '1 day')",[folder.id])
  await db.query("insert into private.ai_usage(user_id,usage_date,requests) values($1,current_date-100,1),($1,current_date,1)",[ids[0]])
  const pruned=(await backend('select public.prune_maintenance_records() as result')).rows[0].result
  assert.equal(pruned.expired_invitations,1);assert.equal(pruned.old_usage,1)
  assert.equal((await db.query('select count(*) as n from public.study_assets')).rows[0].n,1)
  assert.equal((await db.query('select count(*) as n from public.study_messages')).rows[0].n,1)
  assert.equal((await db.query('select count(*) as n from public.folder_invitations')).rows[0].n,1)
})
