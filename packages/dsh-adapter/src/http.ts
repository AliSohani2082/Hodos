/**
 * HTTP surface under `/hodos`, mounted on the DSH web server:
 *
 * - `/hodos/api/v1/*`: the workspace's JSON API. Every request passes DSH's
 *   own Host/Origin checks and browser authentication; the authenticated
 *   owner maps to the local learner. State-changing requests must be JSON.
 * - `/hodos/app/*`: the workspace single-page app (first-party, same origin).
 * - `/hodos/env/<plugin>/<renderer>/*`: environment renderer files. They are
 *   served with `Content-Security-Policy: sandbox allow-scripts`, so a renderer
 *   document always runs in an opaque origin with no network access, even if
 *   opened directly.
 * @module @hodos/dsh/http
 */
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { HodosError, httpStatusOf, type Actor, type SelfReport } from '@hodos/core'
import type { JsonObject, JsonValue } from '@hodos/plugin-sdk'
import { isJsonValue } from '@hodos/plugin-sdk'
import type { HodosService } from './service.js'

export const API_PREFIX = '/hodos/api/v1'
export const APP_PREFIX = '/hodos/app'
export const ENV_PREFIX = '/hodos/env'

/** Largest accepted request body. */
export const MAX_BODY_BYTES = 64 * 1024

/** Content-Security-Policy of the workspace app. */
export const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"

/** Content-Security-Policy of renderer files: always sandboxed, no network. */
export const RENDERER_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/

/** Host services the HTTP layer needs. */
export interface HttpDeps {
  readonly hodos: HodosService
  /** DSH's request check: 401/403 to reject, undefined to accept. */
  readonly rejection: (req: IncomingMessage) => number | undefined
  /** A session became bound to a journey from the workspace. */
  readonly onBound: (sessionId: string) => void
  /** Directory of the built workspace app (index.html, assets). */
  readonly appDir: string | null
}

class BadRequest extends HodosError {
  constructor(message: string) {
    super('INVALID_INPUT', message)
  }
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text),
    ...extra,
  })
  res.end(text)
}

function sendError(res: ServerResponse, error: HodosError): void {
  const retry = error.details?.retryAfterSec
  send(res, httpStatusOf(error.code), { error: { code: error.code, message: error.message, ...(typeof retry === 'number' ? { retryAfterSec: retry } : {}) } },
    typeof retry === 'number' ? { 'retry-after': String(retry) } : {})
}

async function readJson(req: IncomingMessage): Promise<JsonObject> {
  const type = req.headers['content-type'] ?? ''
  // Requiring JSON keeps cross-site form posts out even before the Origin check.
  if (!/^application\/json\b/i.test(type)) throw new BadRequest('requests must be application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new BadRequest('request body is too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Malformed JSON is a client error; the parser's message adds nothing.
    throw new BadRequest('request body is not valid JSON')
  }
  if (!isJsonValue(parsed) || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new BadRequest('request body must be a JSON object')
  return parsed
}

function str(body: JsonObject, key: string, required: true): string
function str(body: JsonObject, key: string, required?: false): string | undefined
function str(body: JsonObject, key: string, required = false): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) {
    if (required) throw new BadRequest(`${key} is required`)
    return undefined
  }
  if (typeof value !== 'string' || value.length > 4000) throw new BadRequest(`${key} must be a string`)
  return value
}

function bool(body: JsonObject, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new BadRequest(`${key} must be true or false`)
  return value
}

function selfReports(value: JsonValue | undefined): SelfReport[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > 20) throw new BadRequest('selfReport must be a list')
  return value.map(entry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new BadRequest('selfReport entries must be objects')
    const level = entry.level
    if (level !== 'never' && level !== 'heard-of' && level !== 'used-it') throw new BadRequest('selfReport level must be never, heard-of or used-it')
    const skill = str(entry, 'skill')
    const skillId = str(entry, 'skillId')
    return { level, ...(skill === undefined ? {} : { skill }), ...(skillId === undefined ? {} : { skillId }) }
  })
}

function orNull<T>(read: () => T): T | null {
  try {
    return read()
  } catch (error) {
    if (error instanceof HodosError && error.code === 'NOT_FOUND') return null
    throw error
  }
}

/** Like {@link orNull}, for reads that fail while an environment plugin is missing. */
function unlessUnavailable<T>(read: () => T): T | null {
  try {
    return read()
  } catch (error) {
    if (error instanceof HodosError && error.code === 'UNAVAILABLE') return null
    throw error
  }
}

type Route = (actor: Actor, body: JsonObject, query: URLSearchParams) => unknown

function routes(deps: HttpDeps): Record<string, Route> {
  const { hodos } = deps
  const engine = hodos.engine
  const bound = (actor: Actor): void => { if (actor.sessionId !== undefined) deps.onBound(actor.sessionId) }
  return {
    'GET state': actor => {
      const journey = orNull(() => engine.journey(actor))
      return {
        journey,
        // A missing environment leaves the journey readable; the exercise waits until it is back.
        exercise: journey === null ? null : unlessUnavailable(() => engine.currentExercise(actor)),
        checkpoint: journey === null ? null : engine.checkpointStatus(actor),
        catalog: engine.catalog(),
        drafts: engine.drafts(),
      }
    },
    'POST journeys': (actor, body) => {
      const selfReport = selfReports(body.selfReport)
      const courseId = str(body, 'courseId')
      const environment = str(body, 'environment')
      const skipDiagnostic = bool(body, 'skipDiagnostic')
      const view = engine.startJourney(actor, {
        goal: str(body, 'goal', true),
        ...(courseId === undefined ? {} : { courseId }),
        ...(environment === undefined ? {} : { environment }),
        ...(selfReport === undefined ? {} : { selfReport }),
        ...(skipDiagnostic === undefined ? {} : { skipDiagnostic }),
      })
      bound(actor)
      return view
    },
    'POST journey/resume': actor => {
      const view = engine.resume(actor)
      if (view !== null) bound(actor)
      return view
    },
    'POST journey/approve': actor => engine.approvePath(actor),
    'POST journey/skip-diagnostic': actor => engine.skipDiagnostic(actor),
    'GET lesson': (actor, _body, query) => {
      const skillId = query.get('skill')
      return engine.lesson(actor, skillId === null ? {} : { skillId })
    },
    'POST lesson/check': (actor, body) => engine.answerCheck(actor, { lessonId: str(body, 'lessonId', true), checkId: str(body, 'checkId', true), optionId: str(body, 'optionId', true) }),
    'POST lesson/complete': actor => engine.completeLesson(actor),
    'POST exercise/next': actor => engine.nextExercise(actor),
    'POST exercise/hint': (actor, body) => engine.requestHint(actor, str(body, 'presentationId', true)),
    'POST exercise/submit': (actor, body) => {
      const response = body.response
      if (response === undefined) throw new BadRequest('response is required')
      const latency = body.latencyMs
      const confidence = body.confidence
      return engine.submitAttempt(actor, {
        presentationId: str(body, 'presentationId', true),
        response,
        ...(typeof latency === 'number' ? { latencyMs: latency } : {}),
        ...(confidence === 'sure' || confidence === 'unsure' ? { confidence } : {}),
      })
    },
    'POST checkpoint/start': actor => engine.startCheckpoint(actor),
    'GET checkpoint': actor => engine.checkpointStatus(actor),
    'POST review/start': actor => engine.startReview(actor),
    'GET progress': actor => engine.progress(actor),
    'GET catalog': () => engine.catalog(),
    'GET drafts': () => engine.drafts(),
    'POST drafts/decide': async (actor, body) => {
      const approve = bool(body, 'approve')
      if (approve === undefined) throw new BadRequest('approve is required')
      await engine.decideCourse(actor, { courseId: str(body, 'courseId', true), version: str(body, 'version', true), approve })
      return { ok: true }
    },
    'GET export': actor => engine.exportData(actor),
    'GET renderers': () => hodos.registry.environments().map(environment => {
      const r = hodos.registry.rendererFor(environment)
      return { environment, renderer: r === undefined ? null : { pluginId: r.pluginId, rendererId: r.spec.id, entry: r.spec.entry, capabilities: [...r.granted] } }
    }),
  }
}

/**
 * Serve one file from a directory, refusing anything outside it.
 * @returns false when the file does not exist (caller sends 404).
 */
function serveFile(res: ServerResponse, root: string, requested: string, headers: Record<string, string>): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(requested)
  } catch {
    // A malformed escape cannot name a real file.
    return false
  }
  if (decoded.includes('\0')) return false
  const realRoot = realpathSync(root)
  const target = resolve(realRoot, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`)
  const lexical = relative(realRoot, target)
  if (lexical.startsWith('..') || isAbsolute(lexical) || !existsSync(target)) return false
  const real = realpathSync(target)
  const rel = relative(realRoot, real)
  if (rel.startsWith('..') || isAbsolute(rel)) return false
  const info = statSync(real)
  if (!info.isFile()) return false
  const type = MIME[extname(real).toLowerCase()]
  if (type === undefined) return false
  res.writeHead(200, { 'content-type': type, 'content-length': info.size, 'x-content-type-options': 'nosniff', ...headers })
  createReadStream(real).pipe(res)
  return true
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' })
  res.end('Not found')
}

/**
 * Create the `/hodos` request handler.
 * @param deps - Hodos service, DSH request check and callbacks.
 * @returns the handler for `ctx.webServer.register`.
 */
export function createHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const table = routes(deps)
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://hodos.invalid')
    const path = url.pathname

    if (path.startsWith(`${ENV_PREFIX}/`)) {
      // Static renderer files: public plugin assets, sandboxed by CSP.
      if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res)
      const [pluginId, rendererId, ...rest] = path.slice(ENV_PREFIX.length + 1).split('/')
      const renderer = rendererId === undefined ? undefined : deps.hodos.registry.renderer(rendererId)
      if (renderer === undefined || renderer.pluginId !== pluginId || rest.length === 0) return notFound(res)
      const served = serveFile(res, renderer.spec.root, rest.join('/'), {
        'content-security-policy': RENDERER_CSP,
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
        'cache-control': 'no-cache',
        'referrer-policy': 'no-referrer',
      })
      if (!served) notFound(res)
      return
    }

    const rejection = deps.rejection(req)
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(rejection === 401 ? 'Unauthorized' : 'Forbidden')
      return
    }

    if (path === APP_PREFIX || path.startsWith(`${APP_PREFIX}/`)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res)
      if (deps.appDir === null) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('The Hodos workspace app is not built. Run `pnpm build` in the Hodos repository.')
        return
      }
      const rest = path.slice(APP_PREFIX.length)
      const file = rest === '' || rest === '/' ? '/index.html' : rest
      const served = serveFile(res, deps.appDir, file, {
        'content-security-policy': APP_CSP,
        'referrer-policy': 'same-origin',
        'cache-control': 'no-cache',
      })
      if (!served) notFound(res)
      return
    }

    if (!path.startsWith(`${API_PREFIX}/`)) return notFound(res)
    const route = table[`${req.method ?? 'GET'} ${path.slice(API_PREFIX.length + 1)}`]
    if (route === undefined) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'no such Hodos API route' } })
    try {
      const sessionParam = url.searchParams.get('session')
      if (sessionParam !== null && sessionParam !== '' && !SESSION_ID.test(sessionParam)) throw new BadRequest('invalid session id')
      const actor = deps.hodos.uiActor(sessionParam === null || sessionParam === '' ? undefined : sessionParam)
      const body = req.method === 'POST' ? await readJson(req) : {}
      const result = await route(actor, body, url.searchParams)
      send(res, 200, { data: result ?? null })
    } catch (error) {
      if (error instanceof HodosError) return sendError(res, error)
      // Unexpected failures are logged; the client gets no internals.
      deps.hodos.logger.error(`API ${req.method ?? ''} ${path} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      send(res, 500, { error: { code: 'INTERNAL', message: 'Hodos could not complete this request.' } })
    }
  }
}
