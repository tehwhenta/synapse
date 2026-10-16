import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse, compileScript } from '@vue/compiler-sfc'
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url:'http://localhost:5173',pretendToBeVisual:true })
let rich, mount, flushPromises, runtime
const runtimePath = fileURLToPath(new URL('./.rich-ui-runtime.mjs',import.meta.url))
before(async () => {
  for (const key of ['window','document','Document','ShadowRoot','HTMLElement','Element','SVGElement','Node','DOMParser','MutationObserver','File','Blob','FileReader','localStorage','sessionStorage','location','history','getComputedStyle']) globalThis[key] = dom.window[key]
  globalThis.requestAnimationFrame = callback => setTimeout(callback,0)
  globalThis.cancelAnimationFrame = clearTimeout
  dom.window.Range.prototype.getClientRects = () => []
  dom.window.Range.prototype.getBoundingClientRect = () => ({left:0,right:0,top:0,bottom:0,width:0,height:0})
  rich = { ...await import('../src/lib/richText.js'), ...await import('../src/lib/studyRendering.js') }
  const utils = await import('@vue/test-utils'); mount = utils.mount; flushPromises = utils.flushPromises
  const compiled = await build({ stdin:{ contents:"export {default as MistakeNotebook} from './src/components/MistakeNotebook.vue'; export {default as HighlightCards} from './src/components/HighlightCards.vue'; export {default as ConceptConnections} from './src/components/ConceptConnections.vue'; export {useLearningStore} from './src/stores/learning.js'; export {default as App} from './src/App.vue'; export {default as SpaceList} from './src/components/SpaceList.vue'; export {default as RichEditor} from './src/components/RichEditor.vue'; export {default as StudyViewer} from './src/components/StudyViewer.vue'; export {default as Modal} from './src/components/Modal.vue'; export {default as GenerationProgress} from './src/components/GenerationProgress.vue'; export {default as GenerationPerformance} from './src/components/GenerationPerformance.vue'; export {default as ManualDeckDialog} from './src/components/ManualDeckDialog.vue'; export {createPinia,setActivePinia} from 'pinia'; export {useAuthStore} from './src/stores/auth.js'; export {useWorkspaceStore} from './src/stores/workspace.js';",resolveDir:fileURLToPath(new URL('..',import.meta.url)) },bundle:true,write:false,platform:'node',format:'esm',packages:'external',define:{'import.meta.env':'{}'},plugins:[
    {name:'vue-test',setup(builder){builder.onLoad({filter:/\.vue$/},args=>{const {descriptor}=parse(readFileSync(args.path,'utf8'),{filename:args.path});return {contents:compileScript(descriptor,{id:args.path,inlineTemplate:true}).content.replace(/import\((['"])(\.\/[^'"]+\.vue)\1\)/g,'import($1$2$1).then(module=>module.default)'),loader:'js',resolveDir:dirname(args.path)}})}}
  ] })
  // Download-style asset glob is a build-time feature, irrelevant to these DOM interaction tests.
  const source = compiled.outputFiles[0].text.replace(/import mathCss from "katex\/dist\/katex.min.css\?raw";/,'const mathCss="";').replace(/const fonts = import\.meta\.glob\([^;]+;/,'const fonts={};')
  writeFileSync(runtimePath,source); runtime = await import(pathToFileURL(runtimePath).href)
})
after(() => { dom.window.close(); try {unlinkSync(runtimePath)} catch {} })

test('Admin generation timings distinguish waiting, uncached source reading, provider responses and retries without clutter',async()=>{
 const empty={capacity:{overall:3,per_user:2},totals:{measured:0},window_days:7,sample_limit:2000,stages:[],recent:[]}
 const wrapper=mount(runtime.GenerationPerformance,{props:{data:empty}})
 assert.match(wrapper.text(),/3 tasks overall/);assert.match(wrapper.text(),/up to 2 per account/);assert.match(wrapper.text(),/Timings will appear/)
 const measured={...empty,totals:{measured:5,queue_wait_ms:12000,source_read_ms:1200,gemini_ms:22000,draft_retries:2,provider_retries:1,worker_retries:1,source_cached:3,source_checks:5,input_tokens:1000,output_tokens:600,thought_tokens:20},stages:[{stage:'note',measured:2,queue_wait_ms:5000,dispatch_wait_ms:300,source_read_ms:null,gemini_ms:22000,save_ms:100}],recent:[{title:'Queues.docx',stage:'note',outcome:'saved',queue_wait_ms:5000,gemini_ms:22000,draft_retries:1,provider_retries:0,attempt:1}]}
 await wrapper.setProps({data:measured})
 assert.match(wrapper.text(),/12.0 s/);assert.match(wrapper.text(),/22.0 s/);assert.match(wrapper.text(),/2 draft corrections/);assert.match(wrapper.text(),/1 service retries/)
 assert.equal(wrapper.find('details').attributes('open'),undefined)
 assert.equal(wrapper.find('.timing-table').attributes('tabindex'),'0')
 assert.equal(wrapper.findAll('tbody tr').length,1);assert.match(wrapper.text(),/Queues.docx/);assert.doesNotMatch(wrapper.text(),/NaN|undefined/)
 wrapper.unmount()
})

test('Highlights, text annotations, and freehand pen settings survive serialization safely',async () => {
  const wrapper=mount(runtime.RichEditor,{props:{modelValue:'<p>A coefficient multiplies a variable.</p>'},attachTo:document.body})
  try {
    await flushPromises()
    const editor=wrapper.findComponent({name:'EditorContent'}).props('editor')
    editor.commands.setTextSelection({from:3,to:14})
    await new Promise(resolve=>setTimeout(resolve,30)); await flushPromises()
    await wrapper.find('[aria-label="Highlight selected text"]').trigger('click')
    assert.match(wrapper.emitted('update:modelValue').at(-1)[0],/<mark[^>]+data-highlight-color/)
    await new Promise(resolve=>setTimeout(resolve,30)); await flushPromises()
    const highlighter=wrapper.find('[aria-label="Highlight selected text"]')
    assert.equal(highlighter.attributes('aria-pressed'),'true')
    editor.commands.setTextSelection({from:20,to:28})
    await new Promise(resolve=>setTimeout(resolve,150)); await flushPromises()
    assert.equal(wrapper.findAll('.ProseMirror mark').length,2)
    await wrapper.find('.ProseMirror').trigger('keydown',{key:'Escape'})
    assert.equal(highlighter.attributes('aria-pressed'),'false')
    editor.commands.setTextSelection({from:30,to:34})
    await new Promise(resolve=>setTimeout(resolve,150)); await flushPromises()
    assert.equal(wrapper.findAll('.ProseMirror mark').length,2)
    await wrapper.find('[aria-label="Add text annotation"]').trigger('click')
    await wrapper.find('.annotation-editor textarea').setValue('Remember the multiplier.')
    await wrapper.findAll('.annotation-editor button').find(button=>button.text()==='Save annotation').trigger('click')
    assert.match(wrapper.emitted('update:modelValue').at(-1)[0],/data-comment="Remember the multiplier/)
    await wrapper.find('[aria-label="Draw on reviewer"]').trigger('click')
    await wrapper.find('[aria-label="Pen color"]').setValue('#2563eb')
    await wrapper.find('[aria-label="Pen thickness"]').setValue('7')
    const host=wrapper.find('.annotated-paper').element,p=wrapper.find('.ProseMirror p').element
    host.getBoundingClientRect=()=>({left:0,top:0,width:600,height:100})
    p.getBoundingClientRect=()=>({left:0,top:0,width:600,height:60})
    const surface=wrapper.find('.drawing-layer').element
    for(const [type,x,y] of [['pointerdown',30,20],['pointermove',120,40],['pointerup',150,40]]) {
      const event=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:1});surface.dispatchEvent(event);await flushPromises()
    }
    const strokes=wrapper.emitted('update:annotations').at(-1)[0]
    assert.equal(strokes.length,1);assert.equal(strokes[0].width,7);assert.equal(strokes[0].color,'#2563eb');assert.equal(strokes[0].anchor,'synapse-paper-v1')
    const {annotatedHtml,cleanAnnotations}=await import('../src/lib/annotations.js')
    const output=annotatedHtml(wrapper.emitted('update:modelValue').at(-1)[0],strokes)
    assert.match(output,/svg class="saved-drawing"/);assert.match(output,/stroke="#2563eb"/)
    assert.deepEqual(cleanAnnotations([{...strokes[0],color:'url(javascript:alert(1))'}]),[])
    assert.doesNotMatch(rich.noteHtml('<mark data-highlight-color="url(javascript:alert(1))" style="background:url(https://evil)">Text</mark>','html'),/javascript:|background:/)
  } finally { wrapper.unmount() }
})
test('Reviewer windows maximize, restore, and offer keyboard-operable edge resizing',async () => {
  const wrapper=mount(runtime.Modal,{props:{title:'Reviewer',wide:true,resizable:true},slots:{default:'Study content'},global:{stubs:{Teleport:true}},attachTo:document.body})
  try {
    assert.equal(wrapper.findAll('.resize-edge').length,8)
    await wrapper.find('[aria-label="Maximize window"]').trigger('click')
    assert.equal(wrapper.find('.modal-frame').classes().includes('modal-maximized'),true)
    assert.equal(wrapper.findAll('.resize-edge').length,0)
    await wrapper.find('[aria-label="Restore window"]').trigger('click')
    await new Promise(resolve=>setTimeout(resolve,30))
    const frame=wrapper.find('.modal-frame').element;frame.getBoundingClientRect=()=>({width:600,height:400})
    await wrapper.find('[aria-label="Resize from right edge"]').trigger('keydown',{key:'ArrowRight'})
    await flushPromises()
    assert.equal(wrapper.find('.modal-frame').element.style.width,'624px');assert.equal(wrapper.find('.modal-frame').element.style.height,'400px')
    wrapper.find('.modal-frame').element.getBoundingClientRect=()=>({width:624,height:400})
    const down=new dom.window.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0,clientX:30,clientY:20});Object.defineProperty(down,'pointerId',{value:1})
    wrapper.find('[aria-label="Resize from right edge"]').element.dispatchEvent(down)
    const move=new dom.window.MouseEvent('pointermove',{clientX:60,clientY:20});Object.defineProperty(move,'pointerId',{value:1});window.dispatchEvent(move);await flushPromises()
    assert.equal(wrapper.find('.modal-frame').element.style.width,'684px');window.dispatchEvent(new dom.window.MouseEvent('pointerup'))
  } finally {wrapper.unmount()}
})
test('Invitation origins use the production domain and reject unsafe schemes',async()=>{
  const {appOrigin}=await import('../src/lib/appUrl.js')
  assert.equal(appOrigin('', 'http://localhost:5173',true),'https://rcgsynapse.vercel.app')
  assert.equal(appOrigin('https://rcgsynapse.vercel.app/','http://localhost:5173'),'https://rcgsynapse.vercel.app')
  assert.throws(()=>appOrigin('javascript:alert(1)','http://localhost:5173'),/HTTPS app/)
})

test('Reviewers render terms, tables, numbered lists, and equations; HTML cannot execute unsafe content',() => {
  const source = '# Terms\n\nA **coefficient** multiplies a variable.\n\n| Term | Definition |\n| --- | --- |\n| Variable | Unknown |\n\n1. Subtract five.\n2. Divide by two.\n\n$$\nx=\\frac{12}{2}=6\n$$\n\nThe answer is $x=6$.'
  const edit = rich.noteHtml(source)
  assert.match(edit,/<strong>coefficient<\/strong>/); assert.match(edit,/<table>/); assert.match(edit,/<ol>/)
  assert.match(edit,/data-type="block-math"/); assert.match(edit,/data-latex="x=\\frac/)
  const read = rich.renderStudyHtml(source); assert.match(read,/class="katex/); assert.match(read,/<math/)
  const malicious = rich.renderStudyHtml('<p onclick="alert(1)" style="background:url(https://evil)">A</p><img src=x onerror=alert(1)><script>alert(1)</script><a href="javascript:alert(1)">link</a>','html')
  assert.doesNotMatch(malicious,/<script|<img|onclick|javascript:|background:/)
  assert.match(rich.noteHtml('<p style="text-align: center"><u>Useful</u></p>','html'),/text-align: center/)
  assert.match(rich.plainStudyText(source),/coefficient/)
})
test('Downloaded flashcard and quiz study sheets are readable documents without code tooling',() => {
  const body = rich.printableCards('Math <Basics>',[{front:'Solve $2x=12$',back:'$x=6$'}])
  const sheet = rich.studySheet('Math <Basics>',body,'/* embedded math fonts */')
  const exported = new JSDOM(sheet)
  assert.equal(exported.window.document.title,'Math <Basics>')
  assert.match(exported.window.document.body.textContent,/Flashcard study sheet/)
  assert.equal(exported.window.document.querySelectorAll('.export-card').length,1)
  assert.equal(exported.window.document.querySelectorAll('script').length,0)
  assert.match(sheet,/embedded math fonts/); assert.match(sheet,/katex/)
  const quiz = rich.printableQuiz('Practice',[{question:'What is FIFO?',options:['First in first out','Stack'],answer:'First in first out',explanation:'A queue preserves arrival order.'}])
  assert.match(quiz,/Answer key/); assert.match(quiz,/arrival order/); exported.window.close()
})
test('Formatted editor keeps displayed bold, tables, and math when opening and saving',async () => {
  const value = rich.noteHtml('## Reviewer\n\nA **key term**.\n\n| Part | Role |\n| --- | --- |\n| Root | Start |\n\n$\\frac{1}{2}$')
  const wrapper = mount(runtime.RichEditor,{props:{modelValue:value},attachTo:document.body})
  await flushPromises()
  assert.equal(wrapper.findAll('.ProseMirror strong').length,1)
  assert.equal(wrapper.findAll('.ProseMirror table').length,1)
  assert.equal(wrapper.findAll('.ProseMirror .katex').length,1)
  assert.doesNotMatch(wrapper.find('.ProseMirror').text(),/\*\*key term\*\*/)
  await wrapper.find('[aria-label="Bullet list"]').trigger('click'); await flushPromises()
  const updates = wrapper.emitted('update:modelValue')
  assert.ok(updates.length); assert.match(updates.at(-1)[0],/<table>/); assert.match(updates.at(-1)[0],/data-latex/)
  await wrapper.find('[aria-label="Insert equation"]').trigger('click')
  await wrapper.find('.equation-editor textarea').setValue('x=6')
  await wrapper.find('.equation-editor .button.primary').trigger('click'); await flushPromises()
  assert.ok(wrapper.findAll('.ProseMirror .katex').length>=2)
  wrapper.unmount()
})
test('Study viewer navigates retained sets, edits titles, and refreshes directly without losing earlier sets',async () => {
  runtime.setActivePinia(runtime.createPinia()); const auth=runtime.useAuthStore(); await auth.initialize(); const workspace=runtime.useWorkspaceStore(); await workspace.load()
  const first = workspace.assets.find(a=>a.id==='deck-trees');let refreshed=null
  workspace.refreshAsset=async asset=>{refreshed=asset.id;return asset.id}
  const wrapper = mount(runtime.StudyViewer,{props:{asset:first},global:{stubs:{Teleport:true}},attachTo:document.body})
  try {
  await flushPromises(); assert.equal(wrapper.findAll('.set-numbers button').length,2)
  assert.equal(wrapper.find('.set-numbers .active').text(),'1')
  await wrapper.find('[aria-label="Open set 2"]').trigger('click'); await flushPromises()
  assert.equal(wrapper.find('.set-numbers .active').text(),'2')
  assert.match(wrapper.find('.flashcard-text').text(),/leaf node/)
  assert.ok(wrapper.findAll('button').find(b=>b.text()==='Rename').find('svg.lucide-text-cursor-input-icon').exists())
  assert.doesNotMatch(wrapper.text(),/Teach-back/i)
  await wrapper.findAll('button').find(b=>b.text()==='Rename').trigger('click')
  await wrapper.find('.rename-form input').setValue('My own practice title')
  await wrapper.find('.rename-form').trigger('submit'); await flushPromises()
  assert.equal(workspace.assets.find(a=>a.id==='deck-trees-2').title,'My own practice title')
  assert.equal(workspace.assets.find(a=>a.id==='deck-trees').title,first.title)
  assert.doesNotMatch(wrapper.text(),/JSON/)
  await wrapper.findAll('button').find(b=>b.text()==='Generate').trigger('click'); await flushPromises()
  assert.equal(refreshed,'deck-trees-2')
  assert.equal(wrapper.findAll('.set-numbers button').length,2); assert.equal(wrapper.find('.set-numbers .active').text(),'2')
  await wrapper.find('[aria-label="Open set 1"]').trigger('click'); await flushPromises()
  assert.match(wrapper.find('.flashcard-text').text(),/makes a graph a tree/)
  }finally{wrapper.unmount(); await workspace.dispose()}
})
test('Profile name and photo persist in sample mode; invalid formats and oversized photos are rejected',async () => {
  runtime.setActivePinia(runtime.createPinia()); const auth=runtime.useAuthStore(); await auth.initialize()
  await assert.rejects(auth.updateProfile('Student',new File(['x'],'bad.svg',{type:'image/svg+xml'})),/Choose a JPG/)
  await assert.rejects(auth.updateProfile('Student',new File([new Uint8Array(10485761)],'large.jpg',{type:'image/jpeg'})),/10 MB/)
  const photo=new File(['photo bytes'],'avatar.png',{type:'image/png'});Object.defineProperty(photo,'size',{value:10485760})
  await auth.updateProfile('Ralph',photo)
  assert.equal(auth.profile.display_name,'Ralph'); assert.match(auth.profile.avatar_path,/^data:image\/png;base64,/)
  auth.enterDemo(); assert.equal(auth.profile.display_name,'Ralph')
  await auth.updateProfile('Ralph',null,true); assert.equal(auth.profile.avatar_path,null)
})
test('Flashcards expose distinct question and answer faces, flip, and reset to the question on navigation',async () => {
  runtime.setActivePinia(runtime.createPinia()); const auth=runtime.useAuthStore(); await auth.initialize(); const workspace=runtime.useWorkspaceStore(); await workspace.load()
  const wrapper=mount(runtime.StudyViewer,{props:{asset:workspace.assets.find(a=>a.id==='deck-trees')},global:{stubs:{Teleport:true}},attachTo:document.body})
  await flushPromises()
  assert.equal(wrapper.find('.flashcard-front').attributes('aria-hidden'),'false')
  assert.equal(wrapper.find('.flashcard-back').attributes('aria-hidden'),'true')
  assert.equal(wrapper.find('.ratings').classes().includes('ratings-hidden'),true)
  await wrapper.find('.flashcard').trigger('click')
  assert.equal(wrapper.find('.flashcard').classes().includes('is-flipped'),true)
  assert.equal(wrapper.find('.flashcard-back').attributes('aria-hidden'),'false')
  assert.equal(wrapper.find('.card-face-label').text(),'Question')
  assert.equal(wrapper.findAll('.card-face-label')[1].text(),'Answer')
  await wrapper.find('[aria-label="Next card"]').trigger('click')
  assert.equal(wrapper.find('.flashcard').classes().includes('is-flipped'),false)
  assert.equal(wrapper.find('.flashcard-front').attributes('aria-hidden'),'false')
  wrapper.unmount(); await workspace.dispose()
})
test('Expired-source refresh warns before spending a generation and offers re-upload without deleting sets',async () => {
  runtime.setActivePinia(runtime.createPinia()); const auth=runtime.useAuthStore(); await auth.initialize(); const workspace=runtime.useWorkspaceStore(); await workspace.load()
  workspace.documents.push({id:'expired-document',expires_at:new Date(Date.now()-1000).toISOString(),folder_id:'algorithms'})
  const first={...workspace.assets.find(a=>a.id==='deck-trees'),document_id:'expired-document'}
  let generated=0
  workspace.refreshAsset=async current=>{generated++;return current.id}
  const wrapper=mount(runtime.StudyViewer,{props:{asset:first},global:{stubs:{Teleport:true}},attachTo:document.body})
  await flushPromises()
  assert.match(wrapper.find('.source-notice').text(),/Original file expired/)
  await wrapper.findAll('button').find(b=>b.text()==='Generate').trigger('click'); await flushPromises()
  assert.equal(generated,0); assert.equal(wrapper.find('.refresh-warning').exists(),true)
  await wrapper.findAll('button').find(b=>b.text()==='Upload original').trigger('click')
  assert.equal(wrapper.emitted('reupload').length,1)
  await wrapper.findAll('button').find(b=>b.text()==='Use retained text').trigger('click'); await flushPromises()
  assert.equal(generated,1); assert.equal(workspace.assets.some(a=>a.id===first.id),true)
  wrapper.unmount(); await workspace.dispose()
})

test('Custom flashcard form adds/removes cards and saves a usable deck without generation',async()=>{
  runtime.setActivePinia(runtime.createPinia());const auth=runtime.useAuthStore();await auth.initialize();const workspace=runtime.useWorkspaceStore();await workspace.load()
  const before=workspace.assets.length
  workspace.generateSet=async()=>{throw new Error('Custom decks must not invoke AI')}
  const wrapper=mount(runtime.ManualDeckDialog,{global:{stubs:{Teleport:true}},attachTo:document.body})
  try {
    await wrapper.find('input').setValue('My own queue cards')
    await wrapper.find('[aria-label="Question 1"]').setValue('What does FIFO mean?')
    await wrapper.find('[aria-label="Answer 1"]').setValue('First in, first out.')
    await wrapper.findAll('button').find(b=>b.text().startsWith('Add a card')).trigger('click')
    assert.equal(wrapper.findAll('.custom-card-row').length,2)
    await wrapper.find('[aria-label="Remove card 2"]').trigger('click')
    await wrapper.find('form').trigger('submit');await flushPromises()
    assert.equal(workspace.assets.length,before+1)
    const deck=wrapper.emitted('created')[0][0];assert.equal(deck.title,'My own queue cards');assert.equal(deck.data[0].back,'First in, first out.')
  } finally {wrapper.unmount();await workspace.dispose()}
})

test('Custom flashcard creation appears only in the Flashcards workspace section',async()=>{
  runtime.setActivePinia(runtime.createPinia())
  const wrapper=mount(runtime.App,{global:{stubs:{Teleport:true,StudyRoom:true,StudyViewer:true,RichEditor:true,AdminPanel:true,FocusTimer:true,Avatar:true}},attachTo:document.body})
  try {
    await flushPromises();await flushPromises()
    assert.equal(wrapper.find('.manual-deck-entry').exists(),false)
    const tabs=wrapper.findAll('.material-tabs button')
    assert.ok(tabs.length)
    await tabs.find(b=>b.text()==='Flashcards').trigger('click')
    assert.equal(wrapper.find('.manual-deck-entry').exists(),true)
    await tabs.find(b=>b.text()==='All materials').trigger('click')
    assert.equal(wrapper.find('.manual-deck-entry').exists(),false)
    await tabs.find(b=>b.text()==='Reviewers').trigger('click')
    assert.equal(wrapper.find('.manual-deck-entry').exists(),false)
  } finally {wrapper.unmount();await flushPromises()}
})
test('Spaces scroll independently after three entries, accumulate smooth wheel movement, and keep create outside the scrollport',async()=>{
  const spaces=Array.from({length:5},(_,i)=>({id:'space-'+i,title:'Space '+i,color:'#8c8d65',owner_id:'owner'}))
  const wrapper=mount(runtime.SpaceList,{props:{spaces:spaces.slice(0,3),selectedId:'space-0',userId:'owner'},attachTo:document.body})
  const previousMedia=window.matchMedia
  try {
    assert.equal(wrapper.find('.spaces-scrollport').classes().includes('has-overflow'),false)
    await wrapper.setProps({spaces})
    const port=wrapper.find('.spaces-scrollport')
    assert.equal(port.classes().includes('has-overflow'),true)
    assert.equal(port.attributes('tabindex'),'0')
    assert.equal(port.find('.add-folder').exists(),false)
    Object.defineProperties(port.element,{scrollHeight:{value:248,configurable:true},clientHeight:{value:146,configurable:true}})
    const calls=[];port.element.scrollTo=options=>calls.push(options)
    window.matchMedia=()=>({matches:false})
    const wheel=new dom.window.WheelEvent('wheel',{deltaY:40,bubbles:true,cancelable:true});port.element.dispatchEvent(wheel)
    port.element.dispatchEvent(new dom.window.WheelEvent('wheel',{deltaY:40,bubbles:true,cancelable:true}));await flushPromises()
    assert.equal(wheel.defaultPrevented,true)
    assert.deepEqual(calls.map(c=>c.top),[40,80]);assert.equal(calls[0].behavior,'smooth')
    const zoom=new dom.window.WheelEvent('wheel',{deltaY:40,ctrlKey:true,bubbles:true,cancelable:true});port.element.dispatchEvent(zoom);assert.equal(zoom.defaultPrevented,false)
    await wrapper.findAll('.folder-button')[4].trigger('click');assert.equal(wrapper.emitted('select')[0][0],'space-4')
    const last=wrapper.findAll('.folder-button')[4].element
    Object.defineProperties(last,{offsetTop:{value:204},offsetHeight:{value:44}})
    window.matchMedia=()=>({matches:true})
    await wrapper.setProps({selectedId:'space-4'});await flushPromises()
    assert.deepEqual(calls.at(-1),{top:102,behavior:'instant'})
    await wrapper.find('.add-folder').trigger('click');assert.equal(wrapper.emitted('create').length,1)
    assert.equal(wrapper.findAll('.folder-button').length,5)
  } finally {window.matchMedia=previousMedia;wrapper.unmount()}
})
test('Custom deck viewer hides generation controls, edits questions/answers, and removes individual cards',async()=>{
 runtime.setActivePinia(runtime.createPinia());const auth=runtime.useAuthStore();await auth.initialize();const workspace=runtime.useWorkspaceStore();await workspace.load()
 const deck=await workspace.createManualDeck('My custom deck',[{front:'First question?',back:'First answer.'},{front:'Second question?',back:'Second answer.'}])
 const wrapper=mount(runtime.StudyViewer,{props:{asset:deck},global:{stubs:{Teleport:true}},attachTo:document.body})
 try{
  await flushPromises()
  assert.equal(wrapper.findAll('button').some(b=>b.text()==='Generate'||b.text()==='Create custom flashcards'),false)
  await wrapper.findAll('button').find(b=>b.text()==='Edit card').trigger('click')
  await wrapper.find('[aria-label="Edit custom question"]').setValue('A revised question?')
  await wrapper.find('[aria-label="Edit custom answer"]').setValue('A revised answer.')
  await wrapper.find('.custom-card-editor').trigger('submit');await flushPromises()
  assert.equal(workspace.assets.find(a=>a.id===deck.id).data[0].front,'A revised question?')
  await wrapper.findAll('button').find(b=>b.text()==='Delete card').trigger('click')
  await wrapper.findAll('button').find(b=>b.text()==='Delete this card').trigger('click');await flushPromises()
  assert.equal(workspace.assets.find(a=>a.id===deck.id).data.length,1)
  assert.match(wrapper.find('.flashcard-front').text(),/Second question/)
  await wrapper.findAll('button').find(b=>b.text()==='Delete card').trigger('click')
  assert.match(wrapper.find('.custom-card-editor').text(),/last card/)
  await wrapper.findAll('button').find(b=>b.text()==='Delete this card').trigger('click');await flushPromises()
  assert.equal(workspace.assets.some(a=>a.id===deck.id),false);assert.equal(wrapper.emitted('close').length,1)
 }finally{wrapper.unmount();await workspace.dispose()}
})
test('Invitation dialog provides a paste box without email input, including for users with no spaces',async()=>{
 runtime.setActivePinia(runtime.createPinia())
 const wrapper=mount(runtime.App,{global:{stubs:{Teleport:true,StudyRoom:true,StudyViewer:true,RichEditor:true,AdminPanel:true,FocusTimer:true,Avatar:true}},attachTo:document.body})
 try{
  await flushPromises();await flushPromises()
  const workspace=runtime.useWorkspaceStore();let supplied=''
  workspace.acceptInvitation=async value=>{supplied=value;return 'joined-space'}
  workspace.selectedFolderId=null
  await flushPromises()
  const join=wrapper.findAll('button').find(b=>b.text()==='Join a space')
  assert.equal(join.attributes('disabled'),undefined);await join.trigger('click');await flushPromises()
  assert.equal(wrapper.find('[aria-label="Invitation link or code"]').exists(),true)
  assert.equal(wrapper.find('.modal input[type="email"]').exists(),false)
  await wrapper.find('[aria-label="Invitation link or code"]').setValue('https://rcgsynapse.vercel.app/?invite='+ 'a'.repeat(64))
  await wrapper.find('.join-space-form').trigger('submit');await flushPromises()
  assert.equal(supplied,'https://rcgsynapse.vercel.app/?invite='+ 'a'.repeat(64))
 }finally{wrapper.unmount();await flushPromises()}
})

test('Generation bars track saved sets and unsupported uploads show a clear error before queue admission',async()=>{
 runtime.setActivePinia(runtime.createPinia())
 const wrapper=mount(runtime.App,{global:{stubs:{Teleport:true,StudyRoom:true,StudyViewer:true,RichEditor:true,AdminPanel:true,FocusTimer:true,Avatar:true}},attachTo:document.body})
 try{
  await flushPromises();await flushPromises()
  const workspace=runtime.useWorkspaceStore();let uploads=0;workspace.uploadDocument=async()=>{uploads++}
  const task={id:'pending',title:'Chapter',document_id:'document',folder_id:workspace.selectedFolderId,status:'processing',stage:'note',completed_kinds:[]}
  for(const [saved,expected] of [[[],0],[['note'],33],[['note','deck'],66]]){
   workspace.generationTasks=[{...task,completed_kinds:saved}];await flushPromises()
   assert.equal(Number(wrapper.find('.generation-status progress').attributes('value')),expected)
  }
  const input=wrapper.find('input[type="file"][accept^=".pdf"]')
  Object.defineProperty(input.element,'files',{value:[{name:'network.pkt',size:200}],configurable:true})
  await input.trigger('change');await flushPromises()
  assert.equal(uploads,0);assert.match(wrapper.find('.modal .error-box').text(),/cannot be read.*PDF.*Packet Tracer/)
  assert.equal(wrapper.find('.toast-error').exists(),true);assert.equal(wrapper.find('.toast-error').attributes('role'),'alert')
 }finally{wrapper.unmount();await flushPromises()}
 const bar=mount(runtime.GenerationProgress,{props:{task:{status:'completed',document_id:'doc',completed_kinds:['note','deck','quiz']}}})
 assert.equal(bar.find('progress').attributes('value'),'100');bar.unmount()
 const single=mount(runtime.GenerationProgress,{props:{task:{status:'processing',kind:'deck',completed_kinds:[]}}})
 assert.equal(single.find('progress').attributes('value'),undefined,'An active AI request does not invent a completion percentage');single.unmount()
})

function pointer(target,type,x,y,id=1){
 const event=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,button:0,buttons:1,clientX:x,clientY:y})
 Object.defineProperty(event,'pointerId',{value:id});target.dispatchEvent(event)
}
test('One continuous drawing crosses paragraph gaps and table areas without escaping the paper; legacy anchors still render',async()=>{
 const legacy={id:'old-stroke',anchor:'old-block',color:'#c2413a',width:3,points:[[0.1,0.2],[0.7,0.5]]}
 const wrapper=mount(runtime.RichEditor,{props:{modelValue:'<p data-annotation-id="old-block">First</p><p>Second</p>',annotations:[legacy]},attachTo:document.body})
 try{
  await flushPromises();const host=wrapper.find('.annotated-paper').element
  host.getBoundingClientRect=()=>({left:10,top:20,width:500,height:400})
  const paragraphs=wrapper.findAll('.ProseMirror p');paragraphs[0].element.getBoundingClientRect=()=>({left:10,top:20,width:500,height:40});paragraphs[1].element.getBoundingClientRect=()=>({left:10,top:150,width:500,height:40})
  await wrapper.find('[aria-label="Draw on reviewer"]').trigger('click')
  const svg=wrapper.find('svg.drawing-layer').element
  for(const [type,x,y]of [['pointerdown',50,40],['pointermove',80,110],['pointermove',140,180],['pointermove',200,300],['pointerup',200,300]]){pointer(svg,type,x,y);await flushPromises()}
  const strokes=wrapper.emitted('update:annotations').at(-1)[0];assert.equal(strokes.length,2);assert.equal(strokes[1].anchor,'synapse-paper-v1');assert.ok(strokes[1].points.length>=5)
  assert.deepEqual(strokes[0],legacy);assert.ok(wrapper.find('[data-stroke-id="old-stroke"]').exists())
  pointer(svg,'pointerdown',70,70);pointer(svg,'pointermove',9999,9999);pointer(svg,'pointerup',9999,9999);await flushPromises()
  const latest=wrapper.emitted('update:annotations').at(-1)[0];assert.ok(latest.every(s=>s.points.every(p=>p.every(n=>n>=0&&n<=1))))
  const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');assert.match(css,/\.drawing-layer \{ z-index: 20; overflow: hidden; contain: paint; \}/);assert.match(css,/\.annotated-paper \{ min-width:0; isolation:isolate; overflow:clip;/)
 }finally{wrapper.unmount()}
})
test('The eraser works with highlights alone, removes marks without text loss, and dragging erases drawings too',async()=>{
 const wrapper=mount(runtime.RichEditor,{props:{modelValue:'<p><mark data-highlight-color="#fef08a">Important</mark> plain <mark data-highlight-color="#fef08a">Second</mark></p>'},attachTo:document.body})
 const prior=document.elementsFromPoint
 try{
  await flushPromises();const editor=wrapper.findComponent({name:'EditorContent'}).props('editor'),host=wrapper.find('.annotated-paper').element
  host.getBoundingClientRect=()=>({left:0,top:0,width:500,height:100})
  const button=wrapper.find('[aria-label="Erase drawings and highlights"]');assert.equal(button.attributes('disabled'),undefined);await button.trigger('click')
  const svg=wrapper.find('svg.drawing-layer').element
  document.elementsFromPoint=()=>[svg,...wrapper.findAll('.ProseMirror mark').slice(0,1).map(w=>w.element)]
  const before=editor.getText();pointer(svg,'pointerdown',20,20);pointer(svg,'pointerup',20,20);await flushPromises()
  assert.equal(wrapper.findAll('.ProseMirror mark').length,1);assert.equal(editor.getText(),before)
  await wrapper.setProps({annotations:[{id:'erase-me',anchor:'synapse-paper-v1',color:'#c2413a',width:3,points:[[0.1,0.5],[0.8,0.5]]}]})
  pointer(svg,'pointerdown',10,50);pointer(svg,'pointermove',100,50);pointer(svg,'pointerup',100,50);await flushPromises()
  assert.deepEqual(wrapper.emitted('update:annotations').at(-1)[0],[]);assert.equal(wrapper.findAll('.ProseMirror mark').length,0);assert.equal(editor.getText(),before)
  editor.commands.undo();await flushPromises();assert.ok(wrapper.findAll('.ProseMirror mark').length>0,'Highlight erasure participates in editor undo')
 }finally{document.elementsFromPoint=prior;wrapper.unmount()}
})
test('Column and row border dragging persists safe sizes through save, read view, editor reopen, and undo',async()=>{
 const wrapper=mount(runtime.RichEditor,{props:{modelValue:'<table><tbody><tr><th><p>Term</p></th><th><p>Meaning</p></th></tr><tr><td><p>FIFO</p></td><td><p>First in, first out</p></td></tr></tbody></table>'},attachTo:document.body})
 let reopened
 try{
  await flushPromises();const editor=wrapper.findComponent({name:'EditorContent'}).props('editor'),cell=wrapper.find('th').element,row=cell.parentElement
  cell.getBoundingClientRect=()=>({left:0,right:120,top:0,bottom:50,width:120,height:50});Object.defineProperty(cell,'offsetWidth',{value:120,configurable:true});row.getBoundingClientRect=()=>({left:0,right:300,top:0,bottom:50,width:300,height:50})
  let cellPosition;editor.state.doc.descendants((node,pos)=>{if(cellPosition===undefined&&node.type.name==='tableHeader')cellPosition=pos})
  const oldCoords=editor.view.posAtCoords;editor.view.posAtCoords=()=>({pos:cellPosition+2,inside:cellPosition})
  cell.dispatchEvent(new dom.window.MouseEvent('mousemove',{bubbles:true,clientX:119,clientY:20}))
  cell.dispatchEvent(new dom.window.MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,clientX:119,clientY:20}))
  window.dispatchEvent(new dom.window.MouseEvent('mouseup',{clientX:179,clientY:20}));await flushPromises();editor.view.posAtCoords=oldCoords
  assert.match(editor.getHTML(),/colwidth="180"/)
  const rowCell=wrapper.find('th').element;rowCell.getBoundingClientRect=()=>({left:0,right:180,top:0,bottom:50,width:180,height:50});rowCell.parentElement.getBoundingClientRect=()=>({left:0,right:300,top:0,bottom:50,width:300,height:50})
  pointer(rowCell,'pointerdown',60,49);pointer(window,'pointermove',60,109);pointer(window,'pointerup',60,109);await flushPromises()
  let saved=wrapper.emitted('update:modelValue').at(-1)[0]
  assert.match(saved,/data-row-height="110"/);assert.match(saved,/colwidth="180"/)
  const rendered=rich.renderStudyHtml(saved,'html');assert.match(rendered,/height: 110px/);assert.match(rendered,/width: 180px/)
  reopened=mount(runtime.RichEditor,{props:{modelValue:saved},attachTo:document.body});await flushPromises()
  assert.match(reopened.findComponent({name:'EditorContent'}).props('editor').getHTML(),/data-row-height="110"/)
  assert.match(reopened.findComponent({name:'EditorContent'}).props('editor').getHTML(),/colwidth="180"/)
  editor.commands.undo();await flushPromises();assert.doesNotMatch(editor.getHTML(),/data-row-height="110"/)
  const safe=rich.cleanHtml('<table><tr data-row-height="-99" style="position:fixed"><td colwidth="5,url(evil)" style="width:99999px">Safe</td></tr></table>')
  assert.doesNotMatch(safe,/position:|url\(|colwidth|row-height/)
 }finally{reopened?.unmount();wrapper.unmount()}
})

test('Blank-note dialog maximizes and resizes, and a failed save retains the title and full draft',async()=>{
 runtime.setActivePinia(runtime.createPinia())
 const wrapper=mount(runtime.App,{global:{stubs:{Teleport:true,StudyRoom:true,StudyViewer:true,AdminPanel:true,FocusTimer:true,Avatar:true,AsyncComponentWrapper:{name:'RichEditorFixture',props:['modelValue'],emits:['update:modelValue'],template:'<textarea aria-label="Note draft" :value="modelValue" @input="$emit(\'update:modelValue\',$event.target.value)" />'}}},attachTo:document.body})
 try{
  await flushPromises();await flushPromises()
  await wrapper.find('.blank-note-card').trigger('click');await flushPromises()
  assert.equal(wrapper.findAll('.resize-edge').length,8)
  await wrapper.find('[aria-label="Maximize window"]').trigger('click')
  assert.ok(wrapper.find('.modal-frame').classes().includes('modal-maximized'))
  await wrapper.find('[aria-label="Restore window"]').trigger('click')
  assert.equal(wrapper.findAll('.resize-edge').length,8)
  await wrapper.find('.modal input').setValue('My long chapter')
  const draft='<p>'+('A complete idea. '.repeat(16000))+'</p>'
  await wrapper.find('.modal [aria-label="Note draft"]').setValue(draft)
  await wrapper.find('.modal form').trigger('submit');await flushPromises()
  assert.match(wrapper.find('.error-box').text(),/too long.*draft is still open/)
  assert.equal(wrapper.find('.modal input').element.value,'My long chapter')
  assert.equal(wrapper.find('.modal [aria-label="Note draft"]').element.value,draft)
 }finally{wrapper.unmount();await flushPromises()}
})

test('Highlight cards show generated questions and evidence without a second manual save',async()=>{
 runtime.setActivePinia(runtime.createPinia());const auth=runtime.useAuthStore();await auth.initialize();const workspace=runtime.useWorkspaceStore();await workspace.load()
 const asset={...workspace.assets.find(a=>a.kind==='note'),content_format:'html',content:'<h2>Queues</h2><p><mark>FIFO means first in first out.</mark></p>'}
 const wrapper=mount(runtime.HighlightCards,{props:{asset},attachTo:document.body})
 try{
  await flushPromises()
  assert.match(wrapper.find('.highlight-card-row').text(),/What does FIFO mean\?/)
  assert.match(wrapper.find('.highlight-card-row').text(),/First in, first out/)
  assert.match(wrapper.find('.tool-evidence').text(),/FIFO means first in first out/)
  assert.equal(wrapper.find('.pill').text(),'Sample')
  assert.equal(wrapper.find('form').exists(),false)
  assert.equal(wrapper.find('[aria-label="Save highlight flashcards"]').exists(),false)
  assert.equal(wrapper.find('[aria-label="Destination custom deck"]').exists(),false)
 }finally{wrapper.unmount();await workspace.dispose()}
})
test('Concept map shows specific directed relationships, explanations and source evidence',async()=>{
 runtime.setActivePinia(runtime.createPinia());const auth=runtime.useAuthStore();await auth.initialize();const workspace=runtime.useWorkspaceStore();await workspace.load()
 const asset=workspace.assets.find(a=>a.id==='note-trees')
 const wrapper=mount(runtime.ConceptConnections,{props:{asset}})
 try{
  await flushPromises()
  await wrapper.findAll('.concept-index button').find(b=>b.text()==='Tree').trigger('click')
  assert.equal(wrapper.find('.concept-detail h4').text(),'Tree')
  assert.match(wrapper.find('.concept-links').text(),/is a type of/)
  await wrapper.findAll('.concept-links button').find(b=>b.text().includes('is a type of')).trigger('click')
  assert.match(wrapper.find('.concept-explanation').text(),/connectivity and no cycles/)
  assert.match(wrapper.find('.concept-explanation .tool-evidence').text(),/connected graph without cycles/)
  assert.ok(wrapper.find('line[marker-end]').exists())
  await wrapper.find('input').setValue('Binary search');assert.equal(wrapper.findAll('.concept-index button').length,1)
 }finally{wrapper.unmount();await workspace.dispose()}
})
test('Mistake notebook records wrong answers, supports recall and mastery, and clears private state on sign-out',async()=>{
 runtime.setActivePinia(runtime.createPinia());const auth=runtime.useAuthStore();await auth.initialize();const workspace=runtime.useWorkspaceStore();await workspace.load()
 const quiz=workspace.assets.find(a=>a.kind==='quiz')
 await workspace.submitQuiz(quiz,quiz.data.map(()=> 'Wrong'))
 const learning=runtime.useLearningStore(),wrapper=mount(runtime.MistakeNotebook,{attachTo:document.body})
 try{
  await flushPromises();assert.equal(wrapper.findAll('.mistake-entry').length,quiz.data.length)
  await wrapper.find('.mistake-question').trigger('click')
  await wrapper.find('[aria-label="Recall the answer"]').setValue(learning.mistakes[0].answer)
  await wrapper.find('[aria-label="Check recalled answer"]').trigger('click');assert.ok(wrapper.find('.quiz-feedback').classes().includes('is-correct'))
  await wrapper.find('[aria-label="Mark as understood"]').trigger('click');await flushPromises();assert.equal(wrapper.findAll('.mistake-entry').length,quiz.data.length-1)
  await wrapper.find('[aria-label="Show mastered mistakes"]').trigger('click');await flushPromises();assert.equal(wrapper.findAll('.mistake-entry').length,1)
  auth.user=null;assert.equal(learning.mistakes.length,0)
 }finally{wrapper.unmount();await workspace.dispose()}
})

test('Highlight extraction preserves equation source and table boundaries instead of duplicated rendered math',async()=>{
 const {reviewerHighlights,selectedReviewerText}=await import('../src/lib/studyTools.js')
 const source='<p><mark>Find <span data-type="inline-math" data-latex="x=6"><span>rendered twice</span></span> exactly.</mark></p><table><tr><td>Queue</td><td>FIFO</td></tr></table>'
 assert.deepEqual(reviewerHighlights(source,'html').map(h=>h.text),['Find x=6 exactly.'])
 assert.match(rich.plainStudyText(source,'html').replace(/\s+/g,' '),/Queue FIFO/)
 const host=document.createElement('article');host.innerHTML=source;document.body.append(host)
 const range=document.createRange();range.selectNodeContents(host);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range)
 try{assert.equal(selectedReviewerText(host),'Find x=6 exactly. Queue FIFO')}finally{selection.removeAllRanges();host.remove()}
 const wrapper=mount(runtime.RichEditor,{props:{modelValue:source},attachTo:document.body})
 try{
  await flushPromises();const editor=wrapper.findComponent({name:'EditorContent'}).props('editor');editor.commands.selectAll();await flushPromises();await new Promise(resolve=>setTimeout(resolve,30))
  await wrapper.find('[aria-label="Create flashcard from highlighted text"]').trigger('click')
  assert.match(wrapper.emitted('flashcard')[0][0],/x=6/)
  assert.doesNotMatch(wrapper.emitted('flashcard')[0][0],/rendered twice/)
 }finally{wrapper.unmount()}
})
test('AI tool progress distinguishes checking and preview cards clear when their highlights disappear',async()=>{
 const task={id:'checking',tool:'highlights',tool_phase:'checking',kind:'deck',stage:'deck',status:'processing',completed_kinds:[],stream_chars:120}
 const progress=mount(runtime.GenerationProgress,{props:{task}})
 assert.match(progress.text(),/Checking source support/);assert.equal(progress.find('.generation-stream-status').exists(),false);progress.unmount()
 runtime.setActivePinia(runtime.createPinia());const auth=runtime.useAuthStore();await auth.initialize();const workspace=runtime.useWorkspaceStore();await workspace.load()
 const asset={...workspace.assets.find(a=>a.kind==='note'),content_format:'html',content:'<p><mark>FIFO means first in first out.</mark></p>'}
 const wrapper=mount(runtime.HighlightCards,{props:{asset},attachTo:document.body})
 try{await flushPromises();assert.ok(wrapper.find('.highlight-card-row').exists());await wrapper.setProps({asset:{...asset,content:'<p>The reviewer no longer has highlighted text.</p>'}});await flushPromises();assert.equal(wrapper.find('.highlight-card-row').exists(),false);assert.match(wrapper.text(),/Highlight a passage first/)}finally{wrapper.unmount();await workspace.dispose()}
})

test('Reviewer tool buttons isolate clicks and hide the parent reviewer generation action',async()=>{
 runtime.setActivePinia(runtime.createPinia());const auth=runtime.useAuthStore();await auth.initialize();const workspace=runtime.useWorkspaceStore();await workspace.load()
 const id=crypto.randomUUID(),asset={...workspace.assets.find(a=>a.kind==='note'),id,series_id:id,content_format:'html',content:'<p><mark>FIFO means first in first out.</mark></p>'};workspace.assets.unshift(asset)
 let refreshes=0,bubbled=0;workspace.refreshAsset=async()=>{refreshes++;return {status:'queued',id:'unexpected'}}
 const wrapper=mount(runtime.StudyViewer,{props:{asset},global:{stubs:{Teleport:true,Modal:{template:'<section><slot /></section>'},DrawingLayer:true}},attachTo:document.body})
 try{
  await flushPromises();const viewer=wrapper.find('.viewer-content').element;viewer.addEventListener('click',()=>bubbled++)
  const highlight=wrapper.findAll('button').find(button=>button.text()==='Flashcards from highlights')
  assert.equal(highlight.attributes('type'),'button');await highlight.trigger('click');await flushPromises();
  assert.equal(bubbled,0);assert.equal(refreshes,0);assert.ok(wrapper.find('.highlight-cards').exists())
  assert.equal(wrapper.findAll('button').some(button=>button.text()==='Generate'),false)
  await wrapper.find('[aria-label="Generate flashcards from selected highlights"]').trigger('click');await flushPromises()
  assert.equal(refreshes,0);assert.equal(bubbled,0)
  await wrapper.find('[aria-label="Close highlight cards"]').trigger('click');await flushPromises()
  const generate=wrapper.findAll('button').find(button=>button.text()==='Generate');assert.ok(generate)
  await generate.trigger('click');await flushPromises();assert.equal(refreshes,1)
 }finally{wrapper.unmount();await workspace.dispose()}
})

test('Saved concept maps reopen from material data without generating, exporting or rendering a quiz',async()=>{
 runtime.setActivePinia(runtime.createPinia());const auth=runtime.useAuthStore();await auth.initialize();const workspace=runtime.useWorkspaceStore();await workspace.load()
 const graph={nodes:[{id:'c1',label:'Saved queue concept',body:'Preserves arrival order.',evidence:{quote:'FIFO'}},{id:'c2',label:'FIFO',body:'First in first out.',evidence:{quote:'FIFO'}}],edges:[{from:'c1',to:'c2',label:'uses',explanation:'Queue removal uses FIFO.',evidence:{quote:'FIFO'}}]}
 const id=crypto.randomUUID(),asset={id,series_id:id,set_number:1,kind:'concept',title:'Saved Concept Map',folder_id:workspace.selectedFolderId,data:[graph],content:'',content_format:'markdown',created_by:auth.user.id};workspace.assets.unshift(asset)
 let refreshes=0;workspace.refreshAsset=async()=>{refreshes++;throw Error('Unexpected generation')}
 const wrapper=mount(runtime.StudyViewer,{props:{asset},global:{stubs:{Teleport:true,Modal:{template:'<section><slot /></section>'},DrawingLayer:true}},attachTo:document.body})
 try{
  await flushPromises();assert.match(wrapper.find('.viewer-toolbar .pill').text(),/Concept Map/)
  assert.match(wrapper.find('.concept-detail h4').text(),/Saved queue concept/)
  assert.equal(wrapper.find('.error-box').exists(),false);assert.equal(wrapper.find('.quiz-body').exists(),false)
  assert.equal(wrapper.find('.export-menu').exists(),false);assert.equal(wrapper.find('.print-content').exists(),false)
  assert.equal(wrapper.findAll('button').some(button=>button.text()==='Generate'),false);assert.equal(refreshes,0)
  await wrapper.find('[aria-label="Close concept connections"]').trigger('click');assert.ok(wrapper.emitted('close'))
 }finally{wrapper.unmount();await workspace.dispose()}
})
