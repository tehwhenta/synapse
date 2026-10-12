export const palette = ['#d9d5cc', '#beb089', '#aca086', '#8c8d65', '#9f7c60']
export function initials(name = '') { return name.trim().split(/\s+/).slice(0, 2).map(n => n[0]).join('').toUpperCase() || 'S' }
export function timeAgo(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
export function bytes(value) { return value < 1048576 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1048576).toFixed(1)} MB` }
export function localDay(value) { const d = new Date(value); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` }
export function studyStreak(sessions, attempts, now = new Date()) {
  const days = new Set([...sessions, ...attempts].map(x => localDay(x.created_at)))
  const day = new Date(now); let count = 0
  if (!days.has(localDay(day))) day.setDate(day.getDate() - 1)
  while (days.has(localDay(day))) { count++; day.setDate(day.getDate() - 1) }
  return count
}
export function quizResult(questions, answers) {
  const feedback = questions.map((q, i) => ({ correct: [q.answer, ...(q.accepted_answers || [])].some(a => String(a).trim().toLowerCase() === String(answers[i] ?? '').trim().toLowerCase()), answer: q.answer, explanation: q.explanation }))
  return { correct: feedback.filter(x => x.correct).length, total: questions.length, feedback }
}
export function downloadFile(name, content, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
export function safeFilename(title) { return title.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 90) || 'Synapse export' }
export function ankiTsv(cards) { return cards.map(c => [c.front, c.back].map(x => String(x).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n') }
