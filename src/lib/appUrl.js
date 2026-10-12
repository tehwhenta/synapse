export const productionUrl = 'https://rcgsynapse.vercel.app'

export function appOrigin(configured, origin, production = false) {
  const value = (configured || '').trim() || (production ? productionUrl : origin)
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('VITE_APP_URL must be your HTTPS app address, or localhost for development.')
  return url.origin
}
export const publicAppUrl = appOrigin(import.meta.env?.VITE_APP_URL, location.origin, import.meta.env?.PROD)
export function invitationUrl(token) { return `${publicAppUrl}/?invite=${encodeURIComponent(token)}` }
