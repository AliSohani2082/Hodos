/**
 * Client for the Hodos workspace API (`/hodos/api/v1`). Same-origin, cookie
 * authenticated by DeepSeek Harness; the DSH chat the panel is shown in
 * travels as the `session` query parameter.
 */
import type {
  GraphSnapshot,
  PracticeView,
  QuestionView,
  SessionSummary,
  SessionView,
} from '@hodos/core'
import type { JsonValue } from '@hodos/plugin-sdk/protocol'

/** What a chat is to Hodos. */
export type ChatBinding =
  | { readonly kind: 'learn'; readonly sessionId: string; readonly phase: string }
  | { readonly kind: 'practice'; readonly sessionId: string; readonly closed: boolean }

/** A draft course (question bank) awaiting the learner's decision. */
export interface DraftEntry {
  readonly id: string
  readonly version: string
  readonly title: string
  readonly description: string
  readonly origin: 'agent' | 'import'
  readonly proposedBy: string
  readonly lessons: number
  readonly items: number
}

/** A plan node due for review. */
export interface DueReview {
  readonly sessionId: string
  readonly goal: string
  readonly nodeId: string
  readonly title: string
  readonly dueAt: string
}

/** Everything the panel shows for one chat. */
export interface WorkspaceState {
  readonly binding: ChatBinding | null
  readonly learn: SessionView | null
  readonly practice: PracticeView | null
  readonly sessions: readonly SessionSummary[]
  readonly practiceSessions: ReadonlyArray<{ readonly id: string; readonly title: string; readonly status: string; readonly hostSessionId: string | null; readonly updatedAt: string }>
  readonly reviews: readonly DueReview[]
  /** A model is available for background work (graph extraction, notes import). */
  readonly model: boolean
  readonly drafts: readonly DraftEntry[]
}

/** An installed renderer for an environment. */
export interface RendererEntry {
  readonly environment: string
  readonly renderer: { readonly pluginId: string; readonly rendererId: string; readonly entry: string; readonly capabilities: readonly string[] } | null
}

/** The result of answering. */
export type AnswerResult =
  | { readonly status: 'continue'; readonly question: QuestionView; readonly message?: string }
  | { readonly status: 'answered'; readonly question: QuestionView }

/** An API failure with the server's stable code. */
export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterSec?: number) {
    super(message)
  }
}

interface ApiEnvelope {
  readonly data?: unknown
  readonly error?: { readonly code?: string; readonly message?: string; readonly retryAfterSec?: number }
}

const params = new URLSearchParams(window.location.search)
const session = params.get('session') ?? ''

/** The DSH chat this panel belongs to ('' outside a chat). */
export function currentChat(): string {
  return session
}

/** Which view the panel shows: the workspace or the knowledge graph. */
export function currentView(): 'workspace' | 'graph' {
  return params.get('view') === 'graph' ? 'graph' : 'workspace'
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: Record<string, JsonValue | undefined>): Promise<T> {
  const query = new URLSearchParams()
  if (session !== '') query.set('session', session)
  const response = await fetch(`/hodos/api/v1/${path}?${query.toString()}`, {
    method,
    credentials: 'same-origin',
    headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  })
  let payload: ApiEnvelope | null = null
  try {
    payload = await response.json() as ApiEnvelope
  } catch {
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
  renderers: () => call<RendererEntry[]>('GET', 'renderers'),
  startLearning: (goal: string) => call<SessionView>('POST', 'learn/start', { goal }),
  answer: (questionId: string, answer: { response?: JsonValue; dontKnow?: boolean; thinking?: string }) => call<AnswerResult>('POST', 'learn/answer', { questionId, ...answer }),
  closeLearning: (sessionId: string) => call<{ ok: true }>('POST', 'learn/close', { sessionId }),
  extract: (sessionId: string) => call<{ started: true }>('POST', 'learn/extract', { sessionId }),
  graph: () => call<GraphSnapshot>('GET', 'graph'),
  importNotes: (title: string, text: string) => call<{ started: true }>('POST', 'graph/import', { title, text }),
  deleteProposition: (propositionId: string) => call<{ propositions: number; chains: number }>('POST', 'graph/delete', { propositionId }),
  removeSource: (sourceId: string, mode: 'preserve-graph' | 'delete-nodes') => call<{ propositions: number; chains: number }>('POST', 'graph/remove-source', { sourceId, mode }),
  startPractice: (targets: readonly string[], title?: string) => call<PracticeView>('POST', 'practice/start', { targets: [...targets], ...(title === undefined ? {} : { title }) }),
  thinking: (problemId: string, text: string) => call<PracticeView>('POST', 'practice/thinking', { problemId, text }),
  dismiss: (problemId: string) => call<PracticeView>('POST', 'practice/dismiss', { problemId }),
  nextProblem: (sessionId: string) => call<{ ok: true }>('POST', 'practice/next', { sessionId }),
  closePractice: (sessionId: string) => call<{ ok: true }>('POST', 'practice/close', { sessionId }),
  decideDraft: (courseId: string, version: string, approve: boolean) => call<{ ok: true }>('POST', 'drafts/decide', { courseId, version, approve }),
}

/** A failure in words for the learner. */
export function errorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Hodos is not reachable.'
  return error.code === 'UNAUTHORIZED' ? 'Your DeepSeek Harness session has expired; reload the page.' : error.message
}
