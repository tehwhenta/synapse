import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'
const source=await transform(readFileSync(new URL('../supabase/functions/cleanup-files/accountDeletion.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'})
const { purgeDueAccounts }=await import('data:text/javascript;base64,'+Buffer.from(source.code).toString('base64'))
function setup(failStorage=false,backlog=false) {
  const calls=[]; let objects=[{bucket_id:'profile-photos',name:'user/photo.png'},{bucket_id:'study-files',name:'space/user/source.pdf'}]
  const admin={rpc:async(name,args)=>{calls.push([name,args]); if(name==='claim_due_account_deletions')return {data:[{user_id:'user',claim_token:'lease'}],error:null};if(name==='account_storage_deletions')return {data:objects,error:null};return {data:null,error:null}},storage:{from:bucket=>({remove:async paths=>{calls.push(['remove',bucket,paths]);if(failStorage)return {error:new Error('Storage unavailable')};if(!backlog)objects=objects.filter(o=>o.bucket_id!==bucket||!paths.includes(o.name));return {error:null}}})},auth:{admin:{deleteUser:async(...args)=>{calls.push(['deleteUser',...args]);return {error:null}}}}}
  return {admin,calls}
}
test('The deletion worker removes every bucket object before preparing rows and hard-deleting Auth',async()=>{
  const {admin,calls}=setup(); const result=await purgeDueAccounts(admin)
  assert.equal(result.deleted,1);assert.deepEqual(result.errors,[])
  const prepared=calls.findIndex(call=>call[0]==='prepare_account_deletion'),deleted=calls.findIndex(call=>call[0]==='deleteUser')
  assert.ok(calls.filter(call=>call[0]==='remove').every(call=>calls.indexOf(call)<prepared));assert.ok(prepared<deleted)
  assert.deepEqual(calls[deleted],['deleteUser','user',false])
  assert.deepEqual(calls[prepared][1],{p_user_id:'user',p_claim_token:'lease'})
})
test('Storage failures retain the account and rows for a later retry',async()=>{
  const {admin,calls}=setup(true);const result=await purgeDueAccounts(admin)
  assert.equal(result.deleted,0);assert.match(result.errors[0],/Storage unavailable/)
  assert.equal(calls.some(call=>['prepare_account_deletion','deleteUser'].includes(call[0])),false)
  assert.equal(calls.filter(call=>call[0]==='retry_account_deletion').length,1)
})
test('A large backlog continues on later runs rather than deleting Auth before the objects are gone',async()=>{
  const {admin,calls}=setup(false,true);const result=await purgeDueAccounts(admin)
  assert.equal(result.deleted,0);assert.equal(result.more,true)
  assert.equal(calls.some(call=>['prepare_account_deletion','deleteUser'].includes(call[0])),false)
})
