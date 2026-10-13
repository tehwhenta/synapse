// Shared, dependency-free upload validation for the browser and Edge Function.
export const MAX_FILE_SIZE = 20 * 1024 * 1024
export const acceptedUploadFormats = 'PDF, DOCX, PPTX/PPT, JPG, PNG, WEBP, TXT, or MD'
export const unreadableUploadMessage = `This file cannot be read as study material. Please upload a readable ${acceptedUploadFormats} file. Export legacy DOC or Packet Tracer files as PDF first.`
export class UploadReadError extends Error {
 readonly code='UPLOAD_UNREADABLE'
 constructor(message=unreadableUploadMessage){super(message);this.name='UploadReadError'}
}
export const uploadTypes: Record<string,string>={
 pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',txt:'text/plain',md:'text/plain',
 docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',ppt:'application/vnd.ms-powerpoint',
}
export function fileType(name:string){return uploadTypes[String(name || '').split('.').pop()!.toLowerCase()]}
export function validateUploadMetadata(file:{name:string,size:number},mime?:string){
 const type=fileType(file.name)
 if(!type)throw new UploadReadError(`This file type cannot be read. Choose a PDF, DOCX, PPTX/PPT, JPG, PNG, WEBP, TXT, or MD file. Export Packet Tracer or legacy DOC files as PDF first.`)
 if(mime && mime!==type)throw new UploadReadError()
 if(!file.size || file.size>MAX_FILE_SIZE)throw new Error('Files must be between 1 byte and 20 MB.')
 return type
}
export async function validateUploadContents(file:Blob,name:string,mime?:string){
 const type=validateUploadMetadata({name,size:file.size},mime),bytes=new Uint8Array(await file.slice(0,1024).arrayBuffer())
 const starts=(signature:number[])=>signature.every((value,index)=>bytes[index]===value)
 const ascii=(start:number,end:number)=>new TextDecoder().decode(bytes.slice(start,end))
 let valid=false
 if(type==='application/pdf')valid=ascii(0,1024).includes('%PDF-')
 else if(type==='image/png')valid=starts([137,80,78,71,13,10,26,10])
 else if(type==='image/jpeg')valid=starts([255,216,255])
 else if(type==='image/webp')valid=ascii(0,4)==='RIFF' && ascii(8,12)==='WEBP'
 else if(type==='application/vnd.ms-powerpoint')valid=starts([208,207,17,224,161,177,26,225])
 else if(type.includes('openxmlformats'))valid=starts([80,75,3,4]) || starts([80,75,5,6]) || starts([80,75,7,8])
 else if(type==='text/plain'){
  try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes,{stream:file.size>bytes.length});valid=!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)}catch{}
 }
 if(!valid)throw new UploadReadError()
 return type
}
export function validateStudyText(text:string){
 if(text.trim().length<20)throw new UploadReadError(`Not enough readable study text was found. Please upload a readable ${acceptedUploadFormats} file; use PDF for scans or diagrams.`)
 if(text.length>100000)throw new UploadReadError('This chapter exceeds 100,000 text characters. Split it into shorter chapters before uploading.')
 if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))throw new UploadReadError()
 return text
}
