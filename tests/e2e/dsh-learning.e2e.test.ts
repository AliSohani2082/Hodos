/**
 * A learning session through a real DeepSeek Harness (`dsh web`), with a
 * scripted tutor in place of DeepSeek and Playwright as the learner:
 *
 *   "I want to learn how knight forks win material" → the tutor probes with a
 *   graded question in the Hodos panel → concludes the probe → writes the plan
 *   map → teaches: a prediction, a chess position to solve on the board, a
 *   program to write and run in the Python sandbox, an explanation in the
 *   learner's own words → the knowledge graph fills from what it taught →
 *   a practice session on picked propositions in a new chat.
 *
 * Every answer is graded by Hodos on the server and reaches the tutor as the
 * next turn. Needs `pnpm build` and HODOS_DSH_BIN; skipped otherwise.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import { chromium, type Browser, type FrameLocator, type Page } from 'playwright'
import { learningScript, startMockLlm, type MockLlm } from '@hodos/testing'
import { DSH_AVAILABLE, prepareHome, startDsh, type DshProcess } from './support/dsh.js'
import { enterDsh, graphApp, hodosApp, hodosState, openGraphTab, openHodosTab, say as sayIn, waitForQuestion, type HodosState } from './support/ui.js'

const GOAL = 'I want to learn how knight forks win material'

const FORK = {
  role: 'check', nodeId: 'fork', question: 'Find the fork.', kind: 'chess.puzzle',
  payload: { fen: '6k1/3q1p1p/8/8/4N3/8/5PPP/6K1 w - - 0 1', orientation: 'white', prompt: 'White to move and win material.', goal: 'best', plies: 2 },
  key: { line: ['Nf6+', 'Kf8', 'Nxd7'], theme: 'fork' },
  explanation: 'Nf6+ forks the king and the queen on d7.',
}

const SCRIPT = learningScript({
  probe: { question: 'How does a knight move?', options: ['In an L: two squares one way, one square to the side', 'Diagonally, any distance', 'One square in any direction'], correct: 'In an L: two squares one way, one square to the side' },
  assessment: { strands: [{ strand: 'piece movement', assessment: 'Knows how the knight moves.' }, { strand: 'tactics', assessment: 'Has not met forks.' }], summary: 'Start from the knight fork itself.' },
  plan: 'graph TD\n  knight[How a knight attacks] --> fork[The knight fork]\n  fork --> win[Winning material with a fork]',
  steps: [
    {
      text: 'A knight attacks every square an L-move away, and nothing between can block it.',
      tool: 'hodos_quiz',
      input: { role: 'predict', nodeId: 'knight', question: 'A knight on g1 attacks which square?', options: ['f3', 'g3', 'h2'], correct: 'f3', explanation: 'Two squares up and one to the left.' },
    },
    { text: 'A fork is one move that attacks two pieces at once, so the opponent can save only one of them.', tool: 'hodos_exercise', input: FORK },
    {
      text: 'Counting the squares a knight attacks is how you spot forks quickly.',
      tool: 'hodos_exercise',
      input: {
        role: 'check', nodeId: 'win', question: 'Count the knight\'s moves.', kind: 'code.sandbox',
        payload: { language: 'python', prompt: 'Write `knight_moves(file, rank)`: how many squares a knight on that square (files and ranks 1-8) attacks.', starter: 'def knight_moves(file, rank):\n    ...', tests: [{ name: 'corner', code: 'assert knight_moves(1, 1) == 2' }, { name: 'centre', code: 'assert knight_moves(4, 4) == 8' }] },
        key: { solution: 'def knight_moves(file, rank):\n    steps = [(1, 2), (2, 1), (-1, 2), (-2, 1), (1, -2), (2, -1), (-1, -2), (-2, -1)]\n    return sum(1 <= file + a <= 8 and 1 <= rank + b <= 8 for a, b in steps)' },
      },
    },
    {
      text: 'A fork wins material because only one piece can move away per turn.',
      tool: 'hodos_explain',
      input: { role: 'review', nodeId: 'fork', question: 'Why does a fork win material?', answer: 'Both attacked pieces cannot move in one turn, so the opponent must give one up.' },
    },
  ],
  problem: { statement: 'White: Kg1, Nc3. Black: Kc8, Qb5... find the fork square.', mode: 'recall', modelSolution: 'Nd5? No: Na4? The fork is on d5 when the queen is on b4 and the king on e7.' },
  conclusion: { outcome: 'solved', verdict: 'You found the fork square.', rung: 'none', missClass: 'none', retest: false },
})

/** Python that tries the Hodos API from inside the sandbox, with credentials, and prints each status. */
function apiProbe(origin: string, chat: string, learnId: string): string {
  return [
    'import js',
    'def attempt(method, url, body=None):',
    '    try:',
    '        x = js.XMLHttpRequest.new()',
    '        x.open(method, url, False)',
    '        x.withCredentials = True',
    '        if body is not None:',
    '            x.setRequestHeader("content-type", "application/json")',
    '        x.send(body)',
    '        return str(x.status)',
    '    except Exception as e:',
    '        return type(e).__name__',
    `print("state:", attempt("GET", "${origin}/hodos/api/v1/state?session=${chat}"))`,
    `print("close:", attempt("POST", "${origin}/hodos/api/v1/learn/close", '{"sessionId": "${learnId}"}'))`,
  ].join('\n')
}

const KNIGHT_SOLUTION = 'def knight_moves(file, rank):\n    steps = [(1, 2), (2, 1), (-1, 2), (-2, 1), (1, -2), (2, -1), (-1, -2), (-2, -1)]\n    return sum(1 <= file + a <= 8 and 1 <= rank + b <= 8 for a, b in steps)'

let dsh: DshProcess | undefined
let mock: MockLlm | undefined
let browser: Browser | undefined
let page: Page | undefined
let session = ''
const seen = new Set<string>()

function the<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not ready`)
  return value
}

function app(): FrameLocator {
  return hodosApp(the(page, 'page'))
}

function state(sessionId = session): Promise<HodosState> {
  return hodosState(the(page, 'page'), the(dsh, 'dsh').origin, sessionId)
}

function say(text: string): Promise<void> {
  return sayIn(the(page, 'page'), text)
}

async function shot(name: string): Promise<void> {
  const dir = process.env.HODOS_E2E_SCREENSHOTS
  if (dir !== undefined && page !== undefined) await page.screenshot({ path: `${dir}/${name}.png` })
}

/** What the model was told in a request: the system prompt and the runtime context DSH sends as messages. */
function told(request: { system: string; userTexts: readonly string[] } | undefined): string {
  return request === undefined ? '' : [request.system, ...request.userTexts].join('\n')
}

/** Wait for the next open question, mark it seen, and open it if it waits behind the check button. */
async function nextQuestion(): Promise<{ id: string; role: string }> {
  const q = await waitForQuestion(() => state(), seen)
  seen.add(q.id)
  const check = app().getByRole('button', { name: 'Check your understanding' })
  if (q.role === 'check' || q.role === 'review') await check.click()
  return q
}

/** The text of the follow-up the tutor received for a question. */
async function reportOf(questionId: string): Promise<string> {
  const found: { text: string } = { text: '' }
  await expect.poll(() => {
    found.text = the(mock, 'mock').requests.map(r => r.lastUserText ?? '').find(t => t.startsWith(`[Hodos] Answer to question ${questionId}`)) ?? ''
    return found.text !== ''
  }, { timeout: 60_000 }).toBe(true)
  return found.text
}

describe.skipIf(!DSH_AVAILABLE)('a learning session in DeepSeek Harness', () => {
  beforeAll(async () => {
    mock = await startMockLlm(SCRIPT)
    dsh = await startDsh(prepareHome(['packages/dsh-adapter', 'packages/environments/chess', 'packages/environments/code']), mock.url)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  })

  beforeEach(context => {
    onTestFailed(async () => {
      await shot(`failed-${context.task.name.slice(0, 40).replace(/\W+/g, '-')}`)
      const requests = mock?.requests.slice(-6).map(r => ({ index: r.index, said: r.lastUserText?.split('\n')[0], tools: r.tools.filter(t => t.startsWith('hodos_')), results: r.toolResults.map(t => `${t.name}${t.isError ? ' (error)' : ''}: ${t.text.slice(0, 200)}`) }))
      console.error('mock model requests (last 6):', JSON.stringify(requests, null, 1))
      console.error('dsh output (tail):', dsh?.output().slice(-3000))
    })
  })

  afterAll(async () => {
    await browser?.close()
    await dsh?.stop()
    await mock?.close()
  })

  it('starts a learning session from the chat; the prober asks in the Hodos panel', async () => {
    await enterDsh(the(page, 'page'), the(dsh, 'dsh').url)
    await say(GOAL)
    session = await openHodosTab(the(page, 'page'))
    const probe = await nextQuestion()
    expect(probe.role).toBe('probe')
    expect((await state()).binding).toMatchObject({ kind: 'learn', phase: 'probe' })
    const prober = the(mock, 'mock').requests.find(r => r.tools.includes('hodos_probe'))
    expect(told(prober)).toContain('## You are probing')
    // A restricted tutoring session: only Hodos's tools and DSH's own question tool.
    expect(prober?.tools.filter(t => !t.startsWith('hodos_') && t !== 'ask_user_question' && t !== 'subagent')).toEqual([])
    await shot('01-probe')
    await app().getByRole('radio', { name: 'In an L: two squares one way, one square to the side' }).check()
    await app().getByLabel('Think out loud (optional, sent to your tutor)').fill('It jumps over pieces.')
    await app().getByRole('button', { name: 'Submit' }).click()
    const report = await reportOf(probe.id)
    expect(report).toContain('Correct.')
    expect(report).toContain('Their thinking out loud: «It jumps over pieces.»')
  })

  it('concludes the probe and shows the plan map, live', async () => {
    await expect.poll(async () => (await state()).learn?.plan?.nodes.map(n => n.id), { timeout: 60_000 }).toEqual(['knight', 'fork', 'win'])
    const learn = (await state()).learn
    expect(learn?.phase).toBe('plan')
    expect(learn?.assessment?.strands.map(s => s.strand)).toEqual(['piece movement', 'tactics'])
    await expect.poll(() => app().locator('.plan-node').count(), { timeout: 20_000 }).toBe(3)
    await shot('02-plan')
  })

  it('teaches: a prediction, graded and reported to the tutor', async () => {
    await say('Looks good, let us start')
    const q = await nextQuestion()
    expect(q.role).toBe('predict')
    await expect.poll(async () => (await state()).learn?.phase).toBe('teach')
    const teacher = the(mock, 'mock').requests.find(r => r.tools.includes('hodos_quiz'))
    expect(told(teacher)).toContain('## You are the teacher')
    expect(teacher?.tools).not.toContain('hodos_probe')
    await app().getByRole('radio', { name: 'g3' }).check()
    await app().getByRole('button', { name: 'Submit' }).click()
    const report = await reportOf(q.id)
    expect(report).toContain('The learner answered "g3". Incorrect.')
    expect(report).toContain('The correct answer: "f3".')
    // The tutor moves on to the next node with its next question; where the lesson stands follows.
    await expect.poll(async () => (await state()).learn?.plan?.statuses, { timeout: 30_000 }).toEqual({ knight: 'visited', fork: 'current', win: 'upcoming' })
  })

  it('asks a chess position on the board, like a puzzle, and grades the line', async () => {
    const q = await nextQuestion()
    const board = app().locator('iframe.renderer-frame').contentFrame()
    await board.locator('[data-square="e4"]').click({ timeout: 30_000 })
    await board.locator('[data-square="f6"]').click()
    await expect.poll(async () => (await state()).learn?.openQuestion?.progress, { timeout: 20_000 }).toBeDefined()
    await board.locator('[data-square="f6"]').click()
    await board.locator('[data-square="d7"]').click()
    const report = await reportOf(q.id)
    expect(report).toContain('Correct.')
    const answered = (await state()).learn?.answered.find(a => a.id === q.id)
    expect(answered?.answer?.verdict).toMatchObject({ outcome: 'correct', countsAsEvidence: true })
    expect((await state()).learn?.mastery.map(m => m.nodeId)).toEqual(['fork'])
    await shot('03-chess')
  })

  it('runs Python in the browser sandbox, self-reported and never mastery evidence', async () => {
    const q = await nextQuestion()
    const box = app().locator('iframe.renderer-frame').contentFrame()
    const editor = box.locator('textarea.editor')
    // Code in the sandbox (the learner's, or test code the tutor wrote) may load Pyodide from the
    // Hodos server, but it cannot use the Hodos API with the learner's sign-in.
    const learnId = (await state()).learn?.id ?? ''
    await editor.fill(apiProbe(the(dsh, 'dsh').origin, session, learnId))
    await box.getByRole('button', { name: 'Run tests' }).click()
    await expect.poll(() => box.locator('.output').textContent(), { timeout: 120_000 }).toContain('close:')
    const probed = await box.locator('.output').textContent() ?? ''
    expect(probed).toMatch(/state: \S+/)
    expect(probed).not.toMatch(/: 200\b/)
    expect((await state()).learn?.phase).toBe('teach')
    await editor.fill('def knight_moves(file, rank):\n    return 8')
    await box.getByRole('button', { name: 'Run tests' }).click()
    await expect.poll(() => box.locator('.status').textContent(), { timeout: 120_000 }).toBe('1 of 2 tests passed.')
    await editor.fill(KNIGHT_SOLUTION)
    await box.getByRole('button', { name: 'Run tests' }).click()
    await expect.poll(() => box.locator('.status').textContent(), { timeout: 30_000 }).toBe('2 of 2 tests passed.')
    await shot('04-code')
    await box.getByRole('button', { name: 'Submit' }).click()
    const report = await reportOf(q.id)
    expect(report).toContain('All 2 tests passed in your browser.')
    expect(report).toContain('knight_moves')
    const answered = (await state()).learn?.answered.find(a => a.id === q.id)
    expect(answered?.answer?.verdict).toMatchObject({ outcome: 'correct', countsAsEvidence: false })
    expect((await state()).learn?.mastery.map(m => m.nodeId)).toEqual(['fork'])
  })

  it('takes an answer in the learner\'s own words and gives it to the tutor with the committed answer', async () => {
    const q = await nextQuestion()
    expect(q.role).toBe('review')
    await app().getByLabel('Your answer, in your own words').fill('The opponent can only move one piece per turn.')
    await app().getByRole('button', { name: 'Submit' }).click()
    const report = await reportOf(q.id)
    expect(report).toContain('Your committed answer: «Both attacked pieces cannot move in one turn, so the opponent must give one up.»')
    await expect.poll(() => app().getByText('Your tutor\'s answer:').count(), { timeout: 20_000 }).toBeGreaterThan(0)
  })

  it('fills the knowledge graph from what the tutor taught, through the user\'s default model', async () => {
    // After each turn Hodos extracts once enough new prose has accumulated; the learner can also ask now.
    await app().getByRole('button', { name: 'Update knowledge graph' }).click()
    await expect.poll(() => the(mock, 'mock').requests.some(r => r.system.includes('You are the extraction stage')), { timeout: 60_000 }).toBe(true)
    const extraction = the(mock, 'mock').requests.find(r => r.system.includes('You are the extraction stage'))
    expect(extraction?.tools).toEqual([])
    expect(extraction?.lastUserText).toContain('A fork is one move that attacks two pieces at once')
    // Only teacher prose is extracted: not the learner's answers or thinking.
    expect(extraction?.lastUserText).not.toContain('It jumps over pieces')
    await openGraphTab(the(page, 'page'))
    const graph = graphApp(the(page, 'page'))
    await expect.poll(() => graph.locator('.kg-node').count(), { timeout: 30_000 }).toBeGreaterThan(1)
    await shot('05-graph')
  })

  it('practises picked propositions in a new chat: problem, thinking, verdict and the tutor\'s solution', async () => {
    const p = the(page, 'page')
    await p.getByRole('button', { name: 'New Session' }).first().click()
    await say('Hello')
    await expect.poll(() => the(mock, 'mock').requests.some(r => (r.lastUserText ?? '').startsWith('Hello')), { timeout: 30_000 }).toBe(true)
    const chat = await openGraphTab(p)
    expect(chat).not.toBe(session)
    const graph = graphApp(p)
    await graph.getByText('All propositions').click()
    const boxes = graph.locator('.kg-list input[type="checkbox"]')
    await expect.poll(() => boxes.count(), { timeout: 20_000 }).toBeGreaterThan(1)
    await boxes.nth(0).check()
    await boxes.nth(1).check()
    await graph.getByRole('button', { name: 'Practise selected' }).click()
    await expect.poll(async () => (await state(chat)).practice?.problems.length, { timeout: 60_000 }).toBe(1)
    const practice = (await state(chat)).practice
    expect(practice?.targets).toHaveLength(2)
    // The committed solution stays on the server while the problem is open.
    expect(JSON.stringify(practice)).not.toContain('The fork is on d5')
    const practiser = the(mock, 'mock').requests.find(r => r.tools.includes('hodos_problem'))
    expect(told(practiser)).toContain('## You are running a practice session')
    await openHodosTab(p)
    const panel = hodosApp(p)
    await panel.getByLabel('Your thinking: work in progress, a question, or your answer').fill('The knight goes to d5.')
    await panel.getByRole('button', { name: 'Send to tutor' }).click()
    await expect.poll(async () => (await state(chat)).practice?.problems[0]?.status, { timeout: 60_000 }).toBe('concluded')
    const done = (await state(chat)).practice?.problems[0]
    expect(done?.conclusion).toMatchObject({ outcome: 'solved', verdict: 'You found the fork square.' })
    expect(done?.modelSolution).toContain('The fork is on d5')
    expect(done?.thinking.map(t => t.text)).toEqual(['The knight goes to d5.'])
    await shot('06-practice')
  })
})
