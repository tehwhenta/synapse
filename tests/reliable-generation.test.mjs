import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root=fileURLToPath(new URL('../supabase/functions/generate-study/',import.meta.url))
const bundle=await build({stdin:{contents:"export * from './automatic.ts'; export * from './guided.ts'; export * from './errors.ts'; export * from './reliable.ts'; export * from './transport.ts'",resolveDir:root},bundle:true,write:false,format:'esm',platform:'neutral'})
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const {validateAutomatic,validateGuidedOutput,historyReference,learningVariants,automaticPrompt,runDraftPipeline,StudyDraftError,GeminiRequestError,geminiJson}=api

test('A fresh reviewer may reuse source definitions and vocabulary without the retired 40% copying rule',()=>{
  const facts=[
    'A queue preserves first-in, first-out ordering: enqueue inserts an item at the rear, while dequeue removes the earliest remaining arrival from the front. Peek reads the front without changing the queue.',
    'A stack preserves last-in, first-out ordering: push places an item on the top, while pop removes the most recently pushed remaining item. Peek reads the top without changing the stack.',
    'An empty structure contains no items, so removal requires an emptiness check before accessing an item. A bounded implementation additionally checks whether an insertion would exceed its available capacity.',
  ]
  const source=facts.join('\n\n')
  const older='# Foundations\n\n'+source+'\n\n'+[
    'Consider an arrival list before choosing an operation. A queue maintains the relationship between the arrival position and the removal position, so reasoning begins at the front rather than the newest item.',
    'The top of a stack records the most recent unmatched insertion. Trace a push by changing that position, and trace a pop by consuming it; the surviving earlier items become available afterwards.',
    'Capacity and emptiness answer different questions. An insertion checks the available room, whereas a removal checks the availability of an existing item. Confusing them causes invalid operations.',
  ].join('\n\n')
  const fresh='# Worked applications\n\n'+source+'\n\n'+[
    'For an illustrative queue containing A then B, removing once returns A. The remaining front is B. This follows from arrival order, so a later insertion at the rear cannot change which remaining item is first.',
    'For an illustrative stack containing X then Y, removing once returns Y. X becomes the accessible top. This application connects the insertion order to the opposite removal order rather than reciting a definition.',
    'When diagnosing a failed removal, check the number of stored items first. A full container still has removable items; an empty container does not. Trace the operation in question instead of using the wrong boundary test.',
  ].join('\n\n')
  assert.throws(()=>validateGuidedOutput({notes:fresh},'note',{},[{prompt:older}]),/repeated|reused/)
  assert.equal(validateAutomatic(fresh,'note',[{prompt:older}],source).notes,fresh)
  assert.throws(()=>validateAutomatic(older.replace('# Foundations','# A new title'),'note',[{prompt:older}],source),/repeated/)
  assert.equal(validateAutomatic('```json\n'+JSON.stringify({notes:fresh})+'\n```','note').notes,fresh)
  assert.throws(()=>validateAutomatic('{"notes":"An unfinished reviewer string','note'),/incomplete reviewer/)
})

test('Copied explanations still fail, while useful one- and two-item sets and harmless aliases normalize safely',()=>{
  const paragraphs=Array.from({length:4},(_,i)=>`Explanation ${i}: `+'Trace the operations in order and describe why each changes the accessible item rather than merely naming the data structure. Preserve the relationship between insertion and removal while checking boundaries.')
  const earlier=paragraphs.join('\n\n')
  const copied=paragraphs.slice(0,3).join('\n\n')+'\n\nA fresh but short conclusion does not make the copied explanations useful.'
  assert.throws(()=>validateAutomatic(copied,'note',[{prompt:earlier}]),/reused/)
  const one=validateAutomatic({cards:[{question:'What does enqueue do?',answer:'It inserts at the rear.'}]},'deck')
  assert.equal(one.flashcards.length,1)
  assert.equal(one.flashcards[0].coverage_key,validateAutomatic({flashcards:[{front:'What does enqueue do?',back:'It inserts at the rear.'}]},'deck').flashcards[0].coverage_key)
  assert.throws(()=>validateAutomatic({cards:[{question:'What does enqueue do?',answer:'Rear insertion.'}]},'deck',[{prompt:one.flashcards[0].front}]),/repeated/)
  const quiz=validateAutomatic({questions:[{question_type:'Multiple Choice',question:'Which operation inserts at the rear?',options:['A. Enqueue','B. Dequeue','C. Peek','D. Sort'],correct_answer:'A.',rationale:'Enqueue appends to the queue.'},{type:'Identification',question:'Name the removal operation.',answer:'Dequeue',rationale:'It removes at the front.'}]},'quiz')
  assert.equal(quiz.quiz.length,2);assert.equal(quiz.quiz[0].answer,'Enqueue');assert.equal(quiz.quiz[1].type,'short_answer')
  assert.throws(()=>validateAutomatic({quiz:[{question:'An unanswered question.',type:'short_answer',options:[]}]},'quiz'),/invalid/)
  assert.throws(()=>validateAutomatic({flashcards:[one.flashcards[0],one.flashcards[0]]},'deck'),/repeated/)
})

test('Initial generation plus five refreshes use six different treatments for every format',()=>{
  assert.equal(new Set(learningVariants).size,6)
  for(const kind of ['note','deck','quiz'])for(const [index,variant] of learningVariants.entries()){
    const prompt=automaticPrompt(kind,variant,index+1)
    assert.ok(prompt.includes(variant));assert.ok(prompt.includes('saved set '+(index+1)))
    assert.match(prompt,/not merely a different title/)
    if(index>0 && kind!=='note')assert.match(prompt,/Do not force the initial set size/)
  }
})

test('Bounded reviewer history includes the initial notes and the ends of the most recent notes',()=>{
 const past=Array.from({length:6},(_,i)=>({prompt:'Start '+i+'\n'+'Middle explanation. '.repeat(1500)+'\nEnd '+i}))
 const reference=historyReference('note',past)
 assert.equal(reference.length,4)
 assert.match(reference[0].reviewer_excerpt,/Start 0/);assert.match(reference[0].reviewer_excerpt,/End 0/)
 for(let i=1;i<4;i++)assert.ok(reference[i].reviewer_excerpt.includes('End '+(i+2)))
 assert.ok(reference.every(item=>item.reviewer_excerpt.length<19000))
})

test('Malformed, empty, truncated and premature-exhaustion drafts recover within one action and save only once',async()=>{
  for(const code of ['format','empty','truncated','exhausted']){
    let drafts=0,saves=0
    const result=await runDraftPipeline({deadline:Date.now()+130000,generate:async(revision,timeout)=>{
      drafts++;assert.ok(timeout<=60000)
      if(drafts===1)throw new StudyDraftError(code,'Mock first draft defect')
      assert.match(revision,/DRAFT REVISION/);return {flashcards:[{front:'How does a queue preserve arrival order?',back:'Insertion at the rear and removal at the front.'}]}
    },validate:raw=>validateAutomatic(raw,'deck'),save:async output=>{saves++;return output}})
    assert.equal(drafts,2);assert.equal(saves,1);assert.equal(result.flashcards.length,1)
  }
})

test('A transactional duplicate save can be revised using the same claim; unknown save outcomes cannot be retried',async()=>{
  let drafts=0,saves=0
  const result=await runDraftPipeline({deadline:Date.now()+130000,generate:async revision=>{drafts++;if(drafts===2)assert.match(revision,/different explanation/);return {flashcards:[{front:'Trace operation '+drafts,back:'A valid answer.',coverage_key:'trace:operation_'+drafts}]}},validate:raw=>validateAutomatic(raw,'deck'),save:async output=>{saves++;if(saves===1)throw new Error('AI repeated an earlier question or learning objective. Existing sets are kept');return output}})
  assert.equal(drafts,2);assert.equal(saves,2);assert.match(result.flashcards[0].front,/2$/)
  drafts=0;saves=0
  await assert.rejects(runDraftPipeline({deadline:Date.now()+130000,generate:async()=>{drafts++;return {}},validate:()=>({}),save:async()=>{saves++;throw new Error('Database response lost after saving')}}),/response lost/)
  assert.equal(drafts,1);assert.equal(saves,1)
})

test('Persistent invalid output stops after three drafts; the total deadline and nonretryable errors are respected',async()=>{
  let calls=0,saves=0
  await assert.rejects(runDraftPipeline({deadline:Date.now()+130000,generate:async()=>{calls++;return {flashcards:[null]}},validate:raw=>validateAutomatic(raw,'deck'),save:async()=>{saves++}}),/incomplete question/)
  assert.equal(calls,3);assert.equal(saves,0)
  let elapsed=0;calls=0
  await assert.rejects(runDraftPipeline({deadline:130000,now:()=>elapsed,generate:async(_revision,timeout)=>{calls++;elapsed+=timeout;throw new StudyDraftError('format','Still incomplete')},validate:()=>({}),save:async()=>{throw new Error('must not save')}}),/Still incomplete/)
  assert.equal(calls,2);assert.equal(elapsed,120000)
  for(const status of [400,401,402,403,404,429]){
    calls=0
    await assert.rejects(runDraftPipeline({deadline:Date.now()+130000,generate:async()=>{calls++;throw new GeminiRequestError(status,'provider rejection '+status)},validate:()=>({}),save:async()=>({})}),new RegExp(String(status)))
    assert.equal(calls,1)
  }
})

test('Transient provider errors back off and recover within the same bounded action',async()=>{
  let calls=0;const delays=[]
  const value=await runDraftPipeline({deadline:Date.now()+130000,pause:async ms=>delays.push(ms),generate:async()=>{calls++;if(calls<3)throw new GeminiRequestError(503,'Temporary unavailability');return 'complete'},validate:raw=>raw,save:async output=>output})
  assert.equal(value,'complete');assert.equal(calls,3);assert.equal(delays.length,2);assert.ok(delays[1]>delays[0])
})

test('Actual Gemini JSON parsing and MAX_TOKENS handling trigger in-action revision, without parsing guessed partial answers',async()=>{
  const old={Deno:globalThis.Deno,fetch:globalThis.fetch}
  globalThis.Deno={env:{get:()=> 'gemini-3.5-flash-lite'}}
  try{
    for(const fault of ['json','truncated','empty']){
      let calls=0,saves=0
      globalThis.fetch=async(_url,request)=>{
        calls++;const payload=JSON.parse(request.body)
        if(calls===1)return Response.json({candidates:[{finishReason:fault==='truncated'?'MAX_TOKENS':'STOP',content:{parts:[{text:fault==='json'?'{"flashcards":[':fault==='empty'?'':'A partial answer'}]}}]})
        assert.match(payload.systemInstruction.parts[0].text,/DRAFT REVISION/)
        return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({flashcards:[{front:'Name the front-removal operation.',back:'Dequeue.'}]})}]}}]})
      }
      await runDraftPipeline({deadline:Date.now()+130000,generate:(revision,timeout)=>geminiJson('mock-only','Return flashcards'+revision,[{text:'Queue source'}],{},16000,1,timeout),validate:raw=>validateAutomatic(raw,'deck'),save:async output=>{saves++;return output}})
      assert.equal(calls,2);assert.equal(saves,1)
    }
  }finally{for(const [k,v] of Object.entries(old)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}}
})

test('Source extraction revision stays faithful Markdown and does not ask Gemini to generate study materials',async()=>{
 let drafts=0
 const text=await runDraftPipeline({task:'source',deadline:Date.now()+130000,generate:async revision=>{
  drafts++;if(drafts===1)throw new StudyDraftError('truncated','Partial extraction')
  assert.match(revision,/faithful extracted Markdown only/);assert.match(revision,/without JSON or generated study notes/)
  assert.doesNotMatch(revision,/Keep every substantive reviewer topic/)
  return 'A faithful extraction of the supplied course material.'
 },validate:raw=>raw,save:async output=>output})
 assert.equal(drafts,2);assert.match(text,/faithful extraction/)
})
