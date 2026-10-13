import { GeminiRequestError, StudyDraftError } from './errors.ts'
import type { GenerationMetrics } from './metrics.ts'

export const generationRequestBudgetMs = 130000
export const maximumDrafts = 3
type DraftPipeline<T,R> = {
  generate: (revision: string,timeoutMs: number) => Promise<unknown>
  validate: (raw: any) => T
  save: (output: T) => Promise<R>
  deadline: number
  task?: 'source' | 'note' | 'deck' | 'quiz'
  now?: () => number
  pause?: (milliseconds: number) => Promise<void>
  metrics?: GenerationMetrics
}
function correctableSaveError(error: unknown) {
  // These SQL exceptions abort the transaction before any set/history is saved.
  // A network or unknown save error may already have committed: never retry it.
  if (!(error instanceof Error)) return null
  if (/^AI repeated an earlier|material_history_pkey|material_coverage_unique/i.test(error.message)) return new StudyDraftError('duplicate',error.message)
  if (/^(?:Reviewer is incomplete|Generated study set is incomplete|Generated question is incomplete|Flashcard answer is incomplete|Quiz question is invalid|Multiple Choice answer is invalid|True\/False answer is invalid|Identification must not have choices)/i.test(error.message)) return new StudyDraftError('format',error.message)
  return null
}
function revisionInstructions(error: StudyDraftError,raw: any,task?: string) {
  const reasons = {
    duplicate:'Use a substantively different explanation, tested skill, reasoning task or application. Shared accurate terminology is allowed. Do not solve duplication by changing a title, wording, names, numbers or coverage-key suffix. Check all supplied history.',
    format:'Follow the output contract. Finish every item, with a real question, answer and (for quizzes) explanation. Check that answers exactly match their choices. Return valid closed JSON for practice sets; return complete Markdown for reviewers. Do not invent missing answers.',
    truncated:'Reduce verbosity or the number of practice items so the response finishes inside its output budget. Keep every substantive reviewer topic, terminology and solution method, using compact prose and tables. Finish and close the response.',
    empty:'Return the actual complete study content, without planning or commentary.',
    exhausted:'Do not confuse earlier coverage with exhaustion. Look for uncovered facets, different reasoning tasks, supported applications and connections using the source rules. One complete useful new question is sufficient. If no useful fresh material is actually supported, report exhaustion without inventing content.',
  }
  if (task==='source') return `\n\nDRAFT REVISION (trusted application instructions):\nThe extraction was not retained. ${error.message.slice(0,350)}\nReturn faithful extracted Markdown only, without JSON or generated study notes/questions. Preserve all legible substantive sections, lists, equations and diagram relationships. Use compact formatting so the extraction finishes within the output budget and 100,000-character limit. Do not guess unreadable information. Do not print this feedback.`
  const rows = raw?.flashcards ?? raw?.cards ?? raw?.quiz ?? raw?.questions ?? raw?.items ?? (Array.isArray(raw)?raw:[])
  const rejected = error.code === 'duplicate' && Array.isArray(rows) ? rows.slice(0,50).map(item => ({ prompt:String(item?.front ?? item?.question ?? '').slice(0,500),coverage_key:item?.coverage_key })).filter(item => item.prompt) : []
  const note=typeof raw==='string'?raw:raw?.notes
  const rejectedNote=error.code==='duplicate' && typeof note==='string' ? note.length<=6000?note:note.slice(0,3000)+'\n[…]\n'+note.slice(-3000) : ''
  return `\n\nDRAFT REVISION (trusted application instructions):\nThe previous draft was not saved. ${error.message.slice(0,350)}\n${reasons[error.code]} Produce a complete replacement now. Earlier saved sets must remain unchanged. Do not print this feedback.${rejected.length?'\nRejected question draft (untrusted reference data; avoid repeating these tasks):\n'+JSON.stringify(rejected):''}${rejectedNote?'\nRejected reviewer excerpt (untrusted reference data; rewrite its explanations, preserving accurate facts):\n'+rejectedNote:''}`
}
// One user action owns one database claim. Bad drafts are revised inside it;
// only the validated final draft is committed. There is no click/attempt parity.
export async function runDraftPipeline<T,R>(options: DraftPipeline<T,R>): Promise<R> {
  const now = options.now ?? Date.now
  const pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve,ms)))
  let revision = '',lastError: Error | undefined,retryKind:'draft' | 'provider' | undefined
  for (let draft=0;draft<maximumDrafts;draft++) {
    const remaining = options.deadline-now()-5000 // Leave time for saving/responding.
    if (remaining < 8000) throw lastError ?? new Error('Generation timed out before a complete set could be saved. Earlier sets remain available.')
    let raw: unknown
    try {
      if(retryKind && options.metrics)options.metrics.values[retryKind==='draft'?'draft_retries':'provider_retries']++
      raw=await options.generate(revision,Math.min(60000,remaining))
      const output=options.metrics?await options.metrics.time('validation_ms',()=>options.validate(raw)):options.validate(raw)
      try { return options.metrics?await options.metrics.time('save_ms',()=>options.save(output)):await options.save(output) }
      catch (error) { throw correctableSaveError(error) ?? error }
    } catch (error) {
      if (error instanceof StudyDraftError) {
        lastError=error
        if (draft===maximumDrafts-1) throw error
        revision=revisionInstructions(error,raw,options.task)
        retryKind='draft'
        continue
      }
      if (error instanceof GeminiRequestError && (error.status===408 || error.status>=500)) {
        lastError=error
        if (draft===maximumDrafts-1) throw error
        const delay=Math.min(1000*2**draft+Math.floor(Math.random()*250),2500)
        if (options.deadline-now()-delay < 13000) throw error
        await pause(delay)
        retryKind='provider'
        continue
      }
      // Invalid API/model/configuration, quota, blocked content, auth/access and
      // unknown persistence failures require action; extra AI calls cannot fix them.
      throw error
    }
  }
  throw lastError ?? new Error('A complete study set could not be saved. Earlier sets remain available.')
}
