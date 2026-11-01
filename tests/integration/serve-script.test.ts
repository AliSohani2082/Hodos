/**
 * The self-hosting launcher (`deploy/serve.sh`): what it passes to
 * DeepSeek Harness and what it refuses. Runs the script in dry-run mode, so no
 * Harness is needed.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SERVE = fileURLToPath(new URL('../../deploy/serve.sh', import.meta.url))
const INSTALL = fileURLToPath(new URL('../../deploy/install.sh', import.meta.url))

interface Run { readonly code: number; readonly out: string; readonly err: string }

function run(script: string, env: Record<string, string>, args: readonly string[] = []): Run {
  const result = spawnSync('bash', [script, ...args], {
    // A clean environment: whatever the machine running the test has set must not leak in.
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent', ...env },
    encoding: 'utf8',
  })
  return { code: result.status ?? -1, out: result.stdout, err: result.stderr }
}

function serve(env: Record<string, string>): Run {
  return run(SERVE, { HODOS_DRY_RUN: '1', HODOS_HOST: '10.9.8.7', ...env })
}

describe.skipIf(process.platform === 'win32')('deploy/serve.sh', () => {
  it('listens on one concrete address and does not open a browser', () => {
    const r = serve({ HODOS_ALLOW_PLAIN_HTTP: '1' })
    expect(r.code).toBe(0)
    expect(r.out.trim()).toBe('dsh --profile web --no-open --host 10.9.8.7 --port 8787')
  })

  it('trusts the host of the public address, and the hosts it is told to', () => {
    const r = serve({ HODOS_PUBLIC_URL: 'https://box.example:8443/hodos/', HODOS_TRUSTED_HOSTS: ' alt.example , 10.0.0.5:9000 ,' })
    expect(r.code).toBe(0)
    expect(r.out.trim()).toBe('dsh --profile web --no-open --host 10.9.8.7 --port 8787 --public-url https://box.example:8443/hodos/ --trusted-host box.example:8443 --trusted-host alt.example --trusted-host 10.0.0.5:9000')
  })

  it('serves HTTPS from a certificate and key, and only with both', () => {
    const files = { HODOS_TLS_CERT: SERVE, HODOS_TLS_KEY: INSTALL }
    const r = serve(files)
    expect(r.code).toBe(0)
    expect(r.out).toContain(`--tls-cert ${SERVE} --tls-key ${INSTALL}`)
    expect(serve({ HODOS_TLS_CERT: SERVE })).toMatchObject({ code: 1, err: expect.stringContaining('set both HODOS_TLS_CERT and HODOS_TLS_KEY') as unknown })
    expect(serve({ HODOS_TLS_CERT: SERVE, HODOS_TLS_KEY: '/no/such/key.pem' }).err).toContain('cannot read HODOS_TLS_KEY')
  })

  it('security: refuses plain HTTP on a network address unless that was chosen', () => {
    const refused = serve({})
    expect(refused.code).toBe(1)
    expect(refused.out).toBe('')
    expect(refused.err).toContain('refusing to serve plain HTTP on 10.9.8.7')
    const choices: Array<Record<string, string>> = [
      { HODOS_ALLOW_PLAIN_HTTP: '1' },
      { HODOS_PUBLIC_URL: 'https://box.example/' },
      { HODOS_TLS_CERT: SERVE, HODOS_TLS_KEY: INSTALL },
      { HODOS_HOST: '127.0.0.1' },
      { HODOS_LOCAL_ONLY: '1' },
    ]
    for (const choice of choices) expect(serve(choice).code, JSON.stringify(choice)).toBe(0)
    // An http:// public address is no protection.
    expect(serve({ HODOS_PUBLIC_URL: 'http://box.example/' }).code).toBe(1)
  })

  it('security: never listens on every address, and trusts no wildcard', () => {
    for (const host of ['0.0.0.0', '::', '[::]']) {
      const r = serve({ HODOS_HOST: host, HODOS_ALLOW_PLAIN_HTTP: '1' })
      expect(r.code, host).toBe(1)
      expect(r.err).toContain('does not listen on all addresses')
    }
    for (const entry of ['*.example', 'https://box.example', 'box.example/path', 'a b']) {
      const r = serve({ HODOS_ALLOW_PLAIN_HTTP: '1', HODOS_TRUSTED_HOSTS: entry })
      expect(r.code, entry).toBe(1)
      expect(r.err).toContain('is not a host name or address')
    }
  })

  it('rejects a public address with credentials, a query or no host, and a bad port', () => {
    for (const url of ['https://user:pass@box.example/', 'https://box.example/?x=1', 'ftp://box.example/', 'box.example', 'https:///path']) {
      expect(serve({ HODOS_ALLOW_PLAIN_HTTP: '1', HODOS_PUBLIC_URL: url }).code, url).toBe(1)
    }
    for (const port of ['0', '70000', 'abc', '80 80']) expect(serve({ HODOS_ALLOW_PLAIN_HTTP: '1', HODOS_PORT: port }).code, port).toBe(1)
  })

  it('listens on this machine only when asked, whatever address it was given', () => {
    const r = run(SERVE, { HODOS_DRY_RUN: '1', HODOS_LOCAL_ONLY: '1', HODOS_HOST: '10.9.8.7' })
    expect(r.out.trim()).toBe('dsh --profile web --no-open --host 127.0.0.1 --port 8787')
  })

  it('finds a network address of this machine by itself when none is given', () => {
    const r = run(SERVE, { HODOS_DRY_RUN: '1', HODOS_ALLOW_PLAIN_HTTP: '1' })
    // A machine with no network address has nothing to find; the script then says so.
    const found = r.code === 0 ? r.out : r.err
    expect(found).toMatch(/--host (?!127\.)\d+\.\d+\.\d+\.\d+ --port 8787|found no network address to listen on/u)
  })

  it('names what is missing when the Harness is not installed', () => {
    const r = run(SERVE, { HODOS_HOST: '127.0.0.1', DSH_PREFIX: '/no/such/prefix' })
    expect(r.code).toBe(1)
    expect(r.err).toContain('DeepSeek Harness is not installed')
  })
})

describe.skipIf(process.platform === 'win32')('deploy/install.sh', () => {
  it('refuses a plugin it does not know, and tells when nothing is installed yet', () => {
    expect(run(INSTALL, { DSH_PREFIX: '/no/such/prefix' }, ['plugins']).err).toContain('DeepSeek Harness is not installed')
    expect(run(INSTALL, {}, ['frobnicate']).err).toContain('usage: deploy/install.sh')
  })
})
