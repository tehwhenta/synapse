export function fileExpiry(document, now = Date.now()) {
  if (!document) return { state: 'unknown', label: 'Source availability unknown', expired: false }
  const expires = Date.parse(document.expires_at)
  if (document.purged_at || (Number.isFinite(expires) && expires <= now)) return { state: 'expired', label: 'Original file expired', expired: true }
  if (!Number.isFinite(expires)) return { state: 'unknown', label: 'Source availability unknown', expired: false }
  return { state: expires - now <= 3600000 ? 'soon' : 'available', label: 'Expires ' + new Date(expires).toLocaleString(), expired: false }
}
