import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse, compileScript } from '@vue/compiler-sfc'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:5173', pretendToBeVisual: true })
const runtimePath = fileURLToPath(new URL('./.lounge-runtime.mjs',import.meta.url))
let runtime, mount, flushPromises, channels, peers, stopped, closed, mediaRequest, mediaFactory, encodings, auth, workspace
const peerId = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function stream(screen = false) { const tracks = (screen ? ['video'] : ['audio','video']).map(kind => ({ kind, enabled: true, stop() { stopped++ } })); return { getTracks: () => tracks, getAudioTracks: () => tracks.filter(t=>t.kind==='audio'), getVideoTracks: () => tracks.filter(t=>t.kind==='video') } }
before(async () => {
  for (const key of ['window','document','HTMLElement','Element','SVGElement','Node','localStorage','sessionStorage','location','history']) globalThis[key] = dom.window[key]
  Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true})
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async request=>{mediaRequest=request;return mediaFactory()},getDisplayMedia:async()=>stream(true)},configurable:true})
  globalThis.RTCPeerConnection = class {
    constructor() { this.senders=[]; this.connectionState='new' }
    addTrack(track) { this.senders.push({track,getParameters:()=>({encodings:[{}]}),setParameters:async parameters=>{encodings.push(parameters.encodings[0])},async replaceTrack(value){this.track=value}}) }
    getSenders(){return this.senders}
    close(){closed++}
    restartIce(){}
  }
  globalThis.__loungeClient = {
    auth:{getSession:async()=>({data:{session:{access_token:'test-session'}}})},realtime:{setAuth:async()=>{}},
    channel(){const callbacks={};const channel={on(type,_filter,fn){callbacks[type]=fn;return this},subscribe(fn){this.update=fn;queueMicrotask(()=>fn('SUBSCRIBED'));return this},presenceState(){return {others:peers,self:this.self?[this.self]:[]}},async track(value){this.self=value;callbacks.presence?.();return 'ok'},async send(){return 'ok'},async untrack(){this.self=null},callbacks};channels.push(channel);return channel},
    async removeChannel(channel){channel.update('CLOSED')},
  }
  const compiled=await build({stdin:{contents:"export {default as StudyRoom} from './src/components/StudyRoom.vue'; export {createPinia,setActivePinia} from 'pinia'; export {useAuthStore} from './src/stores/auth.js'; export {useWorkspaceStore} from './src/stores/workspace.js';",resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'node',packages:'external',define:{'import.meta.env':'{}'},plugins:[{name:'lounge-test',setup(builder){
    builder.onResolve({filter:/lib\/supabase$/},()=>({path:'supabase-mock',namespace:'mock'}))
    builder.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const supabase=globalThis.__loungeClient; export const isConfigured=true;',loader:'js'}))
    builder.onLoad({filter:/\.vue$/},args=>{const {descriptor}=parse(readFileSync(args.path,'utf8'));return {contents:compileScript(descriptor,{id:args.path,inlineTemplate:true}).content,loader:'js',resolveDir:dirname(args.path)}})
  }}]})
  writeFileSync(runtimePath,compiled.outputFiles[0].contents);runtime=await import(pathToFileURL(runtimePath).href)
  const utils=await import('@vue/test-utils');mount=utils.mount;flushPromises=utils.flushPromises
})
beforeEach(()=>{
  channels=[];stopped=0;closed=0;encodings=[];mediaFactory=()=>stream()
  peers=Array.from({length:20},(_,i)=>({client_id:peerId(i+1),user_id:'peer-'+i,name:'Student '+(i+1),in_call:true,away:false,last_seen_at:new Date().toISOString()}))
  runtime.setActivePinia(runtime.createPinia());auth=runtime.useAuthStore();auth.user={id:'me'};auth.profile={display_name:'Student'};auth.demo=false
  workspace=runtime.useWorkspaceStore();workspace.folders=[{id:'space',owner_id:'me',title:'Test class'}];workspace.selectedFolderId='space'
})
after(()=>{delete globalThis.__loungeClient;delete globalThis.RTCPeerConnection;dom.window.close();try{unlinkSync(runtimePath)}catch{}})

test('Calls allow more than four people, page visible video tiles, and keep audio for every participant',async t=>{
  const wrapper=mount(runtime.StudyRoom,{attachTo:document.body});t.after(()=>wrapper.unmount());await flushPromises()
  await wrapper.find('.call-welcome .button').trigger('click');await flushPromises()
  assert.equal(wrapper.find('.call-controls').exists(),true)
  assert.equal(wrapper.findAll('.video-tile').length,12)
  assert.equal(wrapper.findAll('audio').length,20)
  assert.match(wrapper.find('.video-pagination').text(),/21 participants/)
  assert.equal(mediaRequest.video.width.ideal,640)
  await wrapper.find('[aria-label="Next participants"]').trigger('click');await flushPromises()
  assert.equal(wrapper.findAll('.video-tile').length,9);assert.equal(wrapper.findAll('audio').length,20)
  await wrapper.find('[aria-label="Mute microphone"]').trigger('click');await flushPromises()
  assert.equal(channels[0].self.muted,true)
  await wrapper.findAll('button').find(b=>b.text()==='Share screen').trigger('click');await flushPromises()
  assert.equal(wrapper.findAll('.is-sharing').length,1);assert.equal(channels[0].self.sharing,true,wrapper.find('[role="alert"]').exists()?wrapper.find('[role="alert"]').text():'Screen-sharing presence was not updated')
  wrapper.unmount();assert.equal(closed,20);assert.equal(stopped,3)
})
test('Disconnecting clears online peers and releases cameras and all peer connections',async t=>{
  const wrapper=mount(runtime.StudyRoom,{attachTo:document.body});t.after(()=>wrapper.unmount());await flushPromises()
  await wrapper.find('.call-welcome .button').trigger('click');await flushPromises()
  channels[0].update('CHANNEL_ERROR');await flushPromises()
  assert.equal(wrapper.find('.call-controls').exists(),false)
  assert.equal(wrapper.emitted('presence').at(-1)[0].length,0)
  assert.equal(wrapper.emitted('connection').at(-1)[0],'connecting')
  assert.equal(closed,20);assert.equal(stopped,2)
  assert.match(wrapper.find('[role="alert"]').text(),/call ended/)
  wrapper.unmount()
})
test('A delayed camera permission response cannot leave media running after leaving the room',async t=>{
  let resolveMedia;mediaFactory=()=>new Promise(resolve=>{resolveMedia=resolve})
  const wrapper=mount(runtime.StudyRoom,{attachTo:document.body});t.after(()=>wrapper.unmount());await flushPromises()
  await wrapper.find('.call-welcome .button').trigger('click');wrapper.unmount()
  resolveMedia(stream());await flushPromises()
  assert.equal(stopped,2);assert.equal(closed,0)
})

test('Page restoration recreates presence, network loss clears it, and repeated tabs count as one person',async t=>{
  peers=[{client_id:peerId(1),user_id:'buddy',name:'Buddy',away:true,last_seen_at:new Date().toISOString()},{client_id:peerId(2),user_id:'buddy',name:'Buddy',away:false,last_seen_at:new Date().toISOString()}]
  const wrapper=mount(runtime.StudyRoom,{attachTo:document.body});t.after(()=>wrapper.unmount());await flushPromises()
  assert.match(wrapper.find('.section-heading .muted').text(),/2 online/)
  const setVisibility=value=>Object.defineProperty(document,'visibilityState',{value,configurable:true})
  setVisibility('hidden');document.dispatchEvent(new window.Event('visibilitychange'));await flushPromises()
  assert.equal(channels[0].self.away,true)
  assert.match(wrapper.find('.section-heading .muted').text(),/1 online · 1 away/)
  setVisibility('visible');document.dispatchEvent(new window.Event('visibilitychange'));await flushPromises()
  assert.equal(channels[0].self.away,false)
  window.dispatchEvent(new window.Event('pagehide'));await flushPromises()
  assert.equal(wrapper.emitted('presence').at(-1)[0].length,0)
  window.dispatchEvent(new window.Event('pageshow'));await flushPromises()
  assert.equal(channels.length,2);assert.equal(channels[1].self.away,false)
  Object.defineProperty(navigator,'onLine',{value:false,configurable:true});window.dispatchEvent(new window.Event('offline'));await flushPromises()
  assert.equal(wrapper.emitted('connection').at(-1)[0],'offline');assert.equal(wrapper.emitted('presence').at(-1)[0].length,0)
  Object.defineProperty(navigator,'onLine',{value:true,configurable:true});window.dispatchEvent(new window.Event('online'));await flushPromises()
  assert.equal(channels.length,3);assert.equal(wrapper.emitted('connection').at(-1)[0],'online')
})
