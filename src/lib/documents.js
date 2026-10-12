import { unzipSync, strFromU8 } from 'fflate'

export const MAX_FILE_SIZE = 10 * 1024 * 1024
const types = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  txt: 'text/plain', md: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint',
}
export function fileType(name) { return types[name.split('.').pop().toLowerCase()] }
export function validateFile(file) {
  if (!fileType(file.name)) throw new Error('Choose a PDF, DOCX, PPTX, PPT, JPG, PNG, WEBP, TXT, or MD file.')
  if (!file.size || file.size > MAX_FILE_SIZE) throw new Error('Files must be between 1 byte and 10 MB.')
}
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
  const ext = file.name.split('.').pop().toLowerCase()
  if (['txt', 'md'].includes(ext)) return (await file.text()).slice(0, 100000)
  if (!['docx', 'pptx', 'ppt'].includes(ext)) return null
  const buffer = new Uint8Array(await file.arrayBuffer())
  let text = ''
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
  if (text.trim().length < 20) throw new Error('No readable text found. Export as PDF to include diagrams and scanned pages.')
  if (text.length > 100000) throw new Error('This document exceeds 100,000 text characters. Split it into smaller chapters.')
  return text
}
