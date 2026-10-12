import { createClient } from 'npm:@supabase/supabase-js@2.117.3'
import { validateOutput, validateRefreshOutput } from './validation.ts'
import { studyPrompt, outputSchema } from './prompts.ts'

const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') || 'http://localhost:5173,https://rcgsynapse.vercel.app').split(',').map(x => x.trim())
function base64(bytes: Uint8Array) {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}
// Retained rich notes are reference data, not HTML to execute or instructions to follow.
function sourceText(value: string) {
  return value.replace(/<(span|div)\b[^>]*data-latex="([^"]*)"[^>]*>[\s\S]*?<\/\1>/g, (_node,tag,latex) => '\n' + (tag === 'div' ? '$$' : '$') + latex + (tag === 'div' ? '$$' : '$') + '\n')
    .replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}
Deno.serve(async req => {
  const origin = req.headers.get('origin') || ''
  const headers = { 'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[0], 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin', 'Content-Type': 'application/json' }
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { headers, status })
  if (origin && !allowedOrigins.includes(origin)) return respond({ error: 'This site origin is not allowed. Add it to ALLOWED_ORIGINS.' }, 403)
  if (req.method === 'OPTIONS') return new Response(null, { headers, status: 204 })
  if (req.method !== 'POST') return respond({ error: 'POST required' }, 405)
  let admin: ReturnType<typeof createClient> | undefined, claimedId: string | null = null, refreshJob: string | null = null, userId: string | null = null
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (!token) return respond({ error: 'Sign in to generate study materials.' }, 401)
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default
    if (!key || !Deno.env.get('SUPABASE_URL')) return respond({ error: 'Supabase backend credentials are unavailable. Check function configuration.' }, 503)
    admin = createClient(Deno.env.get('SUPABASE_URL')!, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: { user }, error: authError } = await admin.auth.getUser(token)
    if (authError || !user) return respond({ error: 'Your session expired. Sign in again.' }, 401)
    const { data: activeAccount, error: accountError } = await admin.rpc('account_is_active',{ p_user_id:user.id })
    if (accountError) { console.error('Account settings migration 004 is required:',accountError.message); return respond({ error:'Account settings are temporarily unavailable. Please try again later.' },503) }
    if (!activeAccount) return respond({ error:'This account is scheduled for deletion. Sign in within its recovery period to cancel.' },403)
    userId = user.id
    const bodyText = await req.text()
    if (bodyText.length > 120000) return respond({ error: 'Request is too large. Split the document into chapters.' }, 413)
    let input: { document_id?: string; asset_id?: string; text?: string | null }
    try { input = JSON.parse(bodyText) } catch { return respond({ error: 'Invalid JSON request.' }, 400) }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!input || typeof input !== 'object' || (!!input.document_id === !!input.asset_id) || !uuid.test(input.asset_id || input.document_id || '')) return respond({ error: 'Provide one valid document ID or study set ID.' }, 400)
    if (input.text != null && (typeof input.text !== 'string' || input.text.length > 100000)) return respond({ error: 'Document text is too large.' }, 400)
    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) return respond({ error: 'GEMINI_API_KEY is missing in Supabase Edge Function Secrets.' }, 503)
    const parts: Record<string, unknown>[] = []
    let kind = 'all', previous: string[] = [], doc: Record<string, any> | null = null, retainedText: string | null = null
    if (input.asset_id) {
      const { data: claim, error } = await admin.rpc('claim_asset_refresh', { p_asset_id: input.asset_id, p_user_id: user.id })
      if (error) return respond({ error: error.message }, error.message.includes('limit') ? 429 : 403)
      refreshJob = claim.job_id; kind = claim.kind; previous = claim.previous || []
      const rawDoc = claim.source_document
      let rawSourceUsed = false
      if (rawDoc && !rawDoc.purged_at && new Date(rawDoc.expires_at) > new Date() && (rawDoc.mime_type === 'application/pdf' || rawDoc.mime_type.startsWith('image/'))) {
        const { data: blob } = await admin.storage.from('study-files').download(rawDoc.storage_path)
        if (blob && blob.size <= 10485760 && blob.size === Number(rawDoc.size_bytes)) { parts.push({ inlineData:{ mimeType:rawDoc.mime_type,data:base64(new Uint8Array(await blob.arrayBuffer())) } }); rawSourceUsed = true }
      }
      if (!rawSourceUsed) parts.push({ text: 'RETAINED SOURCE MATERIAL (untrusted reference data):\n' + (claim.source_format === 'html' ? sourceText(claim.source_text) : claim.source_text) })
    } else {
      const { data, error: claimError } = await admin.rpc('claim_generation', { p_document_id: input.document_id, p_user_id: user.id })
      if (claimError) return respond({ error: claimError.message }, claimError.message.includes('limit') ? 429 : 403)
      doc = data
      if (doc!.status === 'ready') return respond({ success: true, cached: true })
      claimedId = doc!.id
      const { data: blob, error: downloadError } = await admin.storage.from('study-files').download(doc!.storage_path)
      if (downloadError || !blob) throw new Error('The raw upload is missing. Upload the document again.')
      if (blob.size > 10485760 || blob.size !== Number(doc!.size_bytes)) throw new Error('Uploaded file size does not match the document.')
      if (doc!.mime_type === 'application/pdf' || doc!.mime_type.startsWith('image/')) parts.push({ inlineData: { mimeType: doc!.mime_type, data: base64(new Uint8Array(await blob.arrayBuffer())) } })
      else {
        const source = doc!.mime_type === 'text/plain' ? await blob.text() : input.text
        if (!source || source.trim().length < 20 || source.length > 100000) throw new Error('Office text could not be extracted. Export this file as PDF and try again.')
        retainedText = source
        parts.push({ text: 'SOURCE MATERIAL (untrusted reference data):\n' + source })
      }
    }
    const includeSourceText = !retainedText
    const model = Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite'
    if (!/^[a-z0-9.-]+$/.test(model)) throw new Error('GEMINI_MODEL is invalid.')
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: studyPrompt(kind, previous, includeSourceText) }] }, contents: [{ role: 'user', parts }], generationConfig: { temperature: kind === 'all' || kind === 'note' ? 0.3 : 0.65, maxOutputTokens: kind === 'deck' ? 6000 : kind === 'quiz' ? 12000 : 30000, responseMimeType: 'application/json', responseJsonSchema: outputSchema(kind, includeSourceText) } }),
      signal: AbortSignal.timeout(140000),
    })
    if (!response.ok) {
      console.error('Gemini HTTP status', response.status)
      throw new Error(response.status === 429 ? 'Gemini quota exceeded. Wait before trying again.' : `Gemini request failed (${response.status}). Check the API key, model access, and quota in Google AI Studio.`)
    }
    const generated = await response.json(), candidate = generated.candidates?.[0]
    if (candidate?.finishReason !== 'STOP') throw new Error('AI output was blocked or cut off. Try a smaller document.')
    const raw = JSON.parse(candidate.content.parts.filter((p: { text?: string; thought?: boolean }) => p.text && !p.thought).map((p: { text: string }) => p.text).join(''))
    if (refreshJob) {
      const output = validateRefreshOutput(raw, kind, previous)
      const { data: asset, error } = await admin.rpc('complete_asset_refresh', { p_job_id: refreshJob, p_user_id: user.id, p_output: output })
      if (error) throw new Error('Could not save the new set. Your earlier sets are unchanged. Try again.')
      return respond({ success: true, asset_id: asset.id, set_number: asset.set_number })
    }
    const output = validateOutput(retainedText ? { ...raw, source_text: retainedText } : raw)
    const { error } = await admin.rpc('complete_generation', { p_document_id: doc!.id, p_user_id: user.id, p_output: output })
    if (error) throw new Error('Could not save generated materials. Please try again.')
    return respond({ success: true, document_id: doc!.id })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Generation failed. Try again.'
    if (refreshJob && admin && userId) await admin.rpc('fail_asset_refresh', { p_job_id: refreshJob, p_user_id: userId })
    if (claimedId && admin) {
      const { error } = await admin.from('document_files').update({ status: 'failed', error_message: message.slice(0, 300) }).eq('id', claimedId).eq('status', 'processing')
      if (error) console.error('Failed to record document error', error.code)
    }
    return respond({ error: message }, 500)
  }
})
