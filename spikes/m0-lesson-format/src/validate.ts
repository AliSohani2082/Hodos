// Per-arm validator: parse (arm-specific) -> schema + semantic checks (shared) -> deduplicated diagnostics.
import { parseDirective } from './parse-directive.ts'
import { parseMarkdoc } from './parse-markdoc.ts'
import { validateTree } from './shared-validate.ts'
import type { Arm, Diagnostic, ParseResult, ValidateResult, ValidationContext } from './types.ts'

export const parse = (arm: Arm, src: string): ParseResult => (arm === 'markdoc' ? parseMarkdoc(src) : parseDirective(src))

function dedupe(diags: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>()
  const out: Diagnostic[] = []
  // Arm-specific diagnostics come first, so on overlap (e.g. Markdoc.validate and JSON Schema both
  // reporting a missing attribute) the arm's own message wins.
  for (const d of diags) {
    const top = d.attr?.split('.')[0]
    const keys = [`${d.id}|${d.line}|${d.block}|${d.attr ?? ''}|${d.message}`]
    if (top) keys.push(`attr|${d.line}|${d.block}|${top}`)
    if (d.id === 'unknown-block') keys.push(`unk|${d.line}|${d.block}`)
    if (keys.some((k) => seen.has(k))) continue
    keys.forEach((k) => seen.add(k))
    out.push(d)
  }
  return out
}

export function validateLesson(arm: Arm, src: string, ctx: ValidationContext): ValidateResult {
  const parsed = parse(arm, src)
  const shared = validateTree(parsed.doc, ctx)
  const diagnostics = dedupe([...parsed.diagnostics.map((d) => ({ ...d, stage: 'parse' as const })), ...shared]).sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
  return { doc: parsed.doc, diagnostics, valid: diagnostics.length === 0 }
}

export function formatDiagnostics(diags: Diagnostic[], max = 40): string {
  const shown = diags.slice(0, max).map((d) => {
    const where = [d.block, d.attr].filter(Boolean).join('.')
    return `- line ${d.line ?? '?'} [${d.id}]${where ? ` ${where}:` : ''} ${d.message}`
  })
  if (diags.length > max) shown.push(`- ... and ${diags.length - max} more`)
  return shown.join('\n')
}
