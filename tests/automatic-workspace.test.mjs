import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { writeFileSync,unlinkSync } from 'node:fs'

test('Upload automatically generates all three formats; retry fills only missing output; refresh uses the open asset without choices or Seeds',async()=>{
 const old={__autoWorkspaceClient:globalThis.__autoWorkspaceClient,location:globalThis.location,localStorage:globalThis.localStorage,sessionStorage:globalThis.sessionStorage}
 const requests=[],rpcNames=[],assets=[],documents=[];let failDeck=true
 const folderId=crypto.randomUUID(),userId=crypto.randomUUID(),runtimePath=fileURLToPath(new URL('./.automatic-workspace-runtime.mjs',import.meta.url))
 const chain=table=>({select(){return this},eq(){return this},order(){return this},limit(){return this},insert(value){documents.push({...value,expires_at:new Date(Date.now()+86400000).toISOString()});return this},then:resolve=>resolve({data:table==='document_files'?documents:[],error:null})})
 globalThis.__autoWorkspaceClient={from:chain,rpc:async(name)=>{rpcNames.push(name);return {data:name==='list_latest_assets'?[...assets]:null,error:null}},storage:{from:()=>({upload:async()=>({error:null})})},functions:{invoke:async(_name,{body})=>{
  requests.push(body)
  if(body.action==='prepare')return {data:{material_id:'material'},error:null}
  if(body.kind==='deck'&&failDeck)return {data:null,error:{message:'Failed',context:{json:async()=>({error:'Gemini returned incomplete JSON for the practice set.'})}}}
  if(body.initial){const existing=assets.find(a=>a.kind===body.kind);if(existing)return {data:{asset_id:existing.id,existing:true},error:null}}
  const kind=body.kind || assets.find(a=>a.id===body.asset_id).kind,id=crypto.randomUUID()
  assets.push({id,folder_id:folderId,kind,title:'Saved '+kind,set_number:1,created_at:new Date().toISOString()});return {data:{asset_id:id},error:null}
 }} }
 const storage=()=>({getItem(){return null},setItem(){},removeItem(){}})
 globalThis.localStorage=storage();globalThis.sessionStorage=storage();globalThis.location={origin:'http://localhost:5173'}
 try{
  const bundle=await build({stdin:{contents:"export {createPinia,setActivePinia} from 'pinia';export {useWorkspaceStore} from './src/stores/workspace.js';export {useAuthStore} from './src/stores/auth.js';",resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,platform:'node',format:'esm',packages:'external',define:{'import.meta.env':'{}'},plugins:[{name:'mock-supabase',setup(b){b.onResolve({filter:/\/lib\/supabase$/},()=>({path:'mock-supabase',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const supabase=globalThis.__autoWorkspaceClient;export const isConfigured=true;export const supabaseUrl="https://test.supabase.co";',loader:'js'}))}}]})
  writeFileSync(runtimePath,bundle.outputFiles[0].contents);const runtime=await import(pathToFileURL(runtimePath).href)
  runtime.setActivePinia(runtime.createPinia());const auth=runtime.useAuthStore();auth.user={id:userId};auth.demo=false
  const workspace=runtime.useWorkspaceStore();workspace.folders=[{id:folderId,owner_id:userId}];workspace.selectedFolderId=folderId
  const file=new File(['A complete source about queues and their FIFO operations.'],'queues.txt',{type:'text/plain'})
  const partial=await workspace.uploadDocument(file)
  assert.deepEqual(requests.map(r=>r.action==='prepare'?'prepare':r.kind),['prepare','note','deck','quiz'])
  assert.equal(partial.completed.length,2);assert.equal(partial.failures[0].kind,'deck');assert.equal(workspace.uploading,false)
  const firstNote=assets.find(a=>a.kind==='note').id,firstQuiz=assets.find(a=>a.kind==='quiz').id
  failDeck=false;const resumed=await workspace.retryDocument(documents[0])
  assert.equal(resumed.failures.length,0);assert.equal(assets.length,3);assert.equal(assets.find(a=>a.kind==='note').id,firstNote);assert.equal(assets.find(a=>a.kind==='quiz').id,firstQuiz)
  const deck=assets.find(a=>a.kind==='deck');await workspace.refreshAsset(deck)
  assert.deepEqual(requests.at(-1),{action:'generate',asset_id:deck.id});assert.equal(assets.length,4)
  assert.ok(requests.every(r=>!('options' in r)));assert.ok(!rpcNames.includes('my_seed_balance'));assert.equal('seeds' in workspace,false)
  await workspace.dispose()
 }finally{try{unlinkSync(runtimePath)}catch{};for(const[k,v]of Object.entries(old)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}}
})
