// Only draft defects and transient provider failures may be retried. Configuration,
// authentication, quota, permissions and save failures must remain actionable.
export class StudyDraftError extends Error {
  constructor(public code: 'format' | 'duplicate' | 'truncated' | 'empty' | 'exhausted', message: string) {
    super(message)
    this.name = 'StudyDraftError'
  }
}
export class GeminiRequestError extends Error {
  constructor(public status: number, message: string, public retryAfterSeconds?: number) {
    super(message)
    this.name = 'GeminiRequestError'
  }
}
