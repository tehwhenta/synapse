import test from 'node:test'
import assert from 'node:assert/strict'
import { build, transform } from 'esbuild'
import { readFileSync } from 'node:fs'
import { quizResult, studyStreak, localDay, ankiTsv } from '../src/lib/utils.js'
import { fileType, validateFile, extractPptText } from '../src/lib/documents.js'
import { demoData } from '../src/lib/demo.js'
import { fileExpiry } from '../src/lib/sourceFiles.js'
import { livePresence, peopleInSpace, cameraQuality } from '../src/lib/lounge.js'

async function importTs(path) {
  const source=readFileSync(new URL(path,import.meta.url),'utf8')
  const compiled=await transform(source,{loader:'ts',format:'esm'})
  return import('data:text/javascript;base64,'+Buffer.from(compiled.code).toString('base64'))
}
test('Reviewer instructions cover terminology, source sections, complete lists, and reproducible worked solutions',async()=>{
  const { studyPrompt, outputSchema } = await importTs('../supabase/functions/generate-study/prompts.ts')
  const prompt = studyPrompt()
  for (const part of ['every substantive source section','Key terminology','explanation of EACH item','Comparisons and connections','line-by-line worked solution','verification','self-check questions WITH short answers','Source limitations']) assert.ok(prompt.includes(part), part)
  const retained = studyPrompt('all', [], false)
  assert.match(retained, /source text is already retained/)
  assert.equal(outputSchema('all',false).required.includes('source_text'),false)
  assert.equal(outputSchema().required.includes('source_text'),true)
  assert.deepEqual(Object.keys(outputSchema('note').properties),['notes'])
})
test('File expiry warnings cover elapsed deadlines before cleanup, imminent expiry, and removed originals',()=>{
  const now = Date.parse('2026-10-11T10:00:00Z')
  assert.equal(fileExpiry({expires_at:'2026-10-11T09:59:00Z'},now).expired,true)
  assert.equal(fileExpiry({expires_at:'2026-10-11T10:30:00Z'},now).state,'soon')
  assert.equal(fileExpiry({expires_at:'2026-10-12T10:00:00Z'},now).state,'available')
  assert.equal(fileExpiry({expires_at:'2026-10-12T10:00:00Z',purged_at:'2026-10-11T09:00:00Z'},now).expired,true)
  assert.equal(fileExpiry(null,now).state,'unknown')
})
test('Signup and recovery email templates contain a plain OTP, no auth links, and no fixed digit-count wording',()=>{
  for (const filename of ['confirm-signup','reset-password']) {
    const html=readFileSync(new URL(`../supabase/templates/${filename}.html`,import.meta.url),'utf8')
    assert.match(html,/\{\{ \.Token \}\}/)
    assert.doesNotMatch(html,/ConfirmationURL|TokenHash|<a\b|six.digit|6.digit/i)
    assert.match(html,/one-time use/)
  }
})
test('Presence removes stale sessions, counts people once, preserves active calls, and adapts video quality',()=>{
  const now = Date.parse('2026-10-11T10:00:00Z'), id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
  const peers = livePresence([{client_id:id(1),user_id:'one',name:'One',away:true,in_call:true,last_seen_at:'2026-10-11T09:59:50Z'},{client_id:id(2),user_id:'one',name:'One',away:false,in_call:false,last_seen_at:'2026-10-11T09:59:50Z'},{client_id:id(3),user_id:'two',name:'Two',last_seen_at:'2026-10-11T09:58:00Z'},{client_id:'bad',user_id:'three'},{client_id:id(4),user_id:'four',last_seen_at:'invalid'}],now)
  assert.equal(peers.length,2)
  const people = peopleInSpace(peers); assert.equal(people.length,1); assert.equal(people[0].in_call,true); assert.equal(people[0].away,false)
  assert.ok(cameraQuality(20).maxBitrate < cameraQuality(4).maxBitrate)
  assert.equal(cameraQuality(20,true).scaleResolutionDownBy,1)
})
test('AI result validation rejects malformed or inconsistent study output',async()=>{
  const {validateOutput}=await importTs('../supabase/functions/generate-study/validation.ts')
  const output={title:'Study',source_text:'Source notes',notes:'# Notes',flashcards:Array.from({length:3},()=>({front:'A?',back:'B.'})),quiz:Array.from({length:3},()=>({type:'multiple_choice',question:'Q?',options:['A','B','C','D'],answer:'A',accepted_answers:[],explanation:'Because A.'}))}
  assert.equal(validateOutput(output).title,'Study')
  const bad=structuredClone(output);bad.quiz[0].answer='Missing';assert.throws(()=>validateOutput(bad),/do not match/)
  const badTF=structuredClone(output);badTF.quiz[0].type='true_false';assert.throws(()=>validateOutput(badTF),/true\/false/)
  assert.throws(()=>validateOutput({}),/incomplete/)
})
test('New study sets validate their own output and reject repeated card/quiz prompts',async()=>{
  const {validateRefreshOutput}=await importTs('../supabase/functions/generate-study/validation.ts')
  const cards={flashcards:[{front:'Define a queue',back:'FIFO.'},{front:'Where are items enqueued?',back:'At the rear.'},{front:'What removes a queue item?',back:'Dequeue.'}]}
  assert.equal(validateRefreshOutput(cards,'deck',['What is a stack?']).flashcards.length,3)
  assert.throws(()=>validateRefreshOutput(cards,'deck',[' DEFINE A QUEUE! ']),/repeated/)
  const duplicate=structuredClone(cards);duplicate.flashcards[1].front=duplicate.flashcards[0].front;assert.throws(()=>validateRefreshOutput(duplicate,'deck'),/repeated/)
  assert.throws(()=>validateRefreshOutput({notes:''},'note'),/incomplete/)
  assert.equal(validateRefreshOutput({notes:'# Full notes\n\nA term and its definition.'},'note').notes.startsWith('#'),true)
})
test('Practice scores accept normalized answers and only accepted synonyms',()=>{
  const quiz=demoData().assets.find(a=>a.kind==='quiz')
  const result=quizResult(quiz.data,['Breadth-first search','False',' FIFO queue ','O(n)','inorder traversal'])
  assert.equal(result.correct,5)
  assert.equal(quizResult(quiz.data,['Stack','True','stack','O(1)','preorder']).correct,0)
})
test('Study streak respects local calendar dates and permits yesterday as the last day',()=>{
  const now=new Date(2026,9,11,20)
  const items=[10,9,8].map(day=>({created_at:new Date(2026,9,day,12).toISOString()}))
  assert.equal(studyStreak(items,[],now),3)
  assert.equal(studyStreak([...items,{created_at:now.toISOString()}],[],now),4)
  assert.equal(studyStreak([{created_at:new Date(2026,9,7,12).toISOString()}],[],now),0)
  assert.equal(localDay(now),'2026-9-11')
})
test('Supported formats and size caps; Anki uses a TSV row per card',()=>{
  for(const name of ['notes.PDF','book.docx','slides.pptx','slides.ppt','photo.jpg','text.md']) assert.ok(fileType(name))
  assert.throws(()=>validateFile({name:'script.exe',size:1024}),/Choose a PDF/)
  assert.throws(()=>validateFile({name:'book.pdf',size:10485761}),/10 MB/)
  assert.equal(ankiTsv([{front:'Hello\nworld',back:'Yes\tindeed'}]),'Hello world\tYes indeed')
})
test('Legacy PPT extracts text atoms and rejects invalid record boundaries safely',()=>{
  const text=Buffer.from('A binary tree is a connected graph.','utf16le')
  const atom=Buffer.alloc(8+text.length);atom.writeUInt16LE(0,0);atom.writeUInt16LE(4000,2);atom.writeUInt32LE(text.length,4);text.copy(atom,8)
  assert.equal(extractPptText(atom),'A binary tree is a connected graph.')
  atom.writeUInt32LE(1000000,4);assert.equal(extractPptText(atom),'')
})
test('Edge handlers reject untrusted calls and only persist validated generation',async()=>{
  const previousDeno=globalThis.Deno, previousClient=globalThis.__synapseTestClient, previousFetch=globalThis.fetch
  const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-only',ALLOWED_ORIGINS:'http://localhost:5173',CRON_SECRET:'server-cleanup-only'}
  let handler,claims=0,persisted=null,failedRefreshes=0,storageReads=0,activeAccount=true
  const validOutput={title:'Study',source_text:'Source notes',notes:'# Notes',flashcards:Array.from({length:3},()=>({front:'A?',back:'B.'})),quiz:Array.from({length:3},()=>({type:'multiple_choice',question:'Q?',options:['A','B','C','D'],answer:'A',accepted_answers:[],explanation:'Because A.'}))}
  const mock={auth:{getUser:async(token)=>token==='real-session'?{data:{user:{id:'user'}},error:null}:{data:{user:null},error:{message:'invalid'}}},rpc:async(name,args)=>{
    if(name==='account_is_active')return {data:activeAccount,error:null}
    if(name==='claim_generation'){claims++;return {data:{id:args.p_document_id,status:'processing',storage_path:'file.txt',mime_type:'text/plain',size_bytes:28},error:null}}
    if(name==='claim_asset_refresh')return {data:{job_id:'refresh-job',kind:'deck',source_text:'<p>A queue uses first in first out ordering.</p><span data-type="inline-math" data-latex="x&lt;5"></span>',source_format:'html',previous:['Define FIFO']},error:null}
    if(name==='fail_asset_refresh'){failedRefreshes++;return {data:null,error:null}}
    if(name==='complete_asset_refresh'){persisted=args;return {data:{id:'new-set',set_number:2},error:null}}
    persisted=args;return {data:null,error:null}
  },storage:{from:()=>({download:async()=>{storageReads++;return {data:new Blob(['A source note about a queue.']),error:null}}})}}
  globalThis.__synapseTestClient=()=>mock
  globalThis.Deno={env:{get:key=>env[key]},serve:fn=>{handler=fn}}
  try{
    const bundle=await build({entryPoints:[new URL('../supabase/functions/generate-study/index.ts',import.meta.url).pathname],bundle:true,write:false,platform:'neutral',format:'esm',external:['npm:*']})
    const source=bundle.outputFiles[0].text.replace(/^import.*from "npm:.*";$/m,'const createClient=globalThis.__synapseTestClient;')
    await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))
    assert.equal((await handler(new Request('https://test/functions/v1/generate-study',{method:'OPTIONS',headers:{Origin:'http://localhost:5173'}}))).status,204)
    const req=(auth='',body={},origin='http://localhost:5173')=>new Request('https://test/functions/v1/generate-study',{method:'POST',headers:{Origin:origin,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(body)})
    assert.equal((await handler(req())).status,401)
    assert.equal((await handler(req('Bearer forged'))).status,401)
    assert.equal((await handler(req('Bearer real-session',{},'https://unapproved.example'))).status,403)
    assert.equal(claims,0)
    activeAccount=false
    assert.equal((await handler(req('Bearer real-session',{document_id:'11111111-1111-4111-8111-111111111111'}))).status,403)
    assert.equal(claims,0)
    activeAccount=true
    assert.equal((await handler(req('Bearer real-session',{document_id:'not-uuid'}))).status,400)
    assert.equal((await handler(req('Bearer real-session',{document_id:'11111111-1111-4111-8111-111111111111'}))).status,503)
    env.GEMINI_API_KEY='mock-only'
    globalThis.fetch=async(_url,options)=>{
      const payload=JSON.parse(options.body)
      assert.match(payload.systemInstruction.parts[0].text,/comprehensive set of notes/)
      assert.equal('source_text' in payload.generationConfig.responseJsonSchema.properties,false)
      assert.equal(payload.generationConfig.temperature,0.3)
      const {source_text,...withoutRepeatedSource}=validOutput
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(withoutRepeatedSource)}]}}]})
    }
    assert.equal((await handler(req('Bearer real-session',{document_id:'11111111-1111-4111-8111-111111111111'}))).status,200)
    assert.equal(claims,1);assert.equal(persisted.p_user_id,'user');assert.deepEqual(persisted.p_output,{...validOutput,source_text:'A source note about a queue.'})
    const cards={flashcards:[{front:'Which operation inserts at the rear?',back:'Enqueue.'},{front:'What does dequeue remove?',back:'The oldest queued item.'},{front:'How do queues preserve arrival order?',back:'Items are removed from the front.'}]}
    globalThis.fetch=async(_url,options)=>{const payload=JSON.parse(options.body);assert.deepEqual(Object.keys(payload.generationConfig.responseJsonSchema.properties),['flashcards']);assert.match(payload.contents[0].parts[0].text,/\$x<5\$/);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(cards)}]}}]})}
    const refreshed=await handler(req('Bearer real-session',{asset_id:'11111111-1111-4111-8111-111111111111'}))
    assert.equal(refreshed.status,200);assert.equal((await refreshed.json()).asset_id,'new-set');assert.equal(storageReads,1);assert.deepEqual(persisted.p_output,cards)
    const repeated=structuredClone(cards);repeated.flashcards[0].front='Define FIFO'
    globalThis.fetch=async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(repeated)}]}}]})
    assert.equal((await handler(req('Bearer real-session',{asset_id:'11111111-1111-4111-8111-111111111111'}))).status,500)
    assert.equal(failedRefreshes,1);assert.deepEqual(persisted.p_output,cards)
    let cleanupCalls=0
    globalThis.__synapseTestClient=()=>{cleanupCalls++;throw new Error('Unauthorized cleanup must never create a client')}
    const cleanup=await build({entryPoints:[new URL('../supabase/functions/cleanup-files/index.ts',import.meta.url).pathname],bundle:true,write:false,platform:'neutral',format:'esm',external:['npm:*']})
    const cleanupSource=cleanup.outputFiles[0].text.replace(/^import.*from "npm:.*";$/m,'const createClient=globalThis.__synapseTestClient;')
    await import('data:text/javascript;base64,'+Buffer.from(cleanupSource).toString('base64'))
    assert.equal((await handler(new Request('https://test/cleanup',{method:'POST'}))).status,401)
    assert.equal((await handler(new Request('https://test/cleanup',{method:'POST',headers:{'x-cron-secret':'incorrect'}}))).status,401)
    assert.equal(cleanupCalls,0)
  }finally{globalThis.Deno=previousDeno;globalThis.__synapseTestClient=previousClient;globalThis.fetch=previousFetch}
})
