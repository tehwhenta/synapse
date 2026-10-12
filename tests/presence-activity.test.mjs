import test from 'node:test'
import assert from 'node:assert/strict'
import { livePresence, peopleInSpace, presenceLabel, presencePublisher, PRESENCE_EXPIRY } from '../src/lib/lounge.js'
import { startActivityTracking } from '../src/lib/activity.js'

test('Presence expires suspended clients, rejects invalid/future clocks, and merges multiple devices honestly',() => {
  const now=Date.now(), a=crypto.randomUUID(), b=crypto.randomUUID()
  const row=(client,offset,extra={})=>({client_id:client,user_id:'student',name:'Student',last_seen_at:new Date(now+offset).toISOString(),...extra})
  const peers=livePresence([row(a,-100,{away:true}),row(a,-200,{away:false}),row(b,-1000,{away:false}),row(crypto.randomUUID(),-PRESENCE_EXPIRY-1),row(crypto.randomUUID(),60000),{client_id:crypto.randomUUID(),user_id:'missing-clock'}],now)
  assert.equal(peers.length,2);assert.equal(peers.find(p=>p.client_id===a).away,true)
  assert.equal(peopleInSpace(peers).length,1);assert.equal(presenceLabel(peers),'1 online')
  assert.equal(presenceLabel(peers.map(p=>({...p,away:true}))),'0 online · 1 away')
})
test('Rapid presence controls coalesce pending payloads without simultaneous track calls',async () => {
  const sent=[];let complete,maxPending=0,pending=0
  const publish=presencePublisher(async value=>{sent.push(value);maxPending=Math.max(maxPending,++pending);if(value.n===1)await new Promise(resolve=>{complete=resolve});pending--})
  const first=publish({n:1});publish({n:2});const last=publish({n:3});complete();await Promise.all([first,last])
  assert.deepEqual(sent,[{n:1},{n:3}]);assert.equal(maxPending,1)
})
test('Activity writes are throttled, stop in hidden/offline/dormant tabs, resume on interaction, and release listeners',async () => {
  const doc=new EventTarget(), win=new EventTarget();doc.visibilityState='visible';win.navigator={onLine:true}
  let now=0,tick,records=0,cancelled=false
  const stop=startActivityTracking({record:async()=>{records++},document:doc,window:win,clock:()=>now,interval:fn=>{tick=fn;return 1},cancelInterval:()=>{cancelled=true}})
  await Promise.resolve();assert.equal(records,1)
  now=1000;win.dispatchEvent(new Event('pointerdown'));await Promise.resolve();assert.equal(records,1)
  now=600000;tick();await Promise.resolve();assert.equal(records,1)
  doc.visibilityState='hidden';win.dispatchEvent(new Event('keydown'));await Promise.resolve();assert.equal(records,1)
  doc.visibilityState='visible';win.navigator.onLine=false;win.dispatchEvent(new Event('pointerdown'));await Promise.resolve();assert.equal(records,1)
  win.navigator.onLine=true;win.dispatchEvent(new Event('online'));await Promise.resolve();assert.equal(records,2)
  stop();now+=600000;win.dispatchEvent(new Event('pointerdown'));tick();await Promise.resolve();assert.equal(records,2);assert.equal(cancelled,true)
})
