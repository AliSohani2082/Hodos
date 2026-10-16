// Marker scan for the silent-failure metric (M4): which block openers does the *text* contain, independent of
// what the parser made of them. Fenced and inline code are blanked first so literal syntax in code samples is ignored.
import { REGISTRY } from './blocks.ts'
import type { Arm } from './types.ts'

export function stripCode(src: string): string {
  const out: string[] = []
  let fence: { ch: string; len: number } | null = null
  for (const line of src.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len && /^\s*(`{3,}|~{3,})\s*$/.test(line)) fence = null
      out.push('')
    } else if (m) {
      fence = { ch: m[1]![0]!, len: m[1]!.length }
      out.push('')
    } else {
      out.push(line.replace(/(`+)[^`\n]*?\1/g, ''))
    }
  }
  return out.join('\n')
}

export interface Marker {
  name: string
  line: number
}

export function markers(arm: Arm, src: string): Marker[] {
  const out: Marker[] = []
  const lines = stripCode(src).split('\n')
  lines.forEach((ln, i) => {
    if (arm === 'markdoc') {
      for (const m of ln.matchAll(/\{%\s*([a-z][\w-]*)/g)) out.push({ name: m[1]!, line: i + 1 })
    } else {
      const lead = /^[\s>]*:{2,}([a-z][\w-]*)/.exec(ln)
      if (lead) out.push({ name: lead[1]!, line: i + 1 })
      for (const m of ln.matchAll(/(?<![\w:]):([a-z][\w-]*)(?=[[{])/g)) {
        if (REGISTRY.has(m[1]!)) out.push({ name: m[1]!, line: i + 1 })
      }
    }
  })
  return out
}
