import { CORE_PLUGIN_API_VERSION, SDK_VERSION, createCordisEntry, uniformGrade, type HodosEnvironmentPlugin, type JsonValue } from '@hodos/plugin-sdk'

/** A string field of a JSON object; '' when the value is not an object or the field is not a string. */
function field(value: JsonValue, name: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
  const found = value[name]
  return typeof found === 'string' ? found : ''
}

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
          const right = field(input.response, 'text').trim().toLowerCase() === field(input.key, 'answer').toLowerCase()
          return uniformGrade(input.skills, right ? 1 : 0, { feedback: right ? 'Correct.' : 'Not quite.' })
        },
      })
      ctx.registerExerciseKind({
        id: 'capitals.name', title: 'Name the capital', environment: 'capitals.text',
        responseKind: 'text', interaction: 'single', grader: 'capitals.grader', format: { guessable: false },
        payloadSchema: { type: 'object', required: ['country'], properties: { country: { type: 'string' } } },
        keySchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } },
        responseSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 100 } } },
        fallbackText: payload => `What is the capital of ${field(payload, 'country')}?`,
      })
    },
  }
}

// DeepSeek Harness bundle entry: waits for the `hodos` service from @hodos/dsh.
const entry = createCordisEntry(createPlugin())
export const name = entry.name
export const inject = entry.inject
export const apply = entry.apply
