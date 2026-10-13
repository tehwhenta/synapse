<script setup>
import { computed } from 'vue'
const props=defineProps({task:{type:Object,required:true}})
const completed=computed(()=>new Set(props.task.completed_kinds || []).size)
const isUpload=computed(()=>!!props.task.document_id)
const percent=computed(()=>props.task.status==='completed'?100:isUpload.value?Math.min(99,Math.floor(completed.value*100/3)):null)
const label=computed(()=>props.task.status==='completed'?'Ready':isUpload.value?`${completed.value} of 3 study sets saved`:'Preparing your new set')
const resumeTime=computed(()=>props.task.status==='paused' && props.task.auto_resume_at?new Date(props.task.auto_resume_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'')
</script>
<template>
 <div class="generation-progress" :class="{'generation-progress-waiting':task.status==='paused'}">
  <div class="generation-progress-label"><span>{{ label }}</span><span v-if="percent !== null">{{ percent }}%</span></div>
  <progress v-if="percent !== null" :value="percent" max="100" :aria-label="label"></progress>
  <progress v-else max="100" :aria-label="label"></progress>
  <p v-if="resumeTime" class="tiny muted">Continues automatically around {{ resumeTime }}. You can keep studying.</p>
 </div>
</template>
