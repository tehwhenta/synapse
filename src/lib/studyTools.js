import {noteHtml,plainStudyText} from './richText.js'
const tidy=value=>String(value || '').replace(/\s+/g,' ').trim()

export function reviewerHighlights(content,format='html'){
 const root=document.createElement('div');root.innerHTML=noteHtml(content,format)
 return [...new Set([...root.querySelectorAll('mark')].map(el=>tidy(plainStudyText(el.outerHTML,'html'))).filter(Boolean))].map((text,index)=>({id:'highlight-'+index,text}))
}
export function selectedReviewerText(host){
 const selection=window.getSelection()
 if(!host || !selection || selection.isCollapsed || !selection.rangeCount)return ''
 const range=selection.getRangeAt(0)
 if(!host.contains(range.startContainer) || !host.contains(range.endContainer))return ''
 const fragment=document.createElement('div');fragment.append(range.cloneContents())
 return tidy(plainStudyText(fragment.innerHTML,'html'))
}
