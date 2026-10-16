// Host-side validation of everything a plugin worker returns. The worker is untrusted, so its output is data to be checked, never to be believed.
// Strict allowlists: unknown keys are dropped, numbers must be finite and in range, strings are length-capped.
import type { Diagnostic, GradeResult, Json } from '../sdk/types.ts'

export class ResultError extends Error { constructor(msg: string) { super(msg); this.name = 'ResultError' } }
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (x: unknown, what: string, max: number) => { if (typeof x !== 'string' || x.length > max) throw new ResultError(`${what}: expected string up to ${max} chars`); return x }
const num01 = (x: unknown, what: string) => { if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) throw new ResultError(`${what}: expected a finite number in [0, 1], got ${String(x)}`); return x }
const jsonSize = (x: unknown) => { try { return JSON.stringify(x)?.length ?? 0 } catch { return Infinity } }

export function parseDiagnostics(x: unknown): Diagnostic[] {
  if (!Array.isArray(x) || x.length > 200) throw new ResultError('diagnostics: expected an array of at most 200 items')
  return x.map((d, i) => {
    if (!isObj(d)) throw new ResultError(`diagnostics[${i}]: not an object`)
    if (d.level !== 'error' && d.level !== 'warning') throw new ResultError(`diagnostics[${i}].level: error or warning`)
    const out: Diagnostic = { level: d.level, id: str(d.id, `diagnostics[${i}].id`, 128), message: str(d.message, `diagnostics[${i}].message`, 1000) }
    if (d.nodeId !== undefined) out.nodeId = str(d.nodeId, 'nodeId', 128)
    if (d.line !== undefined) { if (!Number.isInteger(d.line) || (d.line as number) < 0) throw new ResultError('line'); out.line = d.line as number }
    return out
  })
}

export function parseFallbackText(x: unknown): string { return str(x, 'fallback.text', 4000) }

export function parseGradeResult(x: unknown): GradeResult {
  if (!isObj(x)) throw new ResultError('grade: not an object')
  const fb = x.feedback
  if (!isObj(fb)) throw new ResultError('grade.feedback: missing')
  const misc = x.misconceptionsDetected
  if (!Array.isArray(misc) || misc.length > 20) throw new ResultError('grade.misconceptionsDetected: array of at most 20')
  if (typeof x.needsHumanReview !== 'boolean') throw new ResultError('grade.needsHumanReview: boolean')
  if (typeof fb.revealsAnswer !== 'boolean') throw new ResultError('grade.feedback.revealsAnswer: boolean')
  if (x.oracle !== undefined && jsonSize(x.oracle) > 4096) throw new ResultError('grade.oracle: over 4 KB')
  const out: GradeResult = {
    score: num01(x.score, 'grade.score'),
    misconceptionsDetected: misc.map((m, i) => str(m, `misconception[${i}]`, 128)),
    feedback: { text: str(fb.text, 'grade.feedback.text', 2000), revealsAnswer: fb.revealsAnswer },
    graderConfidence: num01(x.graderConfidence, 'grade.graderConfidence'),
    needsHumanReview: x.needsHumanReview,
  }
  if (x.correct !== undefined) { if (typeof x.correct !== 'boolean') throw new ResultError('grade.correct: boolean'); out.correct = x.correct }
  if (x.oracle !== undefined) out.oracle = x.oracle as Json
  return out
}
