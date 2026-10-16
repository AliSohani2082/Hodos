// One lesson, written twice (same data, different syntax). Used to prove the two arms normalise identically.
import type { ValidationContext } from '../src/types.ts'

export const CTX: ValidationContext = {
  chunkIds: new Set(['src:lichess#c3', 'src:lichess#c4', 'src:silman#c12', 'src:chesstempo#c7']),
  outlets: new Set(['src:lichess', 'src:silman', 'src:chesstempo']),
  allowed: new Set(['cite', 'term', 'callout', 'perspective', 'position', 'plot', 'animation', 'timeline', 'worked-example', 'step', 'exercise']),
}

export const LESSON_M = `---
lesson: knight-fork
concept: chess.tactics.fork.knight
---

# The knight fork

A {% term gloss="One move that attacks two valuable pieces at once." %}fork{% /term %} wins material because the opponent can only save one piece {% cite chunk="src:lichess#c3" %}a forked piece cannot capture a protected forker{% /cite %}.

{% position id="p1" fen="r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1" orientation="white" caption="White to move: where does the knight fork king and rook?" reveal={move: "Nc7+", highlight: ["c7", "e8", "a8"]} /%}

{% perspective outlet="src:silman" role="emphasis" %}
Silman frames forks as a symptom of *loose pieces* {% cite chunk="src:silman#c12" %}a fork only wins material if its targets lack protection{% /cite %}.
{% /perspective %}

{% callout type="tip" %}
Count loose pieces first.
{% /callout %}

{% worked-example id="w1" title="Find the fork" skills=["chess.tactics.fork.knight"] %}
{% step id="s1" %}
List the squares the knight on d5 can reach.
{% /step %}
{% step id="s2" %}
Pick c7: it attacks e8 and a8.
{% /step %}
{% /worked-example %}

{% exercise id="e1" group="fork-recognize-1" kind="mcq" cognitive="recognize" scaffold="independent"
   skills=[{id: "chess.tactics.fork.knight", weight: 1, role: "target"}]
   difficulty={b: 0.0, source: "llm"} modes=["formative"] %}
{% prompt %}Which squares does a knight on c7 attack that matter in the diagram?{% /prompt %}
{% choice id="a" correct=true %}e8 and a8{% /choice %}
{% choice id="b" misconception="chess.misc.knight-moves-straight" %}d8 and b8
{% feedback %}Knights never move along a line.{% /feedback %}{% /choice %}
{% choice id="c" misconception="chess.misc.one-target" %}Only e8{% /choice %}
{% hint level=1 %}What is the knight attacking from c7?{% /hint %}
{% hint level=2 %}Trace the two corners of the L-shape from c7.{% /hint %}
{% /exercise %}
`

export const LESSON_D = `---
lesson: knight-fork
concept: chess.tactics.fork.knight
---

# The knight fork

A :term[fork]{gloss="One move that attacks two valuable pieces at once."} wins material because the opponent can only save one piece :cite[a forked piece cannot capture a protected forker]{chunk="src:lichess#c3"}.

:::position{#p1 fen="r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1" orientation=white caption="White to move: where does the knight fork king and rook?"}
\`\`\`yaml
reveal: {move: Nc7+, highlight: [c7, e8, a8]}
\`\`\`
:::

:::perspective{outlet="src:silman" role=emphasis}
Silman frames forks as a symptom of *loose pieces* :cite[a fork only wins material if its targets lack protection]{chunk="src:silman#c12"}.
:::

:::callout{type=tip}
Count loose pieces first.
:::

::::worked-example{#w1 title="Find the fork"}
\`\`\`yaml
skills: [chess.tactics.fork.knight]
\`\`\`

:::step{#s1}
List the squares the knight on d5 can reach.
:::

:::step{#s2}
Pick c7: it attacks e8 and a8.
:::

::::

:::exercise{#e1 group=fork-recognize-1 kind=mcq cognitive=recognize scaffold=independent}
\`\`\`yaml
prompt: Which squares does a knight on c7 attack that matter in the diagram?
skills:
  - {id: chess.tactics.fork.knight, weight: 1, role: target}
difficulty: {b: 0.0, source: llm}
modes: [formative]
choices:
  - {id: a, text: e8 and a8, correct: true}
  - {id: b, text: d8 and b8, misconception: chess.misc.knight-moves-straight, feedback: Knights never move along a line.}
  - {id: c, text: Only e8, misconception: chess.misc.one-target}
hints:
  - {level: 1, text: What is the knight attacking from c7?}
  - {level: 2, text: Trace the two corners of the L-shape from c7.}
\`\`\`
:::
`
