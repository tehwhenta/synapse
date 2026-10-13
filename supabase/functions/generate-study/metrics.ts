// Timings only: never retain source text, prompts, answers, URLs, or API keys.
export class GenerationMetrics {
 values = {
  source_read_ms:0, gemini_ms:0, save_ms:0, validation_ms:0,
  gemini_calls:0, draft_retries:0, provider_retries:0,
  source_cached:false, source_chars:0, output_chars:0,
  input_tokens:0, output_tokens:0, thought_tokens:0, model:'',
 }
 constructor(public now:()=>number = ()=>performance.now()) {}
 async time<T>(key:'save_ms' | 'validation_ms',action:()=>T | Promise<T>):Promise<T> {
  const start=this.now()
  try {return await action()} finally {this.values[key]+=this.now()-start}
 }
 usage(model:string,usage:any) {
  this.values.model=model
  for(const [key,field] of [['input_tokens','promptTokenCount'],['output_tokens','candidatesTokenCount'],['thought_tokens','thoughtsTokenCount']] as const){
   const value=usage?.[field]
   if(typeof value==='number' && Number.isFinite(value) && value>=0)this.values[key]+=value
  }
 }
 snapshot() {
  return Object.fromEntries(Object.entries(this.values).map(([key,value])=>[key,typeof value==='number'?Math.max(0,Math.min(key.endsWith('_ms')?150000:key.endsWith('_retries') || key==='gemini_calls'?20:key.endsWith('_tokens')?10000000:1000000,Math.round(value))):value]))
 }
}

export async function reportGenerationMetrics(admin:any,task:any,metrics:GenerationMetrics) {
 const data=metrics.snapshot()
 // Structured logs remain useful if the timing write is unavailable. Reporting
 // must never turn a saved set into a failure or request another Gemini draft.
 console.info(JSON.stringify({event:'generation_timing',task_id:task.id,stage:task.stage,attempt:task.attempts,...data}))
 try {
  const request=admin.rpc('record_generation_metrics',{p_task_id:task.id,p_lease:task.lease_token,p_metrics:data})
  if(typeof request.abortSignal==='function')request.abortSignal(AbortSignal.timeout(2000))
  const result=await request
  if(result.error)console.warn('Generation timing report unavailable')
 }catch {console.warn('Generation timing report unavailable')}
}
