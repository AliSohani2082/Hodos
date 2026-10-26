/**
 * A minimal stand-in for the Hodos workspace around one environment
 * renderer: the renderer's files are served with the adapter's real renderer
 * Content-Security-Policy into a `sandbox="allow-scripts"` iframe, and the
 * host page hands over one MessagePort and records every renderer message.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { expect } from 'vitest'
import type { Browser, FrameLocator, Page } from 'playwright'
import { RENDERER_CSP } from '@hodos/dsh'

const MIME: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

const HOST = (src: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>host</title></head><body>
<iframe id="f" sandbox="allow-scripts" src="${src}" style="width:480px;height:720px;border:0"></iframe>
<script>
window.received = [];
var port = null;
window.hostPost = function (m) { if (port) port.postMessage(m); };
document.getElementById('f').addEventListener('load', function () {
  var channel = new MessageChannel();
  port = channel.port1;
  channel.port1.onmessage = function (e) { window.received.push(e.data); };
  document.getElementById('f').contentWindow.postMessage({ type: 'hodos:connect', protocol: 1 }, '*', [channel.port2]);
});
</script></body></html>`

/** A running renderer host. */
export interface RendererHost {
  readonly base: string
  close(): Promise<void>
}

/**
 * Serve a built renderer directory.
 * @param root - the renderer's dist directory.
 * @param path - URL path it is served under, e.g. /hodos/env/hodos-math/math-view/.
 */
export async function startRendererHost(root: string, path: string): Promise<RendererHost> {
  if (!existsSync(join(root, 'renderer.js'))) throw new Error(`build the renderer first (pnpm build): ${root}`)
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(HOST(`${path}index.html`))
      return
    }
    if (url.pathname.startsWith(path)) {
      const file = normalize(join(root, decodeURIComponent(url.pathname.slice(path.length))))
      if (file.startsWith(root + sep) && existsSync(file)) {
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-security-policy': RENDERER_CSP })
        res.end(readFileSync(file))
        return
      }
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the renderer host has no port')
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(done => server.close(() => done())) }
}

/** Messages the renderer sent. */
export async function received(page: Page): Promise<Array<Readonly<Record<string, unknown>>>> {
  const raw = await page.evaluate('JSON.stringify(window.received)')
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : []
  return Array.isArray(parsed) ? parsed.filter((m): m is Readonly<Record<string, unknown>> => typeof m === 'object' && m !== null) : []
}

/** Send a host message to the renderer. */
export async function post(page: Page, message: object): Promise<void> {
  await page.evaluate(`window.hostPost(${JSON.stringify(message)})`)
}

/**
 * Open the host page, wait for the renderer's handshake and send init.
 * @param capabilities - what the host grants the renderer in init.
 * @returns the page, a locator for the renderer frame, and the page errors so far.
 */
export async function openRenderer(browser: Browser, host: RendererHost, environment: string, capabilities: readonly string[] = ['resize']): Promise<{ page: Page; frame: FrameLocator; errors: string[] }> {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(`${host.base}/`)
  await expect.poll(async () => (await received(page)).some(m => m.type === 'hodos:ready'), { timeout: 15_000 }).toBe(true)
  await post(page, { type: 'hodos:init', protocol: 1, environment, locale: 'en', colorScheme: 'light', capabilities })
  return { page, frame: page.frameLocator('#f'), errors }
}
