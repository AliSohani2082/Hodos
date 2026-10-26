/**
 * The course authoring guide: what an author (a person, the tutor agent, a
 * drafting subagent, or Claude Code working in the Hodos repository) needs to
 * write a course that validates. It is generated from the plugin registry,
 * so the kinds, schemas and lesson blocks it lists are exactly the ones
 * validation will accept.
 * @module @hodos/core/content/guide
 */
import { EXERCISE_MODES, SKILL_KINDS, DEFAULT_LOOP_FOR_KIND, type JsonValue } from '@hodos/plugin-sdk'
import type { PluginRegistry } from '../registry/registry.js'
import { DEFAULT_CHECKPOINT_SIZE, MIN_PRACTICE_ITEMS } from './course.js'

/** Options for {@link authoringGuide}. */
export interface GuideOptions {
  /** Include the JSON Schemas of payloads, keys and responses (longer). Default true. */
  readonly schemas?: boolean
  /** Items drawn per checkpoint (the engine's `checkpointSize`). */
  readonly checkpointSize?: number
}

function json(value: JsonValue | undefined): string {
  return JSON.stringify(value ?? null)
}

/**
 * Write the authoring guide for the installed environments.
 * @param registry - installed plugins.
 * @param options - detail level.
 * @returns Markdown text.
 */
export function authoringGuide(registry: PluginRegistry, options: GuideOptions = {}): string {
  const schemas = options.schemas ?? true
  const checkpointSize = options.checkpointSize ?? DEFAULT_CHECKPOINT_SIZE
  const out: string[] = []
  const line = (text = ''): void => { out.push(text) }

  line('# Hodos course authoring guide')
  line()
  line('A course is one JSON object. Hodos validates it against the installed environments; a proposed course stays a draft until the learner approves it in the Hodos workspace.')
  line()
  line('## Course')
  line()
  line('- `id`: lowercase id, 2-64 characters of `a-z 0-9 . _ -`, e.g. `spanish.greetings`.')
  line('- `version`: semantic version, e.g. `0.1.0`. A new revision of an approved course needs a higher version.')
  line('- `title`, `description`: shown to the learner. `keywords`: terms that match learner goals.')
  line('- `language` (optional): BCP 47 code of the course text, e.g. `en`.')
  line('- `goal`: the id of the final skill. Every other skill should be one of its prerequisites (directly or indirectly).')
  line('- `environments`: the environment ids the items use (listed below).')
  line('- `preset` (optional): a pedagogy preset id (listed below).')
  line('- `skills`, `lessons`, `items`: described below.')
  line()
  line('## Skills')
  line()
  line(`Each skill: \`id\` (lowercase dotted, e.g. \`chess.tactics.pin\`), \`title\`, \`kind\` (${SKILL_KINDS.map(k => `\`${k}\``).join(', ')}), optional \`description\`, \`requires\` (prerequisite skill ids; no cycles), \`objectives\` (short learner-facing goals), \`environment\`, \`fluencyTargetSec\` (pattern skills: target answer time), \`confusableWith\` (skills practice should interleave).`)
  line()
  line(`The kind selects the learning loop: ${SKILL_KINDS.map(k => `${k} → ${DEFAULT_LOOP_FOR_KIND[k]}`).join(', ')}.`)
  line()
  line('## Lessons')
  line()
  line('Each lesson: `id`, `skillId`, `title`, `source`. The source is Markdoc: Markdown plus the tags below. No HTML, no images, no scripts; links may only use http(s) or mailto. Give every skill one lesson: the key idea, a worked example, then a check question.')
  line()
  line('Core tags:')
  line()
  line('- `{% callout kind="key-idea" title="…" %}…{% /callout %}`: kind is tip, warning, key-idea or note.')
  line('- `{% worked-example title="…" %}…{% /worked-example %}` and `{% step title="…" %}…{% /step %}`.')
  line('- `{% check question="…" options=[{"id":"a","text":"…"},{"id":"b","text":"…"}] answer="a" explain="…" /%}`: a formative question; `answer` and `explain` stay on the server.')
  for (const block of registry.allBlocks()) {
    const g = block.spec.guidance
    line(`- \`${block.spec.name}\` (from ${block.pluginId}): ${g.when} Example: \`${g.syntax}\`${(g.rules ?? []).length > 0 ? ` Rules: ${(g.rules ?? []).join(' ')}` : ''}`)
  }
  line()
  line('## Exercise items')
  line()
  line(`Each item: \`id\` (unique in the course), \`kind\` (below), \`skills\` (\`[{ "skillId": "…", "weight": 1 }]\`, weights in (0, 1]), \`difficulty\` (logits from -4 to 4; 0 is typical for the skill), \`modes\` (any of ${EXERCISE_MODES.map(m => `\`${m}\``).join(', ')}), \`payload\` (shown to the learner), \`key\` (server only), optional \`hints\`, \`explanation\`, \`misconceptionFeedback\`, \`isomorphGroup\` (variants of one exercise share a group).`)
  line()
  line('- `hints`: up to five `{ "level": 1-5, "text": "…" }` from orienting (1) to bottom-out (5). Only level 5 may state the answer.')
  line('- `explanation`: the worked solution, released after grading (never during a checkpoint).')
  line('- Never put the answer, or anything that gives it away, in the `payload`: the payload is sent to the learner\'s browser.')
  line()
  line('## Coverage and mastery')
  line()
  line(`- Give every skill at least ${MIN_PRACTICE_ITEMS} \`practice\` items and at least ${checkpointSize} \`checkpoint\` items. A checkpoint draws up to ${checkpointSize} items the learner answers alone (no hints, no tutor).`)
  line('- Keep checkpoint items separate from practice items (different exercises, not the same exercise in both modes).')
  line('- A skill is mastered only after evidence from three distinct items and an unassisted checkpoint success; for guessable kinds (multiple choice) three checkpoint successes are needed, so give those skills enough checkpoint items.')
  line('- Add one or two `diagnostic` items per skill (easy, typical difficulty) so placement can find what the learner already knows, and mark practice items `review` too when they suit spaced review.')
  line()
  line('## Integrity')
  line()
  line('- Content must be correct. Environment validators check what they can (for example chess positions and solution lines); they cannot check everything, so double-check facts, translations and answers.')
  line('- Do not claim that material was verified. Hodos records where a course came from and marks proposed courses as not independently verified; `provenance` fields in a proposal are replaced.')
  line()
  line('## Environments and exercise kinds')
  line()
  const environments = registry.environments()
  if (environments.length === 0) line('No environments are installed.')
  for (const environment of environments) {
    line(`### ${environment}`)
    line()
    for (const id of registry.kindIds()) {
      const kind = registry.kind(id)
      if (kind === undefined || kind.spec.environment !== environment) continue
      const spec = kind.spec
      line(`#### \`${spec.id}\`: ${spec.title}`)
      line()
      line(`From ${kind.pluginId}@${kind.pluginVersion}. Response: ${spec.responseKind}, ${spec.interaction === 'stepwise' ? 'answered step by step' : 'one answer'}; ${spec.format.guessable ? `guessable${spec.format.options === undefined ? '' : ` (${spec.format.options} options)`}` : 'guess-resistant'}.`)
      if (spec.guidance !== undefined) {
        line()
        line(spec.guidance.when)
        for (const rule of spec.guidance.rules ?? []) line(`- ${rule}`)
        if (spec.guidance.example !== undefined) {
          line()
          line(`Example: payload \`${json(spec.guidance.example.payload)}\`, key \`${json(spec.guidance.example.key)}\`${spec.guidance.example.hints === undefined ? '' : `, hints \`${JSON.stringify(spec.guidance.example.hints)}\``}.`)
        }
      }
      if (schemas) {
        line()
        line(`Payload schema: \`${json(spec.payloadSchema)}\``)
        line()
        line(`Key schema: \`${json(spec.keySchema)}\``)
        line()
        line(`Response schema: \`${json(spec.responseSchema)}\``)
      }
      line()
    }
  }
  const presets = registry.plugins().flatMap(p => [...(p.manifest.capabilities.presets ?? [])])
  if (presets.length > 0) {
    line('## Presets')
    line()
    for (const id of presets) {
      const preset = registry.preset(id)
      if (preset !== undefined) line(`- \`${preset.id}\`: ${preset.title}.${preset.lessonTemplate === undefined ? '' : ` Lessons: ${preset.lessonTemplate}`}`)
    }
    line()
  }
  return out.join('\n')
}
