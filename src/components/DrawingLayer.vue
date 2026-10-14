<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { cleanAnnotations, PAPER_ANCHOR, distanceToSegment } from '../lib/annotations'
const props = defineProps({ modelValue: { type: Array, default: () => [] }, host: Object, active: Boolean, mode: { type: String, default: 'pen' }, color: { type: String, default: '#c2413a' }, width: { type: Number, default: 3 } })
const emit = defineEmits(['update:modelValue', 'error', 'erase'])
const surface = ref(null), geometry = ref({ width: 1, height: 1, anchors: {} }), current = ref(null)
let observer, mutationObserver, frame, pointerId = null, alive = true, lastErase = null
let localStrokes = cleanAnnotations(props.modelValue)
watch(() => props.modelValue, value => { localStrokes=cleanAnnotations(value) }, {deep:true})
const strokes = computed(() => [...cleanAnnotations(props.modelValue), ...(current.value ? [current.value] : [])])
const paths = computed(() => strokes.value.flatMap(stroke => {
  const anchor = geometry.value.anchors[stroke.anchor]
  return anchor ? [{ ...stroke, points: stroke.points.map(([x,y]) => `${anchor.x+x*anchor.width},${anchor.y+y*anchor.height}`).join(' ') }] : []
}))
function measure() {
  if (!props.host) return
  const bounds = props.host.getBoundingClientRect(), anchors = {}
  for (const node of props.host.querySelectorAll('[data-annotation-id]')) {
    const rect = node.getBoundingClientRect()
    if (rect.width && rect.height) anchors[node.dataset.annotationId] = { x: rect.left-bounds.left, y: rect.top-bounds.top, width: rect.width, height: rect.height }
  }
  anchors[PAPER_ANCHOR]={x:0,y:0,width:Math.max(1,bounds.width),height:Math.max(1,bounds.height)}
  geometry.value = { width: Math.max(1,bounds.width), height: Math.max(1,bounds.height), anchors }
}
function queueMeasure() { if (!frame) frame = requestAnimationFrame(() => { frame = null; measure() }) }
watch(() => props.host, async host => {
  observer?.disconnect(); mutationObserver?.disconnect()
  await nextTick()
  if (!host || !alive) return
  if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(queueMeasure); observer.observe(host) }
  mutationObserver = new MutationObserver(changes => { if (changes.some(change => !change.target.closest?.('.drawing-layer'))) queueMeasure() })
  mutationObserver.observe(host, { childList: true, characterData:true, subtree: true, attributes: true, attributeFilter: ['data-annotation-id','style','colwidth'] })
  measure()
}, { immediate: true })
watch(() => props.active, active => { if (!active) finish(); queueMeasure() })
function locate(event) {
  const bounds=props.host.getBoundingClientRect(),x=event.clientX-bounds.left,y=event.clientY-bounds.top
  if(x<0 || y<0 || x>bounds.width || y>bounds.height)return null
  return {id:PAPER_ANCHOR,point:[x/Math.max(1,bounds.width),y/Math.max(1,bounds.height)].map(n=>Math.round(n*10000)/10000),x,y}
}
function startStroke(position) {
  if (localStrokes.length >= 150) { emit('error','This reviewer has many drawings. Remove a few before adding more.'); return }
  current.value = { id: crypto.randomUUID(), anchor: position.id, color: props.color, width: props.width, points: [position.point,position.point] }
}
function eraseAt(event) {
  const position=locate(event)
  if(!position){lastErase=null;return}
  const previous=lastErase || {x:event.clientX,y:event.clientY}
  const steps=Math.max(1,Math.min(500,Math.ceil(Math.hypot(event.clientX-previous.x,event.clientY-previous.y)/6)))
  const bounds=props.host.getBoundingClientRect(),removed=new Set()
  for(let i=1;i<=steps;i++){
    const x=previous.x+(event.clientX-previous.x)*i/steps,y=previous.y+(event.clientY-previous.y)*i/steps
    for(const stroke of localStrokes){
      const rect=geometry.value.anchors[stroke.anchor];if(!rect || removed.has(stroke.id))continue
      const points=stroke.points.map(([px,py])=>[rect.x+px*rect.width,rect.y+py*rect.height])
      if(points.some((point,j)=>j && distanceToSegment([x-bounds.left,y-bounds.top],points[j-1],point)<=7+stroke.width/2))removed.add(stroke.id)
    }
    emit('erase',{x,y})
  }
  if(removed.size){localStrokes=localStrokes.filter(stroke=>!removed.has(stroke.id));emit('update:modelValue',localStrokes)}
  lastErase={x:event.clientX,y:event.clientY}
}
function down(event) {
  if (!props.active || event.button !== 0 || pointerId!==null) return
  measure();const position=locate(event);if(!position)return
  event.preventDefault();pointerId=event.pointerId;surface.value.setPointerCapture?.(pointerId)
  if(props.mode==='erase')eraseAt(event)
  else startStroke(position)
}
function move(event) {
  if(event.pointerId!==pointerId)return
  if(props.mode==='erase'){eraseAt(event);return}
  const coalesced=event.getCoalescedEvents?.()
  const samples=coalesced?.length?coalesced:[event]
  for(const sample of samples){
    const position=locate(sample)
    if(!position){commit();continue} // Never connect across another UI element.
    if(!current.value){startStroke(position);continue}
    if(current.value.points.length>=500){const last=current.value.points.at(-1);commit();startStroke({...position,point:last})}
    current.value?.points.push(position.point)
  }
}
function commit() {
  if (!current.value) return
  localStrokes=cleanAnnotations([...localStrokes,current.value]);emit('update:modelValue',localStrokes);current.value=null
}
function finish() {commit();if(pointerId!==null && surface.value?.hasPointerCapture?.(pointerId))surface.value.releasePointerCapture(pointerId);pointerId=null;lastErase=null}
function up(event) {if(event.pointerId===pointerId)finish()}
window.addEventListener('resize',queueMeasure)
document.addEventListener('scroll',queueMeasure,true)
document.fonts?.ready.then(()=>{if(alive)queueMeasure()})
onBeforeUnmount(() => { alive = false; finish(); observer?.disconnect(); mutationObserver?.disconnect(); window.removeEventListener('resize',queueMeasure); document.removeEventListener('scroll',queueMeasure,true); if (frame) cancelAnimationFrame(frame) })
</script>
<template>
  <svg ref="surface" class="drawing-layer" :class="{ 'drawing-active': active, 'drawing-eraser': mode === 'erase' }" :viewBox="`0 0 ${geometry.width} ${geometry.height}`" preserveAspectRatio="none" aria-hidden="true" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @lostpointercapture="up">
    <polyline v-for="stroke in paths" :key="stroke.id" :data-stroke-id="stroke.id" :points="stroke.points" :stroke="stroke.color" :stroke-width="stroke.width" fill="none" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" pointer-events="none" />
  </svg>
</template>
