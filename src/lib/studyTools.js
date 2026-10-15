import {noteHtml} from './richText.js'
const tidy=value=>String(value || '').replace(/\s+/g,' ').trim()

export function reviewerHighlights(content,format='html'){
 const root=document.createElement('div');root.innerHTML=noteHtml(content,format)
 return [...new Set([...root.querySelectorAll('mark')].map(el=>tidy(el.textContent)).filter(Boolean))].map((text,index)=>({id:'highlight-'+index,text}))
}
export function selectedReviewerText(host){
 const selection=window.getSelection()
 if(!host || !selection || selection.isCollapsed || !selection.rangeCount)return ''
 const range=selection.getRangeAt(0)
 return host.contains(range.startContainer)&&host.contains(range.endContainer)?tidy(selection.toString()):''
}
