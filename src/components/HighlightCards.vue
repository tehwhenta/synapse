<script setup>
import {ref,computed,watch} from 'vue'
import {reviewerHighlights} from '../lib/studyTools'
import {useStudyTool} from '../lib/useStudyTool'
import {useAuthStore} from '../stores/auth'
import GenerationProgress from './GenerationProgress.vue'
import Icon from './Icon.vue'
const props=defineProps({asset:Object,selection:{type:String,default:''},content:String,format:String})
const emit=defineEmits(['close']),auth=useAuthStore()
const excerpts=computed(()=>props.selection?[{id:'selection',text:props.selection}]:reviewerHighlights(props.content || props.asset.content,props.format || props.asset.content_format))
const selected=ref([])
const {output,task,busy,error,connection,generate,clear}=useStudyTool(()=>props.asset,'highlights')
const cards=computed(()=>(output.value?.cards || []).map(card=>({...card,id:card.highlight_id})))
async function prepare(){await generate(selected.value)}
watch(()=>[props.asset.id,props.asset.content,props.asset.content_format,props.selection],()=>{selected.value=excerpts.value.slice(0,20).map(h=>h.text);if(selected.value.length)void prepare();else clear()}, {immediate:true})
</script>
<template>
 <section class="highlight-cards study-tool-panel">
  <div class="study-tool-heading"><h3>Flashcards from Highlights</h3><div class="inline-actions"><span v-if="auth.demo" class="pill tiny" title="Authored example; connect Supabase for Gemini generation.">Sample</span><button type="button" class="icon-button" aria-label="Close highlight cards" title="Back" @click.stop.prevent="emit('close')"><Icon name="X" /></button></div></div>
  <GenerationProgress v-if="busy && task" :task="task" />
  <p v-else-if="busy" class="tool-empty muted" role="status"><Icon name="LoaderCircle" class="spin" /> Preparing flashcards…</p>
  <p v-if="connection" class="tiny muted" role="status">{{ connection }}</p>
  <p v-if="error" class="error-box" role="alert">{{ error }}</p>
  <p v-if="!excerpts.length" class="tool-empty muted">Highlight a passage first.</p>
  <details v-if="excerpts.length" class="tool-source-picker"><summary>Highlights <span class="tiny muted">{{ selected.length }}/20</span></summary><div><label v-for="excerpt in excerpts" :key="excerpt.id"><input v-model="selected" type="checkbox" :value="excerpt.text" :disabled="busy || !selected.includes(excerpt.text) && selected.length>=20" /><span>{{ excerpt.text }}</span></label><button type="button" class="icon-button primary-action" aria-label="Generate flashcards from selected highlights" title="Generate" :disabled="busy || !selected.length" @click.stop.prevent="prepare"><Icon name="Sparkles" /></button></div></details>
  <div v-if="cards.length && !busy">
   <section v-for="(card,index) in cards" :key="card.id" class="highlight-card-row">
    <span class="tiny muted">{{ index+1 }}</span>
    <p>{{ card.front }}</p><p>{{ card.back }}</p>
    <details class="tool-evidence"><summary>Source</summary><blockquote>{{ card.evidence.quote }}</blockquote></details>
   </section>
  </div>
 </section>
</template>
