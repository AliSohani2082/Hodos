import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { CORE_PLUGIN_API_VERSION, HodosPluginError, SDK_VERSION, type GradeInput, type HodosEnvironmentPlugin } from '@hodos/plugin-sdk'
import { HodosError, loadDeclarativePlugin, PluginRegistry, SandboxRunner, type RegistryLogger } from '../src/index.js'
import { createQuizPlugin, quizCourse } from '@hodos/testing'

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())

function logger(): RegistryLogger & { lines: string[] } {
  const lines: string[] = []
  return { lines, info: m => lines.push(`info ${m}`), warn: m => lines.push(`warn ${m}`), error: m => lines.push(`error ${m}`) }
}

function registry(options: { hookTimeoutMs?: number; registerTimeoutMs?: number } = {}): { registry: PluginRegistry; log: ReturnType<typeof logger> } {
  const log = logger()
  return { registry: new PluginRegistry({ sandbox, logger: log, ...options }), log }
}

const item = quizCourse().items.find(i => i.id === 'add-t1')
if (item === undefined) throw new Error('fixture item missing')
const gradeInput: GradeInput = { kind: item.kind, payload: item.payload, key: item.key, response: { text: '5' }, mode: 'practice', skills: item.skills, attempt: 1 }

function sandboxedPlugin(source: string, spy?: () => void): HodosEnvironmentPlugin {
  return {
    manifest: {
      id: 'third-party', version: '1.0.0', displayName: 'Third party', requiresCore: `^${CORE_PLUGIN_API_VERSION}`, sdkVersion: SDK_VERSION,
      capabilities: { environments: ['tp.env'], exerciseKinds: ['tp.text'], graders: ['tp.grader'] },
    },
    register(ctx) {
      ctx.registerGrader({
        id: 'tp.grader', kinds: ['tp.text'], method: 'deterministic', sandbox: { source },
        // Present to prove the host never calls an untrusted plugin's in-process function.
        grade: () => { spy?.(); return { score: 1, correct: true, skillEvidence: [], misconceptions: [] } },
      })
      ctx.registerExerciseKind({
        id: 'tp.text', title: 'TP text', environment: 'tp.env', responseKind: 'text', interaction: 'single', grader: 'tp.grader',
        format: { guessable: false },
        payloadSchema: { type: 'object', properties: { prompt: { type: 'string' } } }, keySchema: { type: 'object' }, responseSchema: { type: 'object' },
        fallbackText: () => 'IN-PROCESS FALLBACK MUST NOT RUN',
      })
    },
  }
}

/** A plugin with a renderer that asks for every capability. */
function rendererPlugin(source: string): HodosEnvironmentPlugin {
  const base = sandboxedPlugin(source)
  const root = mkdtempSync(join(tmpdir(), 'hodos-renderer-'))
  writeFileSync(join(root, 'index.html'), '<!doctype html>')
  return {
    manifest: { ...base.manifest, capabilities: { ...base.manifest.capabilities, renderers: ['tp-view'] }, rendererPermissions: ['run-code', 'speech-synthesis'] },
    register(ctx) {
      ctx.registerRenderer({ id: 'tp-view', environments: ['tp.env'], root, entry: 'index.html', capabilities: ['respond', 'resize', 'speech-synthesis', 'run-code'] })
      return base.register(ctx)
    },
  }
}

describe('plugin registry', () => {
  it('security: grants running code in a renderer to trusted plugins only', async () => {
    const source = 'function grade(input) { return { score: 1, correct: true, skillEvidence: [], misconceptions: [] } }'
    const untrusted = registry().registry
    await untrusted.register(rendererPlugin(source), { trusted: false })
    expect(untrusted.renderer('tp-view')?.granted).toEqual(['respond', 'resize', 'speech-synthesis'])
    const trusted = registry().registry
    await trusted.register(rendererPlugin(source), { trusted: true })
    expect(trusted.renderer('tp-view')?.granted).toEqual(['respond', 'resize', 'speech-synthesis', 'run-code'])
  })

  it('security: draws an environment with a trusted plugin\'s renderer, even when a sandboxed one registered first', async () => {
    const source = 'function grade(input) { return { score: 1, correct: true, skillEvidence: [], misconceptions: [] } }'
    const { registry: r } = registry()
    await r.register(rendererPlugin(source), { trusted: false })
    expect(r.rendererFor('tp.env')?.pluginId).toBe('third-party')
    const root = mkdtempSync(join(tmpdir(), 'hodos-renderer-'))
    writeFileSync(join(root, 'index.html'), '<!doctype html>')
    await r.register({
      manifest: {
        id: 'built-in', version: '1.0.0', displayName: 'Built in', requiresCore: `^${CORE_PLUGIN_API_VERSION}`, sdkVersion: SDK_VERSION,
        capabilities: { environments: ['tp.env'], renderers: ['built-in-view'] },
      },
      register(ctx) {
        ctx.registerRenderer({ id: 'built-in-view', environments: ['tp.env'], root, entry: 'index.html', capabilities: ['respond', 'resize'] })
      },
    }, { trusted: true })
    expect(r.rendererFor('tp.env')?.pluginId).toBe('built-in')
  })

  it('registers a trusted plugin with all contributions', async () => {
    const { registry: r } = registry()
    await r.register(createQuizPlugin(), { trusted: true })
    expect(r.kind('quiz.choice')?.trusted).toBe(true)
    expect(r.block('quiz-note')).toBeDefined()
    expect(r.environments()).toEqual(['quiz.card'])
    expect(r.contentPacks().map(p => p.pack.id)).toEqual(['quiz-pack'])
    expect(r.graderInfo('quiz.text')).toEqual({ id: 'quiz.grader', method: 'deterministic', trusted: true })
  })

  it('rejects a duplicate plugin id and duplicate contributions', async () => {
    const { registry: r } = registry()
    await r.register(createQuizPlugin(), { trusted: true })
    await expect(r.register(createQuizPlugin(), { trusted: true })).rejects.toMatchObject({ code: 'DUPLICATE_REGISTRATION' })
    // Same kinds under another plugin id.
    await expect(r.register(createQuizPlugin({ id: 'quiz-copy' }), { trusted: true })).rejects.toMatchObject({ code: 'DUPLICATE_REGISTRATION' })
    expect(r.plugins().map(p => p.manifest.id)).toEqual(['hodos-quiz'])
  })

  it('is atomic: an undeclared contribution registers nothing and runs cleanup', async () => {
    const { registry: r } = registry()
    const disposed = vi.fn<() => void>()
    const plugin = createQuizPlugin()
    const sneaky: HodosEnvironmentPlugin = {
      manifest: plugin.manifest,
      async register(ctx) {
        await plugin.register(ctx)
        ctx.onDispose(disposed)
        ctx.registerPreset({ id: 'sneaky@1', title: 'Not declared' })
      },
    }
    const error = await r.register(sneaky, { trusted: true }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HodosPluginError)
    expect((error as HodosPluginError).code).toBe('UNDECLARED_CAPABILITY')
    expect(disposed).toHaveBeenCalledOnce()
    expect(r.kind('quiz.choice')).toBeUndefined()
    expect(r.plugins()).toEqual([])
  })

  it('refuses registrations made after register() returned', async () => {
    const { registry: r } = registry()
    let saved: Parameters<HodosEnvironmentPlugin['register']>[0] | undefined
    const plugin = createQuizPlugin()
    await r.register({ manifest: plugin.manifest, register(ctx) { saved = ctx; return plugin.register(ctx) } }, { trusted: true })
    expect(() => saved?.registerPreset({ id: 'late@1', title: 'late' })).toThrow(/only accepted during register/)
  })

  it('maps a failing register() to REGISTRATION_FAILED and an incompatible core to INCOMPATIBLE_CORE', async () => {
    const { registry: r } = registry()
    const plugin = createQuizPlugin()
    await expect(r.register({ manifest: plugin.manifest, register() { throw new Error('boom') } }, { trusted: true })).rejects.toMatchObject({ code: 'REGISTRATION_FAILED' })
    await expect(r.register({ manifest: { ...plugin.manifest, requiresCore: '^9.0.0' }, register: ctx => plugin.register(ctx) }, { trusted: true })).rejects.toMatchObject({ code: 'INCOMPATIBLE_CORE' })
    await expect(r.register({ manifest: { ...plugin.manifest, id: 'Bad Id' }, register: ctx => plugin.register(ctx) }, { trusted: true })).rejects.toMatchObject({ code: 'INVALID_MANIFEST' })
  })

  it('times out a register() that never settles', async () => {
    const { registry: r } = registry({ registerTimeoutMs: 50 })
    const plugin = createQuizPlugin()
    await expect(r.register({ manifest: plugin.manifest, register: () => new Promise<void>(() => {}) }, { trusted: true })).rejects.toMatchObject({ code: 'REGISTRATION_FAILED' })
  })

  it('unregisters every contribution, runs cleanup and notifies listeners', async () => {
    const { registry: r } = registry()
    const disposed = vi.fn<() => void>()
    const changes = vi.fn<() => void>()
    r.onChange(changes)
    const plugin = createQuizPlugin()
    const dispose = await r.register({ manifest: plugin.manifest, async register(ctx) { await plugin.register(ctx); ctx.onDispose(disposed) } }, { trusted: true })
    await dispose()
    await dispose()
    expect(disposed).toHaveBeenCalledOnce()
    expect(changes).toHaveBeenCalledTimes(2)
    expect(r.kind('quiz.choice')).toBeUndefined()
    expect(r.environments()).toEqual([])
    await expect(r.grade(gradeInput)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('requires an untrusted plugin to ship sandboxed graders', async () => {
    const { registry: r } = registry()
    await expect(r.register(createQuizPlugin(), { trusted: false })).rejects.toMatchObject({ code: 'INVALID_REGISTRATION' })
  })

  it('never calls an untrusted plugin\'s in-process functions', async () => {
    const { registry: r } = registry()
    const spy = vi.fn<() => void>()
    await r.register(sandboxedPlugin('function grade(input) { return { score: 1, correct: true, skillEvidence: [], misconceptions: [], feedback: "sandboxed" } }', spy), { trusted: false })
    const result = await r.grade({ ...gradeInput, kind: 'tp.text' })
    expect(result.feedback).toBe('sandboxed')
    expect(spy).not.toHaveBeenCalled()
    expect(r.fallbackText('tp.text', { prompt: 'Name a colour' })).toBe('[TP text] Name a colour')
  })

  it('keeps grader error text (which may quote the key) out of the error', async () => {
    const { registry: r, log } = registry()
    await r.register(createQuizPlugin({ throwWithKey: true }), { trusted: true })
    const error = await r.grade(gradeInput).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HodosError)
    expect((error as HodosError).message).toBe('grader quiz.grader failed; the attempt was not counted')
    expect((error as HodosError).message).not.toContain('5')
    expect((error as HodosError).details).toMatchObject({ grader: 'quiz.grader', reason: 'error' })
    expect(log.lines.some(l => l.includes('expected'))).toBe(true)
  })

  it('rejects malformed grades and evidence for untagged skills', async () => {
    const a = registry()
    await a.registry.register(createQuizPlugin({ malformed: true }), { trusted: true })
    await expect(a.registry.grade(gradeInput)).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'malformed-result' } })
    const b = registry()
    await b.registry.register(createQuizPlugin({ foreignSkill: true }), { trusted: true })
    await expect(b.registry.grade(gradeInput)).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'malformed-result' } })
  })

  it('times out a trusted grader that never returns', async () => {
    const { registry: r } = registry({ hookTimeoutMs: 50 })
    const plugin = createQuizPlugin()
    await r.register({
      manifest: plugin.manifest,
      async register(ctx) {
        await plugin.register({ ...ctx, registerGrader: spec => ctx.registerGrader({ ...spec, grade: () => new Promise(() => {}) }) })
      },
    }, { trusted: true })
    await expect(r.grade(gradeInput)).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'timeout' } })
  })

  it('validates items: schema, envelope and the plugin\'s semantic check', async () => {
    const { registry: r } = registry()
    await r.register(createQuizPlugin(), { trusted: true })
    const choice = quizCourse().items.find(i => i.kind === 'quiz.choice')
    if (choice === undefined) throw new Error('fixture')
    expect(await r.validateItem(choice)).toEqual([])
    const badKey = await r.validateItem({ ...choice, key: { correct: 'z' } })
    expect(badKey.map(d => d.code)).toContain('quiz/key')
    const badEnvelope = await r.validateItem({ ...choice, id: 'Bad Id', difficulty: 9, skills: [] })
    expect(badEnvelope.map(d => d.code)).toEqual(expect.arrayContaining(['item/bad-id', 'item/difficulty', 'item/no-skills']))
    const badPayload = await r.validateItem({ ...choice, payload: { prompt: 3 } })
    expect(badPayload.some(d => d.path?.startsWith('/payload'))).toBe(true)
  })
})

/** Run a grade hook in the sandbox. */
const call = (source: string, input: unknown = {}): Promise<unknown> => sandbox.call('grade', source, input)

describe('sandbox (QuickJS in a child process)', () => {

  it('runs a pure hook and round-trips tricky input safely', async () => {
    const tricky = { s: '"); throw new Error("x"); ("', line: '  ', html: '</script><script>', back: '\\', emoji: '♞' }
    await expect(call('function grade(input) { return input }', tricky)).resolves.toEqual(tricky)
  })

  it('exposes no Node, filesystem, network or environment', async () => {
    const out = await call(`function grade() {
      return { process: typeof process, require: typeof require, fetch: typeof fetch, module: typeof module,
        XMLHttpRequest: typeof XMLHttpRequest, setTimeout: typeof setTimeout, std: typeof std, os: typeof os,
        globals: Object.getOwnPropertyNames(globalThis).sort() }
    }`)
    expect(out).toMatchObject({ process: 'undefined', require: 'undefined', fetch: 'undefined', module: 'undefined', XMLHttpRequest: 'undefined', setTimeout: 'undefined', std: 'undefined', os: 'undefined' })
    const globals = (out as { globals: string[] }).globals
    expect(globals.filter(g => /process|require|fetch|import|std|os|fs/i.test(g))).toEqual([])
  })

  it('reports a guest error such as an attempt to require a module', async () => {
    await expect(call('function grade() { return require("fs").readFileSync("/etc/passwd", "utf8") }')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(call('var x = 1')).rejects.toThrow(/hook grade is not defined/)
  })

  it('stops an infinite loop at the CPU deadline', async () => {
    const started = Date.now()
    await expect(call('function grade() { for (;;) {} }')).rejects.toBeInstanceOf(HodosError)
    expect(Date.now() - started).toBeLessThan(5000)
    // The worker still serves later calls.
    await expect(call('function grade() { return 42 }')).resolves.toBe(42)
  })

  it('stops a memory bomb at the heap limit', async () => {
    await expect(call('function grade() { var a = []; for (;;) a.push(new Array(100000).fill("x")) }')).rejects.toBeInstanceOf(HodosError)
    await expect(call('function grade() { return "alive" }')).resolves.toBe('alive')
  })

  it('rejects oversized and non-JSON results', async () => {
    await expect(call('function grade() { return "x".repeat(300 * 1024) }')).rejects.toThrow(/oversized/)
    await expect(call('function grade() { return undefined }')).resolves.toBeNull()
    await expect(call('function grade() { return function () {} }')).resolves.toBeNull()
  })

  it('kills the worker at the wall-clock deadline and restarts it', async () => {
    const strict = new SandboxRunner({ cpuMs: 10_000, wallMs: 300, memoryBytes: 32 * 1024 * 1024, maxResultChars: 1024 })
    try {
      await expect(strict.call('grade', 'function grade() { for (;;) {} }', {})).rejects.toThrow(/exceeded 300 ms/)
      await expect(strict.call('grade', 'function grade() { return 7 }', {})).resolves.toBe(7)
    } finally {
      strict.dispose()
    }
  })
})

/** Write a plugin directory from file contents. */
function writePlugin(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hodos-decl-'))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

describe('declarative plugins', () => {
  const manifest = {
    id: 'decl-plugin', version: '1.0.0', displayName: 'Declarative', requiresCore: `^${CORE_PLUGIN_API_VERSION}`, sdkVersion: SDK_VERSION,
    capabilities: { environments: ['decl.env'], exerciseKinds: ['decl.text'], graders: ['decl.grader'] },
  }
  const description = (grader: string): string => JSON.stringify({
    manifest,
    exerciseKinds: [{
      id: 'decl.text', title: 'Declarative text', environment: 'decl.env', responseKind: 'text', interaction: 'single', grader: 'decl.grader',
      format: { guessable: false },
      payloadSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
      keySchema: { type: 'object', properties: { answer: { type: 'string' } } },
      responseSchema: { type: 'object', properties: { text: { type: 'string' } } },
      fallbackTemplate: 'Q: {{prompt}}',
    }],
    graders: [{ id: 'decl.grader', kinds: ['decl.text'], method: 'deterministic', sandbox: grader }],
  })
  const graderSource = `function grade(input) {
    var ok = String(input.response.text).trim().toLowerCase() === String(input.key.answer).toLowerCase()
    return { score: ok ? 1 : 0, correct: ok, skillEvidence: [], misconceptions: [] }
  }`

  it('loads data only and grades in the sandbox', async () => {
    const dir = writePlugin({ 'hodos-plugin.json': description('grader.js'), 'grader.js': graderSource })
    const plugin = await loadDeclarativePlugin(dir)
    const { registry: r } = registry()
    await r.register(plugin, { trusted: false, declarative: true })
    expect(r.fallbackText('decl.text', { prompt: 'Capital of Spain?' })).toBe('Q: Capital of Spain?')
    const grade = await r.grade({ kind: 'decl.text', payload: {}, key: { answer: 'Madrid' }, response: { text: ' madrid ' }, mode: 'practice', skills: [{ skillId: 'geo.capitals', weight: 1 }], attempt: 1 })
    expect(grade.correct).toBe(true)
    expect(grade.skillEvidence).toEqual([{ skillId: 'geo.capitals', score: 1 }])
  })

  it('security: builds text views from what the learner may see, never from server-only payload fields', async () => {
    const withSecret = JSON.parse(description('grader.js')) as { exerciseKinds: Array<{ payloadSchema: unknown; fallbackTemplate: string }> }
    const kind = withSecret.exerciseKinds[0]
    if (kind === undefined) throw new Error('fixture kind missing')
    kind.payloadSchema = { type: 'object', properties: { prompt: { type: 'string' }, note: { type: 'string', 'x-visibility': 'server' } } }
    kind.fallbackTemplate = 'Q: {{prompt}} {{note}}'
    const plugin = await loadDeclarativePlugin(writePlugin({ 'hodos-plugin.json': JSON.stringify(withSecret), 'grader.js': graderSource }))
    const { registry: r } = registry()
    await r.register(plugin, { trusted: false, declarative: true })
    expect(r.fallbackText('decl.text', { prompt: 'Capital of Spain?', note: 'answer: Madrid' })).toBe('Q: Capital of Spain? ')
  })

  /** The description with a renderer whose folder is `root`. */
  const withRenderer = (root: string): string => {
    const d = JSON.parse(description('grader.js')) as Record<string, unknown> & { manifest: { capabilities: Record<string, unknown> } }
    d.manifest.capabilities.renderers = ['decl-view']
    d.renderers = [{ id: 'decl-view', environments: ['decl.env'], root, entry: 'index.html' }]
    return JSON.stringify(d)
  }

  it('security: refuses a renderer folder that would serve the description, graders or content packs', async () => {
    const exposed = writePlugin({ 'hodos-plugin.json': withRenderer('.'), 'grader.js': graderSource, 'index.html': '<!doctype html>' })
    await expect(loadDeclarativePlugin(exposed)).rejects.toThrow(/keep the plugin description, graders and content packs outside renderer folders/)
    const separate = writePlugin({ 'hodos-plugin.json': withRenderer('view'), 'grader.js': graderSource, 'view/index.html': '<!doctype html>' })
    await expect(loadDeclarativePlugin(separate)).resolves.toBeDefined()
  })

  it('refuses paths that escape the plugin directory, including through symlinks', async () => {
    const escape = writePlugin({ 'hodos-plugin.json': description('../outside.js') })
    await expect(loadDeclarativePlugin(escape)).rejects.toMatchObject({ code: 'INVALID_CONTENT' })
    const outside = writePlugin({ 'secret.js': graderSource })
    const linked = writePlugin({ 'hodos-plugin.json': description('link.js') })
    symlinkSync(join(outside, 'secret.js'), join(linked, 'link.js'))
    await expect(loadDeclarativePlugin(linked)).rejects.toThrow(/outside the plugin directory/)
    const absolute = writePlugin({ 'hodos-plugin.json': description('/etc/passwd') })
    await expect(loadDeclarativePlugin(absolute)).rejects.toThrow(/must be relative/)
  })

  it('rejects unknown fields, executable-looking descriptions and oversized graders', async () => {
    const extra = writePlugin({ 'hodos-plugin.json': JSON.stringify({ manifest, main: 'index.js' }) })
    await expect(loadDeclarativePlugin(extra)).rejects.toMatchObject({ code: 'INVALID_CONTENT' })
    const big = writePlugin({ 'hodos-plugin.json': description('grader.js'), 'grader.js': `// ${'x'.repeat(600 * 1024)}\n${graderSource}` })
    await expect(loadDeclarativePlugin(big)).rejects.toThrow(/exceeds/)
  })
})
