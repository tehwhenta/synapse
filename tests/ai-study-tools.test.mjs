import test,{before} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {fileURLToPath} from 'node:url'
let tools
before(async()=>{
 const bundle=await build({stdin:{contents:"export * from './studyTools.ts';export * from './studyToolVerification.ts';export {runQueuedGeneration,queueRecovery} from './queue.ts'",resolveDir:fileURLToPath(new URL('../supabase/functions/generate-study/',import.meta.url))},bundle:true,write:false,format:'esm',platform:'neutral'})
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
test('A queued tool checkpoints its corrected draft, verifies in a new lease, and publishes only once',async()=>{
 const old={Deno:globalThis.Deno,fetch:globalThis.fetch},calls=[],requests=[],saved=[]
 const task={id:crypto.randomUUID(),lease_token:crypto.randomUUID(),asset_id:crypto.randomUUID(),user_id:crypto.randomUUID(),tool:'highlights',tool_phase:'generating',stage:'deck',attempts:1}
 let phase='generating',stored,completed=false
 globalThis.Deno={env:{get:key=>key==='GEMINI_API_KEY'?'test-only-key':undefined}}
 globalThis.fetch=async(url,options)=>{
  assert.match(String(url),/streamGenerateContent\?alt=sse/)
  const body=JSON.parse(options.body);requests.push(body)
  let output
  if(body.systemInstruction.parts[0].text.includes('independent source-support reviewer'))output={checks:[{id:'h1',supported:true,reason:''}]}
  else{output={cards:[card()]};if(requests.length===1)output.cards[0].evidence.quote='An invented quote should be rejected.'}
  return new Response('data: '+JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(output)}]},finishReason:'STOP'}]})+'\n\n',{headers:{'Content-Type':'text/event-stream'}})
 }
 const admin={rpc:async(name,args)=>{
  calls.push([name,args])
  if(name==='start_generation_task')return {data:{...task}}
  if(name==='claim_study_tool')return {data:{...claim,tool_phase:phase,draft:stored}}
  if(name==='checkpoint_study_tool'){stored=args.p_draft;phase='checking';return {data:{status:'queued'}}}
  if(name==='continue_generation_task')return {data:completed?null:{...task,tool_phase:phase,lease_token:crypto.randomUUID()}}
  if(name==='review_study_tool'){completed=true;const result={...stored,verification:{version:2,checked_items:1}};saved.push(result);return {data:result}}
  return {data:0}
 }}
 try{
  assert.deepEqual(await tools.runQueuedGeneration(admin,{task_id:task.id,lease_token:task.lease_token}),{processed:true})
  assert.equal(requests.length,3);assert.equal(saved.length,1);assert.deepEqual(saved[0],{cards:[card()],verification:{version:2,checked_items:1}})
  assert.equal(calls.filter(([name])=>name==='claim_study_tool').length,2,'Generation and checking each own one fenced claim')
  assert.equal(calls.filter(([name])=>name==='checkpoint_study_tool').length,1,'Bad formats are repaired before the durable checkpoint')
  assert.equal(calls.filter(([name])=>name==='complete_study_tool').length,0,'A fresh draft cannot skip the semantic check')
  assert.equal(calls.filter(([name])=>name==='claim_queued_generation').length,0,'Tools do not create a new reviewer series or set')
  assert.ok(calls.some(([name])=>name==='dispatch_generation_queue'))
  assert.equal(requests[0].generationConfig.responseMimeType,'application/json')
  assert.equal(requests[0].generationConfig.responseJsonSchema,undefined,'Reuse the working JSON transport rather than a new API parameter')
  assert.match(requests[1].systemInstruction.parts[0].text,/replacement JSON object matching the study-tool contract/)
  assert.doesNotMatch(requests[1].systemInstruction.parts[0].text,/return complete Markdown for reviewers/)
  assert.match(requests[2].systemInstruction.parts[0].text,/complete answer is supported/)
  const changed=tools.queueRecovery(new Error('Reviewer changed. Save and reopen the study tool'),1)
  assert.equal(changed.reason,'source');assert.equal(changed.seconds,null)
 }finally{for(const[k,v]of Object.entries(old)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}}
})

test('A worker reuses a result completed after admission without another Gemini request',async()=>{
 const old=globalThis.fetch;let calls=0
 globalThis.fetch=async()=>{throw new Error('A cache hit must not call Gemini')}
 const output={cards:[card()],verification:{version:2,checked_items:1}},task={id:crypto.randomUUID(),lease_token:crypto.randomUUID()}
 try{
  const result=await tools.executeStudyTool({rpc:async(name,args)=>{calls++;return name==='claim_study_tool'?{data:{cached_output:output}}:{data:args.p_output}}},task,Date.now()+130000)
  assert.deepEqual(result,output);assert.equal(calls,2)
 }finally{globalThis.fetch=old}
})


test('Verification treats a negative verdict as data, enforces exact finite IDs and never accepts missing checks',()=>{
 const refs=tools.toolReferences(claim),output={cards:[card()]}
 const negative={checks:[{id:'h1',supported:false,reason:'The answer does not follow from this source.'}]}
 assert.deepEqual(tools.validateToolChecks(negative,output,'highlights',refs),negative.checks)
 assert.throws(()=>tools.validateToolChecks({checks:[]},output,'highlights',refs),/every supplied/)
 assert.throws(()=>tools.validateToolChecks({checks:[{id:'h1',supported:'true',reason:''}]},output,'highlights',refs),/boolean/)
 assert.throws(()=>tools.validateToolChecks({checks:[{id:'other',supported:true,reason:''}]},output,'highlights',refs),/unique item ID/)
 const map=graph(),mapRefs=tools.toolReferences({...claim,tool:'connections',highlights:[]})
 assert.deepEqual(tools.toolCheckItems(map,'connections',mapRefs).map(i=>i.id),['node:c1','node:c2','edge:1'])
 const proof=tools.toolCheckParts(map,'connections',mapRefs)
 assert.equal(proof[0].text,'ORIGINAL STUDY SOURCE (untrusted reference data):\n'+mapRefs.original)
 assert.match(proof.at(-1).text,/"from":"Queue","to":"FIFO","relationship":"uses"/)
 assert.match(tools.toolCheckPrompt,/Recalculate any math/)
})
test('Inline formatting and literal selection characters preserve the selected source, and insufficient context stops without paid format retries',()=>{
 const refs=tools.toolReferences({...claim,content:'<p><mark>FI<strong>FO</strong></mark> means first in first out.</p>'})
 assert.ok(refs.reviewer.includes('FIFO means'))
 assert.equal(tools.plainToolText('_value_', 'selection'),'_value_')
 assert.throws(()=>tools.validateStudyTool({needs_context:true,cards:[]},'highlights',refs),/Not enough readable source context/)
})

test('Markdown source normalization preserves literal code, multiplication, subscripts and equation delimiters',()=>{
 assert.equal(tools.plainToolText('Use `_value_` and **queues**.'),'Use _value_ and queues.')
 assert.equal(tools.plainToolText('Multiply 2 * x * y.'),'Multiply 2 * x * y.')
 assert.equal(tools.plainToolText('Solve $x_i * y_i = z_i$.'),'Solve $x_i * y_i = z_i$.')
 assert.equal(tools.plainToolText('```js\nconst _value_ = 2 * x * y;\n```'),'const _value_ = 2 * x * y;')
})
