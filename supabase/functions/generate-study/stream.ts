import { StudyDraftError } from './errors.ts'

// Parse SSE incrementally, including UTF-8 and CRLF split across network chunks.
// Nothing is saved until the caller validates a complete STOP response.
export async function readGeminiStream(response: Response, onChunk: (payload: any) => void, signal: AbortSignal) {
 const reader=response.body?.getReader()
 if(!reader)throw new StudyDraftError('format','Gemini returned no response stream.')
 const decoder=new TextDecoder();let buffer='',eventLines:string[]=[],bytes=0
 const abort=()=>{void reader.cancel().catch(()=>{})}
 signal.addEventListener('abort',abort,{once:true})
 function line(value:string){
  if(value===''){
   if(!eventLines.length)return
   const data=eventLines.join('\n');eventLines=[]
   if(data==='[DONE]')return
   let payload:any
   try{payload=JSON.parse(data)}catch{throw new StudyDraftError('format','Gemini returned an unreadable stream event.')}
   onChunk(payload)
  }else if(value.startsWith('data:'))eventLines.push(value.slice(5).replace(/^ /,''))
 }
 try{
  while(true){
   signal.throwIfAborted()
   const {value,done}=await reader.read()
   signal.throwIfAborted()
   buffer+=done?decoder.decode():decoder.decode(value,{stream:true})
   bytes+=value?.byteLength || 0
   if(bytes>8*1024*1024)throw new StudyDraftError('format','Gemini response exceeded the safe transport limit.')
   let end:number
   while((end=buffer.indexOf('\n'))>=0){line(buffer.slice(0,end).replace(/\r$/,''));buffer=buffer.slice(end+1)}
   if(done){if(buffer)line(buffer.replace(/\r$/,''));line('');break}
  }
 }finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock()}
}
