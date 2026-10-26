/**
 * Hodos for DeepSeek Harness. Mounts, as Cordis sub-plugins:
 *
 * - the `hodos` service (database, registry, sandbox, engine);
 * - the tutor tools and tutor-session handling (needs `tools`, `agents`);
 * - the prompt section and learner context (needs `systemPrompt`);
 * - the workspace routes (needs `webServer`, `connection`);
 * - optional course drafting through subagents (needs `subagents`).
 *
 * Each sub-plugin waits for its DSH services, so Hodos degrades instead of
 * failing in compositions that lack one (for example headless runs without
 * a web server).
 * @module @hodos/dsh
 */
// Type augmentations of the DSH services Hodos uses (connection, webServer, subagents).
/// <reference types="@deepseek-ai/dsh-client-connection" />
/// <reference types="@deepseek-ai/dsh-host-webserver" />
/// <reference types="@deepseek-ai/dsh-subagent" />
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Config, type HodosConfig } from './config.js'
import { draftCourseTool } from './delegate.js'
import { createHandler } from './http.js'
import { registerPrompt } from './prompt.js'
import { HodosService } from './service.js'
import { globalTools, sessionTools } from './tools.js'
import { TutorSessions } from './tutor-sessions.js'

export { Config }
export type { HodosConfig }
export { HodosService } from './service.js'
export { GLOBAL_TOOL_NAMES, SESSION_TOOL_NAMES } from './tools.js'
export { noticeFor } from './tutor-sessions.js'
export { API_PREFIX, APP_PREFIX, ENV_PREFIX, APP_CSP, RENDERER_CSP } from './http.js'

/** Cordis plugin name. */
export const name = 'hodos'

/**
 * Directory of the built workspace app: `app/` next to the bundled plugin
 * (tarball installs) or the `@hodos/ui` package's `dist/` (workspace installs).
 * @returns the directory, or null when the app is not built.
 */
export function findAppDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [resolve(here, '../app'), resolve(here, '../../ui/dist')]
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.resolve('@hodos/ui/package.json'))), 'dist'))
  } catch {
    // Tarball installs bundle the app instead of depending on @hodos/ui.
  }
  return candidates.find(dir => existsSync(join(dir, 'index.html'))) ?? null
}

function toolsPlugin(ctx: Context): void {
  const hodos = ctx.hodos
  const sessions = new TutorSessions(ctx, hodos, () => sessionTools(hodos))
  sessions.listen()
  ctx.effect(() => hodos.onBound(sessionId => sessions.activate(sessionId)), 'hodos tutor sessions')
  for (const tool of globalTools(hodos, { onBound: sessionId => hodos.notifyBound(sessionId) })) {
    ctx.effect(() => {
      const unregister = ctx.tools.register(tool)
      const untrack = hodos.trackGlobalTool(tool.name)
      return () => { untrack(); unregister() }
    }, `hodos tool ${tool.name}`)
  }
  // Sessions already bound before this plugin (re)loaded become tutor sessions again.
  for (const agent of ctx.agents.list()) if (hodos.isTutorSession(String(agent.id))) sessions.activate(String(agent.id))
}
toolsPlugin.inject = ['hodos', 'tools', 'agents']

function promptPlugin(ctx: Context): void {
  registerPrompt(ctx, ctx.hodos)
}
promptPlugin.inject = ['hodos', 'systemPrompt']

function webPlugin(ctx: Context): void {
  const handler = createHandler({
    hodos: ctx.hodos,
    rejection: req => ctx.connection.requestRejection({ headers: req.headers }),
    onBound: sessionId => ctx.hodos.notifyBound(sessionId),
    appDir: findAppDir(),
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/hodos', handler }), 'hodos routes')
}
webPlugin.inject = ['hodos', 'webServer', 'connection']

function delegatePlugin(ctx: Context): void {
  const hodos = ctx.hodos
  const tool = draftCourseTool(hodos, ctx.subagents)
  ctx.effect(() => {
    const unregister = ctx.tools.register(tool)
    const untrack = hodos.trackGlobalTool(tool.name)
    return () => { untrack(); unregister() }
  }, 'hodos tool hodos_draft_course')
}
delegatePlugin.inject = ['hodos', 'tools', 'subagents']

/**
 * Plugin entry.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: HodosConfig): void {
  ctx.plugin(HodosService, config)
  ctx.plugin(toolsPlugin)
  ctx.plugin(promptPlugin)
  ctx.plugin(webPlugin)
  ctx.plugin(delegatePlugin)
}
