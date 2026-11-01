/**
 * Validation of grader output at the plugin trust boundary. A result that is
 * malformed, inconsistent, oversized, or claims evidence for a skill the item
 * is not tagged with is rejected; the attempt is then recorded as ungraded.
 * @module @hodos/core/evidence/grade
 */
import { compileSchema, isJsonValue, type GradeResult, type JsonObject, type JsonSchema, type SkillWeight } from '@hodos/plugin-sdk'
import { HodosError } from '../errors.js'

const GRADE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'correct', 'skillEvidence', 'misconceptions'],
  properties: {
    score: { type: 'number', minimum: 0, maximum: 1 },
    correct: { type: 'boolean' },
    skillEvidence: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['skillId', 'score'],
        properties: { skillId: { type: 'string', maxLength: 128 }, score: { type: 'number', minimum: 0, maximum: 1 } },
      },
    },
    misconceptions: { type: 'array', maxItems: 16, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' } },
    feedback: { type: 'string', maxLength: 2000 },
    details: { type: 'object' },
  },
}

const validateShape = compileSchema(GRADE_SCHEMA, 'grade/schema')

/** Largest accepted `details` object, serialized. */
export const MAX_GRADE_DETAILS_CHARS = 4096

/**
 * Validate and normalize a grader result for one item.
 * @param raw - the grader's return value (untrusted).
 * @param itemSkills - the item's skill tags.
 * @returns a normalized result with evidence for every tagged skill.
 * @throws {HodosError} `INVALID_INPUT` naming the violation.
 */
export function validateGradeResult(raw: unknown, itemSkills: readonly SkillWeight[]): GradeResult {
  if (!isJsonValue(raw)) throw new HodosError('INVALID_INPUT', 'grader returned a value that is not plain JSON')
  const findings = validateShape(raw)
  if (findings.length > 0) throw new HodosError('INVALID_INPUT', `grader result rejected: ${findings.map(f => f.message).join('; ')}`)
  const result = raw as unknown as GradeResult // shape checked by GRADE_SCHEMA above
  if (result.correct && result.score < 0.5) throw new HodosError('INVALID_INPUT', 'grader result rejected: correct with a score below 0.5')
  if (!result.correct && result.score === 1) throw new HodosError('INVALID_INPUT', 'grader result rejected: full score marked incorrect')
  const allowed = new Set(itemSkills.map(s => s.skillId))
  for (const e of result.skillEvidence) {
    if (!allowed.has(e.skillId)) throw new HodosError('INVALID_INPUT', `grader result rejected: evidence for skill ${e.skillId}, which the item is not tagged with`)
  }
  if (result.details !== undefined && JSON.stringify(result.details).length > MAX_GRADE_DETAILS_CHARS) {
    throw new HodosError('INVALID_INPUT', 'grader result rejected: details exceed 4 KiB')
  }
  const perSkill = new Map(result.skillEvidence.map(e => [e.skillId, e.score]))
  const details: JsonObject | undefined = result.details
  return {
    score: result.score,
    correct: result.correct,
    skillEvidence: itemSkills.map(s => ({ skillId: s.skillId, score: perSkill.get(s.skillId) ?? result.score })),
    misconceptions: [...new Set(result.misconceptions)],
    ...(result.feedback === undefined ? {} : { feedback: result.feedback }),
    ...(details === undefined ? {} : { details }),
  }
}
