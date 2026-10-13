import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { writeFileSync,unlinkSync } from 'node:fs'

test('Browser submits one durable upload request, observes all three stages, and resumes monitoring after reload',async()=>{
 const old={__autoWorkspaceClient:globalThis.__autoWorkspaceClient,location:globalThis.location,localStorage:globalThis.localStorage,sessionStorage:globalThis.sessionStorage}
 const requests=[],rpcNames=[],assets=[],documents=[],tasks=[]
 const folderId=crypto.randomUUID(),userId=crypto.randomUUID(),runtimePath=fileURLToPath(new URL('./.automatic-workspace-runtime.mjs',import.meta.url))
 const chain=table=>({select(){return this},eq(){return this},order(){return this},limit(){return this},insert(value){documents.push({...value,expires_at:new Date(Date.now()+86400000).toISOString()});return this},then:resolve=>resolve({data:table==='document_files'?documents:[],error:null})})
 let loseAck=true
 globalThis.__autoWorkspaceClient={from:chain,rpc:async(name)=>{rpcNames.push(name);return {data:name==='list_latest_assets'?[...assets]:name==='my_generation_tasks'?structuredClone(tasks):null,error:null}},storage:{from:()=>({upload:async()=>({error:null})})},functions:{invoke:async(_name,{body})=>{
  requests.push(body);assert.equal(body.action,'enqueue')
  let task=tasks.find(t=>t.request_id===body.request_id || body.document_id && t.document_id===body.document_id)
  if(!task){task={id:crypto.randomUUID(),request_id:body.request_id,document_id:body.document_id || null,asset_id:body.asset_id || null,folder_id:folderId,status:'queued',stage:'prepare',completed_kinds:[]};tasks.push(task)}
  if(loseAck){loseAck=false;return {error:{message:'Network response lost'}}}
  return {data:{task:structuredClone(task)},error:null}
 }} }
 const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}}
 globalThis.localStorage=storage();globalThis.sessionStorage=storage();globalThis.location={origin:'http://localhost:5173'}
 let workspace,restored
 try{
  const bundle=await build({stdin:{contents:"export {createPinia,setActivePinia} from 'pinia';export {useWorkspaceStore} from './src/stores/workspace.js';export {useAuthStore} from './src/stores/auth.js';",resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,platform:'node',format:'esm',packages:'external',define:{'import.meta.env':'{}'},plugins:[{name:'mock-supabase',setup(b){b.onResolve({filter:/\/lib\/supabase$/},()=>({path:'mock-supabase',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const supabase=globalThis.__autoWorkspaceClient;export const isConfigured=true;export const supabaseUrl="https://test.supabase.co";',loader:'js'}))}}]})
  writeFileSync(runtimePath,bundle.outputFiles[0].contents);const runtime=await import(pathToFileURL(runtimePath).href)
  const create=()=>{runtime.setActivePinia(runtime.createPinia());const auth=runtime.useAuthStore();auth.user={id:userId};auth.demo=false;const store=runtime.useWorkspaceStore();store.folders=[{id:folderId,owner_id:userId}];store.selectedFolderId=folderId;return store}
  workspace=create()
  const queued=await workspace.uploadDocument(new File(['A complete source about queues and their FIFO operations.'],'queues.txt',{type:'text/plain'}))
  assert.equal(queued.status,'queued');assert.equal(workspace.uploading,false);assert.equal(tasks.length,1)
  assert.equal(requests.length,2);assert.equal(requests[0].request_id,requests[1].request_id,'Lost acknowledgement retries the same key')
  assert.equal(assets.length,0,'Browser does not make three AI requests')
  tasks[0].stage='quiz';tasks[0].status='queued';tasks[0].completed_kinds=['note','deck'];tasks[0].message='Preparing your remaining study materials…'
  for(const kind of ['note','deck'])assets.push({id:crypto.randomUUID(),folder_id:folderId,kind,set_number:1,created_at:new Date().toISOString()})
  await workspace.pollGeneration();assert.equal(workspace.activeGeneration.length,1);assert.equal(workspace.assets.length,2)
  await workspace.dispose();restored=create();await restored.pollGeneration()
  assert.equal(restored.activeGeneration.length,1,'Server status resumes without browser storage')
  assets.push({id:crypto.randomUUID(),folder_id:folderId,kind:'quiz',set_number:1,created_at:new Date().toISOString()})
  tasks[0].status='completed';tasks[0].completed_kinds=['note','deck','quiz'];await restored.pollGeneration()
  assert.equal(restored.activeGeneration.length,0);assert.equal(restored.assets.length,3)
  const deck=assets.find(a=>a.kind==='deck');await restored.refreshAsset(deck)
  assert.equal(requests.at(-1).asset_id,deck.id);assert.equal(requests.at(-1).action,'enqueue')
  assert.ok(requests.every(r=>!('options' in r)));assert.ok(!rpcNames.includes('my_seed_balance'))
 }finally{await workspace?.dispose();await restored?.dispose();try{unlinkSync(runtimePath)}catch{};for(const[k,v]of Object.entries(old)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}}
})
