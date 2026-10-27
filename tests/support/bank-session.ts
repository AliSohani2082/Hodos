/**
 * A learning session whose tutor asks from installed courses, for integration
 * tests: a registry's content packs become a question bank, and each exercise
 * is asked by reference as a check question about the one node of the plan,
 * as the tutor's exercise tool asks it.
 */
import { courseBank, CourseLibrary, HodosStore, LearnRepository, LearnService, type BankEntry, type LearnerId, type PluginRegistry, type QuestionView } from '@hodos/core'
import type { JsonValue } from '@hodos/plugin-sdk'

const silent = { info: (): void => undefined, warn: (): void => undefined, error: (): void => undefined }

/** A session in its teaching phase, with the bank of the registry's courses. */
export interface BankSession {
  readonly learn: LearnService
  readonly courses: CourseLibrary
  readonly learner: LearnerId
  readonly sessionId: string
  /** Bank entries as the tutor lists them. */
  entries(query?: string): BankEntry[]
  /** Ask a bank exercise by its reference; returns the learner's view of it. */
  ask(ref: string): Promise<QuestionView>
  /** Answer a question as the learner; returns the answered question and the tutor's report. */
  answer(questionId: string, response: JsonValue): Promise<{ question: QuestionView; report: string }>
  close(): void
}

/**
 * Start a session over a registry's content packs.
 * @param registry - the installed plugins.
 * @returns the session, past its probe and with a one-node plan.
 */
export async function bankSession(registry: PluginRegistry): Promise<BankSession> {
  const store = new HodosStore(':memory:')
  const courses = new CourseLibrary({ store, registry })
  const rejected = await courses.syncContentPacks()
  if (rejected.length > 0) throw new Error(`content packs rejected: ${JSON.stringify(rejected)}`)
  const learner = courses.learnerForPrincipal('owner')
  const learn = new LearnService({ repository: new LearnRepository(store), registry, logger: silent, bank: courseBank(store, registry) })
  const session = learn.start(learner, 'Integration test', null)
  learn.concludeProbe(session.id, { strands: [{ strand: 'the topic', assessment: 'new to it' }] })
  learn.setPlan(session.id, 'graph TD\n  topic[The topic]')
  return {
    learn, courses, learner, sessionId: session.id,
    entries: (query = '') => learn.bankEntries(query, 50),
    async ask(ref) {
      const asked = await learn.ask(session.id, { form: 'interface', role: 'check', nodeId: 'topic', prompt: 'Try this one.', input: { bank: ref } })
      const view = learn.openQuestion(session.id)
      if (view?.id !== asked.id) throw new Error(`${ref} is not the open question`)
      return view
    },
    async answer(questionId, response) {
      const result = await learn.answer(learner, questionId, { response })
      if (result.status !== 'answered') throw new Error('expected a final answer')
      return result
    },
    close: () => store.close(),
  }
}
