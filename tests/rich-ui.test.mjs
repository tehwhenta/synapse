import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse, compileScript } from '@vue/compiler-sfc'
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url:'http://localhost:5173',pretendToBeVisual:true })
let rich, mount, flushPromises, runtime
const runtimePath = new URL('./.rich-ui-runtime.mjs',import.meta.url).pathname
before(async () => {
  for (const key of ['window','document','HTMLElement','Element','SVGElement','Node','DOMParser','MutationObserver','File','Blob','FileReader','localStorage','sessionStorage','location','history','getComputedStyle']) globalThis[key] = dom.window[key]
  globalThis.requestAnimationFrame = callback => setTimeout(callback,0)
  globalThis.cancelAnimationFrame = clearTimeout
  dom.window.Range.prototype.getClientRects = () => []
  dom.window.Range.prototype.getBoundingClientRect = () => ({left:0,right:0,top:0,bottom:0,width:0,height:0})
  rich = { ...await import('../src/lib/richText.js'), ...await import('../src/lib/studyRendering.js') }
  const utils = await import('@vue/test-utils'); mount = utils.mount; flushPromises = utils.flushPromises
  const compiled = await build({ stdin:{ contents:"export {default as RichEditor} from './src/components/RichEditor.vue'; export {default as StudyViewer} from './src/components/StudyViewer.vue'; export {default as Modal} from './src/components/Modal.vue'; export {createPinia,setActivePinia} from 'pinia'; export {useAuthStore} from './src/stores/auth.js'; export {useWorkspaceStore} from './src/stores/workspace.js';",resolveDir:new URL('..',import.meta.url).pathname },bundle:true,write:false,platform:'node',format:'esm',packages:'external',define:{'import.meta.env':'{}'},plugins:[
    {name:'vue-test',setup(builder){builder.onLoad({filter:/\.vue$/},args=>{const {descriptor}=parse(readFileSync(args.path,'utf8'));return {contents:compileScript(descriptor,{id:args.path,inlineTemplate:true}).content,loader:'js',resolveDir:dirname(args.path)}})}}
  ] })
  // Download-style asset glob is a build-time feature, irrelevant to these DOM interaction tests.
  const source = compiled.outputFiles[0].text.replace(/import mathCss from "katex\/dist\/katex.min.css\?raw";/,'const mathCss="";').replace(/const fonts = import\.meta\.glob\([^;]+;/,'const fonts={};')
  writeFileSync(runtimePath,source); runtime = await import(runtimePath)
})
after(() => { dom.window.close(); try {unlinkSync(runtimePath)} catch {} })

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
    assert.equal(strokes.length,1);assert.equal(strokes[0].width,7);assert.equal(strokes[0].color,'#2563eb');assert.equal(strokes[0].anchor,p.dataset.annotationId)
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
test('Study viewer navigates retained sets, edits titles, and opens a new set without losing the first',async () => {
  runtime.setActivePinia(runtime.createPinia()); const auth=runtime.useAuthStore(); await auth.initialize(); const workspace=runtime.useWorkspaceStore(); await workspace.load()
  const first = workspace.assets.find(a=>a.id==='deck-trees')
  const wrapper = mount(runtime.StudyViewer,{props:{asset:first},global:{stubs:{Teleport:true}},attachTo:document.body})
  await flushPromises(); assert.equal(wrapper.findAll('.set-numbers button').length,2)
  assert.equal(wrapper.find('.set-numbers .active').text(),'1')
  await wrapper.find('[aria-label="Open set 2"]').trigger('click'); await flushPromises()
  assert.equal(wrapper.find('.set-numbers .active').text(),'2')
  assert.match(wrapper.find('.flashcard-text').text(),/leaf node/)
  await wrapper.findAll('button').find(b=>b.text()==='Rename').trigger('click')
  await wrapper.find('.rename-form input').setValue('My own practice title')
  await wrapper.find('.rename-form').trigger('submit'); await flushPromises()
  assert.equal(workspace.assets.find(a=>a.id==='deck-trees-2').title,'My own practice title')
  assert.equal(workspace.assets.find(a=>a.id==='deck-trees').title,first.title)
  assert.doesNotMatch(wrapper.text(),/JSON/)
  workspace.refreshAsset = async current => {const next={...current,id:'deck-trees-3',set_number:3,data:[{front:'A new prompt?',back:'A new answer.'}]};workspace.assets.push(next);return next.id}
  await wrapper.findAll('button').find(b=>b.text()==='Generate new set').trigger('click'); await flushPromises()
  assert.equal(wrapper.findAll('.set-numbers button').length,3); assert.equal(wrapper.find('.set-numbers .active').text(),'3')
  await wrapper.find('[aria-label="Open set 1"]').trigger('click'); await flushPromises()
  assert.match(wrapper.find('.flashcard-text').text(),/makes a graph a tree/)
  wrapper.unmount(); await workspace.dispose()
})
test('Profile name and photo persist in sample mode; invalid formats and oversized photos are rejected',async () => {
  runtime.setActivePinia(runtime.createPinia()); const auth=runtime.useAuthStore(); await auth.initialize()
  await assert.rejects(auth.updateProfile('Student',new File(['x'],'bad.svg',{type:'image/svg+xml'})),/Choose a JPG/)
  await assert.rejects(auth.updateProfile('Student',new File([new Uint8Array(2097153)],'large.jpg',{type:'image/jpeg'})),/2 MB/)
  await auth.updateProfile('Ralph',new File(['photo bytes'],'avatar.png',{type:'image/png'}))
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
  await wrapper.findAll('button').find(b=>b.text()==='Generate new set').trigger('click'); await flushPromises()
  assert.equal(generated,0); assert.equal(wrapper.find('.refresh-warning').exists(),true)
  await wrapper.findAll('button').find(b=>b.text()==='Upload original').trigger('click')
  assert.equal(wrapper.emitted('reupload').length,1)
  await wrapper.findAll('button').find(b=>b.text()==='Use retained text').trigger('click'); await flushPromises()
  assert.equal(generated,1); assert.equal(workspace.assets.some(a=>a.id===first.id),true)
  wrapper.unmount(); await workspace.dispose()
})
