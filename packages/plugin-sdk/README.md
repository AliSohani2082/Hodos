# @hodos/plugin-sdk

Contracts, schemas and helpers for Hodos environment plugins: the code that teaches one domain (chess, a language, algebra, code) inside Hodos. MIT-licensed, so plugins can use it without taking on the AGPL obligations of the Hodos core.

A plugin contributes exercise kinds, graders, lesson blocks, presets, renderers and courses. It never touches learner state: graders return evidence, and Hodos decides mastery, checkpoints and what is released.

**Read the [plugin guide](../../docs/plugin-guide.md)** for the trust tiers, the renderer protocol, the grading rules and how to test a plugin.

## Entry points

| Import | For | Runs in |
|---|---|---|
| `@hodos/plugin-sdk` | Contracts (`HodosEnvironmentPlugin`, `ExerciseKindSpec`, `GraderSpec`, `LessonBlockSpec`, `RendererSpec`, `CourseSpec`…), schema and manifest validation, `uniformGrade`, `createCordisEntry` | Node |
| `@hodos/plugin-sdk/protocol` | Renderer protocol types and message parsers | Browser and Node |
| `@hodos/plugin-sdk/renderer` | `connectRenderer`: the renderer side of the handshake, with validated messages | Browser (inside the sandboxed iframe) |

## A minimal plugin

```ts
import { CORE_PLUGIN_API_VERSION, SDK_VERSION, createCordisEntry, uniformGrade, type HodosEnvironmentPlugin } from '@hodos/plugin-sdk'

export function createPlugin(): HodosEnvironmentPlugin {
  return {
    manifest: {
      id: 'capitals', version: '1.0.0', displayName: 'Capitals',
      requiresCore: `^${CORE_PLUGIN_API_VERSION}`, sdkVersion: SDK_VERSION, license: 'MIT',
      capabilities: { environments: ['capitals.text'], exerciseKinds: ['capitals.name'], graders: ['capitals.grader'] },
    },
    register(ctx) {
      ctx.registerGrader({
        id: 'capitals.grader', kinds: ['capitals.name'], method: 'deterministic',
        grade: input => {
          const typed = typeof input.response === 'object' && input.response !== null && !Array.isArray(input.response) ? String(input.response.text ?? '') : ''
          const answer = typeof input.key === 'object' && input.key !== null && !Array.isArray(input.key) ? String(input.key.answer ?? '') : ''
          const right = typed.trim().toLowerCase() === answer.toLowerCase()
          return uniformGrade(input.skills, right ? 1 : 0, { feedback: right ? 'Correct.' : 'Not quite.' })
        },
      })
      ctx.registerExerciseKind({
        id: 'capitals.name', title: 'Name the capital', environment: 'capitals.text',
        responseKind: 'text', interaction: 'single', grader: 'capitals.grader', format: { guessable: false },
        payloadSchema: { type: 'object', required: ['country'], properties: { country: { type: 'string' } } },
        keySchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } },
        responseSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 100 } } },
        fallbackText: payload => `What is the capital of ${typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? String(payload.country) : 'this country'}?`,
      })
    },
  }
}

// DeepSeek Harness bundle entry: waits for the `hodos` service from @hodos/dsh.
const entry = createCordisEntry(createPlugin())
export const name = entry.name
export const inject = entry.inject
export const apply = entry.apply
```

Its in-process grader runs only if the host trusts the plugin (`trustedPlugins`). A plugin for hosts that do not trust it ships its grader as a sandboxed source, or comes as a declarative directory: see [`examples/binary-numbers`](../../examples/binary-numbers).

## Versions

SDK 0.1.0, plugin API 0.1.0. The manifest, exercise, grading, lesson-block, preset, renderer and content contracts and the renderer protocol (version 1) are stable within plugin API 0.1. Content generators and the speech contracts are experimental.

## License

MIT. See [LICENSE](LICENSE).
