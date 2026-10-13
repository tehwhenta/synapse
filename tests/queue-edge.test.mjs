import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {fileURLToPath} from 'node:url'

test('Public generation verifies identity, accepts only queue admission, and rejects forged workers and unauthorized targets',async()=>{
 const old={Deno:globalThis.Deno,__queueClient:globalThis.__queueClient}
 let handler,ready=true,active=true,allowed=true;const calls=[]
 const userId=crypto.randomUUID(),doc=crypto.randomUUID(),requestId=crypto.randomUUID(),env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server',CRON_SECRET:'only-server-secret',ALLOWED_ORIGINS:'https://rcgsynapse.vercel.app'}
 globalThis.Deno={env:{get:k=>env[k]},serve:fn=>handler=fn}
 globalThis.__queueClient=()=>({auth:{getUser:async token=>({data:{user:token==='valid'?{id:userId}:null},error:null})},rpc:async(name,args)=>{
  calls.push([name,args])
  if(name==='account_is_active')return {data:active}
  if(name==='generation_queue_ready')return {data:ready}
  if(name==='enqueue_generation'){assert.equal(args.p_user_id,userId);return allowed?{data:{id:crypto.randomUUID(),status:'queued'}}:{error:{message:'Editor access required'}}}
  if(name==='start_generation_task')return {data:null}
  return {data:0}
 }})
 try{
  const bundle=await build({entryPoints:[fileURLToPath(new URL('../supabase/dashboard/generate-study.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['npm:*']})
  await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text.replace(/^import.*from "npm:.*";$/m,'const createClient=globalThis.__queueClient;')).toString('base64'))
  const request=(body={action:'enqueue',request_id:requestId,document_id:doc},token='valid',headers={})=>new Request('https://mock/generate-study',{method:'POST',headers:{origin:env.ALLOWED_ORIGINS,authorization:'Bearer '+token,'content-type':'application/json',...headers},body:JSON.stringify(body)})
  assert.equal((await handler(request(undefined,'invalid'))).status,401)
  active=false;assert.equal((await handler(request())).status,403);active=true
  assert.equal((await handler(request(undefined,'valid',{origin:'https://evil.example'}))).status,403)
  assert.equal((await handler(request(undefined,'valid',{'x-cron-secret':'forged'}))).status,401)
  assert.equal((await handler(request({action:'enqueue',request_id:requestId,document_id:doc,asset_id:crypto.randomUUID()}))).status,400)
  ready=false;assert.equal((await handler(request())).status,503);ready=true
  allowed=false;assert.equal((await handler(request())).status,403);allowed=true
  const ok=await handler(request({action:'enqueue',request_id:requestId,document_id:doc,user_id:crypto.randomUUID()}));assert.equal(ok.status,202);assert.equal((await ok.json()).task.status,'queued')
  assert.equal((await handler(request({action:'generate',document_id:doc,kind:'quiz'}))).status,409,'Old synchronous route cannot bypass queue capacity')
  assert.equal((await handler(request({task_id:crypto.randomUUID(),lease_token:crypto.randomUUID()},'invalid',{'x-cron-secret':env.CRON_SECRET}))).status,200)
  assert.equal(calls.filter(([name])=>name==='enqueue_generation').length,2)
 }finally{for(const[k,v]of Object.entries(old)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}}
})

test('Provider throttling is deferred, malformed drafts have a budget, and configuration errors pause immediately',async()=>{
 const bundle=await build({stdin:{contents:"export {queueRecovery} from './queue.ts';export * from './errors.ts'",resolveDir:fileURLToPath(new URL('../supabase/functions/generate-study/',import.meta.url))},bundle:true,write:false,format:'esm',platform:'neutral'})
 const {queueRecovery,GeminiRequestError,StudyDraftError}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
 const limited=queueRecovery(new GeminiRequestError(429,'quota'),1);assert.ok(limited.seconds>=30);assert.equal(limited.providerBusy,true)
 assert.ok(queueRecovery(new GeminiRequestError(503,'temporary'),2).seconds>0)
 assert.equal(queueRecovery(new GeminiRequestError(400,'configuration'),1).seconds,null)
 assert.equal(queueRecovery(new StudyDraftError('format','invalid'),3).seconds,null)
 assert.equal(queueRecovery(new Error('Editor access required'),1).seconds,null)
 assert.equal(queueRecovery(new StudyDraftError('exhausted','No new context'),1).seconds,null)
})
