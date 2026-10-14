import test from 'node:test'
import assert from 'node:assert/strict'
import {noteCharacterCount,validateNoteContent,noteSaveError} from '../src/lib/noteContent.js'
test('Note validation matches PostgreSQL character counts and keeps every character within bounded capacities',()=>{
 const html='<p>'+('🙂'.repeat(239993))+'</p>'
 assert.equal(noteCharacterCount(html),240000)
 assert.doesNotThrow(()=>validateNoteContent(html,'html'))
 assert.throws(()=>validateNoteContent(html+'x','html'),/too long.*draft is still open/)
 assert.doesNotThrow(()=>validateNoteContent('x'.repeat(60000),'markdown'))
 assert.throws(()=>validateNoteContent('x'.repeat(60001),'markdown'),/too long/)
 assert.throws(()=>validateNoteContent('text','unknown'),/unsupported format/)
 assert.throws(()=>validateNoteContent(null,'html'),/unsupported format/)
})
test('An older server capacity becomes a clear note-size error while unrelated server errors remain intact',()=>{
 const old={message:'new row for relation "study_assets" violates check constraint "study_assets_content_check"'}
 assert.match(noteSaveError(old).message,/server currently accepts.*draft is still open/)
 const access={message:'Editor access required',code:'42501'}
 assert.equal(noteSaveError(access),access)
})
