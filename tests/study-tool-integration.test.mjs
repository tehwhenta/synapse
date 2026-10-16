import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {writeFileSync,unlinkSync} from 'node:fs'
const runtimePath=fileURLToPath(new URL('./.study-tool-integration-runtime.mjs',import.meta.url))
const old={localStorage:globalThis.localStorage,sessionStorage:globalThis.sessionStorage,location:globalThis.location,__integrationClient:globalThis.__integrationClient}
let runtime
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)}}
before(async()=>{
 globalThis.localStorage=storage();globalThis.sessionStorage=storage();globalThis.location={origin:'http://localhost:5173'}
 const bundle=await build({stdin:{contents:"export {createPinia,setActivePinia} from 'pinia';export {useWorkspaceStore} from './src/stores/workspace.js';export {useAuthStore} from './src/stores/auth.js';export {useLearningStore} from './src/stores/learning.js';",resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'node',packages:'external',define:{'import.meta.env':'{}'},plugins:[{name:'integration-client',setup(builder){
  builder.onResolve({filter:/(^|\/)supabase$/},()=>({path:'client',namespace:'mock'}))
  builder.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const supabase={rpc:(...args)=>globalThis.__integrationClient.rpc(...args),from:(...args)=>globalThis.__integrationClient.from(...args)};export const isConfigured=true;',loader:'js'}))
 }}]})
 writeFileSync(runtimePath,bundle.outputFiles[0].contents);runtime=await import(pathToFileURL(runtimePath).href)
})
after(()=>{try{unlinkSync(runtimePath)}catch{};for(const[k,v]of Object.entries(old)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}})
function setup(){runtime.setActivePinia(runtime.createPinia());const auth=runtime.useAuthStore();auth.user={id:crypto.randomUUID()};auth.demo=false;const workspace=runtime.useWorkspaceStore(),folder=crypto.randomUUID();workspace.selectedFolderId=folder;workspace.folders=[{id:folder,owner_id:auth.user.id}];return {auth,workspace,learning:runtime.useLearningStore(),source:{id:crypto.randomUUID(),folder_id:folder,kind:'note'}}}
const cards=[{front:'What does FIFO mean?',back:'First in first out.'}],context={fingerprint:'checked-source-context',highlights:['FIFO']}
test('A lost save acknowledgement retries one request ID; a failed list reload does not repeat the committed card save',async()=>{
 const {workspace,source}=setup(),requests=[],saved=new Map();let lose=true
 globalThis.__integrationClient={rpc:async(name,args)=>{
  if(name!=='save_highlight_cards_v2')throw new Error('List reload is temporarily offline')
  requests.push(args)
  if(!saved.has(args.p_request_id))saved.set(args.p_request_id,{id:crypto.randomUUID(),is_custom:true,data:[{id:crypto.randomUUID(),...cards[0]}]})
  if(lose){lose=false;throw new Error('Save acknowledgement lost')}
  return {data:[saved.get(args.p_request_id)]}
 }}
 try{
  await assert.rejects(workspace.saveHighlightCards(source,'My cards',cards,null,context),/acknowledgement lost/)
  const deck=await workspace.saveHighlightCards(source,'My cards',cards,null,context)
  assert.equal(saved.size,1);assert.equal(deck.data.length,1);assert.equal(requests[0].p_request_id,requests[1].p_request_id)
  assert.deepEqual(requests[0].p_highlights,['FIFO']);assert.equal(requests[0].p_fingerprint,context.fingerprint)
 }finally{await workspace.dispose()}
})
test('Missing checked context blocks saving before a write, and an account change cannot publish the previous user’s save',async()=>{
 const {workspace,source,auth}=setup();let resolveSave,requested
 globalThis.__integrationClient={rpc:async(name,args)=>{requested=args;return new Promise(resolve=>resolveSave=resolve)}}
 try{
  await assert.rejects(workspace.saveHighlightCards(source,'My cards',cards),/Generate and check/)
  assert.equal(requested,undefined)
  const saving=workspace.saveHighlightCards(source,'My cards',cards,null,context)
  while(!resolveSave)await new Promise(resolve=>setTimeout(resolve,1))
  auth.user={id:crypto.randomUUID()};workspace.assets=[]
  resolveSave({data:{id:crypto.randomUUID(),data:cards}})
  await assert.rejects(saving,/account changed after saving/);assert.deepEqual(workspace.assets,[])
 }finally{await workspace.dispose()}
})
test('Notebook mastery/deletion responses cannot mutate a newly signed-in account',async()=>{
 const {workspace,learning,auth}=setup();let resolveMutation
 globalThis.__integrationClient={from:()=>({update(){return this},delete(){return this},eq(){return this},then(resolve){resolveMutation=resolve}})}
 try{
  for(const action of ['setMastered','remove']){
   const oldItem={id:crypto.randomUUID()},newItem={id:crypto.randomUUID()};learning.mistakes=[oldItem]
   const pending=action==='remove'?learning.remove(oldItem):learning.setMastered(oldItem,true)
   await new Promise(resolve=>setTimeout(resolve,0));assert.ok(resolveMutation)
   auth.user={id:crypto.randomUUID()};learning.mistakes=[newItem];const revision=learning.revision
   resolveMutation({data:null,error:null});await pending
   assert.deepEqual(learning.mistakes,[newItem]);assert.equal(learning.revision,revision)
  }
 }finally{await workspace.dispose()}
})
