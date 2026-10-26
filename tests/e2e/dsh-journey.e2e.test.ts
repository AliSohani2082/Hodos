/**
 * The demo journey through a real DeepSeek Harness (`dsh web`), with the
 * deterministic mock model in place of DeepSeek and Playwright as the learner:
 *
 *   "Teach me chess tactics. I know the basic rules but struggle with knight
 *   forks." → placement → path → knight-fork lesson → board practice (a miss,
 *   a hint, the right move) → a failed checkpoint → revisit → an unassisted
 *   checkpoint that passes → restart → resume from a new chat → a missing
 *   environment keeps the journey.
 *
 * Needs `pnpm build` and HODOS_DSH_BIN (the `dsh` launcher of DeepSeek Harness
 * 0.2.1-rc.3 or a compatible version); skipped otherwise. The test knows the
 * answer keys from the course, as a scripted learner would.
 */
import { Chess, type Square } from 'chess.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import { chromium, type Browser, type FrameLocator, type Page } from 'playwright'
import { SKILL, tacticsCourse } from '@hodos/chess'
import type { ExerciseView } from '@hodos/core'
import type { ExerciseItem } from '@hodos/plugin-sdk'
import { startMockLlm, tutorScript, type MockLlm } from '@hodos/testing'
import { DSH_AVAILABLE, prepareHome, startDsh, type DshHome, type DshProcess } from './support/dsh.js'
import { enterDsh as enter, hodosApp, hodosState, openHodosTab as openTab, say as sayIn, type HodosState } from './support/ui.js'
import { jsonObject, jsonObjects, jsonString, jsonStrings } from '../support/json.js'

const GOAL = 'Teach me chess tactics. I know the basic rules but struggle with knight forks.'
const course = tacticsCourse()
const items = new Map(course.items.map(i => [i.id, i]))

let home: DshHome | undefined
let dsh: DshProcess | undefined
let mock: MockLlm | undefined
let browser: Browser | undefined
let page: Page | undefined
let session = ''

function the<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not ready`)
  return value
}

/** The Hodos workspace inside the DSH sidebar. */
function app(): FrameLocator {
  return hodosApp(the(page, 'page'))
}

function board(workspace: FrameLocator): FrameLocator {
  return workspace.locator('section.environment-pane iframe.renderer-frame').contentFrame()
}

function state(sessionId = session): Promise<HodosState> {
  return hodosState(the(page, 'page'), the(dsh, 'dsh').origin, sessionId)
}

function item(exercise: ExerciseView): ExerciseItem {
  return the(items.get(exercise.itemId), `item ${exercise.itemId}`)
}

function position(exercise: ExerciseView): { fen: string; played: string[] } {
  if (exercise.progress !== undefined && exercise.progress !== null) {
    const progress = jsonObject(exercise.progress, 'the puzzle progress')
    return { fen: jsonString(progress.fen, 'the position'), played: jsonStrings(progress.played, 'the moves played') }
  }
  return { fen: jsonString(jsonObject(exercise.payload, 'the puzzle').fen, 'the position'), played: [] }
}

/** The solution line of a puzzle item. */
function solution(entry: ExerciseItem): string[] {
  return jsonStrings(jsonObject(entry.key, `the key of ${entry.id}`).line, `the line of ${entry.id}`)
}

function squares(fen: string, san: string): { from: Square; to: Square } {
  const move = new Chess(fen).move(san)
  return { from: move.from, to: move.to }
}

/** A legal move that fails the item's goal. */
function wrongMove(entry: ExerciseItem, fen: string): { from: Square; to: Square } {
  const key = solution(entry)
  const goal = jsonString(jsonObject(entry.payload, `the payload of ${entry.id}`).goal, `the goal of ${entry.id}`)
  for (const move of new Chess(fen).moves({ verbose: true })) {
    const after = new Chess(move.after)
    const fails = goal === 'mate' ? !after.isCheckmate() : goal === 'check' ? !after.inCheck() : move.san.replace(/[+#]/g, '') !== (key[0] ?? '').replace(/[+#]/g, '')
    if (fails && move.captured === undefined && !after.inCheck()) return { from: move.from, to: move.to }
  }
  throw new Error(`no wrong move in ${fen}`)
}

async function play(move: { from: Square; to: Square }): Promise<void> {
  const frame = board(app())
  await frame.locator(`[data-square="${move.from}"]`).click()
  await frame.locator(`[data-square="${move.to}"]`).click()
}

/** Wait until the server answered the response given at (`attempt`, `played` moves) of `exercise`. */
async function settled(exercise: ExerciseView, played: number): Promise<HodosState> {
  const found: { state: HodosState | null } = { state: null }
  await expect.poll(async () => {
    found.state = await state()
    const ex = found.state.exercise
    return ex === null || ex.id !== exercise.id || ex.attempt > exercise.attempt || position(ex).played.length > played
  }, { timeout: 20_000 }).toBe(true)
  return the(found.state ?? undefined, 'state')
}

/** Solve the open exercise: board moves for puzzles, the option for "spot the tactic". */
async function solve(exercise: ExerciseView): Promise<void> {
  const entry = item(exercise)
  if (entry.kind === 'chess.identify') {
    const correct = jsonObject(entry.key, `the key of ${entry.id}`).correct
    const option = jsonObjects(jsonObject(entry.payload, `the payload of ${entry.id}`).options, `the options of ${entry.id}`).find(o => o.id === correct)
    await app().getByRole('radio', { name: jsonString(option?.text, `the right option of ${entry.id}`) }).check()
    await app().getByRole('button', { name: 'Submit answer' }).click()
    await settled(exercise, 0)
    return
  }
  const line = solution(entry)
  let { fen, played } = position(exercise)
  for (;;) {
    await play(squares(fen, the(line[played.length], `move ${played.length + 1} of ${entry.id}`)))
    const next = await settled(exercise, played.length)
    const ex = next.exercise
    if (ex === null || ex.id !== exercise.id || ex.attempt > exercise.attempt) return
    ;({ fen, played } = position(ex))
    if (played.length >= line.length) return
  }
}

/** Practise correctly until Hodos recommends the checkpoint. */
async function practiseUntilReady(max = 20): Promise<void> {
  for (let n = 0; n < max; n++) {
    const now = await state()
    if (now.journey?.nextAction.type === 'practice' && now.journey.nextAction.readyForCheckpoint) return
    const next = app().getByRole('button', { name: 'Next exercise' })
    if (await next.count() > 0) await next.click()
    await solve(await openExercise())
  }
  throw new Error(`not ready for the checkpoint after ${max} practice items`)
}

async function openExercise(): Promise<ExerciseView> {
  const found: { exercise: ExerciseView | null } = { exercise: null }
  await expect.poll(async () => {
    found.exercise = (await state()).exercise
    return found.exercise !== null
  }, { timeout: 20_000 }).toBe(true)
  return the(found.exercise ?? undefined, 'exercise')
}

async function shot(name: string): Promise<void> {
  const dir = process.env.HODOS_E2E_SCREENSHOTS
  if (dir !== undefined && page !== undefined) await page.screenshot({ path: `${dir}/${name}.png` })
}

function enterDsh(url: string): Promise<void> {
  return enter(the(page, 'page'), url)
}

function say(text: string): Promise<void> {
  return sayIn(the(page, 'page'), text)
}

async function openHodosTab(): Promise<void> {
  session = await openTab(the(page, 'page'))
}

describe.skipIf(!DSH_AVAILABLE)('demo journey in DeepSeek Harness', () => {
  beforeAll(async () => {
    mock = await startMockLlm(tutorScript({ environment: 'chess', selfReport: [{ skill: 'basic rules', level: 'used-it' }, { skill: 'knight forks', level: 'heard-of' }] }))
    home = prepareHome(['packages/dsh-adapter', 'packages/environments/chess'])
    dsh = await startDsh(home, mock.url)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  })

  beforeEach(context => {
    onTestFailed(async () => {
      await shot(`failed-${context.task.name.slice(0, 40).replace(/\W+/g, '-')}`)
      const requests = mock?.requests.slice(-6).map(r => ({ index: r.index, said: r.lastUserText?.split('\n')[0], results: r.toolResults.map(t => `${t.name}${t.isError ? ' (error)' : ''}: ${t.text.slice(0, 200)}`) }))
      console.error('mock model requests (last 6):', JSON.stringify(requests, null, 1))
      const raw = mock?.requests.at(-1)?.raw
      const messages = Array.isArray(raw?.messages) ? raw.messages : []
      console.error('last request, last 3 messages:', JSON.stringify(messages.slice(-3), null, 1).slice(0, 4000))
      console.error('dsh output (tail):', dsh?.output().slice(-3000))
    })
  })

  afterAll(async () => {
    await browser?.close()
    await dsh?.stop()
    await mock?.close()
  })

  it('starts the journey from the chat and opens the Hodos workspace', async () => {
    await enterDsh(the(dsh, 'dsh').url)
    await say(GOAL)
    await expect.poll(() => the(mock, 'mock').requests.some(r => r.toolResults.some(t => t.name === 'hodos_start_learning' && !t.isError)), { timeout: 60_000 }).toBe(true)
    const first = the(mock, 'mock').requests[0]
    expect(first?.tools).toContain('hodos_start_learning')
    expect(first?.system).toContain('Hodos learning')
    await openHodosTab()
    await expect.poll(() => app().locator('.mode-banner strong').textContent(), { timeout: 20_000 }).toBe('Placement')
    await shot('01-placement')
  })

  it('places the learner: the rules are known, knight forks are not', async () => {
    for (let asked = 0; asked < 15; asked++) {
      const now = await state()
      if (now.journey?.nextAction.type !== 'diagnostic') break
      const exercise = await openExercise()
      const entry = item(exercise)
      if (entry.skills.some(s => s.skillId === SKILL.rules) && entry.kind === 'chess.puzzle') {
        const san = the(solution(entry)[0], `the first move of ${entry.id}`)
        await app().getByLabel('Or type your move (e.g. Nf3)').fill(san)
        await app().getByRole('button', { name: 'Submit answer' }).click()
      } else {
        await app().getByRole('button', { name: 'I don\'t know' }).click()
      }
      await settled(exercise, 0)
    }
    const planned = await state()
    expect(planned.journey?.phase).toBe('planning')
    expect(planned.journey?.diagnosedKnown).toContain(SKILL.rules)
    expect(planned.journey?.path[0]?.id).toBe(SKILL.knightFork)
    await expect.poll(() => app().locator('section.plan li').first().textContent()).toBe('Knight forks')
    await shot('02-path')
    await app().getByRole('button', { name: 'Start this path' }).click()
  })

  it('teaches knight forks with a board diagram and a check question', async () => {
    await expect.poll(() => app().locator('.mode-banner strong').textContent(), { timeout: 20_000 }).toBe('Teach')
    await expect(app().locator('.lesson h2').first().textContent()).resolves.toBe('Knight forks')
    const diagram = app().locator('figure.block-frame iframe.renderer-frame').first().contentFrame()
    await expect.poll(() => diagram.locator('[data-square="c3"]').getAttribute('aria-label'), { timeout: 20_000 }).toBe('c3, white knight')
    await app().getByRole('radio', { name: 'a8 and e8' }).check()
    await app().getByRole('button', { name: 'Check' }).click()
    await expect.poll(() => app().locator('.check-status').first().textContent()).toContain('Right.')
    await shot('03-lesson')
    await app().getByRole('button', { name: 'Continue to practice' }).click()
  })

  it('practises on the board: a miss, a hint, then the right move', async () => {
    await expect.poll(() => app().locator('.mode-banner strong').textContent(), { timeout: 20_000 }).toBe('Practice')
    let exercise = await openExercise()
    // Practise a single-move puzzle first (the miss and the hint are clearer there).
    while (item(exercise).kind !== 'chess.puzzle') {
      await solve(exercise)
      await app().getByRole('button', { name: 'Next exercise' }).click()
      exercise = await openExercise()
    }
    const { fen } = position(exercise)
    await play(wrongMove(item(exercise), fen))
    await expect.poll(() => app().locator('.feedback').textContent(), { timeout: 20_000 }).toMatch(/Not quite|Partly right/)
    await app().getByRole('button', { name: /^Hint/ }).click()
    await expect.poll(() => app().locator('ol.hints li').count()).toBeGreaterThan(0)
    await shot('04-miss-and-hint')
    const retry = await state()
    expect(retry.exercise?.id).toBe(exercise.id)
    await solve(the(retry.exercise ?? undefined, 'retry'))
    await expect.poll(() => app().locator('.feedback').textContent()).toContain('Correct.')
    // Only first attempts count as mastery evidence: the miss is recorded, the retry is practice.
    expect((await state()).journey?.activeSkill?.evidenceCount).toBeGreaterThanOrEqual(1)
  })

  it('adapts after a failed checkpoint and passes an unassisted one', async () => {
    await practiseUntilReady()
    await app().getByRole('button', { name: 'Take the checkpoint' }).click()
    await expect.poll(() => app().locator('.mode-banner strong').textContent(), { timeout: 20_000 }).toBe('Checkpoint')
    expect(await app().locator('ol.hints').count()).toBe(0)
    // First checkpoint: wrong answers.
    for (;;) {
      const now = await state()
      if (now.journey?.nextAction.type !== 'checkpoint') break
      const exercise = await openExercise()
      await play(wrongMove(item(exercise), position(exercise).fen))
      await settled(exercise, 0)
    }
    await expect.poll(() => app().locator('.checkpoint-result h3').textContent(), { timeout: 20_000 }).toContain('Not yet')
    await expect.poll(() => app().locator('.mode-banner strong').textContent()).toBe('Revisit')
    await shot('05-revisit')
    await app().getByRole('button', { name: 'Back to practice' }).click()
    await expect.poll(() => app().locator('.mode-banner strong').textContent(), { timeout: 20_000 }).toBe('Practice')
    // Practise until ready again; the next checkpoint opens after the cooldown.
    await practiseUntilReady()
    await expect.poll(async () => {
      const banner = await app().locator('.mode-banner strong').textContent()
      if (banner === 'Checkpoint') return banner
      const next = app().getByRole('button', { name: 'Next exercise' })
      if (await next.count() > 0) await next.click()
      const start = app().getByRole('button', { name: /checkpoint/ })
      if (await start.count() > 0) await start.click()
      return banner
    }, { timeout: 120_000, interval: 5_000 }).toBe('Checkpoint')
    for (;;) {
      const now = await state()
      if (now.journey?.nextAction.type !== 'checkpoint') break
      await solve(await openExercise())
    }
    await expect.poll(() => app().locator('.checkpoint-result h3').textContent(), { timeout: 20_000 }).toBe('Checkpoint passed')
    const after = await state()
    expect(after.journey?.completed).toContain(SKILL.knightFork)
    expect(after.journey?.completedSkills.find(s => s.id === SKILL.knightFork)?.status).toBe('mastered')
    expect(after.journey?.activeSkill?.id).toBe(SKILL.doubleAttack)
    await shot('06-passed')
  })

  it('keeps the journey across a restart and resumes from a new chat', async () => {
    const before = await state()
    await the(dsh, 'dsh').stop()
    dsh = await startDsh(the(home, 'home'), the(mock, 'mock').url)
    await enterDsh(dsh.url)
    const after = await state(session)
    expect(after.journey?.id).toBe(before.journey?.id)
    expect(after.journey?.completed).toContain(SKILL.knightFork)
    await say('Please continue my chess lessons')
    await expect.poll(() => the(mock, 'mock').requests.some(r => r.toolResults.some(t => t.name === 'hodos_resume_learning' && !t.isError && t.text.includes('Chess tactics'))), { timeout: 60_000 }).toBe(true)
    await openHodosTab()
    await expect.poll(() => app().locator('footer.path .status-mastered .skill-title').first().textContent(), { timeout: 20_000 }).toBe('Knight forks')
    await shot('07-resumed')
  })

  it('keeps the journey when the chess environment is missing, and continues when it is back', async () => {
    const disabled = the(home, 'home').patch('no-chess.yml', '- id: hodos-chess\n  disabled: true\n')
    await the(dsh, 'dsh').stop()
    dsh = await startDsh(the(home, 'home'), the(mock, 'mock').url, [disabled])
    const p = the(page, 'page')
    await p.goto(dsh.url)
    await p.goto(`${dsh.origin}/hodos/app/?session=${encodeURIComponent(session)}`)
    await expect.poll(() => p.locator('.environment-pane .warning').textContent(), { timeout: 20_000 }).toContain('your progress is saved')
    const missing = await state()
    expect(missing.journey?.environments).toEqual([{ id: 'chess.board', available: false }])
    expect(missing.journey?.completed).toContain(SKILL.knightFork)
    await shot('08-missing')
    await dsh.stop()
    dsh = await startDsh(the(home, 'home'), the(mock, 'mock').url)
    await p.goto(dsh.url)
    const back = await state()
    expect(back.journey?.environments).toEqual([{ id: 'chess.board', available: true }])
  })
})
