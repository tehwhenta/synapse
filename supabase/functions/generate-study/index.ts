import { createClient } from 'npm:@supabase/supabase-js@2.117.3'
import { automaticPrompt, automaticSchema, extractionPrompt, historyReference, validateAutomatic } from './automatic.ts'
import { geminiFilePart, geminiJson, geminiText, deleteGeminiFiles } from './transport.ts'
import { generationRequestBudgetMs, runDraftPipeline } from './reliable.ts'
import { StudyDraftError } from './errors.ts'

const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') || 'http://localhost:5173,https://rcgsynapse.vercel.app').split(',').map(x => x.trim())
// Retained rich notes are reference data, not HTML to execute or instructions to follow.
function sourceText(value: string) {
  return value.replace(/<(span|div)\b[^>]*data-latex="([^"]*)"[^>]*>[\s\S]*?<\/\1>/g, (_node,tag,latex) => '\n' + (tag === 'div' ? '$$' : '$') + latex + (tag === 'div' ? '$$' : '$') + '\n')
    .replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}
Deno.serve(async req => {
  const deadline=Date.now()+generationRequestBudgetMs
  const origin = req.headers.get('origin') || ''
  const headers = { 'Access-Control-Allow-Origin':allowedOrigins.includes(origin) ? origin : allowedOrigins[0], 'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin','Content-Type':'application/json' }
  const respond = (body: unknown, status=200) => new Response(JSON.stringify(body),{ headers,status })
  if (origin && !allowedOrigins.includes(origin)) return respond({ error:'This site origin is not allowed. Add it to ALLOWED_ORIGINS.' },403)
  if (req.method==='OPTIONS') return new Response(null,{ headers,status:204 })
  if (req.method!=='POST') return respond({ error:'POST required' },405)
  let admin: ReturnType<typeof createClient> | undefined, userId='', jobId='', materialId='', analysisToken='', documentId='', apiKey=''
  const temporaryFiles: string[] = []
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i,'')
    if (!token) return respond({ error:'Sign in to generate study materials.' },401)
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default
    if (!key || !Deno.env.get('SUPABASE_URL')) return respond({ error:'Supabase backend credentials are unavailable. Check function configuration.' },503)
    admin = createClient(Deno.env.get('SUPABASE_URL')!,key,{ auth:{ persistSession:false,autoRefreshToken:false } })
    const { data:{ user },error:authError } = await admin.auth.getUser(token)
    if (authError || !user) return respond({ error:'Your session expired. Sign in again.' },401)
    userId=user.id
    const rpc = async (name: string,args: Record<string, unknown>) => { const result=await admin!.rpc(name,args); if (result.error) throw new Error(result.error.message); return result.data }
    if (!await rpc('account_is_active',{ p_user_id:user.id })) return respond({ error:'This account is scheduled for deletion. Sign in within its recovery period to cancel.' },403)
    const requestBody=await req.text()
    if (requestBody.length>120000) return respond({ error:'Request is too large. Split the source into chapters.' },413)
    let input: any
    try { input=JSON.parse(requestBody) } catch { return respond({ error:'Invalid JSON request.' },400) }
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const targets=['document_id','material_id','asset_id']
    if (!input || typeof input!=='object' || !['prepare','generate'].includes(input.action) || targets.filter(k=>input[k]!=null).length!==1 || !uuid.test(input[targets.find(k=>input[k]!=null)!])) return respond({ error:'Choose prepare or generate and provide one valid source or set ID.' },400)
    if (input.text!=null && (typeof input.text!=='string' || input.text.length>100000)) return respond({ error:'Document text is too large.' },400)
    if (input.action==='generate' && !input.asset_id && !['note','deck','quiz'].includes(input.kind)) return respond({ error:'Choose a reviewer, flashcards, or quiz.' },400)
    apiKey=Deno.env.get('GEMINI_API_KEY') || ''
    if (!apiKey) return respond({ error:'GEMINI_API_KEY is missing in Supabase Edge Function Secrets.' },503)
    let material: any, doc: any, blob: Blob | null=null, kind=input.kind
    if (input.asset_id) {
      const { data:asset,error }=await admin.from('study_assets').select('id,material_id,document_id,kind,is_custom').eq('id',input.asset_id).single()
      if (error || !asset) throw new Error('This study set is unavailable.')
      if (asset.is_custom) throw new Error('Custom flashcards are edited manually.')
      kind=asset.kind
      if (asset.material_id) materialId=asset.material_id
      else if (asset.document_id) input.document_id=asset.document_id
      else if (asset.kind==='note') { material=await rpc('bind_note_source',{ p_asset_id:asset.id,p_user_id:user.id }); materialId=material.id }
      else throw new Error('Upload source material to generate an AI set. Custom flashcards can be created without AI.')
    }
    if (input.document_id) {
      const source=await rpc('generation_source',{ p_document_id:input.document_id,p_user_id:user.id })
      doc=source.document; material=source.material; materialId=material?.id || ''; documentId=doc.id
      const originalAvailable=!doc.purged_at && new Date(doc.expires_at)>new Date()
      if (originalAvailable && !material?.source_hash) {
        const downloaded=await admin.storage.from('study-files').download(doc.storage_path)
        if (downloaded.error || !downloaded.data) throw new Error('The original upload is missing. Upload the file again.')
        blob=downloaded.data
        if (blob.size>20*1024*1024 || blob.size!==Number(doc.size_bytes)) throw new Error('Uploaded file size does not match the document or exceeds 20 MB.')
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))).map(b=>b.toString(16).padStart(2,'0')).join('')
        material=await rpc('bind_generation_source',{ p_document_id:doc.id,p_user_id:user.id,p_hash:hash }); materialId=material.id
      }
      if (!materialId) throw new Error('The original file expired before it was scanned. Upload it again.')
    } else if (input.material_id) materialId=input.material_id
    // Preparing source text is separate from generating a reviewer. No topic scan,
    // fixed counts, Seed claim, or full chapter inside a JSON string is required.
    const scan=await rpc('claim_auto_source',{p_material_id:materialId,p_user_id:user.id})
    material=scan.material
    if (!scan.cached) {
      analysisToken=scan.token
      let retained=input.text
      if (!doc) {const source=await admin.from('document_files').select('*').eq('material_id',materialId).order('expires_at',{ascending:false}).limit(1).maybeSingle();doc=source.data}
      if (!doc || doc.purged_at || new Date(doc.expires_at)<=new Date()) throw new Error('The original file expired before it was prepared. Upload it again.')
      if (!blob) {const downloaded=await admin.storage.from('study-files').download(doc.storage_path);if(downloaded.error || !downloaded.data) throw new Error('The original upload is missing. Upload it again.');blob=downloaded.data}
      if (blob.size>20*1024*1024 || blob.size!==Number(doc.size_bytes)) throw new Error('The file exceeds 20 MB or its size does not match.')
      if (doc.mime_type==='text/plain') retained=await blob.text()
      else if (doc.mime_type==='application/pdf' || doc.mime_type.startsWith('image/')) {
        const file=await geminiFilePart(blob,doc.mime_type,apiKey,temporaryFiles,deadline)
        retained=await runDraftPipeline({
          deadline,task:'source',
          generate:(revision,timeout)=>geminiText(apiKey,extractionPrompt+revision,[file],24000,1,timeout),
          validate:(text)=>{
            if (typeof text==='string' && text.trim()==='SOURCE_UNREADABLE') throw new Error('The source is not legible. Upload a clearer chapter.')
            if (typeof text!=='string' || text.trim().length<20 || text.length>100000) throw new StudyDraftError('format','Source extraction is incomplete or exceeds 100,000 characters. Preserve all substantive sections in compact Markdown.')
            return text
          },
          save:async text=>text,
        })
      }
      if (typeof retained!=='string' || retained.trim().length<20 || retained.length>100000) throw new Error('Source text could not be read completely. Export a shorter chapter as PDF and upload it again.')
      material=await rpc('retain_auto_source',{p_material_id:materialId,p_user_id:user.id,p_text:retained,p_token:analysisToken})
      analysisToken=''
    }
    if (input.action==='prepare') return respond({success:true,material_id:materialId,document_id:documentId || null})
    const claim=await rpc('claim_auto_generation',{p_material_id:materialId,p_user_id:user.id,p_kind:kind,p_initial:input.initial===true})
    if (claim.existing_asset_id) {
      return respond({success:true,asset_id:claim.existing_asset_id,material_id:materialId,existing:true})
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
      save:output=>rpc('complete_auto_generation',{p_job_id:jobId,p_user_id:user.id,p_output:output}),
    })
    jobId=''
    return respond({success:true,asset_id:asset.id,set_number:asset.set_number,material_id:materialId})
  } catch (err) {
    const message=err instanceof Error ? err.message : 'Generation failed. Try again.'
    if (admin && jobId) await admin.rpc('fail_material_generation',{ p_job_id:jobId,p_user_id:userId,p_error:message })
    if (admin && analysisToken) await admin.rpc('fail_material_analysis',{ p_material_id:materialId,p_token:analysisToken,p_error:message })
    if (admin && documentId) await admin.from('document_files').update({ status:'failed',error_message:message.slice(0,300) }).eq('id',documentId)
    console.error('Generation request failed:',message.slice(0,300))
    return respond({ error:message },/limit reached|quota exceeded/i.test(message) ? 429 : /No fresh (study content|questions)/i.test(message)?409 : /access required|scheduled for deletion/i.test(message) ? 403 : /already (being|generating)/i.test(message) ? 409 : 500)
  } finally { if (temporaryFiles.length && apiKey) await deleteGeminiFiles(temporaryFiles,apiKey) }
})
