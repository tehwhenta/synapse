<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { cleanAnnotations } from '../lib/annotations'
const props = defineProps({ modelValue: { type: Array, default: () => [] }, host: Object, active: Boolean, mode: { type: String, default: 'pen' }, color: { type: String, default: '#c2413a' }, width: { type: Number, default: 3 } })
const emit = defineEmits(['update:modelValue', 'error'])
const surface = ref(null), geometry = ref({ width: 1, height: 1, anchors: {} }), current = ref(null)
let observer, mutationObserver, frame, pointerId = null, alive = true
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
  geometry.value = { width: Math.max(1,bounds.width), height: Math.max(1,bounds.height), anchors }
}
function queueMeasure() { if (!frame) frame = requestAnimationFrame(() => { frame = null; measure() }) }
watch(() => props.host, async host => {
  observer?.disconnect(); mutationObserver?.disconnect()
  await nextTick()
  if (!host || !alive) return
  if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(queueMeasure); observer.observe(host) }
  mutationObserver = new MutationObserver(changes => { if (changes.some(change => !change.target.closest?.('.drawing-layer'))) queueMeasure() })
  mutationObserver.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-annotation-id'] })
  measure()
}, { immediate: true })
watch(() => props.active, active => { if (!active) commit(); queueMeasure() })
function locate(event) {
  const bounds = props.host.getBoundingClientRect(), x = event.clientX-bounds.left, y = event.clientY-bounds.top
  let chosen, distance = Infinity
  for (const [id,rect] of Object.entries(geometry.value.anchors)) {
    const dx = Math.max(rect.x-x, 0, x-rect.x-rect.width), dy = Math.max(rect.y-y, 0, y-rect.y-rect.height)
    const score = dx*dx+dy*dy
    if (score < distance) { distance = score; chosen = [id,rect] }
  }
  if (!chosen) return null
  const [id,rect] = chosen
  return { id, point: [Math.max(0,Math.min(1,(x-rect.x)/rect.width)), Math.max(0,Math.min(1,(y-rect.y)/rect.height))].map(n => Math.round(n*10000)/10000) }
}
function startStroke(position) {
  if (props.modelValue.length >= 150) { emit('error','This reviewer has many drawings. Remove a few before adding more.'); return }
  current.value = { id: crypto.randomUUID(), anchor: position.id, color: props.color, width: props.width, points: [position.point,position.point] }
}
function down(event) {
  if (!props.active || event.button !== 0) return
  event.preventDefault()
  if (props.mode === 'erase') {
    const id = event.target.dataset.strokeId
    if (id) emit('update:modelValue', cleanAnnotations(props.modelValue).filter(stroke => stroke.id !== id))
    return
  }
  measure(); const position = locate(event)
  if (!position) return
  pointerId = event.pointerId; surface.value.setPointerCapture?.(pointerId); startStroke(position)
}
function move(event) {
  if (!current.value || event.pointerId !== pointerId) return
  const position = locate(event)
  if (!position) return
  if (position.id !== current.value.anchor || current.value.points.length >= 500) { commit(); startStroke(position) }
  else current.value.points.push(position.point)
}
function commit() {
  if (!current.value) return
  emit('update:modelValue', cleanAnnotations([...props.modelValue,current.value])); current.value = null
}
function up(event) { if (event.pointerId !== pointerId) return; commit(); surface.value.releasePointerCapture?.(pointerId); pointerId = null }
window.addEventListener('resize',queueMeasure)
document.addEventListener('scroll',queueMeasure,true)
onBeforeUnmount(() => { alive = false; commit(); observer?.disconnect(); mutationObserver?.disconnect(); window.removeEventListener('resize',queueMeasure); document.removeEventListener('scroll',queueMeasure,true); if (frame) cancelAnimationFrame(frame) })
</script>
<template>
  <svg ref="surface" class="drawing-layer" :class="{ 'drawing-active': active, 'drawing-eraser': mode === 'erase' }" :viewBox="`0 0 ${geometry.width} ${geometry.height}`" preserveAspectRatio="none" aria-hidden="true" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up">
    <polyline v-for="stroke in paths" :key="stroke.id" :data-stroke-id="stroke.id" :points="stroke.points" :stroke="stroke.color" :stroke-width="stroke.width" fill="none" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" :pointer-events="active && mode === 'erase' ? 'stroke' : 'none'" />
  </svg>
</template>
