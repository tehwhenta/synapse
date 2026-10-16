import { fileURLToPath, pathToFileURL } from 'node:url'
import test,{before,beforeEach,after} from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { writeFileSync,unlinkSync } from 'node:fs'
const runtimePath=fileURLToPath(new URL('./.workspace-sync-runtime.mjs',import.meta.url))
let runtime,workspace,calls,channels,delayAssets,resolveAssets
const previousLocation = globalThis.location
const data=(table,id)=>table==='folder_members'?[]:table==='study_messages'?[{id:id+'-message',folder_id:id,user_id:'me',body:id,created_at:new Date().toISOString()}]:[{id:id+'-item',folder_id:id,series_id:id+'-item',set_number:1,created_at:new Date().toISOString()}]
before(async()=>{
  globalThis.location={origin:'http://localhost:5173'}
  globalThis.__syncClient={
    async rpc(name,args){calls.push(name);if(delayAssets&&name==='list_latest_assets'&&args.p_folder_id==='one')return new Promise(resolve=>{resolveAssets=resolve});return {data:data('study_assets',args.p_folder_id)}},
    from(table){const params={};let inserting=false;const query={select(){return this},eq(key,value){params[key]=value;return this},order(){return this},limit(){return this},insert(){inserting=true;return this},then(resolve){calls.push(table+(inserting?':insert':''));return Promise.resolve({data:inserting?null:data(table,params.folder_id)}).then(resolve)}};return query},
    channel(name){const events=[];const channel={name,events,removed:false,on(type,filter,callback){events.push({type,filter,callback});return this},subscribe(callback){this.status=callback;return this}};channels.push(channel);return channel},
    async removeChannel(channel){channel.removed=true},
  }
  const compiled=await build({stdin:{contents:"export {createPinia,setActivePinia} from 'pinia';export {useAuthStore} from './src/stores/auth.js';export {useWorkspaceStore} from './src/stores/workspace.js';",resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'node',packages:'external',define:{'import.meta.env':'{}'},plugins:[{name:'workspace-api',setup(builder){builder.onResolve({filter:/(^|\/)supabase$/},()=>({path:'client',namespace:'mock'}));builder.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const supabase=globalThis.__syncClient;export const isConfigured=true;',loader:'js'}))}}]})
  writeFileSync(runtimePath,compiled.outputFiles[0].contents);runtime=await import(pathToFileURL(runtimePath).href)
})
beforeEach(()=>{calls=[];channels=[];delayAssets=false;resolveAssets=null;runtime.setActivePinia(runtime.createPinia());const auth=runtime.useAuthStore();auth.user={id:'me'};auth.demo=false;workspace=runtime.useWorkspaceStore();workspace.folders=[{id:'one',owner_id:'me'},{id:'two',owner_id:'me'}];workspace.selectedFolderId='one'})
after(()=>{delete globalThis.__syncClient;if(previousLocation===undefined)delete globalThis.location;else globalThis.location=previousLocation;try{unlinkSync(runtimePath)}catch{}})

test('Chat updates query only messages and leave loaded reviewers/uploads intact',async t=>{
  t.after(()=>workspace.dispose());await workspace.loadFolder();const assets=workspace.assets,documents=workspace.documents
  calls=[];await workspace.loadFolder(new Set(['study_messages']))
  assert.deepEqual(calls,['study_messages']);assert.equal(workspace.assets,assets);assert.equal(workspace.documents,documents)
  calls=[];await workspace.sendMessage('A thought');assert.deepEqual(calls,['study_messages:insert','study_messages'])
})
test('Slow previous-space results cannot overwrite the current space or repopulate after sign-out',async t=>{
  t.after(()=>workspace.dispose());delayAssets=true;const first=workspace.loadFolder();await Promise.resolve();const resolveFirst=resolveAssets
  await workspace.selectFolder('two');assert.equal(workspace.assets[0].folder_id,'two')
  resolveFirst({data:data('study_assets','one')});await first;assert.equal(workspace.assets[0].folder_id,'two')
  workspace.selectedFolderId='one';const pending=workspace.loadFolder();await Promise.resolve();const resolveLast=resolveAssets
  await workspace.dispose();resolveLast({data:data('study_assets','one')});await pending
  assert.equal(workspace.assets.length,0);assert.equal(workspace.messages.length,0)
})
test('Rapid space changes keep one current subscription and stale events cannot reload it',async t=>{
  t.after(()=>workspace.dispose());await workspace.selectFolder('one');const first=channels[0]
  await Promise.all([workspace.selectFolder('two'),workspace.selectFolder('one')])
  assert.equal(workspace.selectedFolderId,'one');assert.equal(channels.filter(c=>!c.removed).length,1)
  assert.equal(channels.find(c=>!c.removed).name,'changes:one')
  calls=[];first.events[0].callback({eventType:'INSERT',new:{folder_id:'one'}})
  await new Promise(resolve=>setTimeout(resolve,400));assert.equal(calls.length,0)
})

test('Workspace catches tool materials after the reviewer closes and after reconnecting',async t=>{
 t.after(()=>workspace.dispose());await workspace.selectFolder('one');const channel=channels.find(c=>!c.removed)
 calls=[];channel.status('SUBSCRIBED');await new Promise(resolve=>setTimeout(resolve,400))
 assert.ok(calls.includes('list_latest_assets'));assert.ok(calls.includes('study_messages'));assert.equal(calls.includes('document_files'),false)
 calls=[];const event=channel.events.find(event=>event.filter.table==='study_assets' && event.filter.event==='INSERT')
 event.callback({eventType:'INSERT',new:{folder_id:'one'}});await new Promise(resolve=>setTimeout(resolve,400))
 assert.deepEqual(calls,['list_latest_assets']);assert.equal(workspace.assets[0].folder_id,'one')
})
