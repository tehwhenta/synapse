import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const bundled=await build({entryPoints:[fileURLToPath(new URL('../supabase/functions/generate-study/guided.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral'})
const { validateAnalysis,validateGuidedOutput,guidedPrompt,guidedSchema }=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'))
const opts={workflow:'manual',total:10,true_false:3,multiple_choice:3,short_answer:4}
const questions=()=>Array.from({length:10},(_,i)=>({type:i<3?'true_false':i<6?'multiple_choice':'short_answer',question:'Distinct concept '+String.fromCharCode(97+i),options:i<3?['True','False']:i<6?['A','B','C','D']:[],answer:i<3?'True':'A',accepted_answers:[],explanation:'Source explanation',coverage_key:'source:facet_'+i}))
test('Analysis assigns stable topic IDs and accepts only integer, evenly divisible topic quiz estimates',()=>{
  const input={title:'Course',source_text:'A faithful extraction of every important source detail.',topics:[{title:'Topic A',description:'Scope of this topic',card_count:12,quiz_count:18}]}
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
