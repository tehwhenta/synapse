<script setup>
import {ref,computed,watch} from 'vue'
import {reviewerHighlights} from '../lib/studyTools'
import {useStudyTool} from '../lib/useStudyTool'
import {useWorkspaceStore} from '../stores/workspace'
import {useAuthStore} from '../stores/auth'
import GenerationProgress from './GenerationProgress.vue'
import Icon from './Icon.vue'
const props=defineProps({asset:Object,selection:{type:String,default:''},content:String,format:String})
const emit=defineEmits(['close','saved']),workspace=useWorkspaceStore(),auth=useAuthStore()
const title=ref((props.asset.title+' · Highlights').slice(0,150)),deckId=ref(''),saving=ref(false),saveError=ref(''),cards=ref([])
const excerpts=computed(()=>props.selection?[{id:'selection',text:props.selection}]:reviewerHighlights(props.content || props.asset.content,props.format || props.asset.content_format))
const selected=ref([])
const {output,task,busy,error,context,connection,generate,clear}=useStudyTool(()=>props.asset,'highlights')
const decks=computed(()=>workspace.assets.filter(a=>a.kind==='deck'&&a.is_custom&&a.created_by===auth.user?.id&&a.folder_id===props.asset.folder_id))
const included=computed(()=>cards.value.filter(c=>c.include))
watch(output,result=>{cards.value=(result?.cards || []).map(c=>({...c,id:c.highlight_id,include:true}))})
async function prepare(){saveError.value='';await generate(selected.value)}
watch(()=>[props.asset.id,props.asset.content,props.asset.content_format,props.selection],()=>{selected.value=excerpts.value.slice(0,20).map(h=>h.text);if(selected.value.length)void prepare();else clear()}, {immediate:true})
async function save(){saving.value=true;saveError.value='';try{const deck=await workspace.saveHighlightCards(props.asset,title.value,included.value,deckId.value || null,context.value);emit('saved',deck)}catch(e){saveError.value=e.message}finally{saving.value=false}}
</script>
<template>
 <section class="highlight-cards study-tool-panel">
  <div class="study-tool-heading"><h3>Flashcards from Highlights</h3><div class="inline-actions"><span v-if="auth.demo" class="pill tiny" title="Authored example; connect Supabase for Gemini generation.">Sample</span><button class="icon-button" aria-label="Close highlight cards" title="Back" :disabled="saving" @click="emit('close')"><Icon name="X" /></button></div></div>
  <GenerationProgress v-if="busy && task" :task="task" />
  <p v-else-if="busy" class="tool-empty muted" role="status"><Icon name="LoaderCircle" class="spin" /> Preparing flashcards…</p>
  <p v-if="connection" class="tiny muted" role="status">{{ connection }}</p>
  <p v-if="error || saveError" class="error-box" role="alert">{{ error || saveError }}</p>
  <p v-if="!excerpts.length" class="tool-empty muted">Highlight a passage first.</p>
  <details v-if="excerpts.length" class="tool-source-picker"><summary>Highlights <span class="tiny muted">{{ selected.length }}/20</span></summary><div><label v-for="excerpt in excerpts" :key="excerpt.id"><input v-model="selected" type="checkbox" :value="excerpt.text" :disabled="busy || saving || !selected.includes(excerpt.text) && selected.length>=20" /><span>{{ excerpt.text }}</span></label><button type="button" class="icon-button primary-action" aria-label="Generate flashcards from selected highlights" title="Generate" :disabled="busy || saving || !selected.length" @click="prepare"><Icon name="Sparkles" /></button></div></details>
  <form v-if="cards.length && !busy" class="stack-form" @submit.prevent="save">
   <select v-model="deckId" aria-label="Destination custom deck" :disabled="saving"><option value="">New custom deck</option><option v-for="deck in decks" :key="deck.id" :value="deck.id">{{ deck.title }}</option></select>
   <input v-if="!deckId" v-model="title" aria-label="Highlight deck title" placeholder="Deck title" maxlength="150" required :disabled="saving" />
   <section v-for="(card,index) in cards" :key="card.id" class="highlight-card-row" :class="{'card-excluded':!card.include}"><div class="custom-card-heading"><span class="tiny muted">{{ index+1 }}</span><button type="button" class="icon-button" :aria-label="(card.include?'Exclude':'Include')+' highlight '+(index+1)" :aria-pressed="card.include" :disabled="saving" @click="card.include=!card.include"><Icon :name="card.include?'Check':'Plus'" :size="16" /></button></div><div v-if="card.include" class="custom-card-fields"><textarea v-model="card.front" :aria-label="'Highlight question '+(index+1)" placeholder="Question" maxlength="1000" rows="2" :disabled="saving" required></textarea><textarea v-model="card.back" :aria-label="'Highlight answer '+(index+1)" placeholder="Answer" maxlength="2000" rows="3" :disabled="saving" required></textarea></div><details v-if="card.include" class="tool-evidence"><summary>Source</summary><blockquote>{{ card.evidence.quote }}</blockquote></details></section>
   <div class="inline-actions"><button class="icon-button primary-action" aria-label="Save highlight flashcards" title="Save" :disabled="saving || !included.length || (!deckId && !title.trim()) || included.some(c=>!c.front.trim() || !c.back.trim())"><Icon :name="saving?'LoaderCircle':'Check'" :class="{spin:saving}" /></button></div>
  </form>
 </section>
</template>
