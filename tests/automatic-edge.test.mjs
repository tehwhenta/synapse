import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

test('Automatic generation engine prepares once, saves all formats separately, refreshes one kind, and keeps valid output on failure',async()=>{
 const old={Deno:globalThis.Deno,fetch:globalThis.fetch,__synapseAutoClient:globalThis.__synapseAutoClient}
 const materialId=crypto.randomUUID(),documentId=crypto.randomUUID(),uid=crypto.randomUUID()
 const text='A queue uses FIFO ordering. Enqueue adds at the rear and dequeue removes the oldest item.'
 let handler,retained='',hash=null,claimed=0,failed=0,broken=false,active=true,currentKind
 const saved=[],history={note:[],deck:[],quiz:[]},env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-only',GEMINI_API_KEY:'fake-key',ALLOWED_ORIGINS:'http://localhost:5173'}
 const material=()=>({id:materialId,source_hash:hash,source_text:retained,source_format:'markdown'})
 const doc={id:documentId,material_id:materialId,storage_path:'folder/user/file.txt',mime_type:'text/plain',size_bytes:new Blob([text]).size,expires_at:new Date(Date.now()+86400000).toISOString()}
 const client={auth:{getUser:async(token)=>({data:{user:token==='valid'?{id:uid}:null},error:token==='valid'?null:{message:'invalid'}})},from:table=>{
  const query={select(){return this},eq(){return this},update(){return this},single:async()=>({data:{id:documentId,material_id:materialId,kind:'deck',is_custom:false},error:null}),then:resolve=>resolve({data:null,error:null})};return query
 },storage:{from:()=>({download:async()=>({data:new Blob([text]),error:null})})},rpc:async(name,args)=>{
  if(name==='account_is_active')return {data:active,error:null}
  if(name==='generation_source')return {data:{document:doc,material:material()},error:null}
  if(name==='bind_generation_source'){hash=args.p_hash;assert.match(hash,/^[0-9a-f]{64}$/);return {data:material(),error:null}}
  if(name==='claim_auto_source')return {data:{cached:!!retained,token:'source-token',material:material()},error:null}
  if(name==='retain_auto_source'){retained=args.p_text;assert.equal(retained,text);return {data:material(),error:null}}
  if(name==='claim_auto_generation'){currentKind=args.p_kind;claimed++;return {data:{job_id:'job-'+claimed,kind:currentKind,options:{variant:'comprehensive'},source_text:retained,source_format:'markdown',previous:history[currentKind]},error:null}}
  if(name==='complete_auto_generation'){const output=args.p_output,asset={id:crypto.randomUUID(),kind:currentKind,set_number:saved.filter(a=>a.kind===currentKind).length+1};saved.push(asset);history[currentKind].push(...(currentKind==='note'?[{prompt:output.notes}]:output[currentKind==='deck'?'flashcards':'quiz'].map(i=>({prompt:i.front||i.question,coverage_key:i.coverage_key}))));return {data:asset,error:null}}
  if(name==='fail_material_generation'){failed++;return {data:null,error:null}}
  throw new Error('Unexpected RPC: '+name)
 }}
 globalThis.__synapseAutoClient=()=>client;globalThis.Deno={env:{get:k=>env[k]},serve:fn=>handler=fn}
 globalThis.fetch=async(_url,options)=>{
  const payload=JSON.parse(options.body);assert.equal(payload.generationConfig.responseJsonSchema,undefined)
  if(broken)return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"flashcards":['}]}}]})
  if(payload.generationConfig.responseMimeType==='text/plain')return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'# Queues\n\n## Definition\nA FIFO queue preserves arrival order.\n\n## Example\n$\\frac{1}{2}$ is retained without JSON escaping.'}]}}]})
  const contract=JSON.parse(payload.systemInstruction.parts[0].text.split('\n').at(-1))
  const deck=!!contract.properties.flashcards
  const output=deck?{flashcards:Array.from({length:4},(_,i)=>({front:'Distinct queue question '+i,back:'A source-supported answer.',coverage_key:'queue:facet_'+i}))}:{quiz:Array.from({length:3},(_,i)=>({type:'short_answer',question:'Identify source operation '+i,options:[],answer:'Enqueue',accepted_answers:[],explanation:'Adds an item at the rear.',coverage_key:'queue:quiz_'+i}))}
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(output)}]}}]})
 }
 try{
  const bundle=await build({entryPoints:[fileURLToPath(new URL('../supabase/functions/generate-study/engine.ts',import.meta.url))],bundle:true,write:false,platform:'neutral',format:'esm',external:['npm:*']})
  const {executeGeneration}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
  handler=async req=>{try{return Response.json(await executeGeneration(client,uid,await req.json()))}catch(error){return Response.json({error:error.message},{status:500})}}
  const request=(body,token='valid')=>new Request('https://test/generate-study',{method:'POST',headers:{Origin:'http://localhost:5173',Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)})
  assert.equal((await handler(request({action:'prepare',document_id:documentId}))).status,200);assert.equal(claimed,0)
  for(const kind of ['note','deck','quiz'])assert.equal((await handler(request({action:'generate',document_id:documentId,kind,initial:true}))).status,200)
  assert.deepEqual(saved.map(s=>s.kind),['note','deck','quiz']);assert.equal(claimed,3)
  broken=true;const response=await handler(request({action:'generate',asset_id:documentId}))
  assert.equal(response.status,500);assert.match((await response.json()).error,/incomplete JSON/);assert.equal(failed,1);assert.equal(saved.length,3)
 }finally{for(const [k,v]of Object.entries(old)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}}
})

test('Automatic output accepts AI-selected counts and common answer notation while rejecting repeats and malformed data',async()=>{
 const bundle=await build({entryPoints:[fileURLToPath(new URL('../supabase/functions/generate-study/automatic.ts',import.meta.url))],bundle:true,write:false,platform:'neutral',format:'esm'})
 const {validateAutomatic,automaticPrompt}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
 const quiz={quiz:[{type:'true_false',question:'Is FIFO a queue ordering?',answer:true,coverage_key:'queue:fifo',explanation:'A queue removes the earliest arrival.',options:['true','false']},{type:'multiple_choice',question:'Which inserts an item?',answer:'A',options:['Enqueue','Dequeue','Peek','Sort'],coverage_key:'queue:insert',explanation:'Enqueue inserts at the rear.'},{type:'identification',question:'Name the removal operation.',answer:'Dequeue',options:[],coverage_key:'queue:remove',explanation:'Dequeue removes at the front.'}]}
 const value=validateAutomatic(quiz,'quiz');assert.equal(value.quiz[0].answer,'True');assert.equal(value.quiz[1].answer,'Enqueue');assert.equal(value.quiz[2].type,'short_answer')
 assert.throws(()=>validateAutomatic(quiz,'quiz',[{prompt:quiz.quiz[0].question,coverage_key:'queue:fifo'}]),/repeated/)
 assert.throws(()=>validateAutomatic({flashcards:[]},'deck'),/No fresh questions/)
  assert.throws(()=>validateAutomatic({flashcards:[null,null,null]},'deck'),/incomplete question/)
 assert.throws(()=>validateAutomatic('SOURCE_EXHAUSTED','note'),/No fresh study content/)
 assert.match(automaticPrompt('note'),/complete, organized, exam-ready reviewer/);assert.match(automaticPrompt('note'),/line-by-line worked solution/)
})
