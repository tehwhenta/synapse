import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {fileURLToPath} from 'node:url'
const bundle=await build({stdin:{contents:"export * from './metrics.ts';export * from './transport.ts';export * from './reliable.ts';export * from './errors.ts';export * from './queue.ts'",resolveDir:fileURLToPath(new URL('../supabase/functions/generate-study/',import.meta.url))},bundle:true,write:false,platform:'neutral',format:'esm'})
const {GenerationMetrics,reportGenerationMetrics,geminiText,runDraftPipeline,StudyDraftError,GeminiRequestError,runQueuedGeneration}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))

test('Gemini timing includes response reading and failed calls; tokens are observed without storing response content',async()=>{
 const old={Deno:globalThis.Deno,fetch:globalThis.fetch};let elapsed=0,calls=0
 globalThis.Deno={env:{get:()=> 'gemini-3.5-flash-lite'}}
 const metrics=new GenerationMetrics(()=>elapsed)
 try{
  globalThis.fetch=async()=>{
   elapsed+=20;calls++
   if(calls===1)return {ok:true,json:async()=>{elapsed+=15;return {usageMetadata:{promptTokenCount:100,candidatesTokenCount:60,thoughtsTokenCount:5},candidates:[{finishReason:'STOP',content:{parts:[{text:'A complete source-supported response.'}]}}]}}}
   return {ok:false,status:429,headers:new Headers(),json:async()=>{elapsed+=10;return {error:{status:'RESOURCE_EXHAUSTED',message:'Wait briefly'}}}}
  }
  assert.equal(await geminiText('private-test-key','Private instructions',[{text:'Private source'}],24000,1,60000,metrics),'A complete source-supported response.')
  await assert.rejects(geminiText('private-test-key','Private instructions',[],24000,1,60000,metrics),/429/)
  const values=metrics.snapshot();assert.equal(values.gemini_calls,2);assert.equal(values.gemini_ms,65)
  assert.equal(values.input_tokens,100);assert.equal(values.output_tokens,60);assert.equal(values.thought_tokens,5)
  assert.ok(!JSON.stringify(values).includes('private-test-key'));assert.ok(!JSON.stringify(values).includes('Private source'));assert.ok(!JSON.stringify(values).includes('complete source-supported'))
 }finally{for(const[k,v]of Object.entries(old)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}}
})

test('Draft corrections, provider retries, validation and saving are measured separately under the original deadline',async()=>{
 let elapsed=0,calls=0,saves=0;const metrics=new GenerationMetrics(()=>elapsed)
 const output=await runDraftPipeline({metrics,deadline:130000,now:()=>elapsed,pause:async ms=>elapsed+=ms,generate:async()=>{
  calls++;elapsed+=100
  if(calls===1)throw new StudyDraftError('format','Mock incomplete draft')
  if(calls===2)throw new GeminiRequestError(503,'Mock service issue')
  return 'Complete content'
 },validate:raw=>{elapsed+=8;return raw},save:async raw=>{elapsed+=30;saves++;return raw}})
 assert.equal(output,'Complete content');assert.equal(calls,3);assert.equal(saves,1)
 assert.equal(metrics.values.draft_retries,1);assert.equal(metrics.values.provider_retries,1);assert.equal(metrics.values.validation_ms,8);assert.equal(metrics.values.save_ms,30)
})

test('Timing write failures never fail generation and a report uses a short abort deadline',async()=>{
 const old={info:console.info,warn:console.warn};console.info=()=>{};console.warn=()=>{}
 try{
  let signal
  const request={abortSignal(value){signal=value;return this},then(_resolve,reject){return Promise.reject(new Error('Mock timing database unavailable')).then(_resolve,reject)}}
  await reportGenerationMetrics({rpc:()=>request},{id:'task',lease_token:'lease',stage:'note',attempts:1},new GenerationMetrics())
  assert.ok(signal instanceof AbortSignal)
 }finally{console.info=old.info;console.warn=old.warn}
})

test('A slow stage yields before another full draft can exceed the shared worker request budget',async()=>{
 const old={Deno:globalThis.Deno,fetch:globalThis.fetch,now:Date.now,info:console.info};let elapsed=0,continues=0,saves=0
 const task={id:crypto.randomUUID(),lease_token:crypto.randomUUID(),user_id:crypto.randomUUID(),document_id:crypto.randomUUID(),material_id:crypto.randomUUID(),stage:'note',kind:null,attempts:1}
 const admin={rpc:async name=>{
  if(name==='start_generation_task')return {data:task}
  if(name==='claim_queued_generation')return {data:{job_id:crypto.randomUUID(),source_text:'A queue uses FIFO ordering.',source_format:'markdown',previous:[],options:{variant:'comprehensive foundations',set_number:1}}}
  if(name==='complete_queued_generation'){saves++;return {data:{id:crypto.randomUUID(),set_number:1}}}
  if(name==='continue_generation_task'){continues++;return {data:null}}
  return {data:0}
 }}
 globalThis.Deno={env:{get:key=>key==='GEMINI_API_KEY'?'test-key':'gemini-3.5-flash-lite'}};Date.now=()=>elapsed;console.info=()=>{}
 globalThis.fetch=async()=>{elapsed+=61000;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'# Queue\nComplete FIFO definitions and process.'}]}}]})}
 try{await runQueuedGeneration(admin,{task_id:task.id,lease_token:task.lease_token});assert.equal(saves,1);assert.equal(continues,0,'Fewer than 70 seconds remaining must yield to a new worker')}
 finally{Date.now=old.now;console.info=old.info;for(const key of ['Deno','fetch']){if(old[key]===undefined)delete globalThis[key];else globalThis[key]=old[key]}}
})
