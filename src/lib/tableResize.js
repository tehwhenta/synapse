import { TableRow } from '@tiptap/extension-table'
import { Plugin, PluginKey } from '@tiptap/pm/state'

import { safeRowHeight } from './tableDimensions'

export const ResizableTableRow = TableRow.extend({
 addAttributes(){return {height:{default:null,parseHTML:el=>safeRowHeight(el.dataset.rowHeight),renderHTML:attrs=>safeRowHeight(attrs.height)?{'data-row-height':attrs.height,style:`height: ${attrs.height}px`}:{}}}},
 addProseMirrorPlugins(){return [new Plugin({
  key:new PluginKey('synapseRowResize'),
  view(view){
   let hovered=null,drag=null,frame=null
   const win=view.dom.ownerDocument.defaultView
   function hover(row){if(hovered===row)return;hovered?.classList.remove('row-resize-hover');hovered=row;hovered?.classList.add('row-resize-hover');view.dom.classList.toggle('row-resize-cursor',!!row)}
   function target(event){
    if(!view.editable)return null
    const cell=event.target.closest?.('td,th'),row=cell?.parentElement
    if(!row || !view.dom.contains(row))return null
    const rect=row.getBoundingClientRect(),cellRect=cell.getBoundingClientRect()
    // Leave the corners for the native column resize handles.
    return Math.abs(event.clientY-rect.bottom)<=7 && event.clientX>cellRect.left+7 && event.clientX<cellRect.right-7?row:null
   }
   function locate(row){
    const point=view.posAtDOM(row,0),$pos=view.state.doc.resolve(point)
    for(let depth=$pos.depth;depth>0;depth--)if($pos.node(depth).type.name==='tableRow')return $pos.before(depth)
    return view.state.doc.nodeAt(point)?.type.name==='tableRow'?point:null
   }
   function end(commit){
    if(!drag)return
    const finished=drag;drag=null
    if(frame){cancelAnimationFrame(frame);frame=null}
    finished.row.style.height=finished.original
    win.removeEventListener('pointermove',move);win.removeEventListener('pointerup',up);win.removeEventListener('pointercancel',cancel);win.removeEventListener('keydown',key);win.removeEventListener('blur',cancel)
    view.dom.classList.remove('table-resizing');hover(null)
    if(commit && view.editable && view.state.doc===finished.doc){
     const node=view.state.doc.nodeAt(finished.pos)
     if(node?.type.name==='tableRow')view.dispatch(view.state.tr.setNodeMarkup(finished.pos,undefined,{...node.attrs,height:finished.height}))
    }
   }
   function move(event){
    if(!drag){hover(target(event));return}
    if(event.pointerId!==drag.pointer)return
    event.preventDefault();drag.height=Math.max(28,Math.min(1600,Math.round(drag.startHeight+event.clientY-drag.startY)))
    if(!frame)frame=requestAnimationFrame(()=>{frame=null;if(drag)drag.row.style.height=drag.height+'px'})
   }
   function down(event){
    if(drag || event.button!==0)return
    const row=target(event);if(!row)return
    const pos=locate(row);if(pos===null)return
    event.preventDefault();event.stopPropagation()
    const rect=row.getBoundingClientRect()
    drag={row,pos,doc:view.state.doc,pointer:event.pointerId,startY:event.clientY,startHeight:rect.height,height:Math.round(rect.height),original:row.style.height}
    hover(row);view.dom.classList.add('table-resizing')
    win.addEventListener('pointermove',move,{passive:false});win.addEventListener('pointerup',up);win.addEventListener('pointercancel',cancel);win.addEventListener('keydown',key);win.addEventListener('blur',cancel)
   }
   function up(event){if(event.pointerId===drag?.pointer)end(true)}
   function cancel(){end(false)}
   function key(event){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();end(false)}}
   function leave(){if(!drag)hover(null)}
   view.dom.addEventListener('pointerdown',down);view.dom.addEventListener('pointermove',move);view.dom.addEventListener('pointerleave',leave)
   return {update(){if(drag && (!view.editable || view.state.doc!==drag.doc))end(false)},destroy(){end(false);hover(null);view.dom.removeEventListener('pointerdown',down);view.dom.removeEventListener('pointermove',move);view.dom.removeEventListener('pointerleave',leave)}}
  },
 })]},
})
