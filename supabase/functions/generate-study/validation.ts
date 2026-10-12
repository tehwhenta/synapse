export type StudyOutput = {
  title: string; source_text: string; notes: string
  flashcards: { front: string; back: string }[]
  quiz: { type: string; question: string; options: string[]; answer: string; accepted_answers: string[]; explanation: string }[]
}
export function validateOutput(raw: unknown): StudyOutput {
  const value = raw as StudyOutput
  const text = (x: unknown, max: number) => typeof x === 'string' && x.trim().length > 0 && x.length <= max
  if (!value || !text(value.title, 100) || !text(value.notes, 60000) || !text(value.source_text, 100000)) throw new Error('AI returned incomplete study notes. Try a smaller document.')
  if (!Array.isArray(value.flashcards) || value.flashcards.length < 3 || value.flashcards.length > 30 || !value.flashcards.every(c => text(c.front, 1000) && text(c.back, 2000))) throw new Error('AI returned an invalid flashcard deck.')
  if (!Array.isArray(value.quiz) || value.quiz.length < 3 || value.quiz.length > 20) throw new Error('AI returned an invalid quiz.')
  for (const q of value.quiz) {
    if (!['multiple_choice', 'true_false', 'short_answer'].includes(q.type) || !text(q.question, 1500) || !text(q.answer, 1000) || !text(q.explanation, 2000) || !Array.isArray(q.options) || !Array.isArray(q.accepted_answers) || !q.accepted_answers.every(a => text(a, 1000))) throw new Error('AI returned an invalid quiz question.')
    if (q.type !== 'short_answer' && (!q.options.includes(q.answer) || q.options.length < 2 || q.options.length > 4 || !q.options.every(a => text(a, 1000)) || new Set(q.options).size !== q.options.length)) throw new Error('AI quiz answers do not match the options.')
    if (q.type === 'true_false' && (q.options.length !== 2 || !q.options.includes('True') || !q.options.includes('False'))) throw new Error('AI returned invalid true/false options.')
  }
  if (JSON.stringify(value).length > 260000) throw new Error('AI output is too large. Try a shorter document.')
  return value
}

export function validateRefreshOutput(raw: unknown, kind: string, previous: string[] = []) {
  const value = raw as Partial<StudyOutput>
  const dummyCards = Array.from({ length: 3 }, () => ({ front: 'Placeholder', back: 'Placeholder' }))
  const dummyQuiz = Array.from({ length: 3 }, () => ({ type: 'short_answer', question: 'Placeholder', options: [], answer: 'Placeholder', accepted_answers: [], explanation: 'Placeholder' }))
  validateOutput({ title: 'New set', source_text: 'Retained source', notes: kind === 'note' ? value?.notes : 'Not requested', flashcards: kind === 'deck' ? value?.flashcards : dummyCards, quiz: kind === 'quiz' ? value?.quiz : dummyQuiz })
  if (kind !== 'note') {
    const prompts = kind === 'deck' ? value.flashcards!.map(c => c.front) : value.quiz!.map(q => q.question)
    const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const old = new Set(previous.map(normalize)), current = prompts.map(normalize)
    if (new Set(current).size !== current.length || current.some(q => old.has(q))) throw new Error('AI repeated an earlier question. Try refreshing again; your existing sets are safe.')
  }
  return value
}
