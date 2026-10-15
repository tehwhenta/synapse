<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { ResizableTableRow } from '../lib/tableResize'
import TextAlign from '@tiptap/extension-text-align'
import { Mathematics } from '@tiptap/extension-mathematics'
import { noteHtml, cleanHtml } from '../lib/richText'
import Icon from './Icon.vue'
import DrawingLayer from './DrawingLayer.vue'
import { Highlight, Comment, AnnotationAnchors } from '../lib/editorAnnotations'
import { cleanAnnotations } from '../lib/annotations'
const props = defineProps({ modelValue: { type: String, default: '' }, format: { type: String, default: 'html' }, annotations: { type: Array, default: () => [] } })
const emit = defineEmits(['update:modelValue','update:annotations','flashcard'])
const paper = ref(null), drawingMode = ref('text'), penColor = ref('#c2413a'), penWidth = ref(3), highlightColor = ref('#fef08a'), drawingError = ref('')
const commentOpen = ref(false), commentText = ref('')
const highlightEnabled = ref(false)
let highlightTimer, applyingHighlight = false
const mathOpen = ref(false), formula = ref(''), mathBlock = ref(true), mathPosition = ref(null)
function editMath(node, pos, block) { formula.value = node.attrs.latex; mathPosition.value = pos; mathBlock.value = block; mathOpen.value = true }
const editor = useEditor({
  extensions: [StarterKit.configure({ heading: { levels: [1,2,3] }, link: { openOnClick: false } }), Highlight, Comment, AnnotationAnchors, TableKit.configure({ table: { resizable: true, cellMinWidth: 48, handleWidth: 7, renderWrapper: true }, tableRow: false }), ResizableTableRow, TextAlign.configure({ types: ['heading','paragraph'] }), Mathematics.configure({ katexOptions: { trust: false, throwOnError: false, maxExpand: 100, maxSize: 20 }, inlineOptions: { onClick: (node,pos) => editMath(node,pos,false) }, blockOptions: { onClick: (node,pos) => editMath(node,pos,true) } })],
  content: noteHtml(props.modelValue, props.format),
  editorProps: { attributes: { class: 'markdown rich-editor-content', 'aria-label': 'Reviewer editor', role: 'textbox', 'aria-multiline': 'true' }, handleDOMEvents: { keydown: (_view,event) => { if (event.key === 'Escape' && highlightEnabled.value) { event.preventDefault(); event.stopPropagation(); highlightEnabled.value = false; return true }; return false } } },
  onUpdate: ({ editor: current }) => emit('update:modelValue', cleanHtml(current.getHTML())),
  onSelectionUpdate: () => { clearTimeout(highlightTimer); highlightTimer = setTimeout(() => applyHighlight(),120) },
})
watch(() => props.modelValue, value => { if (editor.value && cleanHtml(editor.value.getHTML()) !== noteHtml(value, props.format)) editor.value.commands.setContent(noteHtml(value,props.format), { emitUpdate: false }) })
function command(name, args) { editor.value.chain().focus()[name](...(args ? [args] : [])).run() }
function insertMath() {
  if (!formula.value.trim()) return
  if (mathPosition.value != null) editor.value.chain().focus().setNodeSelection(mathPosition.value)[mathBlock.value ? 'updateBlockMath' : 'updateInlineMath']({ latex: formula.value.trim() }).run()
  else command(mathBlock.value ? 'insertBlockMath' : 'insertInlineMath', { latex: formula.value.trim() })
  mathOpen.value = false
}
function openMath() { formula.value = ''; mathPosition.value = null; mathBlock.value = true; mathOpen.value = true }
function applyHighlight() {
  const current = editor.value
  if (!current || !highlightEnabled.value || applyingHighlight || drawingMode.value !== 'text' || current.state.selection.empty) return
  applyingHighlight = true
  try { current.chain().setMark('highlight',{color:highlightColor.value}).run(); current.view.dispatch(current.state.tr.removeStoredMark(current.schema.marks.highlight)) }
  finally { applyingHighlight = false }
}
function toggleHighlight() { highlightEnabled.value = !highlightEnabled.value; if (highlightEnabled.value) { editor.value.commands.focus(); applyHighlight() }; clearTimeout(highlightTimer) }
function changeHighlight() { if (highlightEnabled.value) applyHighlight() }
function fromHighlight(){const current=editor.value;const {from,to}=current.state.selection;if(from<to)emit('flashcard',current.state.doc.textBetween(from,to,' ').trim())}
function openComment() { commentText.value = editor.value.getAttributes('comment').text || ''; commentOpen.value = true }
function saveComment() { editor.value.chain().focus().setMark('comment',{text:commentText.value.trim()}).run(); commentOpen.value = false }
function setDrawingMode(mode) {
  highlightEnabled.value = false; clearTimeout(highlightTimer)
  drawingError.value = ''; drawingMode.value = drawingMode.value === mode ? 'text' : mode
  if (drawingMode.value === 'pen') {
    const tr = editor.value.state.tr, seen = new Set()
    tr.doc.descendants((node,pos) => {
      if (!['paragraph','heading','codeBlock','blockMath'].includes(node.type.name)) return
      if (node.attrs.annotationId && !seen.has(node.attrs.annotationId)) seen.add(node.attrs.annotationId)
      else { const id=crypto.randomUUID(); seen.add(id); tr.setNodeMarkup(pos,undefined,{...node.attrs,annotationId:id}) }
    })
    if (tr.docChanged) editor.value.view.dispatch(tr)
  }
  editor.value.setEditable(drawingMode.value === 'text')
}
function eraseHighlight({x,y}) {
  const current=editor.value
  if(!current || drawingMode.value!=='erase')return
  // The SVG receives pointer events; inspect the text underneath, within this editor only.
  const marks=new Set((document.elementsFromPoint?.(x,y) || []).map(el=>el.closest?.('mark')).filter(el=>el && current.view.dom.contains(el)))
  let tr=current.state.tr
  for(const mark of marks){
    try{
      const from=current.view.posAtDOM(mark,0),to=current.view.posAtDOM(mark,mark.childNodes.length)
      if(to>from)tr=tr.removeMark(from,to,current.schema.marks.highlight)
    }catch{} // A prior eraser sample can already have removed this DOM node.
  }
  if(tr.docChanged)current.view.dispatch(tr)
}
function updateDrawings(value) { emit('update:annotations',cleanAnnotations(value)) }
onBeforeUnmount(() => { clearTimeout(highlightTimer); editor.value?.destroy() })
</script>
<template>
  <div class="rich-editor" v-if="editor">
    <div class="editor-tools">
    <div class="format-toolbar" role="toolbar" aria-label="Text formatting">
      <button type="button" title="Bold (Ctrl+B)" aria-label="Bold" :aria-pressed="editor.isActive('bold')" @mousedown.prevent @click="command('toggleBold')"><strong>B</strong></button>
      <button type="button" title="Italic (Ctrl+I)" aria-label="Italic" :aria-pressed="editor.isActive('italic')" @mousedown.prevent @click="command('toggleItalic')"><em>I</em></button>
      <button type="button" title="Underline (Ctrl+U)" aria-label="Underline" :aria-pressed="editor.isActive('underline')" @mousedown.prevent @click="command('toggleUnderline')"><u>U</u></button>
      <button type="button" title="Strikethrough" aria-label="Strikethrough" :aria-pressed="editor.isActive('strike')" @mousedown.prevent @click="command('toggleStrike')"><s>S</s></button>
      <button type="button" :title="highlightEnabled ? 'Stop continuous highlighting (Escape)' : 'Turn on continuous highlighting'" aria-label="Highlight selected text" :disabled="drawingMode !== 'text'" :aria-pressed="highlightEnabled" @mousedown.prevent @click="toggleHighlight"><Icon name="Highlighter" :size="17" /></button>
      <label class="toolbar-color" title="Highlight color"><input type="color" v-model="highlightColor" aria-label="Highlight color" @input="changeHighlight" /></label>
      <button type="button" title="Flashcard from selected text" aria-label="Create flashcard from highlighted text" :disabled="drawingMode !== 'text' || editor.state.selection.empty" @mousedown.prevent @click="fromHighlight"><Icon name="Layers" :size="17" /></button>
      <button type="button" title="Remove highlight from selection" aria-label="Remove highlight" :disabled="drawingMode !== 'text' || editor.state.selection.empty" @mousedown.prevent @click="command('unsetMark','highlight')">×</button>
      <button type="button" title="Add a note to selected text" aria-label="Add text annotation" :disabled="drawingMode !== 'text' || (editor.state.selection.empty && !editor.isActive('comment'))" @mousedown.prevent @click="openComment"><Icon name="MessageSquarePlus" :size="17" /></button>
      <select aria-label="Text style" :value="editor.isActive('heading',{level:1}) ? 1 : editor.isActive('heading',{level:2}) ? 2 : editor.isActive('heading',{level:3}) ? 3 : 0" @change="Number($event.target.value) ? command('setHeading',{level:Number($event.target.value)}) : command('setParagraph')"><option value="0">Normal text</option><option value="1">Heading 1</option><option value="2">Heading 2</option><option value="3">Heading 3</option></select>
      <button type="button" aria-label="Bullet list" title="Bullet list" :aria-pressed="editor.isActive('bulletList')" @mousedown.prevent @click="command('toggleBulletList')"><Icon name="List" :size="17" /></button>
      <button type="button" aria-label="Numbered list" title="Numbered list" :aria-pressed="editor.isActive('orderedList')" @mousedown.prevent @click="command('toggleOrderedList')"><Icon name="ListOrdered" :size="17" /></button>
      <button v-for="[align,icon] in [['left','AlignLeft'],['center','AlignCenter'],['right','AlignRight']]" :key="align" type="button" :aria-label="'Align '+align" :title="'Align '+align" :aria-pressed="editor.isActive({textAlign:align})" @mousedown.prevent @click="command('setTextAlign',align)"><Icon :name="icon" :size="17" /></button>
      <button type="button" aria-label="Insert table" title="Insert 3 × 3 table" @mousedown.prevent @click="command('insertTable',{rows:3,cols:3,withHeaderRow:true})"><Icon name="Table" :size="17" /></button>
      <button type="button" aria-label="Insert equation" title="Insert equation" @mousedown.prevent @click="openMath"><Icon name="Sigma" :size="17" /></button>
      <button type="button" aria-label="Undo" title="Undo (Ctrl+Z)" @mousedown.prevent @click="command('undo')"><Icon name="Undo2" :size="17" /></button>
      <button type="button" aria-label="Redo" title="Redo" @mousedown.prevent @click="command('redo')"><Icon name="Redo2" :size="17" /></button>
      <button type="button" aria-label="Draw on reviewer" title="Draw on reviewer" :aria-pressed="drawingMode === 'pen'" @mousedown.prevent @click="setDrawingMode('pen')"><Icon name="PenLine" :size="17" /></button>
      <button type="button" aria-label="Erase drawings and highlights" title="Click or drag over drawings and highlighted text to erase" :aria-pressed="drawingMode === 'erase'" @mousedown.prevent @click="setDrawingMode('erase')"><Icon name="Eraser" :size="17" /></button>
    </div>
    <div v-if="drawingMode !== 'text'" class="drawing-toolbar"><button type="button" class="button secondary small" @click="setDrawingMode(drawingMode)">Return to text</button><label>Color<input type="color" v-model="penColor" aria-label="Pen color" /></label><label>Thickness<input type="range" v-model.number="penWidth" min="1" max="12" aria-label="Pen thickness" /><span>{{ penWidth }} px</span></label><button type="button" class="button ghost small" :disabled="!annotations.length" @click="updateDrawings(annotations.slice(0,-1))">Undo drawing</button></div>
    <div v-if="commentOpen" class="annotation-editor stack-form"><label>Note for the selected text<textarea v-model="commentText" maxlength="1000" rows="3" placeholder="Write your annotation…" /></label><div class="inline-actions"><button type="button" class="button ghost small" @click="command('unsetMark','comment'); commentOpen = false">Remove note</button><button type="button" class="button secondary small" @click="commentOpen = false">Cancel</button><button type="button" class="button primary small" :disabled="!commentText.trim()" @click="saveComment">Save annotation</button></div></div>
    <div v-if="editor.isActive('table')" class="table-toolbar"><button type="button" @mousedown.prevent @click="command('addRowAfter')">+ Row</button><button type="button" @mousedown.prevent @click="command('addColumnAfter')">+ Column</button><button type="button" @mousedown.prevent @click="command('deleteRow')">Delete row</button><button type="button" @mousedown.prevent @click="command('deleteColumn')">Delete column</button><button type="button" @mousedown.prevent @click="command('deleteTable')">Delete table</button></div>
    <div v-if="mathOpen" class="equation-editor stack-form"><label>Equation<textarea v-model="formula" rows="2" maxlength="2000" placeholder="e.g. x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}"></textarea></label><label v-if="mathPosition == null" class="checkbox-label"><input v-model="mathBlock" type="checkbox" /> Display on its own line</label><p class="tiny muted">Use LaTeX here. Your reviewer displays the formatted equation.</p><div class="inline-actions"><button type="button" class="button secondary small" @click="mathOpen = false">Cancel</button><button type="button" class="button primary small" :disabled="!formula.trim()" @click="insertMath">{{ mathPosition == null ? 'Insert' : 'Update' }} equation</button></div></div>
    <p v-if="highlightEnabled" class="highlight-mode-hint" role="status">Highlight is on. Select more text to keep highlighting; click the tool again or press Escape to stop.</p>
    </div>
    <div ref="paper" class="annotated-paper"><EditorContent :editor="editor" /><DrawingLayer :host="paper" :model-value="annotations" :active="drawingMode !== 'text'" :mode="drawingMode" :color="penColor" :width="penWidth" @update:model-value="updateDrawings" @error="drawingError = $event" @erase="eraseHighlight" /></div>
    <p v-if="drawingError" class="tiny error-text" role="alert">{{ drawingError }}</p>
    <p class="editor-hint tiny muted">{{ drawingMode === 'text' ? 'Select text to format, highlight, or annotate it. Click an equation to edit it. Drag table column borders or the bottom edge of a row to resize.' : drawingMode === 'erase' ? 'Click or drag over a drawing or highlighted text to remove it.' : 'Draw directly over the reviewer. Strokes stay inside the reviewer; finish wording and table sizing before drawing for the best alignment.' }}</p>
  </div>
</template>
