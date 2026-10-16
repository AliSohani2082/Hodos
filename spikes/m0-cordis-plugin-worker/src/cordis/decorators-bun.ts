// Bun-only probe: cordis 4 ships a TC39 (stage 3) `@Inject` class decorator. Node 24 cannot parse decorators (type stripping only), so this file is not part of the Bun-vs-Node diff.
//   bun run src/cordis/decorators-bun.ts
import { Context, Inject } from 'cordis'
import { LessonRegistry } from './registries.ts'

const ctx = new Context()
await ctx.plugin(LessonRegistry)
let applied = 0

@Inject('lesson')
class Decorated {
  constructor(c: Context) { applied++; c.lesson.block({ name: 'deco', version: 1, kind: 'leaf', body: 'none', attrs: {}, guidance: { when: '', syntax: '' }, fallback: { mode: 'hide', text: () => '' }, renderer: { entry: 'x', trust: 'sandboxed' } }) }
}
const f = ctx.plugin(Decorated as any)
await f
const ok = f.state === 2 && applied === 1 && ctx.lesson.blocks.has('deco')
await f.dispose()
console.log(JSON.stringify({ check: '@Inject class decorator on Bun', bun: (globalThis as any).Bun?.version, ok, state: f.state, applied, leftBehind: ctx.lesson.blocks.size }))
process.exit(ok && ctx.lesson.blocks.size === 0 ? 0 : 1)
