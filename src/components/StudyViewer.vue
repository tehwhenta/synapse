<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, defineAsyncComponent } from 'vue'
import { useWorkspaceStore } from '../stores/workspace'
import { downloadFile, safeFilename, ankiTsv, quizResult } from '../lib/utils'
import { noteHtml, plainStudyText, escapeHtml } from '../lib/richText'
import { renderStudyHtml, printableCards, printableQuiz, studySheet } from '../lib/studyRendering'
import { fileExpiry } from '../lib/sourceFiles'
import { cleanAnnotations, annotatedHtml } from '../lib/annotations'
const RichEditor = defineAsyncComponent(() => import('./RichEditor.vue'))
import Modal from './Modal.vue'
import Icon from './Icon.vue'
const props = defineProps({ asset: Object })
const emit = defineEmits(['close', 'notify', 'reupload'])
const workspace = useWorkspaceStore()
const asset = ref({ ...props.asset }), sets = ref([props.asset]), setsLoading = ref(false)
const editing = ref(false), renaming = ref(false), draft = ref(''), title = ref(asset.value.title), busy = ref(false), error = ref(''), discard = ref(false)
const draftAnnotations = ref([])
const cardIndex = ref(0), flipped = ref(false), reviewed = ref(new Set()), studyMode = ref('all')
const questionIndex = ref(0), answers = ref([]), revealed = ref(false), result = ref(null)
const sourceDocument = ref(null), refreshWarning = ref(false), now = ref(Date.now())
let alive = true
const clock = setInterval(() => { now.value = Date.now() }, 60000)
const source = computed(() => workspace.documents.find(d => d.id === asset.value.document_id) || sourceDocument.value)
const sourceState = computed(() => fileExpiry(source.value, now.value))
const html = computed(() => annotatedHtml(renderStudyHtml(asset.value.content, asset.value.content_format),asset.value.annotations))
const comments = computed(() => { const root = document.createElement('div'); root.innerHTML = html.value; return [...root.querySelectorAll('[data-comment]')].map(node => ({ text:node.textContent,note:node.dataset.comment })) })
const cards = computed(() => asset.value.data.map((card,index) => ({ ...card, originalIndex:index })).filter(card => studyMode.value === 'all' || !workspace.progress.some(p => p.asset_id === asset.value.id && p.card_index === card.originalIndex && new Date(p.due_at) > new Date())))
const card = computed(() => cards.value[cardIndex.value])
const question = computed(() => asset.value.data[questionIndex.value])
const feedback = computed(() => question.value ? quizResult([question.value], [answers.value[questionIndex.value]]).feedback[0] : null)
const completion = computed(() => Math.round(((questionIndex.value+1)/asset.value.data.length)*100))
const setIndex = computed(() => sets.value.findIndex(s => s.id === asset.value.id))
const printHtml = computed(() => asset.value.kind === 'note' ? `<h1>${escapeHtml(asset.value.title)}</h1>${html.value}${comments.value.length ? '<section><h2>Text annotations</h2><ol>'+comments.value.map(comment=>'<li><strong>'+escapeHtml(comment.text)+'</strong>: '+escapeHtml(comment.note)+'</li>').join('')+'</ol></section>' : ''}` : asset.value.kind === 'deck' ? printableCards(asset.value.title,asset.value.data) : printableQuiz(asset.value.title,asset.value.data))
const dirty = computed(() => editing.value && (draft.value !== noteHtml(asset.value.content,asset.value.content_format) || title.value !== asset.value.title || JSON.stringify(draftAnnotations.value) !== JSON.stringify(cleanAnnotations(asset.value.annotations))))
watch(studyMode, () => { cardIndex.value = 0; flipped.value = false; reviewed.value = new Set() })
watch(() => asset.value.id, () => { cardIndex.value = 0; flipped.value = false; reviewed.value = new Set(); restartQuiz(); renaming.value = false; title.value = asset.value.title })
watch(() => asset.value.document_id, async id => {
  sourceDocument.value = null; refreshWarning.value = false
  if (!id) return
  try { const doc = await workspace.readDocument(id); if (alive && asset.value.document_id === id) sourceDocument.value = doc }
  catch { /* A missing metadata request must not hide saved study content. */ }
}, { immediate: true })
watch(() => workspace.assets, rows => {
  const current = rows.find(a => a.id === asset.value.id)
  if (current && !editing.value && !renaming.value) { asset.value = { ...current }; title.value = current.title }
})
async function loadSets(selectId = asset.value.id) {
  setsLoading.value = true
  try {
    const rows = await workspace.listSets(asset.value)
    if (!alive) return
    sets.value = rows
    const selected = rows.find(a => a.id === selectId)
    if (selected) asset.value = selectId === asset.value.id ? { ...asset.value, ...selected } : { ...await workspace.readAsset(selectId) }
  } finally { if (alive) setsLoading.value = false }
}
async function selectSet(set) {
  if (busy.value || editing.value || renaming.value || !set) return
  busy.value = true; error.value = ''
  try { const row = await workspace.readAsset(set.id); if (alive) asset.value = { ...row } }
  catch (e) { error.value = e.message } finally { busy.value = false }
}
function startEditing() { title.value = asset.value.title; draft.value = noteHtml(asset.value.content,asset.value.content_format); draftAnnotations.value = cleanAnnotations(asset.value.annotations); editing.value = true; renaming.value = false; error.value = '' }
function requestClose() { if (busy.value) return; if (dirty.value) discard.value = true; else emit('close') }
async function save() {
  busy.value = true; error.value = ''
  try {
    if (draft.value.length > 60000) throw new Error('This note is too long to save. Keep it under 60,000 characters including formatting.')
    if (!plainStudyText(draft.value,'html').trim()) throw new Error('Write something in your reviewer first.')
    if (new TextEncoder().encode(JSON.stringify(draftAnnotations.value)).length > 256000) throw new Error('These drawings are too large to save. Remove some strokes and try again.')
    await workspace.saveNote(title.value.trim(),draft.value,asset.value.id,'html',draftAnnotations.value)
    Object.assign(asset.value,{ title:title.value.trim(),content:draft.value,content_format:'html',annotations:cleanAnnotations(draftAnnotations.value) }); editing.value = false
    await loadSets(); emit('notify','Your reviewer is saved.')
  } catch (e) { error.value = e.message } finally { busy.value = false }
}
async function saveTitle() {
  busy.value = true; error.value = ''
  try { await workspace.renameAsset(asset.value.id,title.value); asset.value.title = title.value.trim(); renaming.value = false; await loadSets(); emit('notify','The title is updated.') }
  catch (e) { error.value = e.message } finally { busy.value = false }
}
async function refresh(useRetained = false) {
  now.value = Date.now()
  if (asset.value.document_id && sourceState.value.expired && useRetained !== true) { refreshWarning.value = true; return }
  refreshWarning.value = false
  busy.value = true; error.value = ''
  try { const id = await workspace.refreshAsset(asset.value); await loadSets(id); emit('notify','Your new set is ready. Earlier sets are kept.') }
  catch (e) { error.value = e.message } finally { busy.value = false }
}
function moveCard(delta) { cardIndex.value = (cardIndex.value+delta+cards.value.length)%cards.value.length; flipped.value = false }
async function rate(rating) {
  busy.value = true; error.value = ''
  try {
    const index = card.value.originalIndex
    await workspace.reviewCard(asset.value,index,rating); reviewed.value = new Set([...reviewed.value,index]); flipped.value = false
    if (cards.value.length) cardIndex.value = studyMode.value === 'due' ? Math.min(cardIndex.value,cards.value.length-1) : (cardIndex.value+1)%cards.value.length
    else cardIndex.value = 0
  } catch (e) { error.value = e.message } finally { busy.value = false }
}
async function nextQuestion() {
  if (questionIndex.value < asset.value.data.length-1) { questionIndex.value++; revealed.value = false; return }
  busy.value = true; error.value = ''
  try { result.value = await workspace.submitQuiz(asset.value,answers.value) } catch (e) { error.value = e.message } finally { busy.value = false }
}
async function exportAsset(format) {
  const name = safeFilename(asset.value.title) + ' - set ' + (asset.value.set_number || 1)
  if (format === 'html') { const { offlineMathCss } = await import('../lib/exportStyles'); downloadFile(name+'.html',studySheet(asset.value.title,printHtml.value,offlineMathCss),'text/html') }
  else if (format === 'anki') downloadFile(name+'.tsv',ankiTsv(asset.value.data),'text/tab-separated-values')
  else {
    const text = asset.value.kind === 'note' ? plainStudyText(asset.value.content,asset.value.content_format)
      : asset.value.kind === 'deck' ? asset.value.data.map((c,i) => `${i+1}. ${plainStudyText(c.front)}\nAnswer: ${plainStudyText(c.back)}`).join('\n\n')
        : asset.value.data.map((q,i) => `${i+1}. ${plainStudyText(q.question)}\n${q.options.map((o,j) => `${String.fromCharCode(65+j)}. ${plainStudyText(o)}`).join('\n')}\nAnswer: ${plainStudyText(q.answer)}\n${plainStudyText(q.explanation)}`).join('\n\n')
    downloadFile(name+'.txt',asset.value.title+'\n\n'+text,'text/plain')
  }
}
function finishPrint() { document.body.classList.remove('printing-note') }
async function printAsset() { document.body.classList.add('printing-note'); await nextTick(); window.addEventListener('afterprint',finishPrint,{ once:true }); window.print() }
function restartQuiz() { result.value = null; questionIndex.value = 0; answers.value = []; revealed.value = false }
onMounted(() => loadSets().catch(e => { error.value = e.message }))
onBeforeUnmount(() => { alive = false; clearInterval(clock); finishPrint(); window.removeEventListener('afterprint',finishPrint) })
</script>
<template>
  <Modal :title="asset.title" wide resizable @close="requestClose">
    <div class="viewer-content">
      <div class="viewer-toolbar"><span class="pill"><Icon :name="asset.kind === 'note' ? 'FileText' : asset.kind === 'deck' ? 'Layers' : 'CheckCheck'" :size="14" />{{ asset.kind === 'note' ? 'Reviewer' : asset.kind === 'deck' ? 'Flashcards' : 'Practice quiz' }}</span>
        <div class="inline-actions">
          <button v-if="workspace.canEdit && !editing" class="button ghost small" :disabled="busy || renaming" @click="renaming = true; title = asset.title"><Icon name="Edit3" :size="15" />Rename</button>
          <button v-if="asset.kind === 'note' && workspace.canEdit && !editing" class="button ghost small" :disabled="busy" @click="startEditing">Edit reviewer</button>
          <details class="export-menu" v-if="!editing"><summary class="button ghost small"><Icon name="Download" :size="15" />Export</summary><div><button @click="printAsset">Print / Save as PDF</button><button @click="exportAsset('html')">Study sheet (.html)</button><button @click="exportAsset('txt')">Plain text (.txt)</button><button v-if="asset.kind === 'deck'" @click="exportAsset('anki')">Anki import (.tsv)</button></div></details>
        </div>
      </div>
      <div class="set-toolbar"><nav class="set-navigation" aria-label="Study sets"><span class="tiny muted">SET</span><button class="icon-button" aria-label="Previous set" :disabled="setIndex <= 0 || busy || editing || renaming" @click="selectSet(sets[setIndex-1])"><Icon name="ChevronLeft" :size="16" /></button><div class="set-numbers"><button v-for="set in sets" :key="set.id" :aria-label="'Open set '+(set.set_number || 1)" :aria-current="set.id === asset.id ? 'page' : undefined" :class="{ active:set.id === asset.id }" :disabled="busy || editing || renaming" @click="selectSet(set)">{{ set.set_number || 1 }}</button></div><button class="icon-button" aria-label="Next set" :disabled="setIndex >= sets.length-1 || busy || editing || renaming" @click="selectSet(sets[setIndex+1])"><Icon name="ChevronRight" :size="16" /></button></nav>
        <button v-if="workspace.canEdit" class="button secondary small" :disabled="busy || workspace.uploading || setsLoading || editing || renaming" @click="refresh"><Icon :name="busy ? 'LoaderCircle' : 'RotateCcw'" :class="{spin:busy}" :size="15" />{{ busy ? 'Working…' : 'Generate new set' }}</button>
      </div>
      <div v-if="asset.document_id" class="source-notice" :class="{ 'source-expired': sourceState.expired, 'source-soon': sourceState.state === 'soon' }" role="status"><Icon :name="sourceState.expired ? 'TriangleAlert' : 'Clock3'" :size="16" /><div><strong>{{ sourceState.label }}</strong><p>{{ sourceState.expired ? 'Saved materials are kept. New sets use retained text, which may miss diagrams or source details. Re-upload the original for full detail.' : 'Saved materials do not expire. After the original file expires, re-upload it for new sets that need its full details.' }}</p></div><button v-if="sourceState.expired && workspace.canEdit" class="button secondary small" @click="emit('reupload')">Upload again</button></div>
      <div v-if="refreshWarning" class="refresh-warning" role="alert"><strong>Generate from retained text?</strong><p>The original has expired. Some source details may be unavailable, and this uses an AI generation.</p><div class="inline-actions"><button class="button ghost small" @click="refreshWarning = false">Cancel</button><button class="button secondary small" @click="emit('reupload')">Upload original</button><button class="button primary small" @click="refresh(true)">Use retained text</button></div></div>
      <p v-if="error" role="alert" class="error-box">{{ error }}</p>
      <div v-if="discard" class="discard-panel"><p>You have unsaved edits.</p><button class="button secondary small" @click="discard = false">Keep editing</button><button class="button danger small" @click="emit('close')">Discard and close</button></div>
      <form v-if="renaming" class="rename-form stack-form" @submit.prevent="saveTitle"><label>Title for this set<input v-model="title" required maxlength="150" /></label><div class="inline-actions"><button type="button" class="button secondary small" :disabled="busy" @click="renaming = false">Cancel</button><button class="button primary small" :disabled="busy || !title.trim()">Save title<Icon name="Check" :size="15" /></button></div></form>
      <template v-if="asset.kind === 'note'">
        <form v-if="editing" class="stack-form note-editor" @submit.prevent="save"><label>Title for this set<input v-model="title" required maxlength="150" /></label><RichEditor v-model="draft" v-model:annotations="draftAnnotations" /><div class="inline-actions"><button type="button" class="button secondary" :disabled="busy" @click="editing = false">Cancel edits</button><button class="button primary" :disabled="busy || !title.trim()">{{ busy ? 'Saving…' : 'Save reviewer' }}<Icon name="Check" :size="16" /></button></div></form>
        <template v-else><article class="markdown" v-html="html"></article><details v-if="comments.length" class="reviewer-comments"><summary>Text annotations ({{ comments.length }})</summary><dl><template v-for="(comment,i) in comments" :key="i"><dt>{{ comment.text }}</dt><dd>{{ comment.note }}</dd></template></dl></details></template>
      </template>
      <template v-else-if="asset.kind === 'deck'">
        <div class="deck-controls"><div class="segmented"><button :class="{ active:studyMode === 'all' }" @click="studyMode = 'all'">All cards</button><button :class="{ active:studyMode === 'due' }" @click="studyMode = 'due'">Due for review</button></div><span class="tiny muted">{{ reviewed.size }} reviewed this session</span></div>
        <template v-if="card"><button :key="asset.id + ':' + card.originalIndex" class="flashcard" :class="{ 'is-flipped': flipped }" @click="flipped = !flipped" :aria-label="flipped ? 'Show question' : 'Reveal answer'" :aria-pressed="flipped"><span class="flashcard-inner"><span class="flashcard-face flashcard-front" :aria-hidden="flipped" :inert="flipped || undefined"><span class="card-face-label"><Icon name="CircleHelp" :size="16" />Question</span><span class="flashcard-text" v-html="renderStudyHtml(card.front)"></span><span class="tiny muted">Reveal answer<Icon name="RotateCcw" :size="14" /></span></span><span class="flashcard-face flashcard-back" :aria-hidden="!flipped" :inert="!flipped || undefined"><span class="card-face-label"><Icon name="CheckCheck" :size="16" />Answer</span><span class="flashcard-text" v-html="renderStudyHtml(card.back)"></span><span class="tiny muted">Show question<Icon name="RotateCcw" :size="14" /></span></span></span></button><div class="card-navigation"><button class="icon-button" aria-label="Previous card" @click="moveCard(-1)"><Icon name="ChevronLeft" /></button><span>{{ cardIndex+1 }} <span class="muted">of {{ cards.length }}</span></span><button class="icon-button" aria-label="Next card" @click="moveCard(1)"><Icon name="ChevronRight" /></button></div><div class="ratings" :class="{ 'ratings-hidden': !flipped }" :aria-hidden="!flipped" :inert="!flipped || undefined"><button v-for="(label,i) in ['Again','Hard','Good','Easy']" :key="label" class="button secondary" :disabled="busy || !flipped" @click="rate(i+1)">{{ label }}</button></div><p class="tiny muted center">Your rating schedules the card for its next review.</p></template>
        <div v-else class="empty-state"><Icon name="CheckCheck" :size="34" /><h3>You’re all caught up.</h3><p>There are no cards due right now.</p></div>
      </template>
      <template v-else>
        <div v-if="result" class="quiz-result"><div class="result-circle">{{ Math.round(result.correct/result.total*100) }}<small>%</small></div><h3>{{ result.correct === result.total ? 'It’s all coming together.' : 'Every attempt makes a connection.' }}</h3><p class="muted">{{ result.correct }} of {{ result.total }} correct. Your result is saved.</p><div class="quiz-review"><section v-for="(item,i) in result.feedback" :key="i"><span class="review-status" :class="{correct:item.correct}"><Icon :name="item.correct ? 'Check' : 'X'" :size="15" /></span><div><strong v-html="renderStudyHtml(asset.data[i].question)"></strong><p v-html="renderStudyHtml(item.answer)"></p><div class="tiny muted" v-html="renderStudyHtml(item.explanation)"></div></div></section></div><button class="button primary" @click="restartQuiz">Try again<Icon name="RotateCcw" :size="16" /></button></div>
        <div v-else-if="question" class="quiz-body"><div class="quiz-step"><span class="eyebrow">QUESTION {{ questionIndex+1 }} OF {{ asset.data.length }}</span><span class="tiny muted">{{ question.type.replace('_',' ') }}</span></div><div class="progress-bar"><span :style="{width:completion+'%'}"></span></div><h3 v-html="renderStudyHtml(question.question)"></h3><div v-if="question.type !== 'short_answer'" class="quiz-options"><button v-for="(option,i) in question.options" :key="option" class="quiz-option" :class="{selected:answers[questionIndex] === option,correct:revealed && option === question.answer,incorrect:revealed && answers[questionIndex] === option && !feedback.correct}" :disabled="revealed" @click="answers[questionIndex] = option"><span class="option-letter">{{ String.fromCharCode(65+i) }}</span><span v-html="renderStudyHtml(option)"></span><Icon v-if="revealed && option === question.answer" name="Check" :size="17" /></button></div><label v-else class="stack-form">Your answer<input v-model="answers[questionIndex]" maxlength="1000" :disabled="revealed" placeholder="A term, number, or short phrase…" @keydown.enter="answers[questionIndex]?.trim() && (revealed = true)" /></label><div v-if="revealed" class="quiz-feedback" :class="{'is-correct':feedback.correct}"><strong>{{ feedback.correct ? 'You’ve got it.' : 'One to come back to.' }}</strong><p v-if="!feedback.correct">Expected answer: <span v-html="renderStudyHtml(feedback.answer)"></span></p><div v-html="renderStudyHtml(feedback.explanation)"></div></div><div class="quiz-actions"><p class="tiny muted">{{ question.type === 'short_answer' ? 'Uses the expected answer and accepted synonyms.' : 'No pressure. This is practice.' }}</p><button v-if="!revealed" class="button primary" :disabled="!answers[questionIndex]?.trim()" @click="revealed = true">Check answer<Icon name="Check" :size="16" /></button><button v-else class="button primary" :disabled="busy" @click="nextQuestion">{{ busy ? 'Saving…' : questionIndex === asset.data.length-1 ? 'See my results' : 'Next question' }}<Icon name="ArrowRight" :size="16" /></button></div></div>
        <div v-else class="empty-state">This quiz has no questions.</div>
      </template>
      <p class="viewer-footnote tiny muted">AI materials can make mistakes. Check important details against your source.</p>
    </div>
    <article class="print-content markdown" v-html="printHtml"></article>
  </Modal>
</template>
