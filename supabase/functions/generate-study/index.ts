import { createClient } from 'npm:@supabase/supabase-js@2.117.3'
import { runQueuedGeneration } from './queue.ts'

const allowedOrigins=(Deno.env.get('ALLOWED_ORIGINS') || 'http://localhost:5173,https://rcgsynapse.vercel.app').split(',').map(x=>x.trim())
Deno.serve(async req=>{
 const origin=req.headers.get('origin') || ''
 const headers={'Access-Control-Allow-Origin':allowedOrigins.includes(origin)?origin:allowedOrigins[0],'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin','Content-Type':'application/json'}
 const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{headers,status})
 if(origin && !allowedOrigins.includes(origin))return respond({error:'This site origin is not allowed. Add it to ALLOWED_ORIGINS.'},403)
 if(req.method==='OPTIONS')return new Response(null,{headers,status:204})
 if(req.method!=='POST')return respond({error:'POST required'},405)
 try {
  const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default
  if(!key || !Deno.env.get('SUPABASE_URL'))return respond({error:'Supabase backend credentials are unavailable. Check function configuration.'},503)
  const admin=createClient(Deno.env.get('SUPABASE_URL')!,key,{auth:{persistSession:false,autoRefreshToken:false}})
  // A client cannot supply a user ID or task lease. Only Vault/cron may claim work.
  if(req.headers.has('x-cron-secret')){
   if(!Deno.env.get('CRON_SECRET') || req.headers.get('x-cron-secret')!==Deno.env.get('CRON_SECRET'))return respond({error:'Unauthorized'},401)
   const ticket=await req.json()
   if(!ticket?.task_id || !ticket?.lease_token)return respond({error:'Worker ticket required'},400)
   const runtime=(globalThis as any).EdgeRuntime
   if(typeof runtime?.waitUntil==='function'){
    // Release the dispatcher connection immediately; the persisted lease owns
    // this task. Cron recovers an interrupted runtime without a second user click.
    runtime.waitUntil(runQueuedGeneration(admin,ticket).catch(error=>{
     console.error('Background generation interrupted:',ticket.task_id,(error instanceof Error?error.message:'Worker unavailable').slice(0,300))
    }))
    return respond({accepted:true},202)
   }
   return respond(await runQueuedGeneration(admin,ticket))
  }
  const token=req.headers.get('authorization')?.replace(/^Bearer\s+/i,'')
  if(!token)return respond({error:'Sign in to generate study materials.'},401)
  const {data:{user},error:authError}=await admin.auth.getUser(token)
  if(authError || !user)return respond({error:'Your session expired. Sign in again.'},401)
  const active=await admin.rpc('account_is_active',{p_user_id:user.id})
  if(active.error)throw active.error
  if(!active.data)return respond({error:'This account is scheduled for deletion. Sign in within its recovery period to cancel.'},403)
  const body=await req.text()
  if(body.length>650000)return respond({error:'Request is too large. Split the source into chapters.'},413)
  let input:any
  try {input=JSON.parse(body)}catch{return respond({error:'Invalid JSON request.'},400)}
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const targets=['document_id','material_id','asset_id']
  if(!input || typeof input!=='object' || !['enqueue','prepare','generate'].includes(input.action) || targets.filter(k=>input[k]!=null).length!==1 || !uuid.test(input[targets.find(k=>input[k]!=null)!]))return respond({error:'Choose a valid source or study set.'},400)
  if(input.text!=null && (typeof input.text!=='string' || input.text.length>100000))return respond({error:'Document text is too large.'},400)
  if(input.action==='enqueue'){
   if(!uuid.test(input.request_id) || input.material_id)return respond({error:'A request ID and uploaded file or study set are required.'},400)
   const ready=await admin.rpc('generation_queue_ready')
   if(ready.error || !ready.data)return respond({error:'Generation setup is incomplete. The app owner needs to finish the queue setup.'},503)
   const result=await admin.rpc('enqueue_generation',{p_user_id:user.id,p_request_id:input.request_id,p_document_id:input.document_id || null,p_asset_id:input.asset_id || null,p_text:input.text || null,p_intake:input.intake || null})
   if(result.error)throw result.error
   // A failed kick cannot lose an accepted task: cron will pick it up.
   await admin.rpc('dispatch_generation_queue')
   return respond({success:true,task:result.data},202)
  }
  return respond({error:'Synapse has a generation update. Refresh this page to continue with the saved queue.'},409)
 }catch(error){
  const message=error instanceof Error?error.message:(error as any)?.message || 'Generation is unavailable.'
  console.error('Generation request:',message.slice(0,300))
  return respond({error:message},/access required|scheduled for deletion/i.test(message)?403:/already (being|generating)/i.test(message)?409:/quota exceeded/i.test(message)?429:500)
 }
})
