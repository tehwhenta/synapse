import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'
import { readFileSync,writeFileSync,unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse,compileScript } from '@vue/compiler-sfc'
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost:5173',pretendToBeVisual:true})
const runtimePath=fileURLToPath(new URL('./.admin-ui-runtime.mjs',import.meta.url))
let runtime,mount,flushPromises,auth,calls,cleanupFailure,timingFailure
const rows=[{user_id:crypto.randomUUID(),display_name:'Former student',email:'former@example.com',last_active_at:'2025-01-01T00:00:00Z',owned_spaces:2,materials:4,delete_after:null,deletion_reason:null},{user_id:crypto.randomUUID(),display_name:'Already queued',email:'queued@example.com',last_active_at:'2025-01-02T00:00:00Z',owned_spaces:0,materials:3,delete_after:'2099-01-01T00:00:00Z',deletion_reason:'inactive'}]
before(async()=>{
  for(const key of ['window','document','Document','HTMLElement','Element','SVGElement','Node','localStorage','sessionStorage','location','history'])globalThis[key]=dom.window[key]
  globalThis.__adminUiClient={supabaseUrl:'https://example.supabase.co',async rpc(name,args){calls.push([name,args]);if(name==='admin_system_summary')return {data:{users:12,materials:20,spaces:3,active_week:4,pending_accounts:1,storage_bytes:10e6,database_bytes:25e6,checked_at:new Date().toISOString()}};if(name==='admin_generation_performance')return timingFailure?{error:{message:'Timings unavailable'}}:{data:{capacity:{overall:3,per_user:2},totals:{measured:0},stages:[],recent:[]}};if(name==='admin_cleanup_preview')return {data:{invitations:2,activity:0,jobs:7,usage:0,audits:0,duplicate_text:0,queue:{running:1,waiting:2,paused:1,parallel:2,scheduler_ready:true},paused_tasks:[{id:'paused-id',title:'Chapter',message:'Waiting for configuration',last_error:'Model not found'}]}};if(name==='admin_clean_records')return {data:{jobs:7}};if(name==='admin_resume_generation')return {data:1};if(name==='admin_inactive_accounts')return {data:rows};if(name==='admin_schedule_inactive_accounts')return {data:{scheduled:1,skipped:0}};return {data:true}},functions:{async invoke(){return cleanupFailure?{error:{message:'Function failed',context:{json:async()=>({errors:['Storage unavailable']})}}}:{data:{purged:2,accounts_deleted:0}}}},storage:{from(){return {async createSignedUrl(){calls.push(['signed-url']);return {data:{signedUrl:'https://example.test/avatar.jpg'}}}}}}}
  const compiled=await build({stdin:{contents:"export {default as AdminPanel} from './src/components/AdminPanel.vue'; export {createPinia,setActivePinia} from 'pinia'; export {useAuthStore} from './src/stores/auth.js'; export {profilePhotoUrl,clearProfilePhotos} from './src/lib/profilePhotos.js';",resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'node',packages:'external',define:{'import.meta.env':'{}'},plugins:[{name:'admin-ui',setup(builder){
    builder.onResolve({filter:/(^|\/)supabase$/},()=>({path:'supabase-mock',namespace:'mock'}))
    builder.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const supabase=globalThis.__adminUiClient;export const isConfigured=true;',loader:'js'}))
    builder.onLoad({filter:/\.vue$/},args=>{const {descriptor}=parse(readFileSync(args.path,'utf8'));return {contents:compileScript(descriptor,{id:args.path,inlineTemplate:true}).content,loader:'js',resolveDir:dirname(args.path)}})
  }}]})
  writeFileSync(runtimePath,compiled.outputFiles[0].contents);runtime=await import(pathToFileURL(runtimePath).href);const utils=await import('@vue/test-utils');mount=utils.mount;flushPromises=utils.flushPromises
})
beforeEach(()=>{calls=[];cleanupFailure=false;timingFailure=false;runtime.setActivePinia(runtime.createPinia());auth=runtime.useAuthStore();auth.user={id:'admin-user'};auth.demo=false;auth.isAdmin=true})
after(()=>{delete globalThis.__adminUiClient;dom.window.close();try{unlinkSync(runtimePath)}catch{}})

test('Admin data is fetched only when an authorized user opens System care',async t=>{
  const wrapper=mount(runtime.AdminPanel,{props:{visible:false},attachTo:document.body});t.after(()=>wrapper.unmount());await flushPromises();assert.equal(calls.length,0)
  await wrapper.setProps({visible:true});await flushPromises();assert.equal(wrapper.findAll('.inactive-account').length,2)
  auth.isAdmin=false;await flushPromises();assert.equal(wrapper.find('.admin-page').exists(),false)
  const count=calls.length;await wrapper.setProps({visible:false});await wrapper.setProps({visible:true});assert.equal(calls.length,count)
})
test('A missing timing migration cannot block account review or maintenance controls',async t=>{
 timingFailure=true
 const wrapper=mount(runtime.AdminPanel,{props:{visible:true},attachTo:document.body});t.after(()=>wrapper.unmount());await flushPromises()
 assert.equal(wrapper.findAll('.inactive-account').length,2);assert.match(wrapper.text(),/Generation timings are unavailable/)
 assert.equal(wrapper.find('.maintenance-card button').exists(),true)
 assert.equal(calls.filter(([name])=>name==='admin_generation_performance').length,1)
})
test('Inactive account actions require a scope review and typed confirmation; pending accounts cannot be selected',async t=>{
  const wrapper=mount(runtime.AdminPanel,{props:{visible:true},attachTo:document.body});t.after(()=>wrapper.unmount());await flushPromises()
  const boxes=wrapper.findAll('.inactive-account input[type="checkbox"]');assert.ok(boxes[1].attributes('disabled')!==undefined)
  await boxes[0].setValue(true);await wrapper.find('.admin-actions > button').trigger('click');await flushPromises()
  const modal=document.querySelector('.modal');assert.ok(modal);assert.match(modal.textContent,/owned spaces and their contents/)
  const form=modal.querySelector('form');form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await flushPromises()
  assert.equal(calls.some(([name])=>name==='admin_schedule_inactive_accounts'),false)
  const input=modal.querySelector('input');input.value='DELETE';input.dispatchEvent(new window.Event('input',{bubbles:true}));await flushPromises()
  form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await flushPromises()
  assert.deepEqual(calls.find(([name])=>name==='admin_schedule_inactive_accounts')[1],{p_user_ids:[rows[0].user_id],p_days:90})
  assert.match(wrapper.emitted('notify')[0][0],/7-day recovery window/)
})
test('Cleanup failure remains visible after refreshing usage totals',async t=>{
  cleanupFailure=true;const wrapper=mount(runtime.AdminPanel,{props:{visible:true},attachTo:document.body});t.after(()=>wrapper.unmount());await flushPromises()
  await wrapper.find('.maintenance-card button').trigger('click');await flushPromises()
  assert.match(wrapper.find('[role="alert"]').text(),/Some cleanup tasks failed/)
  assert.equal(calls.filter(([name])=>name==='admin_system_summary').length,2)
})
test('Profile links deduplicate concurrent requests and stay isolated across accounts',async()=>{
  runtime.clearProfilePhotos()
  const [first,second]=await Promise.all([runtime.profilePhotoUrl('one','owner/photo.jpg'),runtime.profilePhotoUrl('one','owner/photo.jpg')])
  assert.equal(first.url,second.url);assert.equal(calls.filter(([name])=>name==='signed-url').length,1)
  await runtime.profilePhotoUrl('two','owner/photo.jpg');assert.equal(calls.filter(([name])=>name==='signed-url').length,2)
  runtime.clearProfilePhotos();await runtime.profilePhotoUrl('one','owner/photo.jpg');assert.equal(calls.filter(([name])=>name==='signed-url').length,3)
})

test('Admin previews selected technical cleanup and can resume a paused generation',async t=>{
 const wrapper=mount(runtime.AdminPanel,{props:{visible:true},attachTo:document.body});t.after(()=>wrapper.unmount());await flushPromises()
 const option=wrapper.findAll('.cleanup-option').find(x=>x.text().includes('Finished technical jobs'))
 await option.find('input').setValue(true)
 await wrapper.findAll('button').find(b=>b.text()==='Review cleanup').trigger('click');await flushPromises()
 const modal=document.querySelector('.modal');assert.match(modal.textContent,/Saved learning materials and user accounts stay intact/)
 assert.equal(calls.some(([name])=>name==='admin_clean_records'),false)
 modal.querySelector('.button.primary').click();await flushPromises()
 assert.deepEqual(calls.find(([name])=>name==='admin_clean_records')[1],{p_categories:['jobs']})
 await wrapper.find('.queue-paused-row button').trigger('click');await flushPromises()
 assert.deepEqual(calls.find(([name])=>name==='admin_resume_generation')[1],{p_ids:['paused-id']})
})
