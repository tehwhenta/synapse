import {ref,computed,watch,onBeforeUnmount} from 'vue'
import {useAuthStore} from '../stores/auth'
import {useWorkspaceStore} from '../stores/workspace'
import {supabase} from './supabase'
import {invokeGeneration} from './generationApi'
import {sampleStudyTool} from './studyToolSamples'

// Only mounted panels poll, and only metadata is streamed. Closing a panel does
// not cancel accepted work. Reopening resumes its task or reads its cached result.
export function useStudyTool(asset,tool) {
 const auth=useAuthStore(),workspace=useWorkspaceStore()
 const output=ref(null),task=ref(null),loading=ref(false),error=ref(''),context=ref(null),connection=ref('')
 let version=0,timer,alive=true,highlights=[],failures=0
 const busy=computed(()=>!!(loading.value || task.value && (['queued','processing'].includes(task.value.status) || task.value.status==='paused' && task.value.auto_resume_at)))
 const valid=(v,user)=>alive && v===version && user===auth.user?.id
 function clear(){++version;clearTimeout(timer);output.value=null;context.value=null;task.value=null;loading.value=false;error.value='';connection.value=''}
 function check(result){if(result.error)throw result.error;return result.data}
 function schedule(v,user){clearTimeout(timer);if(valid(v,user) && busy.value && !globalThis.document?.hidden)timer=setTimeout(()=>poll(v,user),task.value?.status==='paused' || globalThis.navigator?.onLine===false?30000:Math.min(30000,5000*2**Math.min(failures,3)))}
 function apply(result){
  if(result?.output){
   if(result.output.verification?.version!==2 || !result.fingerprint)throw new Error('Update the study-tools SQL and generate-study function to load checked results.')
   output.value=result.output;context.value={fingerprint:result.fingerprint,highlights:[...highlights]};task.value=result.task || null;return
  }
  if(!result?.task)throw new Error('The study tools need the latest database and generation update.')
  task.value=result.task
  if(task.value.status==='completed')throw new Error('This result is unavailable. Reopen the study tool to prepare it again.')
  if(task.value.status==='paused' && !task.value.auto_resume_at)error.value=task.value.message || 'Save this reviewer and reopen the tool.'
 }
 async function poll(v=version,user=auth.user?.id){
  if(!valid(v,user) || !task.value?.id || loading.value)return
  loading.value=true
  try{
   const result=check(await supabase.rpc('read_study_tool_task',{p_task_id:task.value.id}))
   if(valid(v,user)){apply(result);failures=0;connection.value='';if(result?.output)error.value=''}
  }catch(e){
   if(valid(v,user)){
    const message=e.message || 'Reconnecting…'
    if(e.code==='PGRST202' || /access required|reviewer changed|permission denied|session|JWT|update the study|unavailable|function.*not.*found/i.test(message)){error.value=message;task.value=null}
    else {failures++;connection.value='Reconnecting. Your saved task continues.'}
    // A temporary status connection failure leaves the persisted worker alone.
   }
  }finally{if(valid(v,user)){loading.value=false;schedule(v,user)}}
 }
 async function generate(selected=[]){
  clearTimeout(timer);const v=++version,user=auth.user?.id
  output.value=null;task.value=null;context.value=null;error.value='';connection.value='';failures=0;loading.value=true;highlights=[...new Set((Array.isArray(selected)?selected:[]).map(text=>typeof text==='string'?text.replace(/\s+/g,' ').trim():text))]
  try{
   if(tool==='highlights' && (!highlights.length || highlights.length>20 || highlights.some(text=>typeof text!=='string' || text.trim().length<2 || text.length>2000)))throw new Error('Choose up to 20 highlights, each between 2 and 2,000 characters.')
   if(auth.demo){const sample=sampleStudyTool(asset(),tool,highlights);if(!sample)throw new Error('Connect Supabase to generate AI study tools from your own material.');output.value=sample;return}
   if(!user)throw new Error('Sign in to use AI study tools.')
   const cached=check(await supabase.rpc('read_study_tool',{p_asset_id:asset().id,p_tool:tool,p_highlights:highlights}))
   if(!valid(v,user))return
   if(cached?.output){apply(cached);return}
   if(!workspace.canEdit)throw new Error('Ask a space editor to prepare these connections first.')
   const source=asset(),key='synapse.tool.'+user+'.'+source.id+'.'+tool
   const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([source.title,source.content,source.content_format,highlights])))
   if(!valid(v,user))return
   const fingerprint=Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('')
   let receipt;try{receipt=JSON.parse(localStorage.getItem(key) || 'null')}catch{}
   let requestId=receipt?.fingerprint===fingerprint?receipt.request_id:crypto.randomUUID()
   try{localStorage.setItem(key,JSON.stringify({fingerprint,request_id:requestId}))}catch{}
   let result
   for(let attempt=0;attempt<2;attempt++){
    try{result=await invokeGeneration({action:'study-tool',request_id:requestId,asset_id:source.id,tool,highlights});break}
    catch(e){
     if(!attempt && /Use a new request ID/i.test(e.message)){
      requestId=crypto.randomUUID();try{localStorage.setItem(key,JSON.stringify({fingerprint,request_id:requestId}))}catch{}
      continue
     }
     if(attempt || !e.transient)throw e
     await new Promise(resolve=>setTimeout(resolve,700));if(!valid(v,user))return
    }
   }
   if(!valid(v,user))return
   apply(result)
   try{localStorage.removeItem(key)}catch{}
  }catch(e){if(valid(v,user))error.value=e.message}
  finally{if(valid(v,user)){loading.value=false;schedule(v,user)}}
 }
 function wake(){if(!globalThis.document?.hidden && busy.value)void poll()}
 globalThis.window?.addEventListener('online',wake)
 globalThis.document?.addEventListener('visibilitychange',wake)
 watch(()=>auth.user?.id,clear, {flush:'sync'})
 onBeforeUnmount(()=>{alive=false;++version;clearTimeout(timer);globalThis.window?.removeEventListener('online',wake);globalThis.document?.removeEventListener('visibilitychange',wake)})
 return {output,task,busy,error,context,connection,generate,clear}
}
