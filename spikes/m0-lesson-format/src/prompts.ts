// Prompt assembly (§8.2): the same base rules, block list, task text and source pack for both arms; only the
// syntax section, the per-block syntax examples and the two canonical lessons differ (translated, ±10% length).
import { readFileSync } from 'node:fs'
import { BLOCKS } from './blocks.ts'
import { formatDiagnostics } from './validate.ts'
import type { Arm, Diagnostic, SourcePack, Task } from './types.ts'

const read = (rel: string) => readFileSync(new URL(`../prompts/${rel}`, import.meta.url), 'utf8').trimEnd()

export const FRAME = { markdoc: 'markdoc', directive: 'markdown' } as const

export function syntaxSection(arm: Arm): string {
  return read(`syntax.${arm}.md`)
}
export function examples(arm: Arm): string[] {
  return [read(`example-1.${arm}.md`), read(`example-2.${arm}.md`)]
}

const fence = (lang: string, body: string) => `\`\`\`\`\`${lang}\n${body}\n\`\`\`\`\``

export function blockCatalog(arm: Arm, allowed: string[]): string {
  const parts: string[] = ['# Blocks available in this course']
  for (const b of BLOCKS) {
    if (!allowed.includes(b.name)) continue
    const lines = [`## ${b.name} (${b.kind})`, `Use when: ${b.guidance.when}`, 'Rules:', ...b.guidance.rules.map((r) => `- ${r}`)]
    if (b.guidance.avoid?.length) lines.push('Avoid:', ...b.guidance.avoid.map((r) => `- ${r}`))
    lines.push('Syntax:', fence(FRAME[arm], b.syntax[arm]))
    const alt = b.alt?.[arm]
    if (alt) lines.push(alt.note, fence(FRAME[arm], alt.example))
    parts.push(lines.join('\n'))
  }
  return parts.join('\n\n')
}

export function systemPrompt(arm: Arm, allowed: string[]): string {
  const ex = examples(arm)
  return [
    read('base.md'),
    syntaxSection(arm),
    blockCatalog(arm, allowed),
    '# Example lessons',
    'These show the file format in full. They use made-up source ids, and they use blocks your course may not have: use only the blocks in your task.',
    `## Example 1\n\n${fence(FRAME[arm], ex[0]!)}`,
    `## Example 2\n\n${fence(FRAME[arm], ex[1]!)}`,
  ].join('\n\n')
}

export function taskPrompt(task: Task, pack: SourcePack): string {
  const chunks = pack.chunks.filter((c) => task.chunkIds.includes(c.id))
  const outlets = [...new Set(chunks.map((c) => c.outlet))]
  const title = (o: string) => pack.sources.find((s) => s.outlet === o)?.title ?? o
  const checklist = task.checklist.map((c) => `- at least ${c.min} ${c.block} block${c.min === 1 ? '' : 's'}${c.note ? `: ${c.note}` : ''}`)
  return [
    '# Task',
    `Concept: ${task.concept} (frontmatter concept id: ${task.concept_id})`,
    `Learner level: ${task.level}`,
    `Course layout: ${task.layout}`,
    `Target length: about ${task.targetWords} words of prose, not counting block attributes`,
    `Blocks you may use: ${task.allowed.join(', ')}`,
    'Required in the lesson:',
    ...checklist,
    ...(task.brief ? ['', task.brief] : []),
    '',
    '# Source pack',
    `Outlets: ${outlets.map((o) => `${o} (${title(o)})`).join('; ')}`,
    '',
    ...chunks.map((c) => `## ${c.id} (outlet ${c.outlet}, ${c.title})\n${c.text}`),
    '',
    'Write the lesson file now.',
  ].join('\n')
}

export function repairPrompt(diags: Diagnostic[]): string {
  return [
    'The validator found problems in your lesson:',
    '',
    formatDiagnostics(diags),
    '',
    'Reply with the full corrected lesson file only: frontmatter first, no commentary. Keep everything that was already valid.',
  ].join('\n')
}
