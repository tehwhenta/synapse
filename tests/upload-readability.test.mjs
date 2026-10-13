import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {fileURLToPath} from 'node:url'
import {JSDOM} from 'jsdom'
import {zipSync,strToU8} from 'fflate'
const compiled=await build({stdin:{contents:"export * from './supabase/functions/_shared/uploadTypes.ts';export {extractOfficeText} from './src/lib/documents.js';export * from './supabase/functions/generate-study/queue.ts';export * from './supabase/functions/generate-study/errors.ts';export {geminiJson} from './supabase/functions/generate-study/transport.ts';",resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,platform:'neutral',format:'esm'})
const api=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'))

test('Unsupported, renamed binary and unreadable uploads are rejected before generation',async()=>{
 assert.throws(()=>api.validateUploadMetadata({name:'network.pkt',size:100}),error=>error.code==='UPLOAD_UNREADABLE' && /Packet Tracer/.test(error.message))
 assert.throws(()=>api.validateUploadMetadata({name:'old.doc',size:100}),/DOCX|PDF/)
 for(const name of ['renamed.pdf','renamed.docx','renamed.pptx','renamed.png','renamed.jpg','renamed.webp','renamed.ppt','renamed.txt']){
  await assert.rejects(api.validateUploadContents(new Blob([new Uint8Array([0,1,2,3,4,5])]),name),error=>error.code==='UPLOAD_UNREADABLE')
 }
 await assert.rejects(api.extractOfficeText(new File(['Too short'],'short.txt')),/Not enough readable/)
 await assert.rejects(api.extractOfficeText(new File(['A'.repeat(100001)],'long.txt')),/100,000/)
 assert.equal(await api.extractOfficeText(new File(['A queue maintains FIFO order and supports insertion and removal.'],'valid.txt')),'A queue maintains FIFO order and supports insertion and removal.')
})

test('Real signatures and Office text are accepted while empty/corrupt Office files get actionable messages',async()=>{
 for(const [name,bytes] of [['study.pdf',new TextEncoder().encode('%PDF-1.7 real header')],['image.png',new Uint8Array([137,80,78,71,13,10,26,10])],['image.jpg',new Uint8Array([255,216,255])],['image.webp',new TextEncoder().encode('RIFFabcdWEBP')]])assert.ok(await api.validateUploadContents(new Blob([bytes]),name))
 const oldParser=globalThis.DOMParser,dom=new JSDOM('');globalThis.DOMParser=dom.window.DOMParser
 try{
  const good=zipSync({'word/document.xml':strToU8('<w:document xmlns:w="w"><w:p>A queue maintains FIFO order in a sequence of items.</w:p></w:document>')})
  assert.match(await api.extractOfficeText(new File([good],'chapter.docx')),/FIFO/)
  const corrupt=zipSync({'word/document.xml':strToU8('<broken>')})
  await assert.rejects(api.extractOfficeText(new File([corrupt],'chapter.docx')),error=>error.code==='UPLOAD_UNREADABLE' && /new DOCX\/PPTX|PDF/.test(error.message))
  const packetZip=zipSync({'network.pkt':strToU8('Not an Office document')})
  await assert.rejects(api.extractOfficeText(new File([packetZip],'renamed.docx')),/Not enough readable/)
 }finally{globalThis.DOMParser=oldParser;dom.window.close()}
})

test('Gemini throttling respects Retry-After and source failures do not enter automatic retry',async()=>{
 const old={fetch:globalThis.fetch,Deno:globalThis.Deno};globalThis.Deno={env:{get:()=>undefined}}
 globalThis.fetch=async()=>Response.json({error:{status:'RESOURCE_EXHAUSTED',message:'Rate limited',details:[{retryDelay:'70s'}]}},{status:429,headers:{'Retry-After':'45'}})
 try{
  await assert.rejects(api.geminiJson('test','Prompt',[{text:'Source'}],{},1000,1),error=>{assert.equal(error.retryAfterSeconds,70);assert.equal(api.queueRecovery(error,1).seconds,70);return true})
  const stopped=api.queueRecovery(new api.UploadReadError(),1);assert.equal(stopped.seconds,null);assert.equal(stopped.reason,'source')
  assert.equal(api.queueRecovery(new api.StudyDraftError('format','Bad draft'),3).reason,'temporary')
 }finally{Object.assign(globalThis,old)}
})
