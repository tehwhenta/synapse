<script setup>
import { ref,computed,onMounted } from 'vue'
import { useWorkspaceStore } from '../stores/workspace'
import { useAuthStore } from '../stores/auth'
import Modal from './Modal.vue'
import Icon from './Icon.vue'
const props=defineProps({ target:Object,initialKind:{ type:String,default:'note' } })
const emit=defineEmits(['close','generated'])
const workspace=useWorkspaceStore(), kind=ref(props.initialKind), info=ref(null), loading=ref(true), busy=ref(false), error=ref('')
const auth=useAuthStore()
const workflow=ref('manual'), total=ref(15), tf=ref(5), mc=ref(5), identification=ref(5), topicId=ref('')
const labels={ note:'Reviewer',deck:'Flashcards',quiz:'Practice quiz' }, limits={ note:5,deck:10,quiz:5 }
const topic=computed(()=>info.value?.topics.find(t=>t.id===topicId.value))
const used=computed(()=>info.value?.usage[kind.value] || 0)
const valid=computed(()=>!auth.demo && info.value?.status==='ready' && used.value<limits[kind.value] && (kind.value==='note' || (workflow.value==='topic' ? !!topic.value : kind.value==='deck' || [tf.value,mc.value,identification.value].every(n=>Number.isInteger(n)&&n>=0&&n<=30) && tf.value+mc.value+identification.value===total.value)))
function setTotal(value) { total.value=Number(value); tf.value=Math.floor(total.value/3); mc.value=Math.floor(total.value/3); identification.value=total.value-tf.value-mc.value }
async function load() {
  loading.value=true; error.value=''
  try { info.value=await workspace.prepareGeneration(props.target); topicId.value=info.value.topics[0]?.id || '' }
  catch(e) { error.value=e.message } finally { loading.value=false }
}
async function generate() {
  if (!valid.value || busy.value) return
  busy.value=true; error.value=''
  const options=kind.value==='note' ? {} : workflow.value==='topic' ? { workflow:'topic',topic_id:topicId.value } : { workflow:'manual',total:total.value,true_false:tf.value,multiple_choice:mc.value,short_answer:identification.value }
  try { const id=await workspace.generateSet(info.value.id,kind.value,options); emit('generated',await workspace.readAsset(id)) }
  catch(e) { error.value=e.message }
  finally { if(info.value) { try { info.value=await workspace.materialInfo(info.value.id) } catch {} }; busy.value=false }
}
onMounted(load)
</script>
<template>
  <Modal title="Make your next study set" wide @close="!busy && !loading && emit('close')">
    <div class="generation-dialog">
      <p v-if="error" class="error-box" role="alert">{{ error }}</p>
      <div v-if="loading" class="generation-loading" role="status"><Icon name="LoaderCircle" class="spin" /><p>Finding the topics in your material…</p></div>
      <template v-else-if="info">
        <p v-if="auth.demo" class="source-notice">These are sample topics for the preview. Connect your Supabase project to scan your own material and generate real sets. Custom flashcards work here without AI.</p>
        <p class="generation-source"><span class="eyebrow">YOUR SOURCE</span><strong>{{ info.title }}</strong></p>
        <div class="generation-kinds" role="group" aria-label="Study set type">
          <button v-for="(label,key) in labels" :key="key" :aria-pressed="kind===key" :disabled="busy" @click="kind=key"><Icon :name="key==='note'?'FileText':key==='deck'?'Layers':'CheckCheck'" :size="18" /><strong>{{ label }}</strong><small>{{ info.usage[key] || 0 }} / {{ limits[key] }} attempts</small></button>
        </div>
        <p v-if="used>=limits[kind]" class="source-notice" role="status">You’ve used all {{ limits[kind] }} {{ labels[kind].toLowerCase() }} attempts for this material. Your saved sets are still available. You can edit them or make custom flashcards.</p>
        <form class="stack-form" @submit.prevent="generate">
          <p v-if="kind==='note'" class="muted">A complete reviewer with definitions, detailed concepts, enumerations, comparisons, and worked solutions where relevant. Each new set uses a different study emphasis.</p>
          <template v-else>
            <div class="generation-workflows" role="group" aria-label="Generation workflow"><button type="button" :aria-pressed="workflow==='manual'" :disabled="busy" @click="workflow='manual'">Choose item counts</button><button type="button" :aria-pressed="workflow==='topic'" :disabled="busy" @click="workflow='topic'">Focus on a topic</button></div>
            <template v-if="workflow==='manual'">
              <label>Total {{ kind==='deck'?'flashcards':'questions' }}<select :value="total" :disabled="busy" @change="setTotal($event.target.value)"><option v-for="n in [10,15,20,30]" :key="n" :value="n">{{ n }} items</option></select></label>
              <template v-if="kind==='quiz'"><div class="question-quantities"><label>True / False<input v-model.number="tf" aria-label="True/False quantity" type="number" min="0" max="30" step="1" :disabled="busy" /></label><label>Multiple Choice<input v-model.number="mc" aria-label="Multiple Choice quantity" type="number" min="0" max="30" step="1" :disabled="busy" /></label><label>Identification<input v-model.number="identification" aria-label="Identification quantity" type="number" min="0" max="30" step="1" :disabled="busy" /></label></div><p class="tiny" :class="tf+mc+identification===total?'muted':'error-text'" aria-live="polite">{{ tf+mc+identification }} of {{ total }} questions assigned. Quantities must add up to {{ total }}.</p></template>
            </template>
            <template v-else>
              <p class="tiny muted">Topics found in your source. The item count follows the topic’s depth.</p>
              <div class="topic-list" role="group" aria-label="Extracted topics"><button v-for="item in info.topics" :key="item.id" type="button" :aria-pressed="topicId===item.id" :disabled="busy" @click="topicId=item.id"><span><strong>{{ item.title }}</strong><small>{{ item.description }}</small></span><span class="pill">{{ kind==='deck'?item.card_count:item.quiz_count }} items</span></button></div>
              <p v-if="kind==='quiz'&&topic" class="tiny muted">Exactly {{ topic.quiz_count/3 }} True/False, {{ topic.quiz_count/3 }} Multiple Choice, and {{ topic.quiz_count/3 }} Identification questions.</p>
            </template>
          </template>
          <p class="tiny muted generation-retention">Earlier sets stay saved. Limits include the first generation and AI requests that fail after starting. A scan also uses your daily AI allowance. The server checks for repeated questions; a small source may run out of fresh items before its attempt limit.</p>
          <button class="button primary full" :disabled="busy || !valid || workspace.uploading"><Icon :name="busy?'LoaderCircle':'Sparkles'" :class="{spin:busy}" :size="17" />{{ busy?'Completing the ideas…':'Generate '+labels[kind].toLowerCase() }}</button>
        </form>
      </template>
      <div v-else class="inline-actions"><button v-if="!loading" class="button secondary" @click="load">Try again</button><button class="button ghost" :disabled="loading" @click="emit('close')">Close</button></div>
    </div>
  </Modal>
</template>
