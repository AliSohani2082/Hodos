import { describe, expect, it, vi } from 'vitest'
import {
  CORE_PLUGIN_API_VERSION,
  SDK_VERSION,
  compileSchema,
  createCordisEntry,
  defineEnvironmentPlugin,
  isJsonValue,
  parseHostMessage,
  parseRendererMessage,
  serverOnlyPaths,
  stripServerFields,
  uniformGrade,
  validateManifest,
  type HodosEnvironmentHost,
  type HodosEnvironmentManifest,
  type JsonSchema,
} from '@hodos/plugin-sdk'
import { connectRenderer, type PortLike } from '@hodos/plugin-sdk/renderer'

const manifest: HodosEnvironmentManifest = {
  id: 'hodos-sample',
  version: '1.0.0',
  displayName: 'Sample',
  requiresCore: '^0.1.0',
  sdkVersion: SDK_VERSION,
  capabilities: { exerciseKinds: ['sample.choice'], graders: ['sample.grader'] },
}

describe('manifest validation', () => {
  it('accepts a valid, compatible manifest', () => {
    expect(validateManifest(manifest, CORE_PLUGIN_API_VERSION)).toEqual([])
  })

  it('rejects missing required fields and unknown properties', () => {
    const { displayName: _omit, ...missing } = manifest
    expect(validateManifest(missing).map(d => d.code)).toContain('manifest/schema')
    expect(validateManifest({ ...manifest, trust: 'first-party' }).length).toBeGreaterThan(0)
  })

  it('rejects malformed ids and versions', () => {
    expect(validateManifest({ ...manifest, id: 'Bad Id' }).length).toBeGreaterThan(0)
    expect(validateManifest({ ...manifest, version: 'one.two' }).map(d => d.code)).toContain('manifest/version')
  })

  it('rejects a plugin built for an incompatible core', () => {
    const findings = validateManifest({ ...manifest, requiresCore: '^2.0.0' }, CORE_PLUGIN_API_VERSION)
    expect(findings.map(d => d.code)).toEqual(['manifest/incompatible-core'])
  })

  it('rejects undeclared capability groups', () => {
    expect(validateManifest({ ...manifest, capabilities: { estimators: ['x'] } }).length).toBeGreaterThan(0)
  })
})

describe('renderer protocol parsing (security)', () => {
  it('accepts well-formed renderer messages', () => {
    expect(parseRendererMessage({ type: 'hodos:ready', protocol: 1 })).toEqual({ type: 'hodos:ready', protocol: 1 })
    expect(parseRendererMessage({ type: 'hodos:response', exerciseId: 'p1', response: { move: 'Nc7+' } }))
      .toEqual({ type: 'hodos:response', exerciseId: 'p1', response: { move: 'Nc7+' } })
    expect(parseRendererMessage({ type: 'hodos:resize', height: 420.4 })).toEqual({ type: 'hodos:resize', height: 420 })
  })

  it('rejects unknown types, extra fields, functions and oversized payloads', () => {
    expect(parseRendererMessage({ type: 'hodos:grade', score: 1 })).toBeNull()
    expect(parseRendererMessage({ type: 'hodos:response', exerciseId: 'p1', response: 'x', mastered: true })).toBeNull()
    expect(parseRendererMessage({ type: 'hodos:response', exerciseId: 'p1', response: () => 1 })).toBeNull()
    expect(parseRendererMessage({ type: 'hodos:response', exerciseId: 'p1', response: 'x'.repeat(70_000) })).toBeNull()
    expect(parseRendererMessage({ type: 'hodos:resize', height: Number.NaN })).toBeNull()
    expect(parseRendererMessage('hodos:ready')).toBeNull()
    expect(parseRendererMessage(null)).toBeNull()
  })

  it('does not let a crafted __proto__ key pollute prototypes', () => {
    const crafted: unknown = JSON.parse('{"type":"hodos:response","exerciseId":"p1","response":{"__proto__":{"polluted":true}}}')
    parseRendererMessage(crafted)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('parses host messages field by field', () => {
    const exercise = {
      id: 'x1', itemId: 'i1', kind: 'k', environment: 'env', skills: [{ skillId: 's', weight: 1 }],
      difficulty: 0, payload: { q: 1 }, mode: 'practice', hintsAvailable: 5, attempt: 1,
    }
    expect(parseHostMessage({ type: 'hodos:present', exercise })).toEqual({ type: 'hodos:present', exercise })
    expect(parseHostMessage({ type: 'hodos:present', exercise: { ...exercise, mode: 'cheat' } })).toBeNull()
    expect(parseHostMessage({ type: 'hodos:init', protocol: 1, environment: 'e', locale: 'en', colorScheme: 'light', capabilities: ['respond', 'eval'] })).toBeNull()
  })
})

describe('schema projection', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, text: { type: 'string' }, rationale: { type: 'string', 'x-visibility': 'server' } },
        },
      },
      answer: { type: 'string', 'x-visibility': 'server' },
    },
  }

  it('removes server-only fields at every depth and drops undeclared fields', () => {
    const value = {
      question: 'Q?',
      answer: 'a',
      sneaky: 'leak',
      options: [{ id: 'a', text: 'A', rationale: 'because' }],
    }
    expect(stripServerFields(schema, value)).toEqual({ question: 'Q?', options: [{ id: 'a', text: 'A' }] })
    expect(serverOnlyPaths(schema).toSorted()).toEqual(['/answer', '/options/*/rationale'])
  })

  it('keeps open objects when the schema says so', () => {
    expect(stripServerFields({ type: 'object', additionalProperties: true }, { a: 1, b: { c: 2 } })).toEqual({ a: 1, b: { c: 2 } })
  })

  it('compiles schemas with the visibility keyword and rejects invalid schemas', () => {
    const validate = compileSchema(schema, 'test/payload')
    expect(validate({ question: 'Q', options: [], answer: 'a' })).toEqual([])
    expect(validate({ question: 3 }).length).toBeGreaterThan(0)
    expect(validate({ question: Number.POSITIVE_INFINITY }).length).toBeGreaterThan(0)
    expect(() => compileSchema({ type: 'strng' }, 'bad')).toThrowError(/invalid JSON Schema/)
  })
})

describe('helpers', () => {
  it('isJsonValue rejects class instances, cycles and non-finite numbers', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(isJsonValue(new Date())).toBe(false)
    expect(isJsonValue(cyclic)).toBe(false)
    expect(isJsonValue({ a: [1, 'b', null, { c: true }] })).toBe(true)
    expect(isJsonValue(Number.NaN)).toBe(false)
  })

  it('uniformGrade clamps scores and tags every skill', () => {
    const grade = uniformGrade([{ skillId: 'a', weight: 1 }, { skillId: 'b', weight: 0.5 }], 1.7)
    expect(grade.score).toBe(1)
    expect(grade.correct).toBe(true)
    expect(grade.skillEvidence).toEqual([{ skillId: 'a', score: 1 }, { skillId: 'b', score: 1 }])
  })

  it('createCordisEntry registers through the hodos service inside an effect', async () => {
    const dispose = vi.fn<() => Promise<void>>(async () => {})
    const registerEnvironment = vi.fn<HodosEnvironmentHost['registerEnvironment']>(async () => dispose)
    const plugin = defineEnvironmentPlugin({ manifest, register: () => {} })
    const entry = createCordisEntry(plugin)
    expect(entry.inject).toEqual(['hodos'])
    let effect: (() => Promise<() => Promise<void>>) | undefined
    entry.apply({ hodos: { registerEnvironment }, effect: execute => { effect = execute } })
    expect(effect).toBeDefined()
    const disposer = await effect!()
    expect(registerEnvironment).toHaveBeenCalledWith(plugin)
    await disposer()
    expect(dispose).toHaveBeenCalledOnce()
  })
})

/** A window that records its message listener, and a way to deliver messages to it. */
function fakeWindow() {
  const parent = {}
  let listener: ((event: { data: unknown; source: unknown; ports: readonly PortLike[] }) => void) | undefined
  return {
    win: { parent, addEventListener: (_type: 'message', l: typeof listener) => { listener = l } },
    deliver: (data: unknown, source: unknown, ports: PortLike[]) => listener?.({ data, source, ports }),
    parent,
  }
}

describe('renderer handshake', () => {

  it('accepts the port only from the parent and dispatches validated messages', async () => {
    const { win, deliver, parent } = fakeWindow()
    const sent: unknown[] = []
    const listeners: Array<(event: { readonly data: unknown }) => void> = []
    let started = false
    const port: PortLike = { postMessage: m => { sent.push(m) }, addEventListener: (_type, l) => { listeners.push(l) }, start: () => { started = true } }
    const send = (data: unknown): void => { for (const l of listeners) l({ data }) }
    const presented: string[] = []
    const pending = connectRenderer(win, { onPresent: ex => presented.push(ex.id) })
    deliver({ type: 'hodos:connect', protocol: 1 }, {}, [port])
    expect(listeners).toHaveLength(0)
    deliver({ type: 'hodos:connect', protocol: 1 }, parent, [port])
    const connection = await pending
    expect(started).toBe(true)
    expect(sent).toEqual([{ type: 'hodos:ready', protocol: 1 }])
    send({ type: 'hodos:present', exercise: { id: 'bad' } })
    send({
      type: 'hodos:present',
      exercise: { id: 'x1', itemId: 'i1', kind: 'k', environment: 'e', skills: [], difficulty: 0, payload: null, mode: 'practice', hintsAvailable: 0, attempt: 1 },
    })
    expect(presented).toEqual(['x1'])
    connection.respond('x1', { answer: 'a' })
    expect(sent[1]).toEqual({ type: 'hodos:response', exerciseId: 'x1', response: { answer: 'a' } })
  })
})
