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
  assert.match(prompt,/Only when the source teaches a mathematical/);assert.match(prompt,/For non-mathematical topics/);assert.match(prompt,/Do not repeat the body/)
  for (const part of ['every substantive source section','Key terminology','explanation of EACH item','Comparisons and connections','line-by-line worked solution','verification','Internal self-checklist (do not print)','Source limitations']) assert.ok(prompt.includes(part), part)
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
