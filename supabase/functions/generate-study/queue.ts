import { executeGeneration } from './engine.ts'
import { GeminiRequestError, StudyDraftError } from './errors.ts'
import { generationRequestBudgetMs } from './reliable.ts'
import { UploadReadError, unreadableUploadMessage } from '../_shared/uploadTypes.ts'
import { GenerationMetrics, reportGenerationMetrics } from './metrics.ts'

export const minimumContinuationBudgetMs=70000

export function queueRecovery(error: unknown, attempts: number) {
 const message=error instanceof Error?error.message:String(error)
 const status=error instanceof GeminiRequestError?error.status:0
 if(error instanceof UploadReadError)return {seconds:null,message:error.message,providerBusy:false,reason:'source'}
 if(/access required|scheduled for deletion|permission denied/i.test(message))return {seconds:null,message:'Generation stopped because this source or account is no longer accessible.',providerBusy:false,reason:'access'}
 if(/not legible|cannot be read|source.*expired|original.*(expired|missing)|upload.*again|blocked.*(safety|policy)/i.test(message))return {seconds:null,message:unreadableUploadMessage,providerBusy:false,reason:'source'}
 if(error instanceof StudyDraftError && error.code==='exhausted')return {seconds:null,message:"We've covered everything! Try a different topic or material.",providerBusy:false,reason:'exhausted'}
 const configuration=[400,401,402,403,404].includes(status) || /API_KEY|GEMINI_MODEL|model.*not found|credentials|function configuration/i.test(message)
 if(configuration)return {seconds:null,message:'The AI service needs attention. Preparation will resume automatically once it is available.',providerBusy:true,reason:'service'}
 const providerBusy=status===429 || /Gemini.*429/.test(message)
 const maximum=providerBusy?6:error instanceof StudyDraftError?3:5
 if(attempts>=maximum)return {seconds:null,message:'Taking a short pause. Your materials will continue automatically.',providerBusy,reason:'temporary'}
 const suggested=error instanceof GeminiRequestError?error.retryAfterSeconds:undefined
 const seconds=providerBusy?Math.min(3600,Math.max(5,suggested ?? Math.min(120,30*2**Math.min(attempts-1,2)))):Math.min(60,5*2**Math.min(attempts-1,4))
 return {seconds,message:providerBusy?'Waiting briefly for AI capacity. Preparation continues automatically.':'Preparing your remaining study materials…',providerBusy,reason:'temporary'}
}
export async function runQueuedGeneration(admin: any, ticket: any) {
 const deadline=Date.now()+generationRequestBudgetMs
 const claimed=await admin.rpc('start_generation_task',{p_task_id:ticket.task_id,p_lease:ticket.lease_token})
 if(claimed.error)throw claimed.error
 let task=claimed.data
 if(!task)return {idle:true}
 // Reuse a warm worker while a full draft plus saving time still fits. The
 // original 130-second deadline, account cap, material guard and FIFO fairness
 // apply to EVERY continuation; no parallel provider calls inside one task.
 for(let stage=0;stage<4;stage++){
  const metrics=new GenerationMetrics()
  let succeeded=false
  try {
   const input:any={action:task.stage==='prepare'?'prepare':'generate',text:task.source_text}
   if(task.document_id){input.document_id=task.document_id;input.kind=task.stage;input.initial=true}
   else input.asset_id=task.asset_id
   await executeGeneration(admin,task.user_id,input,task,deadline,metrics)
   if(task.stage==='prepare'){
    const done=await admin.rpc('finish_generation_prepare',{p_task_id:task.id,p_lease:task.lease_token})
    if(done.error)throw done.error
   }
   succeeded=true
  } catch(error) {
   const recovery=queueRecovery(error,task.attempts)
   const message=error instanceof Error?error.message:(error as any)?.message || 'Worker interrupted'
   console.error('Queued generation:',task.id,message.slice(0,500))
   const deferred=await admin.rpc('defer_generation_task',{p_task_id:task.id,p_lease:task.lease_token,p_error:message,p_retry_seconds:recovery.seconds,p_message:recovery.message,p_provider_busy:recovery.providerBusy})
   if(deferred.error)throw deferred.error
  } finally {
   await reportGenerationMetrics(admin,task,metrics)
  }
  if(succeeded && stage<3 && (task.stage==='prepare' || task.document_id && !task.kind) && deadline-Date.now()>=minimumContinuationBudgetMs){
   const next=await admin.rpc('continue_generation_task',{p_task_id:task.id,p_previous_lease:task.lease_token})
   if(!next.error && next.data){task=next.data;continue}
  }
  break
 }
 await admin.rpc('dispatch_generation_queue')
 return {processed:true}
}
