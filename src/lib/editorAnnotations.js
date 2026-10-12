import { Extension, Mark, mergeAttributes } from '@tiptap/vue-3'
import { validAnchor, validColor } from './annotations'

export const Highlight = Mark.create({
  name: 'highlight',
  addAttributes() { return { color: { default: '#fef08a', parseHTML: el => validColor(el.dataset.highlightColor) ? el.dataset.highlightColor : '#fef08a' } } },
  parseHTML() { return [{ tag: 'mark' }] },
  renderHTML({ HTMLAttributes }) { const color = validColor(HTMLAttributes.color) ? HTMLAttributes.color : '#fef08a'; return ['mark', { 'data-highlight-color': color, style: `background-color: ${color}` }, 0] },
})
export const Comment = Mark.create({
  name: 'comment',
  addAttributes() { return { text: { default: '', parseHTML: el => (el.dataset.comment || '').slice(0,1000) } } },
  parseHTML() { return [{ tag: 'span[data-comment]' }] },
  renderHTML({ HTMLAttributes }) { const text = String(HTMLAttributes.text || '').slice(0,1000); return ['span', { 'data-comment': text, title: text }, 0] },
})
export const AnnotationAnchors = Extension.create({
  name: 'annotationAnchors',
  addGlobalAttributes() { return [{ types: ['paragraph','heading','codeBlock','blockMath'], attributes: { annotationId: {
    default: null,
    parseHTML: el => validAnchor(el.dataset.annotationId) ? el.dataset.annotationId : null,
    renderHTML: attrs => validAnchor(attrs.annotationId) ? mergeAttributes({ 'data-annotation-id': attrs.annotationId }) : {},
  } } }] },
})
