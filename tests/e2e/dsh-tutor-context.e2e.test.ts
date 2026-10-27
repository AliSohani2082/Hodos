/**
 * What the tutor learns from Hodos in a real DeepSeek Harness, and what Hodos
 * learns from the chat. Once a chat is bound to a journey, every model request
 * carries the learner context; the learner's work in the workspace reaches the
 * tutor as notices with the next message (the default `notices: quiet` makes
 * no extra model calls); and a message the learner types while an assessment
 * item is open marks that item as answered with tutor contact.
 *
 * Needs `pnpm build` and HODOS_DSH_BIN; skipped otherwise.
 */
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { startMockLlm, tutorScript, type MockLlm, type MockRequest } from '@hodos/testing'
import { DSH_AVAILABLE, prepareHome, startDsh, type DshHome, type DshProcess } from './support/dsh.js'
import { enterDsh, hodosApp, hodosState, openHodosTab, say, waitForExercise, waitForGrading, type HodosState } from './support/ui.js'

let home: DshHome | undefined
let mock: MockLlm | undefined
let dsh: DshProcess | undefined
let browser: Browser | undefined
let page: Page | undefined
let session = ''

function the<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not ready`)
  return value
}

const state = (): Promise<HodosState> => hodosState(the(page, 'page'), the(dsh, 'dsh').origin, session)

/** Everything a model request carried, as text. */
const sent = (request: MockRequest | undefined): string => JSON.stringify(request?.raw ?? {})

/** Whether Hodos recorded tutor contact for a presentation (read from its database, which the workspace API does not expose). */
function tutorContact(presentationId: string): boolean {
  const db = new DatabaseSync(join(the(home, 'home').home, 'hodos', 'hodos.db'), { readOnly: true })
  try {
    const row = db.prepare('SELECT tutor_contact FROM presentations WHERE id = ?').get(presentationId)
    return row?.tutor_contact === 1
  } finally {
    db.close()
  }
}

describe.skipIf(!DSH_AVAILABLE)('what the tutor hears from Hodos in DeepSeek Harness', () => {
  beforeAll(async () => {
    mock = await startMockLlm(tutorScript({ environment: 'chess' }))
    home = prepareHome(['packages/dsh-adapter', 'packages/environments/chess'])
    dsh = await startDsh(home, mock.url)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  })

  afterAll(async () => {
    await browser?.close()
    await dsh?.stop()
    await mock?.close()
  })

  it('gives the tutor the learner context once the chat is bound to a journey', async () => {
    const p = the(page, 'page')
    await enterDsh(p, the(dsh, 'dsh').url)
    await say(p, 'Teach me chess tactics. I know the basic rules but struggle with knight forks.')
    await expect.poll(() => the(mock, 'mock').requests.some(r => r.toolResults.some(t => t.name === 'hodos_start_learning' && !t.isError)), { timeout: 60_000 }).toBe(true)
    const requests = the(mock, 'mock').requests
    expect(sent(requests[0])).not.toContain('Hodos learning context')
    expect(sent(requests.at(-1))).toContain('Hodos learning context')
  })

  it('tells the tutor about a workspace answer with the learner\'s next message', async () => {
    const p = the(page, 'page')
    session = await openHodosTab(p)
    const exercise = await waitForExercise(state)
    await hodosApp(p).getByRole('button', { name: 'I don\'t know' }).click()
    await waitForGrading(state, exercise)
    const open = await waitForExercise(state)
    expect(open.id).not.toBe(exercise.id)
    expect(tutorContact(open.id)).toBe(false)
    const before = the(mock, 'mock').requests.length
    await say(p, 'How am I doing so far?')
    await expect.poll(() => the(mock, 'mock').requests.length, { timeout: 60_000 }).toBeGreaterThan(before)
    const next = sent(the(mock, 'mock').requests[before])
    expect(next).toContain('[Hodos] The learner answered an assessment item (result withheld until the end)')
    // The chat message reached Hodos through DSH's session events: the open placement item now counts as assisted.
    await expect.poll(() => tutorContact(open.id), { timeout: 20_000 }).toBe(true)
  })
})
