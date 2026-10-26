/**
 * The minimal plugin in the SDK README works as written: the README's code
 * block is this fixture, and it registers, grades and projects plain text.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PluginRegistry, SandboxRunner } from '@hodos/core'
import { apply, createPlugin, inject, name } from './fixtures/sdk-readme-plugin.js'

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }

describe('SDK README example', () => {
  it('is the code the README shows', () => {
    const readme = readFileSync(new URL('../../packages/plugin-sdk/README.md', import.meta.url), 'utf8')
    const block = /```ts\n([\s\S]*?)```/u.exec(readme)?.[1]
    expect(block).toBe(readFileSync(new URL('./fixtures/sdk-readme-plugin.ts', import.meta.url), 'utf8'))
  })

  it('registers, grades and gives a Cordis entry', async () => {
    const sandbox = new SandboxRunner()
    try {
      const registry = new PluginRegistry({ sandbox, logger: silent })
      await registry.register(createPlugin(), { trusted: true })
      const input = (text: string) => ({ kind: 'capitals.name', payload: { country: 'Peru' }, key: { answer: 'Lima' }, response: { text }, mode: 'practice' as const, skills: [{ skillId: 'geo.capitals', weight: 1 }], attempt: 1 })
      expect(await registry.grade(input(' lima '))).toMatchObject({ correct: true, score: 1 })
      expect(await registry.grade(input('Cusco'))).toMatchObject({ correct: false, feedback: 'Not quite.' })
      expect(registry.fallbackText('capitals.name', { country: 'Peru' })).toBe('What is the capital of Peru?')
      expect({ name, inject, apply: typeof apply }).toEqual({ name: 'hodos-environment:capitals', inject: ['hodos'], apply: 'function' })
    } finally {
      sandbox.dispose()
    }
  })
})
