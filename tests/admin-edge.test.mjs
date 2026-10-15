import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

test('Admin HTTP cleanup requires a verified session and server role; CORS, leases, and retry results are enforced',async () => {
  const oldDeno=globalThis.Deno, oldClient=globalThis.__maintenanceClient
  let handler, busy=false, queryFailure=false, calls=[]
  const adminId=crypto.randomUUID()
  globalThis.Deno={env:{get:key=>({ALLOWED_ORIGINS:'https://rcgsynapse.vercel.app',SUPABASE_URL:'https://mock.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'mock-server-only'})[key]},serve:fn=>{handler=fn}}
  globalThis.__maintenanceClient=()=>({
    auth:{getUser:async token=>token==='invalid'?{data:null,error:new Error('Invalid JWT')}:{data:{user:{id:token==='admin-session'?adminId:'ordinary-user'}}}},
    async rpc(name,args){calls.push([name,args]);if(name==='is_app_admin_user')return {data:args.p_user_id===adminId};if(name==='begin_maintenance_run')return {data:busy?null:'lease'};if(name==='expired_storage_files')return queryFailure?{error:new Error('Database unavailable')}:{data:[]};if(name==='pending_storage_deletions'||name==='claim_due_account_deletions')return {data:[]};if(name==='prune_maintenance_records')return {data:{expired_invitations:0}};return {data:null}},
    from(){return {select(){return this},lt(){return this},is(){return this},order(){return this},limit:async()=>queryFailure?{error:new Error('Database unavailable')}:{data:[]},update(){return this},eq(){return this},then(resolve){return Promise.resolve({error:null}).then(resolve)}}},
  })
  try {
    const bundle=await build({entryPoints:[fileURLToPath(new URL('../supabase/functions/admin-maintenance/index.ts',import.meta.url))],bundle:true,write:false,platform:'neutral',format:'esm',external:['npm:*']})
    const source=bundle.outputFiles[0].text.replace(/^import.*from "npm:.*";$/m,'const createClient=globalThis.__maintenanceClient;')
    await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))
    const req=(token,body={action:'cleanup'},origin='https://rcgsynapse.vercel.app',method='POST')=>new Request('https://mock/functions/v1/admin-maintenance',{method,headers:{origin,...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})})
    assert.equal((await handler(req(null))).status,401)
    assert.equal((await handler(req('invalid'))).status,401)
    assert.equal((await handler(req('ordinary-session'))).status,403)
    assert.equal((await handler(req('admin-session',undefined,'https://untrusted.example'))).status,403)
    assert.equal(calls.some(([name])=>name==='begin_maintenance_run'),false)
    const preflight=await handler(req(null,undefined,undefined,'OPTIONS'))
    assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'https://rcgsynapse.vercel.app')
    assert.equal((await handler(req('admin-session',{action:'delete-arbitrary-user',user_id:adminId}))).status,400)
    busy=true;assert.equal((await handler(req('admin-session'))).status,409)
    busy=false;calls=[]
    const result=await handler(req('admin-session'));assert.equal(result.status,200)
    assert.equal((await result.json()).accounts_deleted,0)
    assert.deepEqual(calls.find(([name])=>name==='begin_maintenance_run')[1],{p_actor_id:adminId})
    assert.equal(calls.at(-1)[0],'finish_maintenance_run')
    queryFailure=true;calls=[]
    const failed=await handler(req('admin-session'));assert.equal(failed.status,500)
    assert.match((await failed.json()).errors[0],/Database unavailable/)
    assert.equal(calls.at(-1)[0],'finish_maintenance_run')
  } finally { if(oldDeno===undefined)delete globalThis.Deno;else globalThis.Deno=oldDeno;if(oldClient===undefined)delete globalThis.__maintenanceClient;else globalThis.__maintenanceClient=oldClient }
})
