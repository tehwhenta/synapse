import { executeGeneration } from './engine.ts'
import { GeminiRequestError, StudyDraftError } from './errors.ts'

export function queueRecovery(error: unknown, attempts: number) {
 const message=error instanceof Error?error.message:String(error)
 const status=error instanceof GeminiRequestError?error.status:0
 const providerBusy=status===429 || /Gemini.*429/.test(message)
 const configuration=[400,401,402,403,404].includes(status) || /API_KEY|model.*not found|credentials|function configuration/i.test(message)
 const blocked=/access required|scheduled for deletion|not legible|source.*expired|upload.*again|Custom flashcards|blocked.*(safety|policy)|permission denied/i.test(message)
 if (configuration) return {seconds:null,message:'AI generation is paused while the app owner checks the service configuration.',providerBusy:false}
 if (blocked) return {seconds:null,message:/access|required|deletion/i.test(message)?'Generation stopped because this source or account is no longer accessible.':'This source needs attention. Please upload a clearer, readable copy.',providerBusy:false}
 if (error instanceof StudyDraftError && error.code==='exhausted') return {seconds:null,message:"We've covered everything! Try a different topic or material.",providerBusy:false}
 const maximum=providerBusy?10:error instanceof StudyDraftError?3:5
 if (attempts>=maximum) return {seconds:null,message:'Generation is paused because the AI service could not finish this material. Saved sets are safe; the app owner can check it.',providerBusy:false}
 // Throttling waits are durable; never hold an Edge Function open during a long backoff.
 const seconds=Math.min(providerBusy?900:300,(providerBusy?60:15)*2**Math.min(attempts-1,5))+Math.floor(Math.random()*5)
 return {seconds,message:providerBusy?'Waiting for AI capacity. Your materials will continue automatically.':'Preparing your remaining study materials…',providerBusy}
}
export async function runQueuedGeneration(admin: any, ticket: any) {
 const claimed=await admin.rpc('start_generation_task',{p_task_id:ticket.task_id,p_lease:ticket.lease_token})
 if(claimed.error)throw claimed.error
 const task=claimed.data
 if(!task)return {idle:true}
 try {
  const input:any={action:task.stage==='prepare'?'prepare':'generate',text:task.source_text}
  if(task.document_id){input.document_id=task.document_id;input.kind=task.stage;input.initial=true}
  else input.asset_id=task.asset_id
  await executeGeneration(admin,task.user_id,input,task)
  if(task.stage==='prepare'){
   const done=await admin.rpc('finish_generation_prepare',{p_task_id:task.id,p_lease:task.lease_token})
   if(done.error)throw done.error
  }
 } catch(error) {
  const recovery=queueRecovery(error,task.attempts)
  // Only server logs/admin see diagnostics. The public status uses a concise explanation.
  const message=error instanceof Error?error.message:(error as any)?.message || 'Worker interrupted'
  console.error('Queued generation:',task.id,message.slice(0,500))
  const deferred=await admin.rpc('defer_generation_task',{p_task_id:task.id,p_lease:task.lease_token,p_error:message,p_retry_seconds:recovery.seconds,p_message:recovery.message,p_provider_busy:recovery.providerBusy})
  if(deferred.error)throw deferred.error
 }
 // Dispatch another bounded worker; cron also recovers an interrupted dispatch.
 await admin.rpc('dispatch_generation_queue')
 return {processed:true}
}
