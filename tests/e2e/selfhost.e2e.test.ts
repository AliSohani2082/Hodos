/**
 * Self-hosting: a Harness started by `deploy/serve.sh` on this machine's network
 * address, after `deploy/install.sh` added the Hodos bundles, opened from a
 * phone: an iPhone-sized touch browser that reaches it by a host name
 * (`phone.test`, mapped to this machine's address) instead of loopback.
 * The HTTPS part uses `phone.localhost` for the same: the sandbox these tests
 * were developed in resets TLS connections to other made-up names.
 *
 * - The printed address carries a one-time token; it signs the phone in and
 *   leaves the address. Without it, or under a host name nobody trusted, the
 *   Harness answers nothing.
 * - A learning session works on the phone: the probe question, then a chess
 *   position solved by touch, which finishes the probe.
 * - The model key does not reach the agent's shell.
 * - With a certificate, the same works over HTTPS and the cookie is `Secure`.
 *
 * Needs `pnpm build`, HODOS_DSH_BIN, openssl and a non-loopback IPv4 address of
 * this machine; skipped otherwise.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { request } from 'node:http'
import { request as secureRequest } from 'node:https'
import { createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright'
import { learningScript, startMockLlm, type MockLlm } from '@hodos/testing'
import { DSH_AVAILABLE, DSH_BIN, ROOT } from './support/dsh.js'
import { enterDsh, hodosApp, openHodosTab, say, waitForQuestion, type HodosState } from './support/ui.js'

const SERVE = join(ROOT, 'deploy/serve.sh')
const INSTALL = join(ROOT, 'deploy/install.sh')
const NAME = 'phone.test'
const TLS_NAME = 'phone.localhost'
const KEY = 'sentinel-model-key-7c1e'

/** This machine's first non-loopback IPv4 address, if it has one. */
function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) if (entry.family === 'IPv4' && !entry.internal) return entry.address
  }
  return undefined
}

const LAN = lanAddress()
const HAS_OPENSSL = spawnSync('openssl', ['version']).status === 0
const RUNNABLE = DSH_AVAILABLE && LAN !== undefined

function the<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not ready`)
  return value
}

/** Proxy settings for registry installs only: the launched Harness gets none. */
function registryEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const name of Object.keys(process.env)) {
    if (!/^(https?_proxy|no_proxy|node_extra_ca_certs|ssl_cert_file|npm_config_(https?_proxy|noproxy|cafile|registry|userconfig))$/i.test(name)) continue
    const value = process.env[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer()
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : 0
      server.close(() => done(port))
    })
  })
}

/** A launched `deploy/serve.sh`. */
interface Served {
  readonly url: string
  readonly port: number
  readonly output: () => string
  stop(): Promise<void>
}

interface Machine {
  readonly base: string
  readonly env: NodeJS.ProcessEnv
}

/** A throwaway Harness home with the Hodos bundles added by deploy/install.sh. */
function installed(): Machine {
  const base = mkdtempSync(join(tmpdir(), 'hodos-selfhost-'))
  const env: NodeJS.ProcessEnv = {
    PATH: `${process.execPath.replace(/\/[^/]*$/u, '')}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
    HOME: join(base, 'user'),
    DSH_HOME: join(base, 'dsh'),
    HODOS_DSH_BIN: DSH_BIN,
    HODOS_PLUGINS: 'chess code',
    LANG: 'C.UTF-8',
  }
  for (const dir of [env.HOME, env.DSH_HOME]) mkdirSync(dir ?? base, { recursive: true })
  const result = spawnSync('bash', [INSTALL, 'plugins'], { env: { ...env, ...registryEnv() }, encoding: 'utf8', timeout: 600_000 })
  if (result.status !== 0) throw new Error(`install.sh plugins failed:\n${result.stdout}\n${result.stderr}`)
  expect(result.stdout).toContain('Adding packages/dsh-adapter to the web profile')
  expect(result.stdout).toContain('Adding packages/environments/chess to the web profile')
  return { base, env }
}

async function serve(machine: Machine, mock: MockLlm, extra: (port: number) => NodeJS.ProcessEnv): Promise<Served> {
  const port = await freePort()
  const child: ChildProcess = spawn('bash', [SERVE], {
    cwd: machine.base,
    env: {
      ...machine.env,
      HODOS_HOST: LAN ?? '',
      HODOS_PORT: String(port),
      HODOS_WORKSPACE: join(machine.base, 'workspace'),
      DEEPSEEK_API_KEY: KEY,
      DEEPSEEK_BASE_URL: `${mock.url}/v1`,
      ...extra(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  const url = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`serve.sh did not print an address within 90 s:\n${log}`)), 90_000)
    const read = (chunk: Buffer): void => {
      log += chunk.toString('utf8')
      const match = /dsh web: (https?:\/\/\S+)/.exec(log)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        done(match[1])
      }
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.on('exit', code => {
      clearTimeout(timer)
      fail(new Error(`serve.sh exited with ${String(code)} before it was ready:\n${log}`))
    })
  })
  return {
    url, port,
    output: () => log,
    stop: () => new Promise<void>(done => {
      if (child.exitCode !== null) return done()
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
      child.once('exit', () => {
        clearTimeout(timer)
        done()
      })
      child.kill('SIGTERM')
    }),
  }
}

/** One raw request to the server's address with a chosen Host header. */
function raw(options: { port: number; host: string; path: string; cookie?: string; tls?: boolean }): Promise<number> {
  return new Promise((done, fail) => {
    const headers: Record<string, string> = { host: options.host, ...(options.cookie === undefined ? {} : { cookie: options.cookie }) }
    const send = options.tls === true ? secureRequest : request
    const req = send({ host: LAN, port: options.port, path: options.path, method: 'GET', headers, ...(options.tls === true ? { rejectUnauthorized: false } : {}) }, res => {
      res.resume()
      done(res.statusCode ?? 0)
    })
    req.on('error', fail)
    req.end()
  })
}

/** The status of a request the page itself makes, with its sign-in (the Node side cannot resolve the phone's host name). */
function statusIn(page: Page, url: string): Promise<number> {
  return page.evaluate(async target => (await fetch(target)).status, url)
}

/** What the Hodos panel reads from the API, fetched by the page with its sign-in. */
async function stateIn(page: Page, origin: string, session: string): Promise<HodosState> {
  const body = await page.evaluate(async target => {
    const response = await fetch(target)
    return { status: response.status, json: await response.json() }
  }, `${origin}/hodos/api/v1/state?session=${encodeURIComponent(session)}`)
  expect(body.status).toBe(200)
  const data = typeof body.json === 'object' && body.json !== null && 'data' in body.json ? body.json.data : undefined
  if (typeof data !== 'object' || data === null || !('binding' in data && 'learn' in data && 'practice' in data)) throw new Error(`not a panel state: ${JSON.stringify(body.json)}`)
  return data as HodosState
}

/** A phone: an iPhone-sized touch browser that finds NAME at this machine's address. */
async function phone(browser: Browser, tls = false): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: tls })
  return { context, page: await context.newPage() }
}

/** On a phone the right sidebar fills the screen; the chat is behind it. */
async function showChat(page: Page): Promise<void> {
  const collapse = page.getByRole('button', { name: /collapse right sidebar/i })
  if (await collapse.count() > 0) await collapse.first().click()
}

async function showSidebar(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: /open right sidebar/i })
  if (await open.count() > 0) await open.first().click()
}

const FORK = {
  question: 'Find the best move.', kind: 'chess.puzzle',
  payload: { fen: '6k1/3q1p1p/8/8/4N3/8/5PPP/6K1 w - - 0 1', orientation: 'white', prompt: 'White to move and win material.', goal: 'best', plies: 2 },
  key: { line: ['Nf6+', 'Kf8', 'Nxd7'], theme: 'fork' },
}

const SCRIPT = learningScript({
  probe: { question: 'How does a knight move?', options: ['In an L: two squares one way, one square to the side', 'Diagonally, any distance', 'One square in any direction'], correct: 'In an L: two squares one way, one square to the side' },
  assessment: { strands: [{ strand: 'tactics', assessment: 'Has not met forks.' }], summary: 'Start from the knight fork.' },
  plan: 'graph TD\n  knight[How a knight attacks] --> fork[The knight fork]',
  steps: [],
})

describe.skipIf(!RUNNABLE)('a Harness served on the network and opened from a phone', () => {
  let machine: Machine | undefined
  let mock: MockLlm | undefined
  let served: Served | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let context: BrowserContext | undefined
  let session = ''

  const origin = (): string => `http://${NAME}:${the(served, 'server').port}`
  const state = (): Promise<HodosState> => stateIn(the(page, 'page'), origin(), session)

  beforeAll(async () => {
    machine = installed()
    mock = await startMockLlm(SCRIPT)
    served = await serve(machine, mock, port => ({ HODOS_PORT: String(port), HODOS_PUBLIC_URL: `http://${NAME}:${port}/`, HODOS_ALLOW_PLAIN_HTTP: '1' }))
    browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${NAME} ${LAN ?? ''}`] })
    const p = await phone(browser)
    page = p.page
    context = p.context
  }, 600_000)

  afterAll(async () => {
    await browser?.close()
    await served?.stop()
    await mock?.close()
  })

  it('prints the address the phone should open, under the public host name, with a one-time token', () => {
    const url = new URL(the(served, 'server').url)
    expect(url.host).toBe(`${NAME}:${the(served, 'server').port}`)
    expect(url.searchParams.get('token')).toMatch(/\S{16,}/u)
    expect(the(served, 'server').output()).toContain('listening on')
  })

  it('security: answers nothing without the sign-in, or under a host name nobody trusted', async () => {
    const { port } = the(served, 'server')
    // The Harness checks the Host header of every API and app request before it looks at the sign-in:
    // the public name and the address it listens on pass that check (and then lack a sign-in: 401),
    // any other name is refused outright (403).
    for (const path of ['/hodos/api/v1/state?session=none', '/hodos/app/', '/api/ping']) {
      expect(await raw({ port, host: `${NAME}:${port}`, path }), `${path} as ${NAME}`).toBe(401)
      expect(await raw({ port, host: `${LAN ?? ''}:${port}`, path }), `${path} as the address`).toBe(401)
      expect(await raw({ port, host: `evil.example:${port}`, path }), `${path} as evil.example`).toBe(403)
    }
  })

  it('signs the phone in with the token, which then leaves the address', async () => {
    const p = the(page, 'page')
    await enterDsh(p, the(served, 'server').url)
    expect(new URL(p.url()).search).toBe('')
    const cookies = (await the(context, 'context').cookies()).filter(c => c.name.startsWith('dsh-auth'))
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatchObject({ httpOnly: true, secure: false })
    // The cookie is the sign-in: the same request now passes.
    expect(await statusIn(p, `${origin()}/hodos/app/`)).toBe(200)
  })

  it('keeps the model key out of the agent\'s shell', async () => {
    const p = the(page, 'page')
    await say(p, 'Call the tool bash with {"command":"env","description":"show the environment"}')
    const found: { text: string | undefined } = { text: undefined }
    await expect.poll(() => {
      found.text = the(mock, 'mock').requests.flatMap(r => r.toolResults).find(t => t.name === 'bash')?.text
      return found.text !== undefined
    }, { timeout: 60_000 }).toBe(true)
    expect(found.text).toContain('PATH=')
    expect(found.text).not.toContain(KEY)
    expect(found.text).not.toContain('DEEPSEEK_API_KEY')
  })

  it('shows a learning session\'s first question on the phone', async () => {
    const p = the(page, 'page')
    await say(p, 'I want to learn how knight forks win material')
    session = await openHodosTab(p)
    const probe = await waitForQuestion(state)
    expect(probe.role).toBe('probe')
    const panel = hodosApp(p)
    await expect.poll(() => panel.getByText('How does a knight move?').isVisible(), { timeout: 20_000 }).toBe(true)
    await expect.poll(() => panel.getByRole('radio', { name: 'Diagonally, any distance' }).isVisible()).toBe(true)
    await expect.poll(() => panel.getByRole('button', { name: 'Submit' }).isVisible()).toBe(true)
  })

  it('plays a chess position by touch, which finishes the probe and brings up the plan', async () => {
    const p = the(page, 'page')
    const before = (await state()).learn?.openQuestion?.id ?? ''
    await showChat(p)
    await say(p, `Call the tool hodos_probe_exercise with ${JSON.stringify(FORK)}`)
    const question = await waitForQuestion(state, new Set([before]))
    expect(question.form).toMatchObject({ type: 'interface', kind: 'chess.puzzle' })
    await showSidebar(p)
    const board = hodosApp(p).locator('iframe.renderer-frame').contentFrame()
    await expect.poll(() => board.locator('[data-square]').count(), { timeout: 30_000 }).toBe(64)
    await board.locator('[data-square="e4"]').tap()
    await board.locator('[data-square="f6"]').tap()
    await expect.poll(async () => (await state()).learn?.openQuestion?.progress, { timeout: 20_000 }).toBeDefined()
    await board.locator('[data-square="f6"]').tap()
    await board.locator('[data-square="d7"]').tap()
    await expect.poll(async () => (await state()).learn?.answered.find(a => a.id === question.id)?.answer?.verdict.outcome, { timeout: 30_000 }).toBe('correct')
    await expect.poll(async () => (await state()).learn?.plan?.nodes.map(n => n.id), { timeout: 60_000 }).toEqual(['knight', 'fork'])
    await expect.poll(() => hodosApp(p).locator('.plan-node').count(), { timeout: 20_000 }).toBe(2)
  })
})

describe.skipIf(!RUNNABLE || !HAS_OPENSSL)('the same Harness served over HTTPS from a certificate', () => {
  let machine: Machine | undefined
  let mock: MockLlm | undefined
  let served: Served | undefined
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let page: Page | undefined

  beforeAll(async () => {
    machine = installed()
    const cert = join(machine.base, 'cert.pem')
    const key = join(machine.base, 'key.pem')
    const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', `/CN=${TLS_NAME}`, '-addext', `subjectAltName=DNS:${TLS_NAME},IP:${LAN ?? '127.0.0.1'}`], { encoding: 'utf8' })
    if (made.status !== 0) throw new Error(`openssl failed:\n${made.stderr}`)
    mock = await startMockLlm(SCRIPT)
    served = await serve(machine, mock, port => ({ HODOS_PORT: String(port), HODOS_PUBLIC_URL: `https://${TLS_NAME}:${port}/`, HODOS_TLS_CERT: cert, HODOS_TLS_KEY: key }))
    browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${TLS_NAME} ${LAN ?? ''}`] })
    const p = await phone(browser, true)
    context = p.context
    page = p.page
  }, 600_000)

  afterAll(async () => {
    await browser?.close()
    await served?.stop()
    await mock?.close()
  })

  it('prints an https address, and the phone signs in with a Secure cookie', async () => {
    const { url, port } = the(served, 'server')
    expect(new URL(url).protocol).toBe('https:')
    expect(the(served, 'server').output()).not.toContain('over plain HTTP')
    const p = the(page, 'page')
    await enterDsh(p, url)
    const cookies = (await the(context, 'context').cookies()).filter(c => c.name.includes('dsh-auth'))
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatchObject({ httpOnly: true, secure: true })
    expect(await statusIn(p, `https://${TLS_NAME}:${port}/hodos/app/`)).toBe(200)
  })

  it('security: refuses plain HTTP on the TLS port and an untrusted host name over TLS', async () => {
    const { port } = the(served, 'server')
    // Plain HTTP spoken to a TLS port gets no HTTP answer: the request fails.
    await expect(raw({ port, host: `${TLS_NAME}:${port}`, path: '/' })).rejects.toThrow(/socket hang up|ECONNRESET|parse/iu)
    const api = '/hodos/api/v1/state?session=none'
    expect(await raw({ port, host: `${TLS_NAME}:${port}`, path: api, tls: true })).toBe(401)
    for (const stranger of [`evil.example:${port}`, `other.localhost:${port}`]) expect(await raw({ port, host: stranger, path: api, tls: true }), stranger).toBe(403)
  })
})
