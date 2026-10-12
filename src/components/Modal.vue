<script setup>
import { onMounted, onBeforeUnmount, ref, computed } from 'vue'
import Icon from './Icon.vue'
const props = defineProps({ title: String, wide: Boolean, resizable: Boolean })
const emit = defineEmits(['close'])
const box = ref(null), maximized = ref(false), dimensions = ref(null), viewport = ref({ width:window.innerWidth,height:window.innerHeight })
let previous, previousOverflow, drag
const edges = ['left','right','top','bottom','top-left','top-right','bottom-left','bottom-right']
const frameStyle = computed(() => maximized.value ? { width:`${viewport.value.width-24}px`,height:`${viewport.value.height-24}px` } : dimensions.value ? { width:`${dimensions.value.width}px`,height:`${dimensions.value.height}px` } : {})
function bounded(width,height) { const maxWidth=Math.max(1,viewport.value.width-24),maxHeight=Math.max(1,viewport.value.height-24); return {width:Math.min(maxWidth,Math.max(Math.min(420,maxWidth),width)),height:Math.min(maxHeight,Math.max(Math.min(240,maxHeight),height))} }
function resized(event) {
  if (!drag || event.pointerId !== drag.pointer) return
  dimensions.value = bounded(drag.width+(event.clientX-drag.x)*(drag.edge.includes('left') ? -2 : drag.edge.includes('right') ? 2 : 0),drag.height+(event.clientY-drag.y)*(drag.edge.includes('top') ? -2 : drag.edge.includes('bottom') ? 2 : 0))
}
function stopResize() { drag=null; window.removeEventListener('pointermove',resized); window.removeEventListener('pointerup',stopResize); window.removeEventListener('pointercancel',stopResize) }
function beginResize(event,edge) {
  if (event.button!==0 || maximized.value) return
  const rect=box.value.getBoundingClientRect()
  drag={pointer:event.pointerId,edge,x:event.clientX,y:event.clientY,width:rect.width,height:rect.height}
  window.addEventListener('pointermove',resized); window.addEventListener('pointerup',stopResize); window.addEventListener('pointercancel',stopResize)
}
function keyResize(event,edge) {
  if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return
  event.preventDefault(); const rect=box.value.getBoundingClientRect(),step=event.shiftKey ? 48 : 24
  const horizontal=edge.includes('left') || edge.includes('right'),vertical=edge.includes('top') || edge.includes('bottom')
  dimensions.value=bounded(rect.width+(horizontal ? event.key==='ArrowRight' ? step : event.key==='ArrowLeft' ? -step : 0 : 0),rect.height+(vertical ? event.key==='ArrowDown' ? step : event.key==='ArrowUp' ? -step : 0 : 0))
}
function resizeViewport() { viewport.value={width:window.innerWidth,height:window.innerHeight}; if(dimensions.value)dimensions.value=bounded(dimensions.value.width,dimensions.value.height) }
function handleKey(e) {
  if (e.key === 'Escape') emit('close')
  if (e.key !== 'Tab') return
  const elements = [...box.value.querySelectorAll('button,input,select,textarea,a[href],summary,[contenteditable="true"],[tabindex="0"]')].filter(el => !el.disabled && el.offsetParent !== null)
  const first = elements[0], last = elements.at(-1)
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
}
onMounted(() => { previous = document.activeElement; previousOverflow=document.body.style.overflow; document.addEventListener('keydown', handleKey); window.addEventListener('resize',resizeViewport); document.body.style.overflow = 'hidden'; box.value.focus() })
onBeforeUnmount(() => { stopResize(); document.removeEventListener('keydown', handleKey); window.removeEventListener('resize',resizeViewport); document.body.style.overflow = previousOverflow; previous?.focus() })
</script>
<template>
  <Teleport to="body"><div class="modal-backdrop" @click.self="emit('close')"><section ref="box" class="modal-frame" :class="{ 'modal-frame-wide': wide,'modal-maximized':maximized }" :style="frameStyle" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
    <div class="modal" :class="{ 'modal-wide': wide }"><div class="modal-head"><h2>{{ title }}</h2><div class="inline-actions"><button v-if="resizable" class="icon-button" :aria-label="maximized ? 'Restore window' : 'Maximize window'" :title="maximized ? 'Restore window' : 'Maximize window'" :aria-pressed="maximized" @click="maximized = !maximized"><Icon :name="maximized ? 'Minimize2' : 'Maximize2'" /></button><button class="icon-button" aria-label="Close dialog" @click="emit('close')"><Icon name="X" /></button></div></div>
    <slot /></div>
    <template v-if="resizable && !maximized"><button v-for="edge in edges" :key="edge" type="button" class="resize-edge" :class="'resize-'+edge" :aria-label="'Resize from '+edge+' edge'" title="Drag to resize, or use arrow keys while focused" @pointerdown.prevent="beginResize($event,edge)" @keydown="keyResize($event,edge)"><span v-if="!edge.includes('-')"><Icon :name="edge === 'left' || edge === 'right' ? 'ArrowLeftRight' : 'ArrowUpDown'" :size="15" /></span></button></template>
  </section></div></Teleport>
</template>
