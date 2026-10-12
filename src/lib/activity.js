// Presence is ephemeral; this low-frequency server timestamp is for maintenance.
// A dormant tab must not keep an unused account alive forever.
export function startActivityTracking({ record, document = globalThis.document, window = globalThis.window, clock = Date.now, interval = setInterval, cancelInterval = clearInterval, onError = () => {} }) {
  let lastInteraction = clock(), lastRecorded = -Infinity, pending = false, stopped = false
  async function touch() {
    const now = clock()
    if (stopped || pending || document.visibilityState === 'hidden' || window.navigator?.onLine === false || now - lastInteraction > 120000 || now - lastRecorded < 300000) return
    pending = true; lastRecorded = now
    try { await record() } catch (error) { onError(error) } finally { pending = false }
  }
  function interact() { lastInteraction = clock(); void touch() }
  function resume() { if (document.visibilityState !== 'hidden') interact() }
  const events = ['pointerdown', 'keydown', 'scroll']
  for (const event of events) window.addEventListener(event, interact, { passive: true, capture: true })
  window.addEventListener('online', resume); document.addEventListener('visibilitychange', resume)
  const timer = interval(() => { void touch() }, 60000)
  void touch()
  return () => { stopped = true; cancelInterval(timer); for (const event of events) window.removeEventListener(event, interact, true); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume) }
}
