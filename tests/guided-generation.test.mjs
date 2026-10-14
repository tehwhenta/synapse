import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const bundled=await build({entryPoints:[fileURLToPath(new URL('../supabase/functions/generate-study/guided.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral'})
const { validateAnalysis,validateGuidedOutput,guidedPrompt,guidedSchema }=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'))
const coverageBundle=await build({entryPoints:[fileURLToPath(new URL('../supabase/functions/generate-study/coverage.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral'})
const {validateCoveredOutput,coveragePrompt,coverageSchema}=await import('data:text/javascript;base64,'+Buffer.from(coverageBundle.outputFiles[0].text).toString('base64'))
const opts={workflow:'manual',total:10,true_false:3,multiple_choice:3,short_answer:4}
const questions=()=>Array.from({length:10},(_,i)=>({type:i<3?'true_false':i<6?'multiple_choice':'short_answer',question:'Distinct concept '+String.fromCharCode(97+i),options:i<3?['True','False']:i<6?['A','B','C','D']:[],answer:i<3?'True':'A',accepted_answers:[],explanation:'Source explanation',coverage_key:'source:facet_'+i}))
test('Analysis assigns stable topic IDs and accepts only integer, evenly divisible topic quiz estimates',()=>{
  const input={title:'Course',source_text:'A faithful extraction of every important source detail.',topics:[{title:'Topic A',description:'Scope of this topic',card_count:12,quiz_count:18,concepts:[{label:'A precise educational facet',covered_by:[]}]} ]}
  assert.equal(validateAnalysis(input).topics[0].id,'topic-1')
  for(const count of [10,0,33,3.5,'18']) assert.throws(()=>validateAnalysis({...input,topics:[{...input.topics[0],quiz_count:count}]}),/estimates/)
  assert.throws(()=>validateAnalysis({...input,topics:[...input.topics,...input.topics]}),/repeated a topic/)
  assert.equal(validateAnalysis({...input,source_text:'A short AI summary.'},input.source_text).source_text,input.source_text)
})
test('Guided quiz validates exact total and type distribution, answers, and four-option MCQs',()=>{
  const quiz=questions();assert.equal(validateGuidedOutput({quiz},'quiz',opts).quiz.length,10)
  assert.throws(()=>validateGuidedOutput({quiz:quiz.slice(1)},'quiz',opts),/requested number/)
  const bad=questions();bad[0]={...bad[0],type:'short_answer',options:[],answer:'A'};assert.throws(()=>validateGuidedOutput({quiz:bad},'quiz',opts),/quantities/)
  const badOptions=questions();badOptions[3].options.pop();assert.throws(()=>validateGuidedOutput({quiz:badOptions},'quiz',opts),/choices/)
  const badAnswer=questions();badAnswer[3].answer='E';assert.throws(()=>validateGuidedOutput({quiz:badAnswer},'quiz',opts),/choices/)
  assert.match(guidedPrompt('quiz',opts),/EXACTLY 10 questions: 3 true_false, 3 multiple_choice, and 4 short_answer/)
  assert.equal(guidedSchema('quiz',opts).properties.quiz.maxItems,10)
})
test('Freshness rejects normalized copies, similar prompts, repeated objectives, and within-set duplicates',()=>{
  const deck={flashcards:[{front:'Explain how cells divide during mitosis',back:'A process explanation',coverage_key:'mitosis:division'},{front:'Define interphase',back:'A preparation phase',coverage_key:'interphase:definition'},{front:'List the stages',back:'A complete list',coverage_key:'mitosis:enumeration'}]}
  const options={total:3}
  assert.throws(()=>validateGuidedOutput(deck,'deck',options,[{prompt:'EXPLAIN HOW CELLS DIVIDE DURING MITOSIS!',coverage_key:'other'}]),/repeated/)
  assert.throws(()=>validateGuidedOutput(deck,'deck',options,[{prompt:'Explain how plant cells divide during mitosis',coverage_key:'other'}]),/repeated/)
  assert.throws(()=>validateGuidedOutput(deck,'deck',options,[{prompt:'Describe the mechanics',coverage_key:'mitosis:division'}]),/repeated/)
  const repeated=structuredClone(deck);repeated.flashcards[1].coverage_key='mitosis:division';assert.throws(()=>validateGuidedOutput(repeated,'deck',options),/repeated/)
  assert.equal(validateGuidedOutput(deck,'deck',options).flashcards.length,3)
})
test('Reviewer rejects copies and requires a new pedagogical emphasis while keeping comprehensive math guidance',()=>{
  assert.throws(()=>validateGuidedOutput({notes:'# Notes\nDetailed explanation.'},'note',{},[{prompt:'# Notes\nDetailed explanation.'}]),/repeated/)
  const prompt=guidedPrompt('note',{angle:'worked_examples'})
  assert.match(prompt,/comprehensive set of notes/);assert.match(prompt,/line-by-line worked solution/);assert.match(prompt,/worked_examples/)
})
test('Large source transport uses Gemini Files API and deletes the provider copy',async()=>{
  const previousFetch=globalThis.fetch
  const bundle=await build({entryPoints:[fileURLToPath(new URL('../supabase/functions/generate-study/transport.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral'})
  const {geminiFilePart,deleteGeminiFiles}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
  const calls=[]
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});if(calls.length===1)return new Response('',{headers:{'x-goog-upload-url':'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=test'}});if(calls.length===2)return Response.json({file:{name:'files/test',uri:'https://generativelanguage.googleapis.com/v1beta/files/test',state:'ACTIVE'}});return new Response('',{status:200})}
  try {
    const cleanup=[],blob=new Blob([new Uint8Array(7*1024*1024)])
    const part=await geminiFilePart(blob,'application/pdf','fake-key',cleanup)
    assert.equal(part.fileData.mimeType,'application/pdf');assert.deepEqual(cleanup,['files/test']);assert.equal(calls[1].init.body,blob)
    await deleteGeminiFiles(cleanup,'fake-key');assert.equal(calls.at(-1).init.method,'DELETE')
    globalThis.fetch=async()=>new Response('',{headers:{'x-goog-upload-url':'https://evil.example/upload'}})
    await assert.rejects(geminiFilePart(blob,'application/pdf','fake-key',[]),/invalid upload address/)
  } finally {globalThis.fetch=previousFetch}
})
test('Gemini errors preserve actionable 400 details, redact credentials, and do not retry rejected requests',async()=>{
  const previousFetch=globalThis.fetch,previousDeno=globalThis.Deno,previousLog=console.error
  const bundle=await build({entryPoints:[fileURLToPath(new URL('../supabase/functions/generate-study/transport.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral'})
  const {geminiJson}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
  const key='mock-private-api-key',logs=[]
  let calls=0
  globalThis.Deno={env:{get:()=> ' models/gemini-3.5-flash-lite '}}
  console.error=(...args)=>logs.push(args.join(' '))
  globalThis.fetch=async(url,request)=>{
    calls++;assert.equal(String(url),'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse')
    assert.equal(request.headers['x-goog-api-key'],key)
    return Response.json({error:{code:400,status:'INVALID_ARGUMENT',message:'Request contains an invalid argument. '+key+' Bearer private-token https://example.invalid/file?key='+key,details:[{fieldViolations:[{field:'generation_config.response_json_schema',description:'Too many states in the response schema.'}]}]}},{status:400})
  }
  try {
    await assert.rejects(geminiJson(key,'private source instructions',[{text:'private source text'}],{type:'object'},30000,.35),error=>{
      assert.match(error.message,/400 INVALID_ARGUMENT; model gemini-3\.5-flash-lite/)
      assert.match(error.message,/generation_config.response_json_schema: Too many states/)
      assert.ok(!error.message.includes(key));assert.ok(!error.message.includes('private-token'));assert.ok(!error.message.includes('https://'))
      return true
    })
    assert.equal(calls,1)
    assert.ok(!logs.join(' ').includes(key));assert.ok(!logs.join(' ').includes('private source'))
    globalThis.fetch=async()=>Response.json({error:{status:'RESOURCE_EXHAUSTED',message:'Daily quota exceeded.'}},{status:429})
    await assert.rejects(geminiJson(key,'prompt',[{text:'source'}],{},20,.7),/Gemini quota exceeded \(429 RESOURCE_EXHAUSTED/)
    globalThis.fetch=async()=>new Response('<html>Untrusted error '+key+'</html>',{status:400})
    await assert.rejects(geminiJson(key,'prompt',[{text:'source'}],{},20,.7),error=>{
      assert.match(error.message,/Google rejected a request parameter or project prerequisite/)
      assert.ok(!error.message.includes(key));assert.ok(!error.message.includes('<html>'));return true
    })
  }finally{globalThis.fetch=previousFetch;globalThis.Deno=previousDeno;console.error=previousLog}
})
test('Nested Word/PowerPoint source analysis uses JSON mode, preserves its contract, and still rejects invalid inventories',async()=>{
  const previousFetch=globalThis.fetch,previousDeno=globalThis.Deno
  const bundle=await build({entryPoints:[fileURLToPath(new URL('../supabase/functions/generate-study/transport.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral'})
  const {geminiJson}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
  const {analysisSchema,analysisPrompt}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'))
  const source='A queue uses FIFO ordering. Enqueue adds at the rear and dequeue removes the front item.'
  const output={title:'Queues',source_text:source,topics:[{title:'Queue operations',description:'Queue insertion and removal',card_count:3,quiz_count:6,concepts:[{label:'FIFO ordering',covered_by:[]}]}]}
  let requests=0
  globalThis.Deno={env:{get:()=> 'gemini-3.5-flash-lite'}}
  globalThis.fetch=async(_url,request)=>{
    requests++
    const body=JSON.parse(request.body)
    assert.deepEqual(body.generationConfig,{maxOutputTokens:30000,responseMimeType:'application/json'})
    assert.ok(body.systemInstruction.parts[0].text.startsWith(analysisPrompt))
    const contract=JSON.parse(body.systemInstruction.parts[0].text.split('\n').at(-1))
    assert.deepEqual(contract,analysisSchema)
    assert.deepEqual(body.contents,[{role:'user',parts:[{text:source}]}])
    // Emulate the provider rejecting the old constrained-schema request.
    if ('responseJsonSchema' in body.generationConfig || 'responseSchema' in body.generationConfig) return Response.json({error:{status:'INVALID_ARGUMENT',message:'Request contains an invalid argument.'}},{status:400})
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(output)}]}}]})
  }
  try {
    const raw=await geminiJson('mock-only',analysisPrompt,[{text:source}],analysisSchema,30000,.2)
    assert.equal(requests,1)
    assert.equal(validateAnalysis(raw,source).topics[0].concepts[0].id,'topic-1:concept-1')
    const invalid=structuredClone(raw);invalid.topics[0].quiz_count=10
    assert.throws(()=>validateAnalysis(invalid,source),/estimates/)
    invalid.topics[0].quiz_count=6;invalid.topics[0].concepts[0].covered_by=['quiz']
    assert.throws(()=>validateAnalysis(invalid,source),/invalid concept/)
  }finally{globalThis.fetch=previousFetch;globalThis.Deno=previousDeno}
})
test('Concept inventory maps prior content only to formats with supporting history and never accepts duplicate facets',()=>{
 const raw={title:'Course',source_text:'Source with a complete definition of this concept.',topics:[{title:'Topic',description:'Educational scope',card_count:3,quiz_count:3,concepts:[{label:'The definition of a concept',covered_by:['note']}]}]}
 assert.throws(()=>validateAnalysis(raw),/invalid concept/)
 const value=validateAnalysis(raw,null,[{kind:'note'}]);assert.equal(value.topics[0].concepts[0].id,'topic-1:concept-1')
 const duplicate=structuredClone(raw);duplicate.topics[0].concepts.push({...duplicate.topics[0].concepts[0]})
 assert.throws(()=>validateAnalysis(duplicate,null,[{kind:'note'}]),/repeated/)
})
test('Paid generation accepts only finite supplied concept IDs and a reviewer must cover every remaining ID',()=>{
 const concepts=[{id:'topic-1:concept-1',label:'Definition',topic_id:'topic-1'},{id:'topic-1:concept-2',label:'Application',topic_id:'topic-1'},{id:'topic-1:concept-3',label:'A distinction',topic_id:'topic-1'}]
 const raw={flashcards:concepts.map((c,i)=>({front:'Distinct prompt '+i,back:'Source answer.',concept_id:c.id}))}
 assert.equal(validateCoveredOutput(raw,'deck',{total:3},[],concepts).flashcards[0].coverage_key,concepts[0].id)
 const bad=structuredClone(raw);bad.flashcards[0].concept_id='invented';assert.throws(()=>validateCoveredOutput(bad,'deck',{total:3},[],concepts),/invented/)
 bad.flashcards[0].concept_id=bad.flashcards[1].concept_id;assert.throws(()=>validateCoveredOutput(bad,'deck',{total:3},[],concepts),/reused/)
 assert.throws(()=>validateCoveredOutput({notes:'Notes',covered_concepts:[concepts[0].id]},'note',{},[],concepts),/all remaining/)
 assert.equal(validateCoveredOutput({notes:'Complete explanatory notes',covered_concepts:concepts.map(c=>c.id)},'note',{},[],concepts).covered_concepts.length,3)
 assert.match(coveragePrompt('deck',{total:3}),/Never invent or rename/)
 const manyConcepts=Array.from({length:500},(_,i)=>({id:'topic-1:concept-'+(i+1),label:'A distinct facet '+i,topic_id:'topic-1'}))
 for(const kind of ['note','deck','quiz']) {
  const shape=coverageSchema(kind,{total:30},manyConcepts)
  assert.ok(JSON.stringify(shape).length<2500,'Request schema stays small for a full concept inventory')
  assert.ok(!JSON.stringify(shape).includes('topic-1:concept-500'))
 }
})
