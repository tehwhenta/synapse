<script setup>
import {computed,ref,watch,useId} from 'vue'
import {useStudyTool} from '../lib/useStudyTool'
import {useAuthStore} from '../stores/auth'
import GenerationProgress from './GenerationProgress.vue'
import Icon from './Icon.vue'
import {renderStudyHtml} from '../lib/studyRendering'
const props=defineProps({asset:Object}),emit=defineEmits(['close']),auth=useAuthStore()
const {output,task,busy,error,connection:connectionStatus,generate}=useStudyTool(()=>props.asset,'connections')
const markerId='concept-arrow-'+useId()
const graph=computed(()=>output.value || {nodes:[],edges:[]})
const chosen=ref(null),search=ref(''),connection=ref(null)
const current=computed(()=>graph.value.nodes.find(n=>n.id===chosen.value) || graph.value.nodes[0])
const visible=computed(()=>graph.value.nodes.filter(n=>n.label.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())))
const neighbors=computed(()=>graph.value.edges.filter(e=>e.from===current.value?.id || e.to===current.value?.id).map(e=>({edge:e,node:graph.value.nodes.find(n=>n.id===(e.from===current.value.id?e.to:e.from)),label:e.label})).filter(e=>e.node))
const orbit=computed(()=>neighbors.value.slice(0,8).map((item,i,list)=>{
 const angle=2*Math.PI*i/list.length-Math.PI/2,x=300+205*Math.cos(angle),y=190+130*Math.sin(angle)
 const distance=Math.hypot(x-300,y-190),nx=(x-300)/distance,ny=(y-190)/distance
 const inset=Math.min(79/Math.abs(nx || 1e-10),29/Math.abs(ny || 1e-10)),near={x:300+nx*33,y:190+ny*33},far={x:x-nx*inset,y:y-ny*inset}
 return {...item,x,y,start:item.edge.from===current.value.id?near:far,end:item.edge.from===current.value.id?far:near}
}))
watch(()=>[props.asset.id,props.asset.content,props.asset.content_format],()=>{chosen.value=null;search.value='';connection.value=null;void generate()}, {immediate:true})
watch(current,()=>{connection.value=null})
</script>
<template>
 <section class="concept-connections study-tool-panel">
  <div class="study-tool-heading"><h3>Concept Connections</h3><div class="inline-actions"><span v-if="auth.demo" class="pill tiny" title="Authored example; connect Supabase for Gemini generation.">Sample</span><button class="icon-button" aria-label="Close concept connections" title="Back" @click="emit('close')"><Icon name="X" /></button></div></div>
  <GenerationProgress v-if="busy && task" :task="task" />
  <p v-else-if="busy" class="tool-empty muted" role="status"><Icon name="LoaderCircle" class="spin" /> Finding connections…</p>
  <p v-if="connectionStatus" class="tiny muted" role="status">{{ connectionStatus }}</p>
  <p v-if="error" class="error-box" role="alert">{{ error }}</p>
  <button v-if="error && !busy" class="icon-button" aria-label="Prepare concept connections" title="Generate" @click="generate()"><Icon name="RefreshCw" /></button>
  <div v-if="current && !busy" class="concept-layout"><div class="concept-index"><input v-model="search" type="search" aria-label="Search concepts" placeholder="Search concepts…" /><nav aria-label="Reviewer concepts"><button v-for="node in visible" :key="node.id" :aria-current="current?.id===node.id?'true':undefined" @click="chosen=node.id">{{ node.label }}</button></nav></div><div class="concept-detail"><svg class="concept-map" viewBox="0 0 600 380" role="group" aria-label="Concept relationships"><defs><marker :id="markerId" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs><g v-for="item in orbit" :key="item.edge.from+item.edge.to+item.label"><line :x1="item.start.x" :y1="item.start.y" :x2="item.end.x" :y2="item.end.y" :marker-end="`url(#${markerId})`" /><circle :cx="item.x" :cy="item.y" r="7" /></g><circle class="concept-center" cx="300" cy="190" r="28" /><text x="300" y="245" text-anchor="middle">{{ current.label.length>32?current.label.slice(0,29)+'…':current.label }}</text><foreignObject v-for="item in orbit" :key="'label-'+item.edge.from+item.edge.to+item.label" :x="item.x-73" :y="item.y-23" width="146" height="46"><button xmlns="http://www.w3.org/1999/xhtml" :aria-label="'Open concept '+item.node.label" @click="chosen=item.node.id">{{ item.node.label }}</button></foreignObject></svg><h4>{{ current.label }}</h4><div class="concept-definition" v-html="renderStudyHtml(current.body)"></div><details class="tool-evidence"><summary>Source</summary><blockquote>{{ current.evidence.quote }}</blockquote></details><div class="concept-links"><button v-for="item in neighbors" :key="item.edge.from+item.edge.to+item.label" :aria-label="'Explain '+graph.nodes.find(n=>n.id===item.edge.from)?.label+' '+item.label+' '+graph.nodes.find(n=>n.id===item.edge.to)?.label" @click="connection=item.edge"><span>{{ graph.nodes.find(n=>n.id===item.edge.from)?.label }} <Icon name="ArrowRight" :size="12" /> {{ graph.nodes.find(n=>n.id===item.edge.to)?.label }}</span><small>{{ item.label }}</small><Icon name="MessageCircle" :size="15" /></button></div><div v-if="connection" class="concept-explanation"><div v-html="renderStudyHtml(connection.explanation)"></div><details class="tool-evidence"><summary>Source</summary><blockquote>{{ connection.evidence.quote }}</blockquote></details><button class="icon-button" :aria-label="'Open connected concept '+graph.nodes.find(n=>n.id===(connection.from===current.id?connection.to:connection.from))?.label" title="Open concept" @click="chosen=connection.from===current.id?connection.to:connection.from"><Icon name="ArrowUpRight" :size="17" /></button></div></div></div>
 </section>
</template>
