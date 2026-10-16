import { describe, expect, test } from 'bun:test'
import type { Arm, DiagId } from '../src/types.ts'
import { formatDiagnostics, validateLesson } from '../src/validate.ts'
import { CTX } from './fixtures.ts'

const FM = '---\nlesson: t\nconcept: a.b\n---\n\n'
const run = (arm: Arm, body: string, ctx = CTX) => validateLesson(arm, FM + body, ctx)
const ids = (arm: Arm, body: string, ctx = CTX): DiagId[] => [...new Set(run(arm, body, ctx).diagnostics.map((d) => d.id))].sort() as DiagId[]
const show = (arm: Arm, body: string) => formatDiagnostics(run(arm, body).diagnostics)

const FEN = 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1'
const NO_PLOT = { ...CTX, allowed: new Set([...CTX.allowed].filter((b) => b !== 'plot')) }

describe('markdoc arm diagnostics', () => {
  const M = (body: string, ctx = CTX) => ids('markdoc', body, ctx)
  test('clean prose is valid', () => expect(M('# Hi\n\nSome text with `{% code %}` and $a_{n+1}$ and 12:30 and x:y.\n')).toEqual([]))
  test('unknown tag', () => expect(M('{% nope /%}\n')).toEqual(['unknown-block']))
  test('built-in tags are not part of the vocabulary', () => expect(M('{% if $x %}\nhi\n{% /if %}\n')).toContain('unknown-block'))
  test('missing attribute', () => expect(M(`{% position id="p1" fen="${FEN}" orientation="white" /%}\n`)).toEqual(['missing-attr']))
  test('bad enum value', () => expect(M('{% callout type="oops" %}\nx\n{% /callout %}\n')).toEqual(['bad-value']))
  test('unknown attribute', () => expect(M('{% callout type="note" foo="x" %}\nx\n{% /callout %}\n')).toEqual(['unknown-attr']))
  test('unclosed container', () => expect(M('{% callout type="note" %}\nx\n')).toEqual(['unclosed']))
  test('bad citation chunk', () => expect(M('Text {% cite chunk="src:nope#c1" %}x{% /cite %}.\n')).toEqual(['bad-citation']))
  test('bad outlet', () => expect(M('{% perspective outlet="src:nope" role="emphasis" %}\nx\n{% /perspective %}\n')).toEqual(['bad-citation']))
  test('illegal FEN', () =>
    expect(M('{% position id="p1" fen="8/8/8 w - - 0 1" orientation="white" caption="Look here" /%}\n')).toEqual(['bad-value']))
  test('disallowed block', () =>
    expect(M('{% plot id="pl" title="T t" kind="line" xLabel="x" yLabel="y" caption="cap" series=[{label: "a", points: [[0,0],[1,1]]}] /%}\n', NO_PLOT)).toEqual(['disallowed-block']))
  test('step outside worked-example', () => expect(M('{% step id="s1" %}\nx\n{% /step %}\n')).toEqual(['bad-nesting']))
  test('perspective inside perspective', () =>
    expect(M('{% perspective outlet="src:silman" role="emphasis" %}\n{% perspective outlet="src:lichess" role="contrast" %}\nx\n{% /perspective %}\n{% /perspective %}\n')).toContain('bad-nesting'))
  test('duplicate ids', () =>
    expect(M(`{% position id="p1" fen="${FEN}" orientation="white" caption="Look here" /%}\n\n{% position id="p1" fen="${FEN}" orientation="white" caption="Look again" /%}\n`)).toEqual(['bad-value']))
  test('literal tag syntax in a fence needs process=false', () => {
    expect(M('```jinja\n{% if x %}hi{% endif %}\n```\n').length).toBeGreaterThan(0)
    expect(M('```jinja {% process=false %}\n{% if x %}hi{% endif %}\n```\n')).toEqual([])
  })
  test('latex with braces and colons is fine', () => expect(M('Let $f: A \\to B$ and $x_{n+1}=\\frac{x_n}{2}$.\n')).toEqual([]))
  test('escaped quotes in attribute values work', () =>
    expect(M('{% callout type="note" %}\nok\n{% /callout %}\n\nSee {% term gloss="He said \\"hi\\" and left C:\\\\temp — 日本語" %}word{% /term %}.\n')).toEqual([]))
  test('text directly inside an exercise', () =>
    expect(M('{% exercise id="e1" group="g" kind="short" cognitive="recall" scaffold="independent" skills=[{id: "a.b", weight: 1, role: "target"}] difficulty={b: 0, source: "llm"} modes=["formative"] answer="x" %}\nstray prose\n{% prompt %}What is it?{% /prompt %}\n{% /exercise %}\n')).toContain('bad-body'))
  test('frontmatter problems', () => {
    expect(validateLesson('markdoc', '# no frontmatter\n', CTX).diagnostics.map((d) => d.id)).toContain('bad-frontmatter')
  })
  test('line numbers are absolute (frontmatter included)', () => {
    const r = run('markdoc', '# H\n\n{% nope /%}\n')
    expect(r.diagnostics[0]?.line).toBe(FM.split('\n').length + 2)
  })
})

describe('directive arm diagnostics', () => {
  const D = (body: string, ctx = CTX) => ids('directive', body, ctx)
  test('clean prose is valid, including colons that look like directives', () =>
    expect(D('# Hi\n\nMeet at 12:30, ratio x:y, and 3:1. Code: `:::` and $f: A \\to B$.\n')).toEqual([]))
  test('literal directive syntax inside fenced code is fine', () => expect(D('```md\n:::note\nhi\n:::\n{% if x %}\n```\n')).toEqual([]))
  test('unknown container', () => expect(D(':::nope\nx\n:::\n')).toEqual(['unknown-block']))
  test('unknown text directive with a label is flagged', () => expect(D('See :nope[x] here.\n')).toEqual(['unknown-block']))
  test('missing attribute', () => expect(D(`::position{#p1 fen="${FEN}" orientation=white}\n`)).toEqual(['missing-attr']))
  test('bad enum', () => expect(D(':::callout{type=oops}\nx\n:::\n')).toEqual(['bad-value']))
  test('unknown attribute', () => expect(D(':::callout{type=note foo=x}\nx\n:::\n')).toEqual(['unknown-attr']))
  test('unclosed container is reported even though remark auto-closes it', () => expect(D(':::callout{type=note}\nx\n')).toEqual(['unclosed']))
  test('same colon count on nested containers', () => {
    const r = D(':::worked-example{#w1 title="Find it"}\n```yaml\nskills: [a.b]\n```\n\n:::step{#s1}\none\n:::\n\n:::step{#s2}\ntwo\n:::\n\n:::\n')
    expect(r).toContain('unclosed')
    expect(r).toContain('bad-nesting')
  })
  test('correct colon counts on nested containers', () =>
    expect(D('::::worked-example{#w1 title="Find it"}\n```yaml\nskills: [a.b]\n```\n\n:::step{#s1}\none\n:::\n\n:::step{#s2}\ntwo\n:::\n\n::::\n')).toEqual([]))
  test('backslash-escaped quote silently turns the directive into prose, and the lint catches it', () => {
    expect(D(`::animation{#a1 scene=x-y durationSec=10 caption="He said \\"hi\\""}\n`)).toEqual(['bad-syntax'])
  })
  test("single quotes and &quot; are the right way to quote a double quote", () => {
    expect(D(`::animation{#a1 scene=x-y durationSec=10 caption='He said "hi"'}\n`)).toEqual([])
    expect(D(`::animation{#a1 scene=x-y durationSec=10 caption="He said &quot;hi&quot;"}\n`)).toEqual([])
  })
  test('unclosed brace', () => expect(D('::animation{#a1 scene=x-y durationSec=10\n\nNext.\n')).toEqual(['bad-syntax']))
  test('unclosed inline directive', () => expect(D('A :cite[claim]{chunk="src:lichess#c3" here.\n')).toEqual(['bad-syntax']))
  test('wrong form: container written as leaf', () => expect(D('::callout{type=tip}\n')).toContain('bad-syntax'))
  test('wrong form: inline written as container', () => expect(D(':::cite{chunk="src:lichess#c3"}\nx\n:::\n')).toContain('bad-syntax'))
  test('leaf form without yaml is fine when no structured field is required', () =>
    expect(D(`::position{#p1 fen="${FEN}" orientation=white caption="Look here"}\n`)).toEqual([]))
  test('numbers and booleans are coerced by schema', () => {
    expect(D('::animation{#a1 scene=x-y durationSec=20 caption="Cap here"}\n')).toEqual([])
    expect(D('::animation{#a1 scene=x-y durationSec=abc caption="Cap here"}\n')).toEqual(['bad-value'])
  })
  test('malformed yaml', () =>
    expect(D(`:::position{#p1 fen="${FEN}" orientation=white caption="Look here"}\n\`\`\`yaml\nreveal: {move: Nc7+, highlight: [c7\n\`\`\`\n:::\n`)).toEqual(['bad-body']))
  test('yaml field also given as attribute', () =>
    expect(D(':::animation{#a1 scene=x-y durationSec=10 caption="Cap here" params=x}\n```yaml\nparams: {a: 1}\n```\n:::\n')).toEqual(['bad-value']))
  test('yaml block required for a container with structured fields', () =>
    expect(D(':::position{#p1 fen="x" orientation=white caption="Look here"}\n:::\n')).toContain('bad-body'))
  test('colon inside an unquoted yaml string breaks the flow mapping', () => {
    const r = D(`:::exercise{#e1 group=g kind=mcq cognitive=recall scaffold=independent}\n\`\`\`yaml\nprompt: Pick one\nskills:\n  - {id: a.b, weight: 1, role: target}\ndifficulty: {b: 0, source: llm}\nmodes: [formative]\nchoices:\n  - {id: a, text: Note: this one, correct: true}\n  - {id: b, text: other}\n  - {id: c, text: third}\n\`\`\`\n:::\n`)
    expect(r).toEqual(['bad-body'])
  })
  test('line numbers point into the yaml block', () => {
    const r = run('directive', `:::position{#p1 fen="${FEN}" orientation=white caption="Look here"}\n\`\`\`yaml\nreveal: {move: Nc7+, highlight: [c7\n\`\`\`\n:::\n`)
    expect(r.diagnostics[0]?.line).toBeGreaterThanOrEqual(FM.split('\n').length)
  })
})

test('diagnostic text is readable', () => {
  expect(show('markdoc', '{% callout type="oops" %}\nx\n{% /callout %}\n')).toContain('line 6 [bad-value] callout.type:')
})
