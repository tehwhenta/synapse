import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { safeRowHeight, safeColumnWidths } from './tableDimensions.js'
import { validAnchor, validColor } from './annotations.js'

export function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]) }
const mathNode = (latex, block) => `<${block ? 'div' : 'span'} data-type="${block ? 'block' : 'inline'}-math" data-latex="${escapeHtml(latex.trim())}"></${block ? 'div' : 'span'}>`
const markdown = new Marked({ extensions: [
  { name: 'blockMath', level: 'block', start: src => src.indexOf('$$'), tokenizer(src) { const m = /^\$\$\s*\n?([\s\S]+?)\$\$(?:[ \t]*\n|$)/.exec(src); if (m) return { type: 'blockMath', raw: m[0], latex: m[1] } }, renderer: token => mathNode(token.latex, true) },
  { name: 'inlineMath', level: 'inline', start: src => src.indexOf('$'), tokenizer(src) { const m = /^\$([^$\n]+)\$/.exec(src); if (m) return { type: 'inlineMath', raw: m[0], latex: m[1] } }, renderer: token => mathNode(token.latex, false) },
] })
DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.hasAttribute('style')) {
    const align = /^\s*text-align:\s*(left|center|right|justify)\s*;?\s*$/i.exec(node.getAttribute('style'))
    if (align) node.setAttribute('style', `text-align: ${align[1].toLowerCase()}`)
    else if (node.tagName === 'MARK' && validColor(node.getAttribute('data-highlight-color'))) node.setAttribute('style', `background-color: ${node.getAttribute('data-highlight-color')}`)
    else node.removeAttribute('style')
  }
  if (node.hasAttribute('colwidth')) {
    const widths=safeColumnWidths(node.getAttribute('colwidth'))
    if(['TD','TH'].includes(node.tagName) && widths)node.setAttribute('colwidth',widths.join(','))
    else node.removeAttribute('colwidth')
  }
  if (node.hasAttribute('data-row-height')) {
    const height=safeRowHeight(node.getAttribute('data-row-height'))
    if(node.tagName==='TR' && height){node.setAttribute('data-row-height',String(height));node.setAttribute('style',`height: ${height}px`)}
    else node.removeAttribute('data-row-height')
  }
  if (node.hasAttribute('data-annotation-id') && !validAnchor(node.getAttribute('data-annotation-id'))) node.removeAttribute('data-annotation-id')
  if (node.hasAttribute('data-highlight-color')) {
    if (node.tagName === 'MARK' && validColor(node.getAttribute('data-highlight-color'))) node.setAttribute('style', `background-color: ${node.getAttribute('data-highlight-color')}`)
    else node.removeAttribute('data-highlight-color')
  }
  if (node.hasAttribute('data-comment')) { const text = node.getAttribute('data-comment').slice(0,1000); node.setAttribute('data-comment',text); node.setAttribute('title',text) }
  if (node.tagName === 'A') { node.setAttribute('rel', 'noopener noreferrer'); node.setAttribute('target', '_blank') }
})
export function cleanHtml(html) {
  return DOMPurify.sanitize(html || '', {
    ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','br','strong','b','em','i','u','s','del','ul','ol','li','blockquote','pre','code','hr','a','table','thead','tbody','tr','td','th','div','span','mark'],
    ALLOWED_ATTR: ['href','rel','target','style','colspan','rowspan','colwidth','data-row-height','start','data-type','data-latex','data-annotation-id','data-highlight-color','data-comment','title'],
    ALLOW_DATA_ATTR: false,
  })
}
export function noteHtml(content, format = 'markdown') { return cleanHtml(format === 'html' ? content : markdown.parse(content || '')) }
export function plainStudyText(content, format = 'markdown') {
  const el = document.createElement('div'); el.innerHTML = noteHtml(content, format)
  for (const node of el.querySelectorAll('[data-latex]')) node.textContent = node.dataset.latex
  for (const node of el.querySelectorAll('p,h1,h2,h3,h4,li,tr,blockquote,div')) node.append('\n')
  return (el.textContent || '').trim()
}

