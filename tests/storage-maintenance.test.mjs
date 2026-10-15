import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {fileURLToPath} from 'node:url'
const bundle=await build({entryPoints:[fileURLToPath(new URL('../supabase/functions/cleanup-files/maintenance.ts',import.meta.url))],bundle:true,write:false,platform:'neutral',format:'esm'})
const {runMaintenance}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
function fixture(fail=false){
 const calls=[],orphans=[{bucket_id:'profile-photos',storage_path:'old/photo.png',claim_id:'photo-claim'},{bucket_id:'study-files',storage_path:'old/file.txt',claim_id:'file-claim'}]
 const admin={from:()=>({update(){return this},in:async()=>({error:null})}),storage:{from:bucket=>({remove:async paths=>{calls.push(['remove',bucket,paths]);return {error:fail&&bucket==='profile-photos'?new Error('Temporary Storage failure'):null}}})},rpc:async(name,args)=>{
  calls.push([name,args])
  if(name==='begin_maintenance_run')return {data:'cleanup-token'}
  if(name==='expired_storage_files')return {data:[{id:'expired',storage_path:'expired/file.pdf'}]}
  if(name==='pending_storage_deletions')return {data:[]}
  if(name==='claim_due_account_deletions')return {data:[]}
  if(name==='claim_orphan_storage')return {data:orphans}
  if(name==='finish_orphan_storage')return {data:args.p_claim_ids.length}
  if(name==='prune_maintenance_records')return {data:{timings:0}}
  return {data:null,error:null}
 }}
 return {admin,calls}
}
test('Expired and orphan objects are removed through the correct Storage buckets before their claims are finalized',async()=>{
 const {admin,calls}=fixture(),result=await runMaintenance(admin)
 assert.equal(result.purged,1);assert.equal(result.orphaned,2);assert.deepEqual(result.errors,[])
 for(const [id,bucket,path]of [['photo-claim','profile-photos','old/photo.png'],['file-claim','study-files','old/file.txt']]){
  const removed=calls.findIndex(c=>c[0]==='remove'&&c[1]===bucket&&c[2].includes(path)),finished=calls.findIndex(c=>c[0]==='finish_orphan_storage'&&c[1].p_claim_ids.includes(id))
  assert.ok(removed>=0&&finished>removed);assert.equal(calls[finished][1].p_run_token,'cleanup-token')
 }
 assert.equal(calls.some(c=>c[0]==='finish_maintenance_run'),true)
})
test('A Storage failure leaves its quarantine for the next scheduled retry while other cleanup still succeeds',async()=>{
 const {admin,calls}=fixture(true),result=await runMaintenance(admin)
 assert.equal(result.orphaned,1);assert.match(result.errors.join(' '),/Temporary Storage failure/)
 assert.equal(calls.some(c=>c[0]==='finish_orphan_storage'&&c[1].p_claim_ids.includes('photo-claim')),false)
 assert.ok(calls.some(c=>c[0]==='finish_orphan_storage'&&c[1].p_claim_ids.includes('file-claim')))
})
