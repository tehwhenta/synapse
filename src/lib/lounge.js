export function livePresence(rows, now = Date.now()) {
  const clients = new Map()
  for (const peer of rows) {
    if (!peer || typeof peer.user_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(peer.client_id || '')) continue
    const seen = Date.parse(peer.last_seen_at)
    if (peer.last_seen_at && (!Number.isFinite(seen) || now - seen > 90000)) continue
    clients.set(peer.client_id, peer)
  }
  return [...clients.values()]
}

export function peopleInSpace(peers) {
  const people = new Map()
  for (const peer of peers) {
    const previous = people.get(peer.user_id)
    people.set(peer.user_id, { ...peer, in_call: !!(peer.in_call || previous?.in_call), away: !!peer.away && (!previous || !!previous.away) })
  }
  return [...people.values()].sort((a, b) => Number(a.away) - Number(b.away) || String(a.name).localeCompare(String(b.name)))
}

export function cameraQuality(participants, screen = false) {
  return screen ? { maxBitrate: 1600000, maxFramerate: 15, scaleResolutionDownBy: 1 }
    : participants > 9 ? { maxBitrate: 180000, maxFramerate: 12, scaleResolutionDownBy: 2 }
      : participants > 4 ? { maxBitrate: 320000, maxFramerate: 18, scaleResolutionDownBy: 1 }
        : { maxBitrate: 600000, maxFramerate: 24, scaleResolutionDownBy: 1 }
}
