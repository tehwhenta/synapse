import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {fileURLToPath} from 'node:url'
const bundle=await build({stdin:{contents:"export * from './transport.ts';export * from './metrics.ts';export * from './reliable.ts';export * from './stream.ts'",resolveDir:fileURLToPath(new URL('../supabase/functions/generate-study/',import.meta.url))},bundle:true,write:false,platform:'neutral',format:'esm'})
const {geminiText,geminiJson,GenerationMetrics,runDraftPipeline,generationProgressReporter,readGeminiStream}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const chunk=(text,finish,usage)=>({candidates:[{content:{parts:[{text}]},...(finish?{finishReason:finish}:{})}],...(usage?{usageMetadata:usage}:{})})
function sse(payloads,split=7){
 const bytes=new TextEncoder().encode(payloads.map(p=>'data: '+JSON.stringify(p)+'\r\n\r\n').join(''))
 let offset=0
 return new Response(new ReadableStream({pull(controller){if(offset>=bytes.length){controller.close();return}controller.enqueue(bytes.slice(offset,offset+split));offset+=split}}),{headers:{'content-type':'text/event-stream'}})
}
test('SSE preserves split UTF-8, equations and full text, observes cumulative token usage once, and reports chunks before completion',async()=>{
 const old={Deno:globalThis.Deno,fetch:globalThis.fetch};let request,elapsed=0;const updates=[];const metrics=new GenerationMetrics(()=>++elapsed)
 metrics.progress=(draft,chars)=>updates.push({draft,chars})
 globalThis.Deno={env:{get:()=> 'gemini-3.5-flash-lite'}}
 globalThis.fetch=async(url,options)=>{request={url,body:JSON.parse(options.body)};return sse([chunk('# Résumé\n',null,{promptTokenCount:100,candidatesTokenCount:2}),chunk('β + x = 3\n\nEvery source concept stays.','STOP',{promptTokenCount:100,candidatesTokenCount:18})],1)}
 try{
  const text=await geminiText('test-key','Comprehensive reviewer',[{text:'Full source'}],24000,1,120000,metrics)
  assert.equal(text,'# Résumé\nβ + x = 3\n\nEvery source concept stays.')
  assert.match(request.url,/:streamGenerateContent\?alt=sse$/);assert.equal(request.body.generationConfig.maxOutputTokens,24000)
  assert.equal(metrics.values.input_tokens,100);assert.equal(metrics.values.output_tokens,18);assert.equal(metrics.values.stream_chunks,2);assert.ok(metrics.values.first_token_ms>=0)
  assert.ok(updates.some(u=>u.chars>0 && u.chars<text.length))
 }finally{Object.assign(globalThis,old)}
})
test('Split JSON is parsed only after STOP; truncation, abrupt EOF and invalid event JSON never become saved sets',async()=>{
 const old={Deno:globalThis.Deno,fetch:globalThis.fetch};globalThis.Deno={env:{get:()=> 'gemini-3.5-flash-lite'}}
 try{
  globalThis.fetch=async()=>sse([chunk('{"flashcards":[{"front":"Q",'),chunk('"back":"A"}]}','STOP')])
  assert.deepEqual(await geminiJson('key','Instructions',[],{},16000),{flashcards:[{front:'Q',back:'A'}]})
  for(const events of [[chunk('Incomplete','MAX_TOKENS')],[chunk('Closed-looking text but no finish event')]]){
   globalThis.fetch=async()=>sse(events)
   await assert.rejects(geminiText('key','Instructions',[],24000),/output limit|before the study set was complete/)
  }
  globalThis.fetch=async()=>new Response('data: {bad}\n\n',{headers:{'content-type':'text/event-stream'}})
  await assert.rejects(geminiText('key','Instructions',[],24000),/unreadable stream event/)
 }finally{Object.assign(globalThis,old)}
})
test('A stalled reader is cancelled on abort, and partial output is discarded',async()=>{
 let cancelled=false
 const response=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(chunk('partial'))+'\n\n'))},cancel(){cancelled=true}}))
 const control=new AbortController();let received=0
 const work=readGeminiStream(response,()=>{received++;control.abort(new DOMException('Deadline','TimeoutError'))},control.signal)
 await assert.rejects(work,/Deadline/);assert.equal(received,1);assert.equal(cancelled,true)
})
test('Productive long generations finish in one call within the worker deadline without lowering output detail',async()=>{
 let elapsed=0,calls=0,saves=0,budget
 const detailed='# Source\n'+('A substantive complete explanation with terminology and equations.\n'.repeat(200))
 const result=await runDraftPipeline({deadline:130000,now:()=>elapsed,generate:async(_revision,timeout)=>{budget=timeout;calls++;assert.ok(timeout>90000);elapsed+=90000;return detailed},validate:value=>value,save:async value=>{elapsed+=20;saves++;return value}})
 assert.equal(budget,120000);assert.equal(calls,1);assert.equal(saves,1);assert.equal(result,detailed);assert.ok(elapsed<130000)
})
test('Progress reporting coalesces high-frequency chunks without blocking generation or parallel writes',async()=>{
 let elapsed=0,writes=0,active=0,peak=0,release
 const admin={rpc(){writes++;active++;peak=Math.max(peak,active);return new Promise(resolve=>{release=()=>{active--;resolve({data:true})}})}}
 const reporter=generationProgressReporter(admin,{id:'task',lease_token:'lease'},()=>elapsed)
 for(let i=1;i<=1000;i++)reporter.update(1,i)
 assert.equal(writes,1);elapsed=9000;reporter.update(1,1100);assert.equal(writes,1)
 release();await Promise.resolve();await Promise.resolve();reporter.update(1,1200);assert.equal(writes,2)
 release();await reporter.close();assert.equal(peak,1);reporter.update(1,1300);assert.equal(writes,2)
})
