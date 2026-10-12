<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'
import { supabase } from '../lib/supabase'
import { timeAgo } from '../lib/utils'
import { livePresence, peopleInSpace, cameraQuality, presenceLabel, presencePublisher, PRESENCE_HEARTBEAT, AWAY_AFTER } from '../lib/lounge'
import Icon from './Icon.vue'
import Avatar from './Avatar.vue'
const auth = useAuthStore(), workspace = useWorkspaceStore()
const emit = defineEmits(['presence', 'connection', 'call'])
const peers = ref([]), active = ref(false), muted = ref(false), cameraOff = ref(false), sharing = ref(false), status = ref(''), error = ref(''), chat = ref(''), joining = ref(false)
const localVideo = ref(null), remoteVideos = new Map(), remoteAudio = new Map(), remoteStreams = shallowRef({}), connected = ref(false), chatBox = ref(null), videoPage = ref(0)
const clientId = crypto.randomUUID()
let channel, localStream, screenStream, heartbeat, publishPresence, connectionVersion = 0, sessionStart = Date.now(), lastInteraction = Date.now(), suspended = false
const selfAway = ref(false)
const onlineLabel = computed(() => connected.value ? presenceLabel(peers.value) : 'Disconnected')
const connections = new Map()
const otherPeers = computed(() => peers.value.filter(p => p.client_id !== clientId))
const callPeers = computed(() => otherPeers.value.filter(p => p.in_call))
const people = computed(() => peopleInSpace(peers.value).filter(p => p.user_id !== auth.user.id))
const participants = computed(() => [{ client_id: clientId, name: 'You', avatar_path: auth.profile?.avatar_path, self: true, muted: muted.value, camera_off: cameraOff.value, sharing: sharing.value }, ...callPeers.value].sort((a,b) => Number(!!b.sharing) - Number(!!a.sharing)))
const pages = computed(() => Math.max(1, Math.ceil(participants.value.length / 12)))
const visibleParticipants = computed(() => participants.value.slice(videoPage.value * 12, (videoPage.value + 1) * 12))
const roomMessages = computed(() => workspace.messages.filter(m => m.folder_id === workspace.selectedFolderId))
function videoRef(id, el) {
  if (id === clientId) { localVideo.value = el; if (el) el.srcObject = sharing.value ? screenStream : localStream }
  else if (el) { remoteVideos.set(id, el); if (remoteStreams.value[id]) el.srcObject = remoteStreams.value[id] }
  else remoteVideos.delete(id)
}
function audioRef(id, el) { if (el) { remoteAudio.set(id, el); if (remoteStreams.value[id]) el.srcObject = remoteStreams.value[id] } else remoteAudio.delete(id) }
async function track() {
  if (connected.value && publishPresence && !suspended && auth.user) {
    selfAway.value = !active.value && (document.visibilityState === 'hidden' || Date.now() - lastInteraction >= AWAY_AFTER)
    await publishPresence({ client_id: clientId, user_id: auth.user.id, name: auth.profile?.display_name || 'Student', avatar_path: auth.profile?.avatar_path || null, joined_at: new Date(sessionStart).toISOString(), last_seen_at: new Date().toISOString(), away: selfAway.value, in_call: active.value, muted: muted.value, camera_off: cameraOff.value, sharing: sharing.value })
  }
}
async function signal(to, payload) {
  if (!channel || !connected.value) throw new Error('The study room is reconnecting. Try again shortly.')
  const result = await channel.send({ type: 'broadcast', event: 'signal', payload: { from: clientId, to, ...payload } })
  if (result !== 'ok') throw new Error('Could not send call signaling. Check your connection.')
}
function syncPeers() {
  if (!channel) return
  if (!connected.value) return
  peers.value = livePresence(Object.values(channel.presenceState()).flat())
  emit('presence', peers.value)
  if (!active.value) return
  for (const peer of callPeers.value) if (!connections.has(peer.client_id)) createPeer(peer.client_id)
  for (const id of connections.keys()) if (!callPeers.value.some(p => p.client_id === id)) closePeer(id)
}
function closePeer(id) { const pc = connections.get(id)?.pc; if (pc) { pc.onicecandidate = null; pc.onnegotiationneeded = null; pc.onconnectionstatechange = null; pc.close() }; connections.delete(id); const streams = { ...remoteStreams.value }; delete streams[id]; remoteStreams.value = streams; remoteVideos.delete(id); remoteAudio.delete(id) }
async function optimizeConnections() {
  const quality = cameraQuality(callPeers.value.length + 1, sharing.value)
  await Promise.all([...connections.values()].map(async ({ pc }) => {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video')
    if (!sender) return
    try { const parameters = sender.getParameters(); if (!parameters.encodings?.length) parameters.encodings = [{}]; Object.assign(parameters.encodings[0], quality); await sender.setParameters(parameters) }
    catch { /* Some browsers do not support changing RTP encodings mid-call. */ }
  }))
}
function createPeer(id) {
  if (connections.has(id) || !localStream) return connections.get(id)
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]
  if (import.meta.env.VITE_TURN_URL) iceServers.push({ urls: import.meta.env.VITE_TURN_URL, username: import.meta.env.VITE_TURN_USERNAME, credential: import.meta.env.VITE_TURN_CREDENTIAL })
  const pc = new RTCPeerConnection({ iceServers })
  const state = { pc, makingOffer: false, ignoreOffer: false, settingAnswer: false, candidates: [], polite: clientId > id }
  connections.set(id, state)
  for (const track of localStream.getTracks()) {
    const replacement = sharing.value && track.kind === 'video' ? screenStream?.getVideoTracks()[0] : null
    pc.addTrack(replacement || track, localStream)
  }
  pc.onicecandidate = ({ candidate }) => { if (candidate) signal(id, { candidate: candidate.toJSON() }).catch(e => { error.value = e.message }) }
  pc.ontrack = async ({ streams }) => { if (streams[0]) { remoteStreams.value = { ...remoteStreams.value, [id]: streams[0] }; await nextTick(); const video = remoteVideos.get(id), audio = remoteAudio.get(id); if (video) video.srcObject = streams[0]; if (audio) audio.srcObject = streams[0] } }
  pc.onnegotiationneeded = async () => {
    try { state.makingOffer = true; await pc.setLocalDescription(); await signal(id, { description: pc.localDescription.toJSON() }) }
    catch (e) { error.value = e.message } finally { state.makingOffer = false }
  }
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') void optimizeConnections()
    if (pc.connectionState === 'failed') { error.value = 'Could not connect to a peer. A TURN relay may be needed on this network.'; pc.restartIce() }
  }
  return state
}
async function receiveSignal({ payload }) {
  if (!active.value || !payload || payload.to !== clientId || payload.from === clientId || !callPeers.value.some(p => p.client_id === payload.from)) return
  try {
    const state = createPeer(payload.from); if (!state) return
    const { pc } = state
    if (payload.description) {
      const description = payload.description
      if (!['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string' || description.sdp.length > 100000) return
      const ready = !state.makingOffer && (pc.signalingState === 'stable' || state.settingAnswer)
      const collision = description.type === 'offer' && !ready
      state.ignoreOffer = !state.polite && collision
      if (state.ignoreOffer) return
      state.settingAnswer = description.type === 'answer'
      await pc.setRemoteDescription(description); state.settingAnswer = false
      for (const candidate of state.candidates.splice(0)) await pc.addIceCandidate(candidate)
      if (description.type === 'offer') { await pc.setLocalDescription(); await signal(payload.from, { description: pc.localDescription.toJSON() }) }
    } else if (payload.candidate && !state.ignoreOffer) {
      if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate)
      else if (state.candidates.length < 100) state.candidates.push(payload.candidate)
    }
  } catch (e) { error.value = 'Call negotiation failed: ' + e.message }
}
async function join() {
  error.value = ''
  if (auth.demo) { error.value = 'Connect Supabase and invite a peer to start a real call.'; return }
  if (!connected.value) { error.value = 'Wait for the lounge to connect.'; return }
  if (!navigator.mediaDevices?.getUserMedia) { error.value = 'Calls require HTTPS or localhost and a supported browser.'; return }
  const version = connectionVersion
  joining.value = true
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 24 } }, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    if (version !== connectionVersion || !connected.value) { stream.getTracks().forEach(t => t.stop()); return }
    localStream = stream; videoPage.value = 0
    active.value = true; muted.value = false; cameraOff.value = false
    await nextTick(); if (localVideo.value) localVideo.value.srcObject = localStream
    await track(); syncPeers()
  } catch (e) { leaveCall(); error.value = e.name === 'NotAllowedError' ? 'Allow camera and microphone access to join the call.' : e.message }
  finally { joining.value = false }
}
function leaveCall() {
  active.value = false
  for (const id of [...connections.keys()]) closePeer(id)
  localStream?.getTracks().forEach(t => t.stop()); screenStream?.getTracks().forEach(t => t.stop()); localStream = null; screenStream = null; sharing.value = false; remoteStreams.value = {}
  void track().catch(() => {})
}
function toggleMute() { muted.value = !muted.value; localStream?.getAudioTracks().forEach(t => { t.enabled = !muted.value }); void track().catch(e => { error.value = e.message }) }
function toggleCamera() { cameraOff.value = !cameraOff.value; localStream?.getVideoTracks().forEach(t => { t.enabled = !cameraOff.value }); void track().catch(e => { error.value = e.message }) }
async function stopSharing() {
  const cameraTrack = localStream?.getVideoTracks()[0]
  await Promise.all([...connections.values()].map(({ pc }) => pc.getSenders().find(s => s.track?.kind === 'video')?.replaceTrack(cameraTrack || null)))
  screenStream?.getTracks().forEach(t => { t.onended = null; t.stop() }); screenStream = null; sharing.value = false
  if (localVideo.value) localVideo.value.srcObject = localStream
  await track(); await optimizeConnections()
}
async function shareScreen() {
  error.value = ''
  try {
    if (sharing.value) { await stopSharing(); return }
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen sharing is unavailable in this browser.')
    const version = connectionVersion
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    if (version !== connectionVersion || !active.value) { stream.getTracks().forEach(t => t.stop()); return }
    screenStream = stream
    const screenTrack = screenStream.getVideoTracks()[0]; screenTrack.onended = () => void stopSharing().catch(e => { error.value = e.message })
    await Promise.all([...connections.values()].map(({ pc }) => pc.getSenders().find(s => s.track?.kind === 'video')?.replaceTrack(screenTrack)))
    sharing.value = true; if (localVideo.value) localVideo.value.srcObject = screenStream
    videoPage.value = 0; await track(); await optimizeConnections()
  } catch (e) { if (e.name !== 'NotAllowedError') error.value = e.message }
}
async function connect() {
  const version = ++connectionVersion
  clearInterval(heartbeat); connected.value = false; leaveCall(); peers.value = []; emit('presence', []); status.value = auth.demo ? 'Sample lounge' : navigator.onLine === false ? 'Offline' : 'Connecting...'; emit('connection', auth.demo ? 'demo' : navigator.onLine === false ? 'offline' : 'connecting')
  const previous = channel; channel = null; publishPresence = null; if (previous && supabase) await supabase.removeChannel(previous)
  if (version !== connectionVersion || suspended || !workspace.selectedFolderId || auth.demo || !supabase || navigator.onLine === false) return
  const { data } = await supabase.auth.getSession()
  if (version !== connectionVersion) return
  if (!data.session) return
  await supabase.realtime.setAuth(data.session.access_token)
  if (version !== connectionVersion) return
  sessionStart = Date.now()
  const id = workspace.selectedFolderId
  const nextChannel = supabase.channel(`folder:${id}`, { config: { private: true, presence: { key: clientId }, broadcast: { self: false, ack: true } } })
  channel = nextChannel
  publishPresence = presencePublisher(async payload => {
    if (version !== connectionVersion || suspended || !connected.value) return
    const result = await nextChannel.track(payload)
    if (version === connectionVersion && result !== 'ok') throw new Error('The lounge is reconnecting. Please try again.')
  })
  nextChannel
    .on('presence', { event: 'sync' }, () => { if (version === connectionVersion) syncPeers() }).on('broadcast', { event: 'signal' }, message => { if (version === connectionVersion) void receiveSignal(message) })
    .subscribe(async state => {
      if (version !== connectionVersion) return
      connected.value = state === 'SUBSCRIBED'
      status.value = connected.value ? 'Connected' : navigator.onLine === false ? 'Offline' : 'Reconnecting...'
      emit('connection', connected.value ? 'online' : navigator.onLine === false ? 'offline' : 'connecting')
      if (!connected.value) { peers.value = []; emit('presence', []); if (active.value) { leaveCall(); error.value = 'The call ended because the lounge disconnected. Rejoin once it reconnects.' } }
      if (connected.value) await track().catch(e => { error.value = e.message })
    })
  heartbeat = setInterval(() => { if (connected.value && !suspended) { syncPeers(); void track().catch(() => {}) } }, PRESENCE_HEARTBEAT)
}
async function sendChat() { error.value = ''; try { await workspace.sendMessage(chat.value); chat.value = ''; await nextTick(); if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight } catch (e) { error.value = e.message } }
function reconnect() { void connect().catch(e => { error.value = e.message }) }
function updateVisibility() {
  if (document.visibilityState !== 'hidden') { lastInteraction = Date.now(); if (!connected.value && !suspended) { reconnect(); return }; syncPeers() }
  void track().catch(() => {})
}
function interacted() {
  lastInteraction = Date.now()
  if (selfAway.value && document.visibilityState !== 'hidden') { selfAway.value = false; void track().catch(() => {}) }
}
function pageHidden() { suspended = true; ++connectionVersion; clearInterval(heartbeat); connected.value = false; leaveCall(); peers.value = []; emit('presence', []); emit('connection', 'offline'); const previous = channel; channel = null; publishPresence = null; if (previous && supabase) void supabase.removeChannel(previous) }
function pageShown(event) { if (suspended || event.persisted) { suspended = false; lastInteraction = Date.now(); reconnect() } }
watch(() => workspace.selectedFolderId, reconnect, { immediate: true })
watch(() => [auth.profile?.display_name,auth.profile?.avatar_path], updateVisibility)
watch(active, value => emit('call', value))
watch(() => callPeers.value.length, () => { videoPage.value = Math.min(videoPage.value, pages.value - 1); void optimizeConnections() })
watch(roomMessages, async () => { await nextTick(); if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight })
onMounted(() => { window.addEventListener('online', reconnect); window.addEventListener('offline', reconnect); window.addEventListener('pagehide', pageHidden); window.addEventListener('pageshow', pageShown); document.addEventListener('visibilitychange', updateVisibility); for (const event of ['pointerdown','pointermove','keydown','scroll']) window.addEventListener(event, interacted, { passive:true }) })
onBeforeUnmount(() => { ++connectionVersion; clearInterval(heartbeat); connected.value = false; leaveCall(); window.removeEventListener('online', reconnect); window.removeEventListener('offline', reconnect); window.removeEventListener('pagehide', pageHidden); window.removeEventListener('pageshow', pageShown); document.removeEventListener('visibilitychange', updateVisibility); for (const event of ['pointerdown','pointermove','keydown','scroll']) window.removeEventListener(event, interacted); if (channel && supabase) void supabase.removeChannel(channel); emit('presence', []); emit('connection', 'offline') })
</script>
<template>
  <section class="lounge"><div class="section-heading"><div><h1 class="page-title" tabindex="-1">Study lounge</h1><p class="muted">{{ workspace.selectedFolder?.title }} · {{ onlineLabel }}</p></div><span class="pill"><span class="status-dot" :class="{ online: connected }"></span>{{ auth.demo ? 'Sample lounge' : status || 'Connecting...' }}</span></div>
    <p v-if="error" class="error-box" role="alert">{{ error }}</p>
    <div class="lounge-grid"><section class="call-stage"><div class="call-stage-head"><span><Icon name="Users" />{{ workspace.selectedFolder?.title || 'Choose a space' }}</span><span class="tiny muted">{{ active ? participants.length : callPeers.length }} in call</span></div>
      <div v-if="!active" class="call-welcome"><Icon name="Video" :size="38" /><h2>Study together.</h2><p>{{ callPeers.length ? `${callPeers.length} ${callPeers.length === 1 ? 'person is' : 'people are'} in the call.` : 'Start a call with the people in this space.' }}</p><button class="button primary" :disabled="joining || (!auth.demo && !connected) || !workspace.selectedFolderId" @click="join"><Icon name="Video" :size="17" />{{ joining ? 'Opening camera...' : callPeers.length ? 'Join study call' : 'Start study call' }}</button></div>
      <template v-else>
        <div class="video-grid" :class="{ 'single-video': visibleParticipants.length === 1, 'sharing-grid': visibleParticipants.some(p => p.sharing) }">
          <div v-for="peer in visibleParticipants" :key="peer.client_id" class="video-tile" :class="{ 'is-sharing': peer.sharing, 'self-video': peer.self && !peer.sharing }">
            <video :ref="el => videoRef(peer.client_id, el)" autoplay playsinline muted :aria-label="peer.name + (peer.sharing ? ' screen share' : ' camera')"></video>
            <div v-if="(!peer.self && !remoteStreams[peer.client_id]) || (peer.camera_off && !peer.sharing)" class="video-placeholder"><Avatar :name="peer.name" :path="peer.avatar_path" /><span>{{ peer.camera_off ? 'Camera off' : 'Connecting...' }}</span></div>
            <span class="video-label"><Icon v-if="peer.muted" name="MicOff" :size="13" />{{ peer.name }}{{ peer.sharing ? ' · Screen' : '' }}</span>
          </div>
        </div>
        <audio v-for="peer in callPeers" :key="peer.client_id" :ref="el => audioRef(peer.client_id, el)" autoplay></audio>
        <nav v-if="pages > 1" class="video-pagination" aria-label="Call participant pages"><button class="icon-button" title="Previous participants" aria-label="Previous participants" :disabled="videoPage === 0" @click="videoPage--"><Icon name="ChevronLeft" :size="17" /></button><span>Page {{ videoPage + 1 }} of {{ pages }} · {{ participants.length }} participants</span><button class="icon-button" title="Next participants" aria-label="Next participants" :disabled="videoPage >= pages - 1" @click="videoPage++"><Icon name="ChevronRight" :size="17" /></button></nav>
      </template>
      <div v-if="active" class="call-controls"><button class="icon-button" :class="{ toggled: muted }" :title="muted ? 'Unmute microphone' : 'Mute microphone'" :aria-label="muted ? 'Unmute microphone' : 'Mute microphone'" @click="toggleMute"><Icon :name="muted ? 'MicOff' : 'Mic'" /></button><button class="icon-button" :class="{ toggled: cameraOff }" :title="cameraOff ? 'Turn camera on' : 'Turn camera off'" :aria-label="cameraOff ? 'Turn camera on' : 'Turn camera off'" @click="toggleCamera"><Icon :name="cameraOff ? 'VideoOff' : 'Video'" /></button><button class="button secondary small" @click="shareScreen"><Icon name="Monitor" :size="17" />{{ sharing ? 'Stop sharing' : 'Share screen' }}</button><button class="button danger small" @click="leaveCall">Leave call</button></div>
      <details class="room-peers"><summary>People in this space <span class="tiny muted">{{ onlineLabel }}</span></summary><div class="person-row"><Avatar class="small-avatar" :name="auth.profile?.display_name" :path="auth.profile?.avatar_path" /><div><strong>You</strong><span class="tiny muted">{{ auth.demo ? 'Preview mode' : connected ? active ? 'In call' : selfAway ? 'Away' : 'Online' : 'Disconnected' }}</span></div><span class="status-dot" :class="{ online: connected && !selfAway, away: connected && selfAway }"></span></div><div v-for="peer in people" :key="peer.user_id" class="person-row"><Avatar class="small-avatar" :name="peer.name" :path="peer.avatar_path" /><div><strong>{{ peer.name }}</strong><span class="tiny muted">{{ peer.in_call ? 'In call' : peer.away ? 'Away' : 'Online' }}</span></div><span class="status-dot" :class="{ online: !peer.away, away: peer.away }"></span></div></details>
    </section><section class="chat-panel"><div class="rail-title"><span><Icon name="MessageCircle" />Study chat</span></div><div ref="chatBox" class="chat-messages"><div v-if="!roomMessages.length" class="chat-empty"><Icon name="MessageCircle" :size="30" /><p>A place to share<br>your next “aha.”</p></div><div v-for="message in roomMessages" :key="message.id" class="chat-message" :class="{ mine: message.user_id === auth.user.id }"><div class="tiny muted">{{ message.user_id === auth.user.id ? 'You' : message.profiles?.display_name || 'Study buddy' }} <span>{{ timeAgo(message.created_at) }}</span></div><p>{{ message.body }}</p></div></div><form @submit.prevent="sendChat" class="chat-input"><input v-model="chat" maxlength="2000" placeholder="Share a thought…" aria-label="Study chat message" :disabled="!workspace.selectedFolderId" /><button class="icon-button" :disabled="!chat.trim()" aria-label="Send message"><Icon name="ArrowRight" /></button></form><p class="tiny muted chat-note">Visible to members of this folder.</p></section></div>
  </section>
</template>
