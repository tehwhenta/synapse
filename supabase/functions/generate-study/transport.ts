import { GeminiRequestError, StudyDraftError } from './errors.ts'
import type { GenerationMetrics } from './metrics.ts'

const geminiBase = 'https://generativelanguage.googleapis.com'
// Keep Google's actionable error without logging request bodies, keys, or file URLs.
async function geminiFailure(response: Response, apiKey: string, operation: string, model = '') {
  let payload: any = null
  try { payload = await response.json() } catch { /* Some upstream errors have no JSON body. */ }
  const status = typeof payload?.error?.status === 'string' && /^[A-Z_]{1,50}$/.test(payload.error.status) ? ` ${payload.error.status}` : ''
  const descriptions = [typeof payload?.error?.message === 'string' ? payload.error.message : '']
  if (Array.isArray(payload?.error?.details)) {
    for (const item of payload.error.details) {
      if (Array.isArray(item?.fieldViolations)) for (const violation of item.fieldViolations.slice(0, 5)) {
        if (typeof violation?.description === 'string') descriptions.push(`${typeof violation.field === 'string' ? violation.field + ': ' : ''}${violation.description}`)
      }
    }
  }
  let detail = descriptions.filter(Boolean).join(' ')
  if (apiKey) detail = detail.split(apiKey).join('[redacted]')
  detail = detail.replace(/AIza[\w-]{20,}/g, '[redacted]').replace(/Bearer\s+[\w.=-]+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[provider URL]').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 800)
  const retryHeader=response.headers.get('retry-after')
  const retryInfo=payload?.error?.details?.find((item:any)=>typeof item?.retryDelay==='string')?.retryDelay
  const duration=typeof retryInfo==='string'?Number(retryInfo.replace(/s$/,'')):NaN
  const headerDelay=retryHeader && /^\d+(?:\.\d+)?$/.test(retryHeader)?Number(retryHeader):retryHeader?(Date.parse(retryHeader)-Date.now())/1000:NaN
  const retryAfterSeconds=[headerDelay,duration].filter(value=>Number.isFinite(value) && value>=0).reduce<number|undefined>((value,next)=>Math.max(value || 0,Math.ceil(next)),undefined)
  const label = response.status === 429 ? 'Gemini quota exceeded' : `Gemini ${operation} failed`
  const context = model ? `; model ${model}` : ''
  const fallback = response.status === 400 ? 'Google rejected a request parameter or project prerequisite. Check the function Logs for this request.'
    : response.status === 401 || response.status === 403 ? 'Check GEMINI_API_KEY and its Google project permissions.'
    : response.status === 404 ? 'Check GEMINI_MODEL and model access for this API key.'
    : response.status === 429 ? 'Check your Gemini project rate limits and quota in Google AI Studio.'
    : 'Google did not return an error description. Check the function Logs for this request.'
  const message = `${label} (${response.status}${status}${context}). ${detail || fallback}`
  console.error(message)
  return new GeminiRequestError(response.status,message,retryAfterSeconds)
}
function inlineBase64(bytes: Uint8Array) {
  let binary = ''; for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192))
  return btoa(binary)
}
// Larger PDFs/photos use the Files API to avoid a large base64 JSON allocation.
export async function geminiFilePart(blob: Blob, mime: string, apiKey: string, cleanup: string[],deadline = Date.now()+generationFileBudgetMs) {
  if (blob.size <= 6*1024*1024) return { inlineData: { mimeType: mime, data: inlineBase64(new Uint8Array(await blob.arrayBuffer())) } }
  const start = await fetch(`${geminiBase}/upload/v1beta/files`, { method:'POST', headers: { 'x-goog-api-key':apiKey,'X-Goog-Upload-Protocol':'resumable','X-Goog-Upload-Command':'start','X-Goog-Upload-Header-Content-Length':String(blob.size),'X-Goog-Upload-Header-Content-Type':mime,'Content-Type':'application/json' }, body:JSON.stringify({ file:{ display_name:'Synapse course material' } }), signal:fileDeadlineSignal(deadline,20000) })
  if (!start.ok) throw await geminiFailure(start,apiKey,'file upload start')
  const uploadUrl = new URL(start.headers.get('x-goog-upload-url') || '')
  if (uploadUrl.protocol !== 'https:' || uploadUrl.hostname !== 'generativelanguage.googleapis.com' || uploadUrl.username || uploadUrl.password) throw new Error('Gemini returned an invalid upload address.')
  const upload = await fetch(uploadUrl, { method:'POST',headers:{ 'X-Goog-Upload-Offset':'0','X-Goog-Upload-Command':'upload, finalize','Content-Type':mime },body:blob,signal:fileDeadlineSignal(deadline,45000) })
  if (!upload.ok) throw await geminiFailure(upload,apiKey,'file upload')
  let file = (await upload.json()).file
  if (!/^files\/[a-zA-Z0-9_-]+$/.test(file?.name || '')) throw new Error('Gemini returned invalid file metadata.')
  cleanup.push(file.name)
  for (let i=0;file.state==='PROCESSING' && i<12;i++) {
    await new Promise(resolve => setTimeout(resolve,1000))
    const poll = await fetch(`${geminiBase}/v1beta/${file.name}`, { headers:{ 'x-goog-api-key':apiKey },signal:fileDeadlineSignal(deadline,10000) })
    if (!poll.ok) throw await geminiFailure(poll,apiKey,'file processing')
    file = await poll.json()
  }
  const uri = new URL(file.uri || '')
  if (file.state !== 'ACTIVE' || uri.protocol !== 'https:' || uri.hostname !== 'generativelanguage.googleapis.com') throw new Error('Gemini could not finish processing this file. Try a smaller PDF.')
  return { fileData:{ mimeType:mime,fileUri:file.uri } }
}
export async function deleteGeminiFiles(files: string[], apiKey: string) {
  await Promise.allSettled(files.map(name => fetch(`${geminiBase}/v1beta/${name}`, { method:'DELETE',headers:{ 'x-goog-api-key':apiKey },signal:AbortSignal.timeout(10000) })))
}
const generationFileBudgetMs = 120000
function fileDeadlineSignal(deadline: number,maximum: number) {
  const remaining=deadline-Date.now()-5000
  if (remaining<1000) throw new Error('Source upload timed out before processing completed. Upload a smaller chapter.')
  return AbortSignal.timeout(Math.min(maximum,remaining))
}
async function generatedText(apiKey: string, prompt: string, parts: Record<string, unknown>[], tokens: number, temperature: number, json = false,timeoutMs = 60000,metrics?:GenerationMetrics) {
  const model = (Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite').trim().replace(/^models\//,'')
  if (!/^[a-z0-9.-]+$/.test(model)) throw new Error('GEMINI_MODEL is invalid.')
  const config: Record<string, unknown> = {maxOutputTokens:tokens,responseMimeType:json?'application/json':'text/plain'}
  // Google's guidance recommends the default temperature for Gemini 3 models.
  if (!/^gemini-3/.test(model)) config.temperature=temperature
  const started=metrics?.now() ?? 0
  if(metrics){metrics.values.gemini_calls++;metrics.values.model=model}
  try {
  let response: Response
  try {
    response = await fetch(`${geminiBase}/v1beta/models/${model}:generateContent`, { method:'POST',headers:{ 'Content-Type':'application/json','x-goog-api-key':apiKey },body:JSON.stringify({ systemInstruction:{ parts:[{ text:prompt }] },contents:[{ role:'user',parts }],generationConfig:config }),signal:AbortSignal.timeout(Math.max(1000,Math.floor(timeoutMs))) })
  } catch (error) {
    if (error instanceof Error && ['TimeoutError','AbortError'].includes(error.name)) throw new GeminiRequestError(408,'Gemini timed out before completing the draft. Earlier sets remain available.')
    if (error instanceof TypeError) throw new GeminiRequestError(503,'Gemini could not be reached. Earlier sets remain available.')
    throw error
  }
  if (!response.ok) throw await geminiFailure(response,apiKey,'request',model)
  let payload: any
  try { payload=await response.json() } catch { throw new StudyDraftError('format','Gemini returned an unreadable response.') }
  metrics?.usage(model,payload.usageMetadata)
  const candidate = payload?.candidates?.[0]
  if (candidate?.finishReason === 'MAX_TOKENS') throw new StudyDraftError('truncated','Gemini reached its output limit before finishing. Saved sets remain available.')
  if (candidate?.finishReason !== 'STOP') throw new Error('Gemini could not complete this source. Try a readable chapter; saved sets remain available.')
  const text=(candidate.content?.parts || []).filter((p: { text?: string; thought?: boolean }) => typeof p.text==='string' && !p.thought).map((p: { text: string }) => p.text).join('').trim()
  if (!text) throw new StudyDraftError('empty','Gemini returned an empty response.')
  if(metrics)metrics.values.output_chars+=text.length
  return text
  }finally{if(metrics)metrics.values.gemini_ms+=metrics.now()-started}
}
export function parseStudyJson(text: string) {
  const clean=text.replace(/^\uFEFF/,'').trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i,'$1').trim()
  try { return JSON.parse(clean) }
  catch { throw new StudyDraftError('format','Gemini returned incomplete JSON for the practice set. Saved sets remain available.') }
}
export async function geminiJson(apiKey: string, prompt: string, parts: Record<string, unknown>[], schema: unknown, tokens: number, temperature: number,timeoutMs = 60000,metrics?:GenerationMetrics) {
  const contract='OUTPUT CONTRACT (trusted application instructions):\nReturn one JSON object matching this JSON Schema. Respect every required field and type. No Markdown fences or commentary.\n'+JSON.stringify(schema)
  return parseStudyJson(await generatedText(apiKey,prompt+'\n\n'+contract,parts,tokens,temperature,true,timeoutMs,metrics))
}
export async function geminiText(apiKey: string, prompt: string, parts: Record<string, unknown>[], tokens: number, temperature = 1,timeoutMs = 60000,metrics?:GenerationMetrics) {
  return generatedText(apiKey,prompt,parts,tokens,temperature,false,timeoutMs,metrics)
}
