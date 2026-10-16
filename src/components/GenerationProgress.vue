<script setup>
import { computed } from 'vue'
const props=defineProps({task:{type:Object,required:true}})
const completed=computed(()=>new Set(props.task.completed_kinds || []).size)
const isUpload=computed(()=>!!props.task.document_id)
const percent=computed(()=>props.task.status==='completed'?100:isUpload.value?Math.min(99,Math.floor(completed.value*100/3)):null)
const label=computed(()=>props.task.status==='completed'?'Ready':props.task.tool && props.task.tool_phase==='checking'?'Checking source support':props.task.tool==='connections'?'Finding concept connections':props.task.tool==='highlights'?'Preparing highlight flashcards':isUpload.value?`${completed.value} of 3 study sets saved`:'Preparing your new set')
const resumeTime=computed(()=>props.task.status==='paused' && props.task.auto_resume_at?new Date(props.task.auto_resume_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'')
</script>
<template>
 <div class="generation-progress" :class="{'generation-progress-waiting':task.status==='paused'}">
  <div class="generation-progress-label"><span>{{ label }}</span><span v-if="percent !== null">{{ percent }}%</span></div>
  <progress v-if="percent !== null" :value="percent" max="100" :aria-label="label"></progress>
  <progress v-else max="100" :aria-label="label"></progress>
  <p v-if="task.status==='processing' && task.stream_chars>0 && !(task.tool && task.tool_phase==='checking')" class="tiny muted generation-stream-status">Receiving {{ task.tool==='connections'?'connections':task.tool==='highlights'?'flashcards':{prepare:'source text',note:'reviewer',deck:'flashcards',quiz:'quiz'}[task.stage] || 'content' }} · {{ task.stream_chars.toLocaleString() }} characters received. Checking before saving.</p>
  <p v-if="resumeTime" class="tiny muted">Continues automatically around {{ resumeTime }}. You can keep studying.</p>
 </div>
</template>
