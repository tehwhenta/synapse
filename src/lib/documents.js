import { unzipSync, strFromU8 } from 'fflate'

import { MAX_FILE_SIZE, fileType, validateUploadMetadata, validateUploadContents, validateStudyText, UploadReadError } from '../../supabase/functions/_shared/uploadTypes.ts'
export {MAX_FILE_SIZE,fileType}
export function validateFile(file){return validateUploadMetadata(file)}

function xmlText(xml, tag) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('This Office file contains invalid XML. Save a new copy and try again.')
  return [...doc.getElementsByTagName(tag)].map(el => el.textContent).join('\n')
}
export function extractPptText(stream) {
  const data = new Uint8Array(stream); const view = new DataView(data.buffer, data.byteOffset, data.byteLength); const texts = []
  function walk(start, end, depth = 0) {
    if (depth > 30) throw new Error('This presentation is too complex. Export it as PDF instead.')
    for (let p = start; p + 8 <= end;) {
      const version = view.getUint16(p, true) & 15; const type = view.getUint16(p + 2, true); const size = view.getUint32(p + 4, true)
      const next = p + 8 + size; if (next > end || next < p) break
      if (version === 15) walk(p + 8, next, depth + 1)
      else if (type === 4000 || type === 4008 || type === 4026) {
        const text = new TextDecoder(type === 4008 ? 'windows-1252' : 'utf-16le').decode(data.subarray(p + 8, next)).replace(/\0/g, '').trim()
        if (text) texts.push(text)
      }
      p = next
    }
  }
  walk(0, data.length); return [...new Set(texts)].join('\n\n')
}
export async function extractOfficeText(file) {
  await validateUploadContents(file,file.name)
  const ext = file.name.split('.').pop().toLowerCase()
  if (['txt','md'].includes(ext)) {
    try{return validateStudyText(new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer()))}
    catch(error){if(error instanceof UploadReadError)throw error;throw new UploadReadError()}
  }
  if (!['docx', 'pptx', 'ppt'].includes(ext)) return null
  const buffer = new Uint8Array(await file.arrayBuffer())
  let text = ''
  try {
  if (ext === 'ppt') {
    const CFB = await import('cfb')
    const container = CFB.read(buffer, { type: 'array' })
    const entry = CFB.find(container, 'PowerPoint Document')
    if (!entry?.content) throw new Error('This PPT is encrypted or unreadable. Save it as PPTX or PDF.')
    text = extractPptText(entry.content)
  } else {
    let total = 0
    const archive = unzipSync(buffer, { filter: entry => {
      const wanted = ext === 'docx' ? entry.name === 'word/document.xml' : /^ppt\/slides\/slide\d+\.xml$/.test(entry.name)
      if (wanted) { total += entry.originalSize; if (total > 20 * 1024 * 1024) throw new Error('The expanded document is too large. Export a shorter PDF.') }
      return wanted
    } })
    const paths = Object.keys(archive).sort((a, b) => (Number(a.match(/slide(\d+)/)?.[1]) || 0) - (Number(b.match(/slide(\d+)/)?.[1]) || 0))
    text = paths.map(path => xmlText(strFromU8(archive[path]), ext === 'docx' ? 'w:p' : 'a:t')).join('\n\n')
  }
  return validateStudyText(text)
  }catch(error){if(error instanceof UploadReadError)throw error;throw new UploadReadError('This Office file cannot be read. Save a new DOCX/PPTX copy, or export it as a readable PDF.')}
}
