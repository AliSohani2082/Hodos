/**
 * Real DeepSeek Harness hosts for end-to-end tests: a fresh Harness home with
 * the Hodos bundles link-installed, launched against the deterministic mock
 * model. The process gets a minimal environment (no ambient credentials) and a
 * throwaway HOME. Set HODOS_DSH_BIN to the `dsh` launcher to run these tests.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** The `dsh` launcher, when configured. */
export const DSH_BIN = process.env.HODOS_DSH_BIN ?? ''

/** Whether the real-host tests can run here. */
export const DSH_AVAILABLE = DSH_BIN !== '' && existsSync(DSH_BIN)

/**
 * Loader overlay that pins DSH's in-browser directory picker. The shipped row
 * resolves to the native OS chooser on a loopback bind with a display, which a
 * Playwright page cannot drive (this mirrors DSH's own web test scaffold).
 */
const PICKER_PATCH = `- id: directory-picker
  disabled: true
- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: ui-directory-picker-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
`

/** A Harness home prepared for tests. */
export interface DshHome {
  readonly home: string
  /** Throwaway HOME for the process (no user files, no credentials). */
  readonly userHome: string
  /** The session workspace directory. */
  readonly workspace: string
  readonly pickerPatch: string
  /** Write an extra patch overlay and return its path. */
  patch(name: string, yaml: string): string
}

/** Proxy settings for registry installs only (the running Harness gets none). */
function registryEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const name of Object.keys(process.env)) {
    if (!/^(https?_proxy|no_proxy|node_extra_ca_certs|ssl_cert_file|npm_config_(https?_proxy|noproxy|cafile|registry|userconfig))$/i.test(name)) continue
    const value = process.env[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

function baseEnv(home: DshHome): NodeJS.ProcessEnv {
  return {
    // `dsh plugin add` runs pnpm, so the runner's PATH (which carries no credentials) is kept.
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
    HOME: home.userHome,
    DSH_HOME: home.home,
    LANG: 'C.UTF-8',
  }
}

/**
 * Create a Harness home and install bundles into the `web` profile.
 * @param bundles - repository package directories (link-installed, e.g. packages/dsh-adapter)
 *   or npm specifiers starting with `@` (installed from the registry).
 * @returns the home.
 */
export function prepareHome(bundles: readonly string[]): DshHome {
  const base = mkdtempSync(join(tmpdir(), 'hodos-e2e-'))
  const home: DshHome = {
    home: join(base, 'dsh-home'),
    userHome: join(base, 'user-home'),
    workspace: join(base, 'workspace'),
    pickerPatch: join(base, 'picker.yml'),
    patch(name, yaml) {
      const path = join(base, name)
      writeFileSync(path, yaml)
      return path
    },
  }
  for (const dir of [home.home, home.userHome, home.workspace]) mkdirSync(dir, { recursive: true })
  writeFileSync(home.pickerPatch, PICKER_PATCH)
  for (const bundle of bundles) {
    const target = bundle.startsWith('@') ? bundle : resolve(ROOT, bundle)
    const result = spawnSync(DSH_BIN, ['plugin', '--profile', 'web', 'add', target], { env: { ...baseEnv(home), ...registryEnv() }, encoding: 'utf8', timeout: 600_000 })
    if (result.status !== 0) throw new Error(`dsh plugin add ${bundle} failed:\n${result.stdout}\n${result.stderr}`)
  }
  return home
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

/** A running Harness. */
export interface DshProcess {
  /** The tokenized URL printed by `dsh web`. */
  readonly url: string
  readonly origin: string
  output(): string
  stop(): Promise<void>
}

/**
 * Launch `dsh --profile web` against the mock model.
 * @param home - the prepared home.
 * @param modelUrl - the mock model's base URL.
 * @param patches - extra overlays (the picker patch is always applied).
 * @returns the running Harness.
 */
export async function startDsh(home: DshHome, modelUrl: string, patches: readonly string[] = []): Promise<DshProcess> {
  const port = await freePort()
  const args = ['--profile', 'web', '--patch', home.pickerPatch, ...patches.flatMap(p => ['--patch', p]), '--no-open', '--port', String(port)]
  const child: ChildProcess = spawn(DSH_BIN, args, {
    cwd: home.workspace,
    env: { ...baseEnv(home), DEEPSEEK_API_KEY: 'mock-key', DEEPSEEK_BASE_URL: `${modelUrl}/v1` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  const url = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`dsh did not start within 90 s:\n${log}`)), 90_000)
    const read = (chunk: Buffer): void => {
      log += chunk.toString('utf8')
      const match = /dsh web: (\S+)/.exec(log)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        done(match[1])
      }
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.on('exit', code => {
      clearTimeout(timer)
      fail(new Error(`dsh exited with ${String(code)} before it was ready:\n${log}`))
    })
  })
  return {
    url,
    origin: new URL(url).origin,
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
