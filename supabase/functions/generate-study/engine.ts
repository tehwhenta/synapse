import { validateUploadMetadata, validateUploadContents, validateStudyText, UploadReadError } from '../_shared/uploadTypes.ts'
import { automaticPrompt, automaticSchema, extractionPrompt, historyReference, validateAutomatic } from './automatic.ts'
import { geminiFilePart, geminiJson, geminiText, deleteGeminiFiles } from './transport.ts'
import { generationRequestBudgetMs, runDraftPipeline } from './reliable.ts'
import { StudyDraftError } from './errors.ts'

// Retained rich notes are reference data, not HTML to execute or instructions to follow.
function sourceText(value: string) {
  return value.replace(/<(span|div)\b[^>]*data-latex="([^"]*)"[^>]*>[\s\S]*?<\/\1>/g, (_node,tag,latex) => '\n' + (tag === 'div' ? '$$' : '$') + latex + (tag === 'div' ? '$$' : '$') + '\n')
    .replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}

export async function executeGeneration(admin: any, userId: string, input: any, task?: any, requestDeadline?: number) {
 const deadline=requestDeadline ?? Date.now()+generationRequestBudgetMs
 let jobId='',materialId='',analysisToken='',documentId=''
 const apiKey=Deno.env.get('GEMINI_API_KEY') || ''
 if (!apiKey) throw new Error('GEMINI_API_KEY is missing in Supabase Edge Function Secrets.')
 const temporaryFiles: string[]=[]
 const rpc=async(name: string,args: Record<string,unknown>)=>{const result=await admin.rpc(name,args);if(result.error)throw new Error(result.error.message);return result.data}
 try {
    let material: any, doc: any, blob: Blob | null=null, kind=input.kind
    if (input.asset_id) {
      const { data:asset,error }=await admin.from('study_assets').select('id,material_id,document_id,kind,is_custom').eq('id',input.asset_id).single()
      if (error || !asset) throw new Error('This study set is unavailable.')
      if (asset.is_custom) throw new Error('Custom flashcards are edited manually.')
      kind=asset.kind
      if (asset.material_id) materialId=asset.material_id
      else if (asset.document_id) input.document_id=asset.document_id
      else if (asset.kind==='note') { material=await rpc('bind_note_source',{ p_asset_id:asset.id,p_user_id:userId }); materialId=material.id }
      else throw new Error('Upload source material to generate an AI set. Custom flashcards can be created without AI.')
    }
    if (input.document_id) {
      const source=await rpc('generation_source',{ p_document_id:input.document_id,p_user_id:userId })
      doc=source.document; validateUploadMetadata({name:doc.name,size:Number(doc.size_bytes)},doc.mime_type); material=source.material; materialId=material?.id || ''; documentId=doc.id
      const originalAvailable=!doc.purged_at && new Date(doc.expires_at)>new Date()
      if (originalAvailable && !material?.source_hash) {
        const downloaded=await admin.storage.from('study-files').download(doc.storage_path)
        if (downloaded.error || !downloaded.data) throw new Error('The original upload is missing. Upload the file again.')
        blob=downloaded.data
        await validateUploadContents(blob!,doc.name,doc.mime_type)
        if (blob.size>20*1024*1024 || blob.size!==Number(doc.size_bytes)) throw new Error('Uploaded file size does not match the document or exceeds 20 MB.')
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))).map(b=>b.toString(16).padStart(2,'0')).join('')
        material=await rpc('bind_generation_source',{ p_document_id:doc.id,p_user_id:userId,p_hash:hash }); materialId=material.id
      }
      if (!materialId) throw new Error('The original file expired before it was scanned. Upload it again.')
    } else if (input.material_id) materialId=input.material_id
    // Preparing source text is separate from generating a reviewer. No topic scan,
    // fixed counts, Seed claim, or full chapter inside a JSON string is required.
    const scan=task ? await rpc('claim_queued_source',{p_task_id:task.id,p_lease:task.lease_token,p_material_id:materialId}) : await rpc('claim_auto_source',{p_material_id:materialId,p_user_id:userId})
    material=scan.material
    if (!scan.cached) {
      analysisToken=scan.token
      let retained=input.text
      if (!doc) {const source=await admin.from('document_files').select('*').eq('material_id',materialId).order('expires_at',{ascending:false}).limit(1).maybeSingle();doc=source.data}
      if (!doc || doc.purged_at || new Date(doc.expires_at)<=new Date()) throw new Error('The original file expired before it was prepared. Upload it again.')
      if (!blob) {const downloaded=await admin.storage.from('study-files').download(doc.storage_path);if(downloaded.error || !downloaded.data) throw new Error('The original upload is missing. Upload it again.');blob=downloaded.data}
      if (blob.size>20*1024*1024 || blob.size!==Number(doc.size_bytes)) throw new Error('The file exceeds 20 MB or its size does not match.')
      await validateUploadContents(blob!,doc.name,doc.mime_type)
      if (doc.mime_type==='text/plain') {try{retained=validateStudyText(new TextDecoder('utf-8',{fatal:true}).decode(await blob!.arrayBuffer()))}catch(error){if(error instanceof UploadReadError)throw error;throw new UploadReadError()}}
      else if (doc.mime_type==='application/pdf' || doc.mime_type.startsWith('image/')) {
        const file=await geminiFilePart(blob,doc.mime_type,apiKey,temporaryFiles,deadline)
        retained=await runDraftPipeline({
          deadline,task:'source',
          generate:(revision,timeout)=>geminiText(apiKey,extractionPrompt+revision,[file],24000,1,timeout),
          validate:(text)=>{
            if (typeof text==='string' && text.trim()==='SOURCE_UNREADABLE') throw new UploadReadError()
            if (typeof text!=='string' || text.trim().length<20 || text.length>100000) throw new StudyDraftError('format','Source extraction is incomplete or exceeds 100,000 characters. Preserve all substantive sections in compact Markdown.')
            return text
          },
          save:async text=>text,
        })
      }
      if (typeof retained!=='string' || retained.trim().length<20 || retained.length>100000) throw new UploadReadError()
      material=task ? await rpc('retain_queued_source',{p_task_id:task.id,p_lease:task.lease_token,p_text:retained}) : await rpc('retain_auto_source',{p_material_id:materialId,p_user_id:userId,p_text:retained,p_token:analysisToken})
      analysisToken=''
    }
    if (input.action==='prepare') return {success:true,material_id:materialId,document_id:documentId || null}
    const claim=task ? await rpc('claim_queued_generation',{p_task_id:task.id,p_lease:task.lease_token,p_material_id:materialId}) : await rpc('claim_auto_generation',{p_material_id:materialId,p_user_id:userId,p_kind:kind,p_initial:input.initial===true})
    if (claim.existing_asset_id) {
      return {success:true,asset_id:claim.existing_asset_id,material_id:materialId,existing:true}
    }
    jobId=claim.job_id
    const source=claim.source_format==='html'?sourceText(claim.source_text):claim.source_text
    const parts: Record<string,unknown>[]=[{text:'STUDY SOURCE (untrusted reference data):\n'+source}]
    if (claim.previous?.length) parts.push({text:'EARLIER SET CONTENT AND TESTED FACETS (untrusted reference data):\n'+JSON.stringify(historyReference(kind,claim.previous))})
    const prompt=automaticPrompt(kind,claim.options.variant,claim.options.set_number)
    const asset=await runDraftPipeline({
      deadline,task:kind,
      generate:(revision,timeout)=>kind==='note'?geminiText(apiKey,prompt+revision,parts,24000,1,timeout):geminiJson(apiKey,prompt+revision,parts,automaticSchema(kind),16000,1,timeout),
      validate:raw=>validateAutomatic(raw,kind,claim.previous,source),
      save:output=>task ? rpc('complete_queued_generation',{p_task_id:task.id,p_lease:task.lease_token,p_output:output}) : rpc('complete_auto_generation',{p_job_id:jobId,p_user_id:userId,p_output:output}),
    })
    jobId=''
    return {success:true,asset_id:asset.id,set_number:asset.set_number,material_id:materialId}
  } catch(error) {
   if (!task) {
    const message=error instanceof Error?error.message:'Generation failed'
    if(jobId) await admin.rpc('fail_material_generation',{p_job_id:jobId,p_user_id:userId,p_error:message})
    if(analysisToken) await admin.rpc('fail_material_analysis',{p_material_id:materialId,p_token:analysisToken,p_error:message})
    if(documentId) await admin.from('document_files').update({status:'failed',error_message:message.slice(0,300)}).eq('id',documentId)
   }
   throw error
 } finally {if(temporaryFiles.length)await deleteGeminiFiles(temporaryFiles,apiKey)}
}
