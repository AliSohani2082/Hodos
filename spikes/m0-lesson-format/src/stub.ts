// Offline stand-in for the model: returns the task's gold lesson, with deterministic defects on some first
// attempts that the repair round then fixes. Exercises the whole pipeline without spending anything.
import { createHash } from 'node:crypto'
import type { CompleteRequest, CompleteResult, LlmClient } from './llm.ts'
import { print } from './print.ts'
import { goldDoc } from './synth.ts'
import { loadPack, TASKS } from './tasks.ts'
import type { Arm } from './types.ts'

const hash = (s: string) => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16)

export function breakLesson(arm: Arm, text: string, variant: number): string {
  const attempts: ((t: string) => string)[] =
    arm === 'markdoc'
      ? [
          (t) => { const i = t.indexOf('{% /perspective %}'); return i < 0 ? t : t.slice(0, i) + t.slice(i + '{% /perspective %}'.length) },
          (t) => t.replace(/type="(note|tip)"/, 'type="oops"'),
          (t) => t.replace(/\n\n/, '\n\n{% nope /%}\n\n'),
        ]
      : [
          (t) => { const c = /caption="/.exec(t); return c ? t.slice(0, c.index) + 'caption="He said \\"hi\\" and ' + t.slice(c.index + 'caption="'.length) : t },
          (t) => { const l = t.split('\n'); const i = l.lastIndexOf(':::'); if (i >= 0) l.splice(i, 1); return l.join('\n') },
          (t) => t.replace(/\n\n/, '\n\n:::nope\nx\n:::\n\n'),
        ]
  // Start from the chosen defect and fall through until the text actually changes.
  for (let k = 0; k < attempts.length; k++) {
    const out = attempts[(variant + k) % attempts.length]!(text)
    if (out !== text) return out
  }
  return text
}

export class StubLlm implements LlmClient {
  calls = 0
  constructor(private failRate = 0.35) {}

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.calls++
    const user = String(req.turns[0]!.content)
    const conceptId = /frontmatter concept id: ([\w.-]+)\)/.exec(user)?.[1]
    const task = TASKS.find((t) => t.concept_id === conceptId)
    if (!task) throw new Error(`stub: cannot identify task in prompt (concept id ${conceptId})`)
    const arm: Arm = req.system.includes('# Block syntax: Markdoc') ? 'markdoc' : 'directive'
    const repair = req.turns.length > 1
    const good = print(arm, goldDoc(task, loadPack(task.pack)))
    const h = hash(`${req.model}|${arm}|${task.id}`)
    const text = !repair && (h % 100) / 100 < this.failRate ? breakLesson(arm, good, h) : good
    const inChars = req.system.length + req.turns.reduce((n, t) => n + JSON.stringify(t.content).length, 0)
    return {
      text,
      stopReason: 'end_turn',
      usage: { input: Math.round(inChars / 3.5), output: Math.round(text.length / 3.5) + 3000, cacheWrite: 0, cacheRead: 0, thinking: 3000 },
      ms: 1,
      raw: text,
    }
  }
  async countTokens(_m: unknown, text: string) {
    return Math.round(text.length / 3.5)
  }
}
