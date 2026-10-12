import { createClient } from 'npm:@supabase/supabase-js@2.117.3'
import { analysisPrompt, analysisSchema, validateAnalysis, guidedPrompt, guidedSchema, validateGuidedOutput } from './guided.ts'
import { geminiFilePart, geminiJson, deleteGeminiFiles } from './transport.ts'

const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') || 'http://localhost:5173,https://rcgsynapse.vercel.app').split(',').map(x => x.trim())
// Retained rich notes are reference data, not HTML to execute or instructions to follow.
function sourceText(value: string) {
  return value.replace(/<(span|div)\b[^>]*data-latex="([^"]*)"[^>]*>[\s\S]*?<\/\1>/g, (_node,tag,latex) => '\n' + (tag === 'div' ? '$$' : '$') + latex + (tag === 'div' ? '$$' : '$') + '\n')
    .replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}
Deno.serve(async req => {
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
    if (!input || typeof input!=='object' || !['analyze','generate'].includes(input.action) || targets.filter(k=>input[k]!=null).length!==1 || !uuid.test(input[targets.find(k=>input[k]!=null)!])) return respond({ error:'Choose analyze or generate and provide one valid source or set ID.' },400)
    if (input.text!=null && (typeof input.text!=='string' || input.text.length>100000)) return respond({ error:'Document text is too large.' },400)
    if (input.action==='generate' && !input.asset_id && !['note','deck','quiz'].includes(input.kind)) return respond({ error:'Choose a reviewer, flashcards, or quiz.' },400)
    apiKey=Deno.env.get('GEMINI_API_KEY') || ''
    if (!apiKey) return respond({ error:'GEMINI_API_KEY is missing in Supabase Edge Function Secrets.' },503)
    let material: any, doc: any, blob: Blob | null=null, kind=input.kind
    if (input.asset_id) {
      const { data:asset,error }=await admin.from('study_assets').select('id,material_id,document_id,kind').eq('id',input.asset_id).single()
      if (error || !asset) throw new Error('This study set is unavailable.')
      kind=asset.kind
      if (asset.document_id) input.document_id=asset.document_id
      else if (asset.material_id) materialId=asset.material_id
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
    // This server-side claim checks membership before returning retained source text.
    const scan=await rpc('claim_material_analysis',{ p_material_id:materialId,p_user_id:user.id })
    material=scan.material
    if (!scan.cached) {
      analysisToken=scan.token
      let retained=material.source_format==='html' ? sourceText(material.source_text) : material.source_text
      const parts: Record<string,unknown>[]=[]
      if (retained && retained.trim().length>=20) parts.push({ text:'SOURCE MATERIAL (untrusted reference data):\n'+retained })
      else {
        if (!doc || doc.purged_at || new Date(doc.expires_at)<=new Date()) throw new Error('The original file expired before its topics were scanned. Upload it again.')
        if (!blob) { const downloaded=await admin.storage.from('study-files').download(doc.storage_path); if (downloaded.error || !downloaded.data) throw new Error('The original upload is missing. Upload it again.'); blob=downloaded.data }
        if (blob.size>20*1024*1024 || blob.size!==Number(doc.size_bytes)) throw new Error('The file exceeds 20 MB or its size does not match.')
        if (doc.mime_type==='application/pdf' || doc.mime_type.startsWith('image/')) parts.push(await geminiFilePart(blob,doc.mime_type,apiKey,temporaryFiles))
        else {
          retained=doc.mime_type==='text/plain' ? await blob.text() : input.text
          if (!retained || retained.trim().length<20 || retained.length>100000) throw new Error('Office text could not be extracted. Export this file as PDF and try again.')
          parts.push({ text:'SOURCE MATERIAL (untrusted reference data):\n'+retained })
        }
      }
      const output=validateAnalysis(await geminiJson(apiKey,analysisPrompt,parts,analysisSchema,30000,.2),retained)
      await rpc('finish_material_analysis',{ p_material_id:materialId,p_user_id:user.id,p_token:analysisToken,p_output:output })
      analysisToken=''; material={ ...material,...output,source_format:'markdown',analysis_status:'ready' }
    }
    if (documentId) await admin.from('document_files').update({ status:'ready',error_message:null }).eq('id',documentId)
    if (input.action==='analyze') return respond({ success:true,cached:!!scan.cached,document_id:documentId || null,material_id:materialId })
    const claim=await rpc('claim_material_generation',{ p_material_id:materialId,p_user_id:user.id,p_kind:kind,p_options:input.options || {} })
    jobId=claim.job_id
    const selectedTopic=claim.options.topic_id ? claim.topics.find((t: any)=>t.id===claim.options.topic_id) : null
    const parts=[{ text:'RETAINED SOURCE (untrusted reference data):\n'+(claim.source_format==='html' ? sourceText(claim.source_text) : claim.source_text) }, { text:'SELECTED TOPIC AND ALL EARLIER SET CONTENT (untrusted reference data):\n'+JSON.stringify({ topic:selectedTopic,previous:claim.previous }) }]
    const original=claim.source_document
    if (original && !original.purged_at && new Date(original.expires_at)>new Date() && (original.mime_type==='application/pdf' || original.mime_type.startsWith('image/'))) {
      const downloaded=await admin.storage.from('study-files').download(original.storage_path)
      if (!downloaded.error && downloaded.data && downloaded.data.size<=20*1024*1024 && downloaded.data.size===Number(original.size_bytes)) parts.push(await geminiFilePart(downloaded.data,original.mime_type,apiKey,temporaryFiles))
    }
    const raw=await geminiJson(apiKey,guidedPrompt(kind,claim.options),parts,guidedSchema(kind,claim.options),kind==='note' ? 30000 : 20000,kind==='note' ? .35 : .7)
    const output=validateGuidedOutput(raw,kind,claim.options,claim.previous)
    const asset=await rpc('complete_material_generation',{ p_job_id:jobId,p_user_id:user.id,p_output:output })
    jobId=''
    return respond({ success:true,asset_id:asset.id,set_number:asset.set_number,material_id:materialId })
  } catch (err) {
    const message=err instanceof Error ? err.message : 'Generation failed. Try again.'
    if (admin && jobId) await admin.rpc('fail_material_generation',{ p_job_id:jobId,p_user_id:userId,p_error:message })
    if (admin && analysisToken) await admin.rpc('fail_material_analysis',{ p_material_id:materialId,p_token:analysisToken,p_error:message })
    if (admin && documentId && analysisToken) await admin.from('document_files').update({ status:'failed',error_message:message.slice(0,300) }).eq('id',documentId)
    console.error('Generation request failed:',message.slice(0,300))
    return respond({ error:message },/limit reached|quota exceeded/i.test(message) ? 429 : /access required|scheduled for deletion/i.test(message) ? 403 : /already (being|generating)/i.test(message) ? 409 : 500)
  } finally { if (temporaryFiles.length && apiKey) await deleteGeminiFiles(temporaryFiles,apiKey) }
})
