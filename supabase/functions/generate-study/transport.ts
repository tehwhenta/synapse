const geminiBase = 'https://generativelanguage.googleapis.com'
function inlineBase64(bytes: Uint8Array) {
  let binary = ''; for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192))
  return btoa(binary)
}
// Larger PDFs/photos use the Files API to avoid a large base64 JSON allocation.
export async function geminiFilePart(blob: Blob, mime: string, apiKey: string, cleanup: string[]) {
  if (blob.size <= 6*1024*1024) return { inlineData: { mimeType: mime, data: inlineBase64(new Uint8Array(await blob.arrayBuffer())) } }
  const start = await fetch(`${geminiBase}/upload/v1beta/files`, { method:'POST', headers: { 'x-goog-api-key':apiKey,'X-Goog-Upload-Protocol':'resumable','X-Goog-Upload-Command':'start','X-Goog-Upload-Header-Content-Length':String(blob.size),'X-Goog-Upload-Header-Content-Type':mime,'Content-Type':'application/json' }, body:JSON.stringify({ file:{ display_name:'Synapse course material' } }), signal:AbortSignal.timeout(20000) })
  if (!start.ok) throw new Error(`Gemini file upload could not start (${start.status}).`)
  const uploadUrl = new URL(start.headers.get('x-goog-upload-url') || '')
  if (uploadUrl.protocol !== 'https:' || uploadUrl.hostname !== 'generativelanguage.googleapis.com' || uploadUrl.username || uploadUrl.password) throw new Error('Gemini returned an invalid upload address.')
  const upload = await fetch(uploadUrl, { method:'POST',headers:{ 'X-Goog-Upload-Offset':'0','X-Goog-Upload-Command':'upload, finalize','Content-Type':mime },body:blob,signal:AbortSignal.timeout(45000) })
  if (!upload.ok) throw new Error(`Gemini file upload failed (${upload.status}).`)
  let file = (await upload.json()).file
  if (!/^files\/[a-zA-Z0-9_-]+$/.test(file?.name || '')) throw new Error('Gemini returned invalid file metadata.')
  cleanup.push(file.name)
  for (let i=0;file.state==='PROCESSING' && i<12;i++) {
    await new Promise(resolve => setTimeout(resolve,1000))
    const poll = await fetch(`${geminiBase}/v1beta/${file.name}`, { headers:{ 'x-goog-api-key':apiKey },signal:AbortSignal.timeout(10000) })
    if (!poll.ok) throw new Error('Gemini could not read the uploaded file.')
    file = await poll.json()
  }
  const uri = new URL(file.uri || '')
  if (file.state !== 'ACTIVE' || uri.protocol !== 'https:' || uri.hostname !== 'generativelanguage.googleapis.com') throw new Error('Gemini could not finish processing this file. Try a smaller PDF.')
  return { fileData:{ mimeType:mime,fileUri:file.uri } }
}
export async function deleteGeminiFiles(files: string[], apiKey: string) {
  await Promise.allSettled(files.map(name => fetch(`${geminiBase}/v1beta/${name}`, { method:'DELETE',headers:{ 'x-goog-api-key':apiKey },signal:AbortSignal.timeout(10000) })))
}
export async function geminiJson(apiKey: string, prompt: string, parts: Record<string, unknown>[], schema: unknown, tokens: number, temperature: number) {
  const model = Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite'
  if (!/^[a-z0-9.-]+$/.test(model)) throw new Error('GEMINI_MODEL is invalid.')
  const response = await fetch(`${geminiBase}/v1beta/models/${model}:generateContent`, { method:'POST',headers:{ 'Content-Type':'application/json','x-goog-api-key':apiKey },body:JSON.stringify({ systemInstruction:{ parts:[{ text:prompt }] },contents:[{ role:'user',parts }],generationConfig:{ temperature,maxOutputTokens:tokens,responseMimeType:'application/json',responseJsonSchema:schema } }),signal:AbortSignal.timeout(140000) })
  if (!response.ok) {
    console.error('Gemini HTTP status',response.status)
    throw new Error(response.status===429 ? 'Gemini quota exceeded. Wait before trying again.' : `Gemini request failed (${response.status}). Check the API key, model access, and quota in Google AI Studio.`)
  }
  const candidate = (await response.json()).candidates?.[0]
  if (candidate?.finishReason !== 'STOP') throw new Error('AI output was blocked or cut off. Try a smaller source.')
  try { return JSON.parse(candidate.content.parts.filter((p: { text?: string; thought?: boolean }) => p.text && !p.thought).map((p: { text: string }) => p.text).join('')) }
  catch { throw new Error('AI returned unreadable output. Existing materials are kept.') }
}
