export const PRESENCE_HEARTBEAT = 45000
export const PRESENCE_EXPIRY = 150000
export const AWAY_AFTER = 300000

export function livePresence(rows, now = Date.now()) {
  const clients = new Map()
  for (const peer of rows) {
    if (!peer || typeof peer.user_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(peer.client_id || '')) continue
    const seen = Date.parse(peer.last_seen_at)
    if (!Number.isFinite(seen) || now - seen > PRESENCE_EXPIRY || seen - now > 30000) continue
    const previous = clients.get(peer.client_id)
    if (!previous || Date.parse(previous.last_seen_at) <= seen) clients.set(peer.client_id, { ...peer, away: !!peer.away, in_call: !!peer.in_call })
  }
  return [...clients.values()]
}

export function peopleInSpace(peers) {
  const people = new Map()
  for (const peer of peers) {
    const previous = people.get(peer.user_id)
    const latest = !previous || Date.parse(peer.last_seen_at) >= Date.parse(previous.last_seen_at) ? peer : previous
    people.set(peer.user_id, { ...latest, in_call: !!(peer.in_call || previous?.in_call), away: !!peer.away && (!previous || !!previous.away) })
  }
  return [...people.values()].sort((a, b) => Number(a.away) - Number(b.away) || String(a.name).localeCompare(String(b.name)))
}

export function presenceLabel(peers) {
  const people = peopleInSpace(peers), away = people.filter(p => p.away).length
  return `${people.length - away} online${away ? ` · ${away} away` : ''}`
}

// Coalesce rapid control/visibility changes while a track request is in flight.
// Each connection owns its publisher, so old completions cannot affect a new room.
export function presencePublisher(send) {
  let task = null, latest
  return function publish(value) {
    latest = value
    if (!task) task = (async () => {
      while (latest) { const payload = latest; latest = null; await send(payload) }
    })().finally(() => { task = null })
    return task
  }
}

export function cameraQuality(participants, screen = false) {
  return screen ? { maxBitrate: 1600000, maxFramerate: 15, scaleResolutionDownBy: 1 }
    : participants > 9 ? { maxBitrate: 180000, maxFramerate: 12, scaleResolutionDownBy: 2 }
      : participants > 4 ? { maxBitrate: 320000, maxFramerate: 18, scaleResolutionDownBy: 1 }
        : { maxBitrate: 600000, maxFramerate: 24, scaleResolutionDownBy: 1 }
}
