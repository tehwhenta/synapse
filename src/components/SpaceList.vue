<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
const props=defineProps({ spaces:{type:Array,default:()=>[]},selectedId:String,userId:String })
const emit=defineEmits(['select','create'])
const scrollport=ref(null),scrolling=ref(false)
const overflowing=computed(()=>props.spaces.length>3)
let target=null,settleTimer
function finishScroll() { clearTimeout(settleTimer);settleTimer=setTimeout(()=>{target=null;scrolling.value=false},220) }
function scrollWheel(event) {
  const el=scrollport.value
  if (!el || event.ctrlKey || event.metaKey || !event.deltaY || Math.abs(event.deltaX)>Math.abs(event.deltaY) || el.scrollHeight<=el.clientHeight) return
  event.preventDefault()
  const delta=event.deltaY*(event.deltaMode===1?20:event.deltaMode===2?el.clientHeight:1)
  target=Math.max(0,Math.min(el.scrollHeight-el.clientHeight,(target??el.scrollTop)+delta))
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollTo({top:target,behavior:reduced?'instant':'smooth'})
  scrolling.value=true;finishScroll()
}
function select(space) { emit('select',space.id) }
watch([()=>props.selectedId,()=>props.spaces.length],async()=>{
  target=null;await nextTick()
  const el=scrollport.value,selected=el?.querySelector('[aria-current="page"]')
  if (!selected || !el.clientHeight) return
  const top=selected.offsetTop,bottom=top+selected.offsetHeight
  const destination=top<el.scrollTop ? top : bottom>el.scrollTop+el.clientHeight ? bottom-el.clientHeight : el.scrollTop
  if (destination!==el.scrollTop) el.scrollTo({top:destination,behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'})
})
onBeforeUnmount(()=>clearTimeout(settleTimer))
</script>
<template>
  <div class="folder-list" :class="{ 'spaces-overflow':overflowing,'spaces-scrolling':scrolling }">
    <div ref="scrollport" class="spaces-scrollport" :class="{ 'has-overflow':overflowing }" role="region" aria-label="Your spaces" :tabindex="overflowing?0:undefined" @wheel="scrollWheel" @scroll.passive="finishScroll" @touchstart.passive="target=null">
      <TransitionGroup name="space-row" tag="div" class="spaces-scroll-content">
        <button v-for="space in spaces" :key="space.id" class="folder-button" :class="{active:selectedId===space.id}" :title="space.title" :aria-current="selectedId===space.id?'page':undefined" @click="select(space)"><span class="folder-color" :style="{backgroundColor:space.color}"></span><span>{{ space.title }}</span><Icon v-if="space.owner_id!==userId" name="Users" :size="14" /></button>
      </TransitionGroup>
    </div>
    <button class="add-folder" @click="emit('create')"><Icon name="Plus" :size="16" />Create a new space</button>
  </div>
</template>
