import { fileURLToPath } from 'node:url'
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
  const peers = livePresence([{client_id:id(1),user_id:'one',name:'One',away:true,in_call:true,last_seen_at:'2026-10-11T09:59:50Z'},{client_id:id(2),user_id:'one',name:'One',away:false,in_call:false,last_seen_at:'2026-10-11T09:59:50Z'},{client_id:id(3),user_id:'two',name:'Two',last_seen_at:'2026-10-11T09:57:00Z'},{client_id:'bad',user_id:'three'},{client_id:id(4),user_id:'four',last_seen_at:'invalid'}],now)
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
  assert.doesNotThrow(()=>validateFile({name:'book.pdf',size:20971520}))
  assert.throws(()=>validateFile({name:'book.pdf',size:20971521}),/20 MB/)
  assert.equal(ankiTsv([{front:'Hello\nworld',back:'Yes\tindeed'}]),'Hello world\tYes indeed')
})
test('Joining extracts a valid invitation token without navigating the supplied URL',async()=>{
 const previousLocation=globalThis.location;globalThis.location={origin:'http://localhost:5173'}
 try {
 const {invitationToken}=await importTs('../src/lib/appUrl.js')
 const token='ab'.repeat(32)
 assert.equal(invitationToken(' '+token.toUpperCase()+' '),token)
 assert.equal(invitationToken('https://rcgsynapse.vercel.app/?invite='+token),token)
 assert.throws(()=>invitationToken('javascript:alert(1)'),/valid Synapse|full invitation/)
 assert.throws(()=>invitationToken('https://elsewhere.example/?invite=nope'),/valid Synapse/)
 }finally{if(previousLocation===undefined)delete globalThis.location;else globalThis.location=previousLocation}
})
test('Legacy PPT extracts text atoms and rejects invalid record boundaries safely',()=>{
  const text=Buffer.from('A binary tree is a connected graph.','utf16le')
  const atom=Buffer.alloc(8+text.length);atom.writeUInt16LE(0,0);atom.writeUInt16LE(4000,2);atom.writeUInt32LE(text.length,4);text.copy(atom,8)
  assert.equal(extractPptText(atom),'A binary tree is a connected graph.')
  atom.writeUInt32LE(1000000,4);assert.equal(extractPptText(atom),'')
})
test('Edge handlers authenticate, scan private sources once, and save only exact fresh guided sets',async()=>{
  const previousDeno=globalThis.Deno, previousClient=globalThis.__synapseTestClient, previousFetch=globalThis.fetch
  const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-only',ALLOWED_ORIGINS:'http://localhost:5173',CRON_SECRET:'server-cleanup-only'}
  const id='11111111-1111-4111-8111-111111111111'
  let handler,claims=0,persisted=null,failed=0,storageReads=0,activeAccount=true,ready=false,hash=null
  const sourceText='A source note about a queue.'
  const analysis={title:'Queues',source_text:sourceText,topics:[{title:'FIFO operations',description:'Queue insertion and removal',card_count:3,quiz_count:6,concepts:[{label:'Queue insertion',covered_by:[]},{label:'Queue removal',covered_by:[]},{label:'FIFO ordering',covered_by:[]}]}]}
  const material=()=>({id,source_hash:hash,source_format:'markdown',source_text:ready?sourceText:'',analysis_status:ready?'ready':'unscanned'})
  const mock={auth:{getUser:async(token)=>token==='real-session'?{data:{user:{id:'user'}},error:null}:{data:{user:null},error:{message:'invalid'}}},rpc:async(name,args)=>{
    if(name==='account_is_active')return {data:activeAccount,error:null}
    if(name==='generation_source')return {data:{document:{id,expires_at:new Date(Date.now()+86400000).toISOString(),storage_path:'file.txt',mime_type:'text/plain',size_bytes:new Blob([sourceText]).size},material:material()},error:null}
    if(name==='bind_generation_source'){assert.match(args.p_hash,/^[0-9a-f]{64}$/);hash=args.p_hash;return {data:material(),error:null}}
    if(name==='claim_material_analysis')return {data:{cached:ready,token:'scan',material:material()},error:null}
    if(name==='finish_material_analysis'){ready=true;assert.equal(args.p_output.topics[0].id,'topic-1');return {data:null,error:null}}
    if(name==='claim_material_generation'){claims++;return {data:{job_id:'guided-job',kind:'deck',source_text:sourceText,source_format:'markdown',previous:[{prompt:'Define FIFO',coverage_key:'fifo:definition'}],topics:[],concepts:[{id:'topic-1:concept-1',label:'Insertion',topic_id:'topic-1'},{id:'topic-1:concept-2',label:'Removal',topic_id:'topic-1'},{id:'topic-1:concept-3',label:'Order',topic_id:'topic-1'}],options:{workflow:'topic',topic_id:'topic-1',topic_title:'FIFO operations',total:3}},error:null}}
    if(name==='fail_material_generation'){failed++;return {data:null,error:null}}
    if(name==='complete_material_generation'){persisted=args;return {data:{id:'new-set',set_number:2},error:null}}
    return {data:null,error:null}
  },from:()=>({update:()=>({eq:()=>Promise.resolve({error:null})})}),storage:{from:()=>({download:async()=>{storageReads++;return {data:new Blob([sourceText]),error:null}}})}}
  globalThis.__synapseTestClient=()=>mock
  globalThis.Deno={env:{get:key=>env[key]},serve:fn=>{handler=fn}}
  try{
    const bundle=await build({entryPoints:[fileURLToPath(new URL('../supabase/functions/generate-study/index.ts',import.meta.url))],bundle:true,write:false,platform:'neutral',format:'esm',external:['npm:*']})
    await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text.replace(/^import.*from "npm:.*";$/m,'const createClient=globalThis.__synapseTestClient;')).toString('base64'))
    const req=(auth='',body={},origin='http://localhost:5173')=>new Request('https://test/functions/v1/generate-study',{method:'POST',headers:{Origin:origin,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(body)})
    assert.equal((await handler(new Request('https://test/generate',{method:'OPTIONS',headers:{Origin:'http://localhost:5173'}}))).status,204)
    assert.equal((await handler(req())).status,401);assert.equal((await handler(req('Bearer forged'))).status,401)
    assert.equal((await handler(req('Bearer real-session',{},'https://unapproved.example'))).status,403)
    activeAccount=false;assert.equal((await handler(req('Bearer real-session',{action:'analyze',document_id:id}))).status,403);activeAccount=true
    assert.equal((await handler(req('Bearer real-session',{action:'analyze',document_id:'not-uuid'}))).status,400)
    assert.equal((await handler(req('Bearer real-session',{action:'analyze',document_id:id,asset_id:id}))).status,400)
    assert.equal((await handler(req('Bearer real-session',{action:'analyze',document_id:id}))).status,503)
    assert.equal(claims,0);env.GEMINI_API_KEY='mock-only'
    globalThis.fetch=async(_url,options)=>{const payload=JSON.parse(options.body);assert.match(payload.systemInstruction.parts[0].text,/EVERY substantive section/);assert.match(payload.contents[0].parts[0].text,/source note/);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(analysis)}]}}]})}
    const analyzed=await handler(req('Bearer real-session',{action:'analyze',document_id:id}));assert.equal(analyzed.status,200);assert.equal((await analyzed.json()).material_id,id);assert.equal(storageReads,1);assert.equal(claims,0)
    globalThis.fetch=async()=>{throw new Error('Cached analysis must never call Gemini')}
    assert.equal((await handler(req('Bearer real-session',{action:'analyze',document_id:id}))).status,200);assert.equal(storageReads,1)
    const cards={flashcards:[{front:'Which operation inserts at the rear?',back:'Enqueue.',concept_id:'topic-1:concept-1',coverage_key:'topic-1:concept-1'},{front:'What does dequeue remove?',back:'The oldest queued item.',concept_id:'topic-1:concept-2',coverage_key:'topic-1:concept-2'},{front:'How do queues preserve arrival order?',back:'Items are removed from the front.',concept_id:'topic-1:concept-3',coverage_key:'topic-1:concept-3'}]}
    globalThis.fetch=async(_url,options)=>{const payload=JSON.parse(options.body);assert.deepEqual(Object.keys(payload.generationConfig.responseJsonSchema.properties),['flashcards']);assert.match(payload.systemInstruction.parts[0].text,/EXACTLY 3 flashcards/);assert.match(payload.contents[0].parts[1].text,/fifo:definition/);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(cards)}]}}]})}
    const generated=await handler(req('Bearer real-session',{action:'generate',material_id:id,kind:'deck',options:{workflow:'topic',topic_id:'topic-1'}}))
    assert.equal(generated.status,200);assert.equal((await generated.json()).asset_id,'new-set');assert.equal(claims,1);assert.deepEqual(persisted.p_output,cards)
    const repeated=structuredClone(cards);repeated.flashcards[0].front='Define FIFO'
    globalThis.fetch=async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(repeated)}]}}]})
    assert.equal((await handler(req('Bearer real-session',{action:'generate',material_id:id,kind:'deck',options:{workflow:'topic',topic_id:'topic-1'}}))).status,500)
    assert.equal(failed,1);assert.deepEqual(persisted.p_output,cards)
    let cleanupCalls=0
    globalThis.__synapseTestClient=()=>{cleanupCalls++;throw new Error('Unauthorized cleanup must never create a client')}
    const cleanup=await build({entryPoints:[fileURLToPath(new URL('../supabase/functions/cleanup-files/index.ts',import.meta.url))],bundle:true,write:false,platform:'neutral',format:'esm',external:['npm:*']})
    await import('data:text/javascript;base64,'+Buffer.from(cleanup.outputFiles[0].text.replace(/^import.*from "npm:.*";$/m,'const createClient=globalThis.__synapseTestClient;')).toString('base64'))
    assert.equal((await handler(new Request('https://test/cleanup',{method:'POST'}))).status,401)
    assert.equal((await handler(new Request('https://test/cleanup',{method:'POST',headers:{'x-cron-secret':'incorrect'}}))).status,401)
    assert.equal(cleanupCalls,0)
  }finally{globalThis.Deno=previousDeno;globalThis.__synapseTestClient=previousClient;globalThis.fetch=previousFetch}
})
