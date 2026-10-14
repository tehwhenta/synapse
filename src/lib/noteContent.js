export const formattedNoteLimit = 240000
export const markdownNoteLimit = 60000

// Match PostgreSQL char_length: an emoji surrogate pair is one character.
export function noteCharacterCount(content) {
  let count=0
  for(const _character of content)count++
  return count
}

export function validateNoteContent(content,format) {
  if(typeof content!=='string' || !['html','markdown'].includes(format))throw new Error('This note has an unsupported format.')
  const limit=format==='html'?formattedNoteLimit:markdownNoteLimit
  if(noteCharacterCount(content)>limit)throw new Error('This note is too long to save. Split it into smaller notes. Your draft is still open.')
}

export function noteSaveError(error) {
  if(/study_assets_content_check/.test(error?.message || ''))return new Error('This note is larger than the server currently accepts. Try splitting it into smaller notes. Your draft is still open.')
  return error
}
