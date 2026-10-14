import { safeColumnWidths } from './tableDimensions.js'
import katex from 'katex'
import { noteHtml, escapeHtml } from './richText.js'

export function renderStudyHtml(content, format = 'markdown') {
  const el = document.createElement('div'); el.innerHTML = noteHtml(content, format)
  for (const node of el.querySelectorAll('[data-type="inline-math"],[data-type="block-math"]')) {
    const latex = node.getAttribute('data-latex') || ''
    katex.render(latex, node, { displayMode: node.dataset.type === 'block-math', throwOnError: false, trust: false, maxExpand: 100, maxSize: 20, strict: 'ignore' })
  }
  for(const table of el.querySelectorAll('table')) {
    const widths=[]
    for(const row of table.rows){let column=0;for(const cell of row.cells){
      const values=safeColumnWidths(cell.getAttribute('colwidth')) || []
      for(let i=0;i<cell.colSpan;i++)if(values[i])widths[column+i]=Math.max(widths[column+i] || 0,values[i])
      column+=cell.colSpan
    }}
    if(widths.some(Boolean)){
      const group=document.createElement('colgroup')
      for(const width of widths){const col=document.createElement('col');if(width)col.style.width=width+'px';group.append(col)}
      table.prepend(group);table.style.tableLayout='fixed';table.style.minWidth=widths.reduce((sum,w)=>sum+(w || 48),0)+'px'
    }
    const wrapper=document.createElement('div');wrapper.className='tableWrapper';table.replaceWith(wrapper);wrapper.append(table)
  }
  return el.innerHTML
}
export function printableCards(title, cards) {
  return `<h1>${escapeHtml(title)}</h1><p>Flashcard study sheet · ${cards.length} cards</p>${cards.map((card,i) => `<section class="export-card"><h2>${i+1}. ${renderStudyHtml(card.front)}</h2><div>${renderStudyHtml(card.back)}</div></section>`).join('')}`
}
export function printableQuiz(title, questions) {
  return `<h1>${escapeHtml(title)}</h1><p>Practice quiz · ${questions.length} questions</p>${questions.map((q,i) => `<section class="export-question"><h2>${i+1}. ${renderStudyHtml(q.question)}</h2>${q.options?.length ? '<ol type="A">'+q.options.map(o => '<li>'+renderStudyHtml(o)+'</li>').join('')+'</ol>' : '<p>Answer: ______________________________</p>'}</section>`).join('')}<div class="answer-key"><h1>Answer key</h1>${questions.map((q,i) => `<section><h3>${i+1}. ${renderStudyHtml(q.answer)}</h3>${renderStudyHtml(q.explanation)}</section>`).join('')}</div>`
}
export function studySheet(title, body, mathStyles = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${mathStyles}</style><style>body{background:#fff!important;color:#222!important;margin:0;padding:32px;font:16px/1.7 system-ui,sans-serif}.study-export{max-width:850px;margin:auto}h1,h2,h3{font-family:Georgia,serif;color:#354129;line-height:1.35}h2{margin-top:28px}p,li{margin-block:12px}strong{color:#354129}blockquote{border-left:3px solid #8c8d65;padding:8px 18px;background:#eeeee2}pre{overflow:auto;padding:14px;background:#f4f3ec}a{color:#647044}h1{font-size:28px}h2{font-size:19px}.export-card,.export-question{border:1px solid #ccc;padding:18px;margin:18px 0;break-inside:avoid}.export-card h2 p,.export-question h2 p{display:inline}.answer-key{break-before:page;margin-top:40px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:8px}svg,img,button{display:none}svg.saved-drawing{display:block}mark{color:inherit;print-color-adjust:exact;-webkit-print-color-adjust:exact}[data-comment]{text-decoration:underline dotted #8c8d65}.katex-display{overflow:auto}@media print{body{padding:0}.export-card,.export-question{box-shadow:none}}</style></head><body><main class="study-export markdown">${body}</main></body></html>`
}
