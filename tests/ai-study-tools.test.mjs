import test,{before} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {fileURLToPath} from 'node:url'
let tools
before(async()=>{
 const bundle=await build({stdin:{contents:"export * from './studyTools.ts';export {runQueuedGeneration,queueRecovery} from './queue.ts'",resolveDir:fileURLToPath(new URL('../supabase/functions/generate-study/',import.meta.url))},bundle:true,write:false,format:'esm',platform:'neutral'})
 tools=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
})
const content='<h2>Queues</h2><p><mark>FIFO</mark> means first in first out. A queue uses FIFO to remove the earliest arrival.</p>'
const claim={tool:'highlights',content,content_format:'html',source_text:'A queue removes the earliest arrival first. FIFO means first in first out.',source_format:'markdown',highlights:['FIFO']}
const card=()=>({highlight_id:'h1',front:'What does FIFO mean?',back:'First in first out.',evidence:{source:'reviewer',quote:'FIFO means first in first out.'}})
const graph=()=>({nodes:[{id:'c1',label:'Queue',body:'A structure that removes the earliest arrival.',evidence:{source:'original',quote:'A queue removes the earliest arrival first.'}},{id:'c2',label:'FIFO',body:'First in first out.',evidence:{source:'reviewer',quote:'FIFO means first in first out.'}}],edges:[{from:'c1',to:'c2',label:'uses',explanation:'A queue follows FIFO to remove the earliest arrival.',evidence:{source:'reviewer',quote:'A queue uses FIFO to remove the earliest arrival.'}}]})
test('Highlights are matched to the saved rendered reviewer, including formatting, numeric entities and math',()=>{
 const refs=tools.toolReferences(claim);assert.equal(refs.highlights[0].text,'FIFO');assert.ok(refs.reviewer.includes(card().evidence.quote))
 assert.equal(tools.plainToolText('<p><strong>FIFO</strong> &amp; &#x3c1; <span data-latex="O(n)">rendered</span></p>','html'),'FIFO & ρ O(n)')
 assert.equal(tools.plainToolText('A **tree** is a connected graph without cycles.'),'A tree is a connected graph without cycles.')
 assert.throws(()=>tools.toolReferences({...claim,highlights:['not present']}),/not in the saved reviewer/)
 assert.throws(()=>tools.toolReferences({...claim,content:'Too short'}),/readable content/)
})
test('Card validation enforces all highlight IDs, distinct questions and quotes from the correct source',()=>{
 const refs=tools.toolReferences(claim),raw={cards:[card()]}
 assert.deepEqual(tools.validateStudyTool(raw,'highlights',refs),raw)
 assert.throws(()=>tools.validateStudyTool({cards:[]},'highlights',refs),/exactly one card/)
 assert.throws(()=>tools.validateStudyTool({cards:[{...card(),highlight_id:'made-up'}]},'highlights',refs),/highlight ID/)
 assert.throws(()=>tools.validateStudyTool({cards:[{...card(),evidence:{source:'original',quote:'A queue uses FIFO to remove the earliest arrival.'}}]},'highlights',refs),/not in its cited source/)
 assert.throws(()=>tools.validateStudyTool({cards:[{...card(),back:''}]},'highlights',refs),/answer.*missing/)
 const two=tools.toolReferences({...claim,highlights:['FIFO','queue']})
 assert.throws(()=>tools.validateStudyTool({cards:[card(),{...card(),highlight_id:'h2'}]},'highlights',two),/repeated questions/)
 assert.ok(JSON.stringify(tools.studyToolSchema('highlights')).length<1000)
})
test('Concept validation rejects invented quotes, arbitrary IDs, vague edges, duplicates and isolated nodes',()=>{
 const refs=tools.toolReferences({...claim,tool:'connections',highlights:[]})
 assert.deepEqual(tools.validateStudyTool(graph(),'connections',refs),graph())
 let raw=graph();raw.edges[0].to='c99';assert.throws(()=>tools.validateStudyTool(raw,'connections',refs),/two different supplied concept IDs/)
 raw=graph();raw.edges[0].evidence.quote='A queue is a type of tree.';assert.throws(()=>tools.validateStudyTool(raw,'connections',refs),/not in its cited source/)
 raw=graph();raw.edges[0].label='Shared passage';assert.throws(()=>tools.validateStudyTool(raw,'connections',refs),/specific semantic/)
 raw=graph();raw.edges.push({...raw.edges[0]});assert.throws(()=>tools.validateStudyTool(raw,'connections',refs),/distinct, specific/)
 raw=graph();raw.nodes.push({...raw.nodes[0],id:'c3',label:'Something else'});assert.throws(()=>tools.validateStudyTool(raw,'connections',refs),/isolated/)
 assert.match(tools.studyToolPrompt('connections'),/shared paragraph alone is insufficient/i)
 assert.match(tools.studyToolPrompt('highlights'),/surrounding material/)
})
test('A queued AI tool internally repairs a bad evidence draft, saves only once, and uses the existing stream/queue delivery',async()=>{
 const old={Deno:globalThis.Deno,fetch:globalThis.fetch},calls=[],requests=[],saved=[]
 const task={id:crypto.randomUUID(),lease_token:crypto.randomUUID(),asset_id:crypto.randomUUID(),user_id:crypto.randomUUID(),tool:'highlights',stage:'deck',attempts:1}
 globalThis.Deno={env:{get:key=>key==='GEMINI_API_KEY'?'test-only-key':undefined}}
 globalThis.fetch=async(url,options)=>{
  assert.match(String(url),/streamGenerateContent\?alt=sse/)
  const body=JSON.parse(options.body);requests.push(body)
  const output={cards:[card()]};if(requests.length===1)output.cards[0].evidence.quote='An invented quote should be rejected.'
  return new Response('data: '+JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(output)}]},finishReason:'STOP'}]})+'\n\n',{headers:{'Content-Type':'text/event-stream'}})
 }
 const admin={rpc:async(name,args)=>{calls.push([name,args]);if(name==='start_generation_task')return {data:task};if(name==='claim_study_tool')return {data:claim};if(name==='complete_study_tool'){saved.push(args.p_output);return {data:args.p_output}}return {data:0}}}
 try{
  assert.deepEqual(await tools.runQueuedGeneration(admin,{task_id:task.id,lease_token:task.lease_token}),{processed:true})
  assert.equal(requests.length,2);assert.equal(saved.length,1);assert.deepEqual(saved[0],{cards:[card()]})
  assert.equal(calls.filter(([name])=>name==='claim_study_tool').length,1,'A corrected draft keeps its one fenced claim')
  assert.equal(calls.filter(([name])=>name==='claim_queued_generation').length,0,'Tools do not create a new reviewer series or set')
  assert.ok(calls.some(([name])=>name==='dispatch_generation_queue'))
  assert.equal(requests[0].generationConfig.responseMimeType,'application/json')
  assert.equal(requests[0].generationConfig.responseJsonSchema,undefined,'Reuse the working JSON transport rather than a new API parameter')
  assert.match(requests[1].systemInstruction.parts[0].text,/replacement JSON object matching the study-tool contract/)
  assert.doesNotMatch(requests[1].systemInstruction.parts[0].text,/return complete Markdown for reviewers/)
  const changed=tools.queueRecovery(new Error('Reviewer changed. Save and reopen the study tool'),1)
  assert.equal(changed.reason,'source');assert.equal(changed.seconds,null)
 }finally{for(const[k,v]of Object.entries(old)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}}
})


test('A worker reuses a result completed after admission without another Gemini request',async()=>{
 const old=globalThis.fetch;let calls=0
 globalThis.fetch=async()=>{throw new Error('A cache hit must not call Gemini')}
 const output={cards:[card()]},task={id:crypto.randomUUID(),lease_token:crypto.randomUUID()}
 try{
  const result=await tools.executeStudyTool({rpc:async(name,args)=>{calls++;return name==='claim_study_tool'?{data:{cached_output:output}}:{data:args.p_output}}},task,Date.now()+130000)
  assert.deepEqual(result,output);assert.equal(calls,2)
 }finally{globalThis.fetch=old}
})
