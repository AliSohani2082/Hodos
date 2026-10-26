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
