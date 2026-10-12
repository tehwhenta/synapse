<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { useWorkspaceStore } from '../stores/workspace'
import Icon from './Icon.vue'
import SeedBalance from './SeedBalance.vue'
const workspace = useWorkspaceStore()
const durationMinutes = ref(25), seconds = ref(25 * 60), running = ref(false), sessionSeconds = ref(0), error = ref(''), done = ref(false)
const wheelDirection = ref('up'), wheelActive = ref(false)
let wheelIdle
let deadline = 0, activeStart = 0, interval = null, sessionFolder = null, wheelDelta = 0, lastWheelAt = 0
const display = computed(() => `${String(Math.floor(seconds.value / 60)).padStart(2, '0')}:${String(seconds.value % 60).padStart(2, '0')}`)
const timerHint = computed(() => running.value ? 'Pause to adjust the time.' : 'Scroll up to add a minute, or down to subtract a minute. You can also use the arrow keys.')
function setMinutes(value) {
  if (running.value) return
  const current=Math.ceil(seconds.value/60)
  wheelDirection.value=value>=current?'up':'down'
  wheelActive.value=true;clearTimeout(wheelIdle);wheelIdle=setTimeout(()=>{wheelActive.value=false},550)
  durationMinutes.value = Math.min(180, Math.max(1, value))
  seconds.value = durationMinutes.value * 60
  done.value = false
}
const wheelMinutes=computed(()=>Math.ceil(seconds.value/60))
const previousMinute=computed(()=>wheelMinutes.value>1 ? String(wheelMinutes.value-1).padStart(2,'0')+':00' : '')
const nextMinute=computed(()=>wheelMinutes.value<180 ? String(wheelMinutes.value+1).padStart(2,'0')+':00' : '')
function adjustMinutes(change) { setMinutes((done.value ? durationMinutes.value : Math.ceil(seconds.value / 60)) + change) }
function scrollTime(event) {
  if (running.value || event.ctrlKey || event.metaKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
  event.preventDefault()
  const delta = event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 120 : 1)
  const now = Date.now()
  if (now - lastWheelAt > 250 || Math.sign(wheelDelta) !== Math.sign(delta)) wheelDelta = 0
  lastWheelAt = now
  wheelDelta += delta
  if (Math.abs(wheelDelta) >= 40) { adjustMinutes(-Math.sign(wheelDelta)); wheelDelta = 0 }
}
function keyTime(event) {
  if (running.value || event.ctrlKey || event.metaKey || event.altKey) return
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') setMinutes(1)
  else if (event.key === 'End') setMinutes(180)
  else adjustMinutes(event.key === 'ArrowUp' ? 1 : -1)
}
function elapsed() { if (activeStart) { sessionSeconds.value += Math.max(0, Math.round((Date.now() - activeStart) / 1000)); activeStart = 0 } }
async function save() { if (sessionSeconds.value >= 30) { const value = sessionSeconds.value; sessionSeconds.value = 0; try { await workspace.logSession(value, sessionFolder) } catch (e) { error.value = e.message } } }
function pause() { if (!running.value) return; seconds.value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)); running.value = false; clearInterval(interval); elapsed() }
async function finish() { pause(); seconds.value = 0; done.value = true; await save() }
function start() {
  if (!workspace.selectedFolderId) { error.value = 'Select a study folder first.'; return }
  if (!seconds.value) { seconds.value = durationMinutes.value * 60; done.value = false }
  sessionFolder ||= workspace.selectedFolderId
  deadline = Date.now() + seconds.value * 1000; activeStart = Date.now(); running.value = true
  interval = setInterval(() => { seconds.value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)); if (!seconds.value) finish() }, 250)
}
async function reset() { pause(); await save(); sessionFolder = null; seconds.value = durationMinutes.value * 60; done.value = false; wheelDelta = 0 }
defineExpose({ finishSession: reset })
onBeforeUnmount(() => { clearTimeout(wheelIdle);pause(); void save() })
</script>
<template><section id="focus-timer" class="focus-card"><div class="rail-title"><span><Icon name="Headphones" /> A moment to focus</span><span class="tiny">{{ durationMinutes }} MIN</span></div><div class="timer-wheel" :class="{ 'wheel-active':wheelActive,'wheel-readonly':running || done }" @wheel="scrollTime"><span class="time-wheel-neighbor time-wheel-previous" aria-hidden="true">{{ previousMinute }}</span><p class="timer-display" role="spinbutton" tabindex="0" aria-label="Focus timer, adjust in minutes" aria-live="off" :aria-valuenow="seconds" :aria-valuetext="display" :aria-valuemin="0" :aria-valuemax="180 * 60" :aria-readonly="running" :title="timerHint" @keydown="keyTime" @mouseleave="wheelDelta = 0"><Transition :name="running ? 'timer-static' : 'time-wheel-'+wheelDirection"><span :key="running ? 'countdown' : display" class="time-wheel-value">{{ display }}</span></Transition></p><span class="time-wheel-neighbor time-wheel-next" aria-hidden="true">{{ nextMinute }}</span></div><p class="tiny muted">{{ done ? 'One good session. Nice work.' : 'One task. A little less noise.' }}</p><div class="timer-minute-controls"><button class="icon-button" aria-label="Subtract one focus minute" :disabled="running || seconds <= 60" @click="adjustMinutes(-1)"><Icon name="Minus" :size="18" /></button><span class="tiny muted">Adjust minutes</span><button class="icon-button" aria-label="Add one focus minute" :disabled="running || seconds >= 10800" @click="adjustMinutes(1)"><Icon name="Plus" :size="18" /></button></div><div class="timer-actions"><button class="button primary" :disabled="!workspace.selectedFolderId" @click="running ? pause() : start()"><Icon :name="running ? 'Pause' : 'Play'" :size="15" />{{ running ? 'Pause' : done ? 'Start again' : 'Start focus' }}</button><button class="icon-button" aria-label="Finish or reset focus session" @click="reset"><Icon name="RotateCcw" :size="17" /></button></div><SeedBalance/><p v-if="error" class="tiny error-text">{{ error }}</p></section></template>
