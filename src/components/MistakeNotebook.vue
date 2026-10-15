<script setup>
import {ref,watch,onMounted,onBeforeUnmount} from 'vue'
import {useLearningStore} from '../stores/learning'
import {renderStudyHtml} from '../lib/studyRendering'
import {quizResult} from '../lib/utils'
import Icon from './Icon.vue'
const emit=defineEmits(['open']),learning=useLearningStore()
const mastered=ref(false),opened=ref(null),response=ref(''),feedback=ref(null),error=ref(''),busy=ref(false)
let alive=true
async function load(append=false){error.value='';try{await learning.load(mastered.value,append)}catch(e){if(alive)error.value=e.message}}
function toggle(item){opened.value=opened.value===item.id?null:item.id;response.value='';feedback.value=null}
function check(item){feedback.value=quizResult([{answer:item.answer,accepted_answers:item.accepted_answers || [],explanation:item.explanation}], [response.value]).feedback[0]}
async function action(item,remove=false){busy.value=true;error.value='';try{if(remove)await learning.remove(item);else await learning.setMastered(item,!mastered.value);opened.value=null}catch(e){error.value=e.message}finally{busy.value=false}}
watch(mastered,()=>{opened.value=null;void load()})
watch(()=>learning.revision,()=>{if(alive)void load()})
onMounted(()=>load());onBeforeUnmount(()=>{alive=false})
</script>
<template>
 <section class="mistake-notebook" aria-label="Mistake notebook">
  <div class="study-tool-heading"><h2>Mistake Notebook</h2><div class="inline-actions"><button class="icon-button" :aria-label="mastered?'Show unresolved mistakes':'Show mastered mistakes'" :title="mastered?'Unresolved':'Mastered'" :aria-pressed="mastered" @click="mastered=!mastered"><Icon :name="mastered?'BookOpen':'CheckCheck'" /></button><button class="icon-button" aria-label="Refresh mistake notebook" title="Refresh" :disabled="learning.loading" @click="load()"><Icon name="RefreshCw" /></button></div></div>
  <p v-if="error" class="error-box" role="alert">{{ error }}</p>
  <div v-if="learning.loading && !learning.mistakes.length" class="tool-empty" role="status"><Icon name="LoaderCircle" class="spin" /></div>
  <p v-else-if="!learning.mistakes.length" class="tool-empty muted">{{ mastered?'No mastered mistakes yet.':'No mistakes to revisit.' }}</p>
  <article v-for="item in learning.mistakes" :key="item.id" class="mistake-entry">
   <div class="mistake-entry-head"><button class="mistake-question" :aria-expanded="opened===item.id" @click="toggle(item)"><span class="tiny muted">{{ item.source_title }}</span><span v-html="renderStudyHtml(item.question)"></span></button><div class="inline-actions"><button class="icon-button" :aria-label="mastered?'Mark as unresolved':'Mark as understood'" :title="mastered?'Revisit':'Understood'" :disabled="busy" @click="action(item)"><Icon :name="mastered?'RotateCcw':'Check'" :size="17" /></button><details class="compact-menu"><summary class="icon-button" aria-label="Mistake options" title="Options"><Icon name="MoreHorizontal" :size="17" /></summary><div><button v-if="item.asset_id" @click="emit('open',item.asset_id)"><Icon name="ArrowUpRight" :size="16" />Open quiz</button><button :disabled="busy" @click="action(item,true)"><Icon name="Trash2" :size="16" />Delete</button></div></details></div></div>
   <div v-if="opened===item.id" class="mistake-recall stack-form"><input v-model="response" aria-label="Recall the answer" placeholder="Recall the answer…" maxlength="1000" @keydown.enter="response.trim() && check(item)" /><div class="inline-actions"><button class="icon-button" aria-label="Check recalled answer" title="Check" :disabled="!response.trim()" @click="check(item)"><Icon name="CheckCheck" /></button></div><div v-if="feedback" class="quiz-feedback" :class="{'is-correct':feedback.correct}" role="status"><Icon :name="feedback.correct?'Check':'RotateCcw'" /><div v-html="renderStudyHtml(item.answer)"></div><div v-html="renderStudyHtml(item.explanation)"></div></div><details><summary>Answer</summary><div v-html="renderStudyHtml(item.answer)"></div><div class="muted" v-html="renderStudyHtml(item.explanation)"></div><p v-if="item.user_answer" class="tiny muted">Your answer: {{ item.user_answer }}</p></details></div>
  </article>
  <button v-if="learning.more" class="icon-button tool-more" aria-label="Load more mistakes" title="More" :disabled="learning.loading" @click="load(true)"><Icon name="ChevronDown" /></button>
 </section>
</template>
