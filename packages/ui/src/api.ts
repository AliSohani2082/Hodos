/**
 * Client for the Hodos workspace API (`/hodos/api/v1`). Same-origin, cookie
 * authenticated by DeepSeek Harness; the DSH session the workspace is shown
 * in travels as the `session` query parameter.
 */
import type {
  AttemptView,
  CheckAnswerView,
  CheckpointView,
  ExerciseView,
  HintView,
  JourneyView,
  LessonView,
  ProgressView,
  SelfReport,
} from '@hodos/core'
import type { JsonValue } from '@hodos/plugin-sdk/protocol'

/** A course in the catalog. */
export interface CatalogEntry {
  readonly id: string
  readonly version: string
  readonly title: string
  readonly description: string
  readonly environments: readonly string[]
  readonly available: boolean
  readonly goal: string
  readonly skills: ReadonlyArray<{ readonly id: string; readonly title: string; readonly kind: string }>
}

/** A draft course awaiting the learner's decision. */
export interface DraftEntry {
  readonly id: string
  readonly version: string
  readonly title: string
  readonly description: string
  /** `agent`: proposed by the tutor or a subagent; `import`: a file from the course inbox. */
  readonly origin: 'agent' | 'import'
  /** The proposing channel, or `inbox:<file name>` for imports. */
  readonly proposedBy: string
  readonly skills: ReadonlyArray<{ readonly id: string; readonly title: string; readonly kind: string; readonly requires: readonly string[] }>
  readonly lessons: number
  readonly items: number
}

/** Everything the workspace shows at once. */
export interface WorkspaceState {
  readonly journey: JourneyView | null
  readonly exercise: ExerciseView | null
  readonly checkpoint: CheckpointView | null
  readonly catalog: readonly CatalogEntry[]
  readonly drafts: readonly DraftEntry[]
}

/** An API failure with the server's stable code. */
export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterSec?: number) {
    super(message)
  }
}

/** Every API response: `{ data }` on success, `{ error }` otherwise. */
interface ApiEnvelope {
  readonly data?: unknown
  readonly error?: { readonly code?: string; readonly message?: string; readonly retryAfterSec?: number }
}

const session = new URLSearchParams(window.location.search).get('session') ?? ''

/** The DSH session this workspace belongs to ('' outside a session). */
export function currentSession(): string {
  return session
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: Record<string, JsonValue | undefined>, query: Record<string, string> = {}): Promise<T> {
  const params = new URLSearchParams(query)
  if (session !== '') params.set('session', session)
  const response = await fetch(`/hodos/api/v1/${path}?${params.toString()}`, {
    method,
    credentials: 'same-origin',
    headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  })
  let payload: ApiEnvelope | null = null
  try {
    payload = await response.json() as ApiEnvelope
  } catch (_notJson) {
    // Non-JSON answers (e.g. the DSH login page) are reported by status below.
  }
  if (!response.ok) {
    throw new ApiError(payload?.error?.code ?? (response.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL'), payload?.error?.message ?? `request failed (${response.status})`, payload?.error?.retryAfterSec)
  }
  // The server's TypeScript types define the response shape of each route.
  return payload?.data as T
}

/** The workspace API. */
export const api = {
  state: () => call<WorkspaceState>('GET', 'state'),
  start: (goal: string, options: { courseId?: string; selfReport?: SelfReport[]; skipDiagnostic?: boolean } = {}) =>
    call<JourneyView>('POST', 'journeys', {
      goal,
      ...(options.courseId === undefined ? {} : { courseId: options.courseId }),
      ...(options.selfReport === undefined ? {} : { selfReport: options.selfReport.map(r => ({ level: r.level, ...(r.skill === undefined ? {} : { skill: r.skill }), ...(r.skillId === undefined ? {} : { skillId: r.skillId }) })) }),
      ...(options.skipDiagnostic === undefined ? {} : { skipDiagnostic: options.skipDiagnostic }),
    }),
  resume: () => call<JourneyView | null>('POST', 'journey/resume'),
  approvePath: () => call<JourneyView>('POST', 'journey/approve'),
  skipDiagnostic: () => call<JourneyView>('POST', 'journey/skip-diagnostic'),
  lesson: (skillId?: string) => call<LessonView>('GET', 'lesson', undefined, skillId === undefined ? {} : { skill: skillId }),
  answerCheck: (lessonId: string, checkId: string, optionId: string) => call<CheckAnswerView>('POST', 'lesson/check', { lessonId, checkId, optionId }),
  completeLesson: () => call<JourneyView>('POST', 'lesson/complete'),
  nextExercise: () => call<ExerciseView | null>('POST', 'exercise/next'),
  hint: (presentationId: string) => call<HintView>('POST', 'exercise/hint', { presentationId }),
  submit: (presentationId: string, response: JsonValue, latencyMs: number) => call<AttemptView>('POST', 'exercise/submit', { presentationId, response, latencyMs }),
  startCheckpoint: () => call<CheckpointView>('POST', 'checkpoint/start'),
  startReview: () => call<JourneyView>('POST', 'review/start'),
  progress: () => call<ProgressView>('GET', 'progress'),
  decideDraft: (courseId: string, version: string, approve: boolean) => call<{ ok: true }>('POST', 'drafts/decide', { courseId, version, approve }),
}
