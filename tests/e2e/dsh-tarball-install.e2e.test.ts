/**
 * The packed tarballs (`pnpm pack:dsh`) in a fresh DeepSeek Harness home:
 * `dsh plugin add <file>.tgz` installs @hodos/dsh and @hodos/chess with the
 * @hodos packages they carry (no registry has them), the installed `hodos`
 * command works outside the Harness, and the Harness runs the installed
 * bundles: the tutor starts the chess course and the workspace presents a
 * placement exercise on the board.
 *
 * Packs with `scripts/pack-bundles.mjs --no-build` (`pnpm test:e2e` builds
 * first). Third-party dependencies install from the npm registry (or a warm
 * pnpm store). Needs HODOS_DSH_BIN; skipped otherwise.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type FrameLocator, type Page } from 'playwright'
import { startMockLlm, tutorScript, type MockLlm } from '@hodos/testing'
import { DSH_AVAILABLE, prepareHome, ROOT, startDsh, type DshHome, type DshProcess } from './support/dsh.js'
import { enterDsh, hodosApp, hodosState, openHodosTab, say, waitForExercise, type HodosState } from './support/ui.js'

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

/** The tarball `pnpm pack:dsh` writes for a workspace package. */
function tarball(dir: string): string {
  const manifest: unknown = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('name' in manifest) || !('version' in manifest)) throw new Error(`${dir} has no package name`)
  const { name, version } = manifest
  if (typeof name !== 'string' || typeof version !== 'string') throw new Error(`${dir} has no package name`)
  return `dist-packages/${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`
}

/** Where the `web` profile keeps its installed packages. */
const profile = (): string => join(the(home, 'home').home, 'profiles/web')

const app = (): FrameLocator => hodosApp(the(page, 'page'))
const state = (): Promise<HodosState> => hodosState(the(page, 'page'), the(dsh, 'dsh').origin, session)

describe.skipIf(!DSH_AVAILABLE)('packed tarballs in DeepSeek Harness', () => {
  beforeAll(async () => {
    const packed = spawnSync(process.execPath, [join(ROOT, 'scripts/pack-bundles.mjs'), '--no-build'], { cwd: ROOT, encoding: 'utf8' })
    if (packed.status !== 0) throw new Error(`pack-bundles failed:\n${packed.stdout}${packed.stderr}`)
    home = prepareHome([tarball('packages/dsh-adapter'), tarball('packages/environments/chess')])
    mock = await startMockLlm(tutorScript({ environment: 'chess' }))
    dsh = await startDsh(home, mock.url)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  }, 600_000)

  afterAll(async () => {
    await browser?.close()
    await dsh?.stop()
    await mock?.close()
  })

  it('installs copies from the tarballs, with the @hodos packages they carry', () => {
    for (const name of ['@hodos/dsh', '@hodos/chess']) {
      const installed = join(profile(), 'node_modules', name)
      // A copy unpacked from the tarball, not a link back into this checkout.
      expect(lstatSync(installed).isSymbolicLink() && realpathSync(installed).startsWith(ROOT), name).toBe(false)
      expect(existsSync(join(installed, 'node_modules/@hodos/plugin-sdk/package.json')), name).toBe(true)
    }
    const adapter = join(profile(), 'node_modules/@hodos/dsh')
    expect(existsSync(join(adapter, 'node_modules/@hodos/core/package.json'))).toBe(true)
    expect(existsSync(join(adapter, 'app/index.html'))).toBe(true)
  })

  it('runs the installed hodos command outside the Harness', () => {
    const run = spawnSync(join(profile(), 'node_modules/.bin/hodos'), ['course', 'guide', '--no-schemas'], {
      env: { PATH: process.env.PATH ?? '', HOME: the(home, 'home').userHome, DSH_HOME: the(home, 'home').home },
      encoding: 'utf8',
    })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('#### `chess.puzzle`: Chess puzzle')
  })

  it('starts the chess course from the chat and presents a placement exercise on the board', async () => {
    const p = the(page, 'page')
    await enterDsh(p, the(dsh, 'dsh').url)
    await say(p, 'Teach me chess tactics. I know the basic rules but struggle with knight forks.')
    await expect.poll(() => the(mock, 'mock').requests.some(r => r.toolResults.some(t => t.name === 'hodos_start_learning' && !t.isError)), { timeout: 60_000 }).toBe(true)
    session = await openHodosTab(p)
    const exercise = await waitForExercise(state)
    expect(exercise.mode).toBe('diagnostic')
    await expect.poll(() => app().locator('.mode-banner strong').textContent(), { timeout: 20_000 }).toBe('Placement')
    // The installed renderer draws every chess exercise's position (interactive for puzzles).
    const board = app().locator('section.environment-pane iframe.renderer-frame').contentFrame()
    await expect.poll(() => board.locator('[data-square]').count(), { timeout: 20_000 }).toBe(64)
  })
})
