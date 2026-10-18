// Gold lessons: for each task, a lesson that meets its checklist and literal checks, built as a neutral spec and
// printed in either syntax. Proves every task is satisfiable in both arms, and drives the offline stub model.
import { inline, type DocSpec, type Item } from './print.ts'
import type { Json, SourcePack, Task } from './types.ts'

const ROLES = ['emphasis', 'contrast', 'context', 'critique', 'exemplar']
const long = (s: string, min: number) => {
  let out = s
  while (out.length < min) out += ' ' + s
  return out
}

export function goldDoc(task: Task, pack: SourcePack): DocSpec {
  const chunks = pack.chunks.filter((c) => task.chunkIds.includes(c.id))
  const outlets = [...new Set(chunks.map((c) => c.outlet))]
  let ci = 0
  const chunk = () => chunks[ci++ % chunks.length]!.id
  const need = (b: string) => task.checklist.find((c) => c.block === b)?.min ?? 0
  const allows = (b: string) => task.allowed.includes(b)
  const ids = new Map<string, number>()
  const id = (p: string) => `${p}${(ids.set(p, (ids.get(p) ?? 0) + 1), ids.get(p))}`
  const cite = (text: string) => inline('cite', { chunk: chunk() }, text)
  const items: Item[] = [`# ${task.concept}`]

  // Terms (ADV3 prescribes exact glosses).
  const glosses = (task.literals ?? []).filter((l) => l.where === 'attr' && l.attr === 'gloss').map((l) => l.value)
  const termCount = Math.max(need('term'), glosses.length, allows('term') ? 1 : 0)
  const terms = Array.from({ length: termCount }, (_, i) =>
    inline('term', { gloss: glosses[i] ?? `Key idea number ${i + 1} of ${task.concept}, defined in one sentence.` }, `term${i + 1}`),
  )

  // Cites spread across paragraphs.
  const citeCount = Math.max(need('cite'), 2)
  const intro: (string | ReturnType<typeof inline>)[] = ['This lesson introduces ', terms[0] ?? 'the idea', ' ']
  intro.push(cite('the sources agree on the basic definition'), '.')
  items.push({ p: intro })
  let used = 1
  while (used < citeCount) {
    const p: (string | ReturnType<typeof inline>)[] = [`Point ${used}: `]
    const t = terms[used]
    if (t) p.push(t, ' is used here ')
    p.push(cite(`claim number ${used} is supported by the pack`), '.')
    items.push({ p })
    used++
  }
  for (let i = 1; i < terms.length && i >= used; i++) items.push({ p: [terms[i]!, ' is also defined here.'] })

  // Task-specific literals.
  if (task.id === 'adv1') {
    items.push({ fence: { lang: 'jinja', body: '{% if user %}Hello{% endif %}' } })
    items.push({ fence: { lang: 'md', body: ':::note\nHeads up\n:::' } })
    items.push('Use `{% raw %}` to escape template syntax and `:::` to fence an admonition.')
  }
  if (task.id === 'adv2')
    items.push('Let $f: \\mathbb{R} \\to \\mathbb{R}$ with $a_{n+1} = \\frac{a_n}{2}$ and $\\sum_{k=0}^{\\infty} a_k$; the ratio of terms is 3:1.')

  // Perspectives (and ADV4 nesting: list > callout > perspective).
  const persp = (i: number): Item => ({
    block: 'perspective',
    attrs: { outlet: outlets[i % outlets.length]!, role: ROLES[i % ROLES.length]! },
    children: [{ p: [`Outlet view ${i + 1} ` , cite(`a framing that this outlet supports`), '.'] }],
  })
  const nPersp = need('perspective')
  if (task.nesting) {
    items.push({
      list: [
        { lead: 'First point', children: [{ block: 'callout', attrs: { type: 'note' }, children: [persp(0)] }] },
        { lead: 'Second point', children: [{ block: 'callout', attrs: { type: 'tip' }, children: ['A short second callout.'] }] },
      ],
    })
    for (let i = 1; i < nPersp; i++) items.push(persp(i))
  } else {
    for (let i = 0; i < nPersp; i++) items.push(persp(i))
  }

  const nCallout = need('callout') || (task.id === 'adv5' ? 1 : 0)
  for (let i = 0; i < nCallout; i++)
    items.push({ block: 'callout', attrs: { type: task.id === 'adv5' ? 'note' : 'tip' }, children: [task.id === 'adv5' ? 'A rotatable 3D board is not available in this course, so the positions are shown as diagrams.' : 'A short tip.'] })

  // Visual blocks.
  for (const v of ['position', 'plot', 'animation', 'timeline']) {
    const n = need(v)
    for (let i = 0; i < n; i++) {
      const base = { id: id(v === 'plot' ? 'pl' : v.slice(0, 1) + 'v') }
      if (v === 'position')
        items.push({ block: v, attrs: { ...base, fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', orientation: 'white', caption: 'White to move: where does the knight fork king and rook?', reveal: { move: 'Nc7+', highlight: ['c7', 'e8', 'a8'] } } })
      if (v === 'plot')
        items.push({ block: v, attrs: { ...base, title: 'A relationship', kind: 'line', xLabel: 'x', yLabel: 'y', caption: long('The quantity grows as x increases, which is the point of this figure.', task.id === 'adv6' ? 320 : 40), series: [{ label: 'series', points: [[0, 0], [1, 1], [2, 4], [3, 9]] }] } })
      if (v === 'animation')
        items.push({ block: v, attrs: { ...base, scene: 'step-through', durationSec: 20, caption: 'The process unfolds one step at a time.', params: { size: 8, target: 5 } } })
      if (v === 'timeline')
        items.push({ block: v, attrs: { ...base, caption: 'Key dates in order.', events: [{ year: 1800, label: 'First event' }, { year: 1850, label: 'Second event' }, { year: 1900, label: 'Third event' }] } })
    }
  }

  // Worked example and exercises.
  if (need('worked-example'))
    items.push({
      block: 'worked-example',
      attrs: { id: id('w'), title: `A worked example of ${task.concept}`, skills: [task.concept_id] },
      children: ['one', 'two', 'three'].map((w, i) => ({ block: 'step', attrs: { id: `ws${i + 1}` }, children: [`Step ${w}: do the next thing.`] })),
    })
  for (let i = 0; i < need('exercise'); i++) {
    const faded = task.shape === 'S4'
    const skills = [{ id: task.concept_id, weight: 1, role: 'target' }]
    const eid = id('e')
    const ex: Record<string, Json> = {
      id: eid, group: `${eid}-group`, kind: 'mcq', cognitive: 'apply', scaffold: faded ? 'faded' : 'independent',
      skills, difficulty: { b: 0.2, source: 'llm' }, modes: ['practice'],
      prompt: `Which option is correct for ${task.concept}?`,
      choices: [
        { id: 'a', text: 'The right answer', correct: true },
        { id: 'b', text: 'A common mistake', misconception: `${task.concept_id}.mistake-one`, feedback: 'This is the usual slip.' },
        { id: 'c', text: 'Another mistake', misconception: `${task.concept_id}.mistake-two` },
        { id: 'd', text: 'A third mistake', misconception: `${task.concept_id}.mistake-three` },
      ],
      hints: [1, 2, 3, 4, 5].map((level) => ({ level, text: `Hint at level ${level}.` })),
      steps: [{ id: 'x1', text: 'First step.', key: 'a' }, { id: 'x2', text: 'Second step.' }],
    }
    items.push({ block: 'exercise', attrs: ex })
  }

  return { lesson: task.id, concept: task.concept_id, items }
}
