<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { useWorkspaceStore } from '../stores/workspace'
import Icon from './Icon.vue'
const workspace = useWorkspaceStore()
const durationMinutes = ref(25), seconds = ref(25 * 60), running = ref(false), sessionSeconds = ref(0), error = ref(''), done = ref(false)
let deadline = 0, activeStart = 0, interval = null, sessionFolder = null, wheelDelta = 0, lastWheelAt = 0
const display = computed(() => `${String(Math.floor(seconds.value / 60)).padStart(2, '0')}:${String(seconds.value % 60).padStart(2, '0')}`)
const timerHint = computed(() => running.value ? 'Pause to adjust the time.' : 'Scroll up to add a minute, or down to subtract a minute. You can also use the arrow keys.')
function setMinutes(value) {
  if (running.value) return
  durationMinutes.value = Math.min(180, Math.max(1, value))
  seconds.value = durationMinutes.value * 60
  done.value = false
}
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
onBeforeUnmount(() => { pause(); void save() })
</script>
<template><section class="focus-card"><div class="rail-title"><span><Icon name="Headphones" /> A moment to focus</span><span class="tiny">{{ durationMinutes }} MIN</span></div><p class="timer-display" role="spinbutton" tabindex="0" aria-label="Focus timer, adjust in minutes" aria-live="off" :aria-valuenow="seconds" :aria-valuetext="display" :aria-valuemin="0" :aria-valuemax="180 * 60" :aria-readonly="running" :title="timerHint" @wheel="scrollTime" @keydown="keyTime" @mouseleave="wheelDelta = 0">{{ display }}</p><p class="tiny muted">{{ done ? 'One good session. Nice work.' : 'One task. A little less noise.' }}</p><div class="timer-actions"><button class="button primary" :disabled="!workspace.selectedFolderId" @click="running ? pause() : start()"><Icon :name="running ? 'Pause' : 'Play'" :size="15" />{{ running ? 'Pause' : done ? 'Start again' : 'Start focus' }}</button><button class="icon-button" aria-label="Finish or reset focus session" @click="reset"><Icon name="RotateCcw" :size="17" /></button></div><p v-if="error" class="tiny error-text">{{ error }}</p></section></template>
