import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
import {build} from 'esbuild'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs'
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost:5173',pretendToBeVisual:true})
const runtimePath=fileURLToPath(new URL('./.study-tools-client-runtime.mjs',import.meta.url))
let runtime,mount,flushPromises
before(async()=>{
 for(const key of ['window','document','HTMLElement','Element','SVGElement','Node','localStorage'])globalThis[key]=dom.window[key]
 const bundle=await build({stdin:{contents:"export {useStudyTool} from './src/lib/useStudyTool.js';export {defineComponent,h,reactive} from 'vue';",resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'node',packages:'external',plugins:[{name:'tool-client-fixtures',setup(builder){
  builder.onResolve({filter:/stores\/auth$/},()=>({path:'auth',namespace:'mock'}))
  builder.onResolve({filter:/stores\/workspace$/},()=>({path:'workspace',namespace:'mock'}))
  builder.onResolve({filter:/\/supabase$/},()=>({path:'supabase',namespace:'mock'}))
  builder.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='auth'?'export const useAuthStore=()=>globalThis.__toolAuth':args.path==='workspace'?'export const useWorkspaceStore=()=>globalThis.__toolWorkspace':'export const supabase={rpc:(...args)=>globalThis.__toolClient.rpc(...args),functions:{invoke:(...args)=>globalThis.__toolClient.invoke(...args)}}',loader:'js'}))
 }}]})
 writeFileSync(runtimePath,bundle.outputFiles[0].text);runtime=await import(pathToFileURL(runtimePath).href)
 const utils=await import('@vue/test-utils');mount=utils.mount;flushPromises=utils.flushPromises
})
after(()=>{for(const key of ['__toolAuth','__toolWorkspace','__toolClient'])delete globalThis[key];dom.window.close();try{unlinkSync(runtimePath)}catch{}})
const asset={id:crypto.randomUUID(),title:'Queues',content:'FIFO means first in first out.',content_format:'markdown'}
const result={cards:[{highlight_id:'h1',front:'What does FIFO mean?',back:'First in first out.',evidence:{source:'reviewer',quote:asset.content}}]}
function setup(tool='highlights'){
 localStorage.clear();globalThis.__toolAuth=runtime.reactive({demo:false,user:{id:crypto.randomUUID()}});globalThis.__toolWorkspace={canEdit:true}
 const calls=[],task={id:crypto.randomUUID(),tool,stage:'deck',status:'queued'}
 let cached=false,finished=false
 globalThis.__toolClient={rpc:async(name,args)=>{calls.push([name,args]);return {data:name==='read_study_tool'?{output:cached?result:null}:{task:{...task,status:finished?'completed':'processing'},output:finished?result:null}}},invoke:async(name,args)=>{calls.push([name,args.body]);return {data:{success:true,task}}}}
 const Component=runtime.defineComponent({setup(){return runtime.useStudyTool(()=>asset,tool)},render(){return runtime.h('div')}}),wrapper=mount(Component)
 return {wrapper,calls,task,setCached:value=>cached=value,setFinished:value=>finished=value}
}
test('Cached tool output makes no provider admission request and readonly users can reuse it',async()=>{
 const {wrapper,calls,setCached}=setup();setCached(true);globalThis.__toolWorkspace.canEdit=false
 try{await wrapper.vm.generate(['FIFO']);assert.deepEqual(wrapper.vm.output,result);assert.equal(wrapper.vm.busy,false);assert.equal(calls.length,1);assert.equal(calls[0][0],'read_study_tool')}
 finally{wrapper.unmount()}
})
test('New AI previews enqueue once, expose progress, resume from status and stop polling when closed',async()=>{
 const {wrapper,calls,setFinished}=setup()
 try{
  await wrapper.vm.generate(['FIFO'])
  const request=calls.find(([name])=>name==='generate-study')[1]
  assert.equal(request.action,'study-tool');assert.equal(request.asset_id,asset.id);assert.equal(request.tool,'highlights');assert.deepEqual(request.highlights,['FIFO']);assert.ok(request.request_id)
  assert.equal(wrapper.vm.busy,true);assert.equal(wrapper.vm.output,null)
  setFinished(true);window.dispatchEvent(new dom.window.Event('online'));await flushPromises()
  assert.deepEqual(wrapper.vm.output,result);assert.equal(wrapper.vm.busy,false)
  const count=calls.length;wrapper.unmount();window.dispatchEvent(new dom.window.Event('online'));await flushPromises();assert.equal(calls.length,count)
 }finally{if(wrapper.exists())wrapper.unmount()}
})
test('Lost acknowledgements reuse a request ID, and late results never cross a signed-out account',async()=>{
 const {wrapper,calls}=setup();let admitted=0,lateResolve
 const base=globalThis.__toolClient.invoke
 globalThis.__toolClient.invoke=async(name,args)=>{calls.push(['request-id',args.body.request_id]);if(!admitted++)return {error:{message:'Lost acknowledgement'}};return base(name,args)}
 try{
  await wrapper.vm.generate(['FIFO']);assert.equal(calls.filter(([name])=>name==='request-id').length,2)
  assert.equal(calls.filter(([name])=>name==='request-id')[0][1],calls.filter(([name])=>name==='request-id')[1][1])
  globalThis.__toolClient.rpc=()=>new Promise(resolve=>lateResolve=resolve)
  window.dispatchEvent(new dom.window.Event('online'));await flushPromises()
  globalThis.__toolAuth.user=null;await flushPromises();assert.equal(wrapper.vm.output,null);assert.equal(wrapper.vm.task,null);assert.equal(wrapper.vm.busy,false)
  lateResolve({data:{task:{status:'completed'},output:result}});await flushPromises();assert.equal(wrapper.vm.output,null);assert.equal(wrapper.vm.task,null)
 }finally{wrapper.unmount()}
})
test('A reader cannot reserve new AI work, invalid highlights fail before admission, and source changes surface without a retry loop',async()=>{
 const {wrapper,calls}=setup();globalThis.__toolWorkspace.canEdit=false
 try{
  await wrapper.vm.generate(['FIFO']);assert.match(wrapper.vm.error,/space editor/);assert.equal(calls.some(([name])=>name==='generate-study'),false)
  await wrapper.vm.generate(['']);assert.match(wrapper.vm.error,/Choose up to 20/)
  globalThis.__toolWorkspace.canEdit=true;await wrapper.vm.generate(['FIFO'])
  globalThis.__toolClient.rpc=async()=>({error:{message:'Reviewer changed. Save and reopen the study tool'}})
  window.dispatchEvent(new dom.window.Event('online'));await flushPromises()
  assert.match(wrapper.vm.error,/Reviewer changed/);assert.equal(wrapper.vm.busy,false);assert.equal(wrapper.vm.task,null)
 }finally{wrapper.unmount()}
})
