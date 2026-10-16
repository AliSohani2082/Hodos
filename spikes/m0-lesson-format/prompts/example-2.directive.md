---
lesson: two-step-equations
concept: math.algebra.two-step-equations
---

# Two-step equations

A :term[two-step equation]{gloss="An equation that needs two inverse operations to isolate the unknown."} such as $3x + 5 = 20$ is solved by undoing the operations in reverse order :cite[undo addition or subtraction first, then multiplication or division]{chunk="src:openstax-algebra#c5"}.

::::worked-example{#w1 title="Solve 3x + 5 = 20"}
```yaml
skills: [math.algebra.two-step-equations]
```

:::step{#s1}
Subtract 5 from both sides to undo the addition: $3x = 15$.
:::

:::step{#s2}
Divide both sides by 3 to undo the multiplication: $x = 5$.
:::

:::step{#s3}
Check by substituting: $3 \cdot 5 + 5 = 20$.
:::
::::

:::callout{type=tip}
Do exactly the same thing to both sides :cite[equality is preserved when the same operation is applied to both sides]{chunk="src:openstax-algebra#c2"}.
:::

:::perspective{outlet="src:openstax-algebra" role=emphasis}
The textbook builds equation solving on inverse operations and a balance picture :cite[each step keeps the two sides balanced]{chunk="src:openstax-algebra#c3"}.
:::

:::perspective{outlet="src:mactutor" role=context}
The history adds that symbolic equations are recent: for centuries equations were written out in words :cite[Recorde introduced the equals sign in 1557]{chunk="src:mactutor#c1"}.
:::

:::timeline{#t1 caption="How the notation for equations developed."}
```yaml
events:
  - {year: 820, label: Al-Khwarizmi writes the first algebra text}
  - {year: 1557, label: Recorde introduces the equals sign}
  - {year: 1591, label: Viète uses letters for unknowns}
```
:::

:::exercise{#e1 group=two-step-solve-1 kind=mcq cognitive=apply scaffold=independent expectedTimeSec=60}
```yaml
prompt: Solve $4x - 3 = 13$.
skills:
  - {id: math.algebra.two-step-equations, weight: 1, role: target}
  - {id: math.algebra.inverse-operations, weight: 0.4, role: prereq}
difficulty: {b: -0.3, source: llm}
modes: [formative, practice]
cites: ["src:openstax-algebra#c5"]
choices:
  - {id: a, text: $x = 4$, correct: true}
  - {id: b, text: $x = 2.5$, misconception: math.misc.wrong-inverse-order, feedback: You divided before adding 3 to both sides.}
  - {id: c, text: $x = 2$, misconception: math.misc.sign-error}
  - {id: d, text: $x = 16$, misconception: math.misc.one-side-only}
hints:
  - {level: 1, text: Which operation was applied last to x?}
  - {level: 2, text: Undo the subtraction first.}
  - {level: 3, text: Add 3 to both sides to get $4x = 16$.}
  - {level: 4, text: Now undo the multiplication by 4.}
  - {level: 5, text: Divide both sides of $4x = 16$ by 4 and check in the original equation.}
steps:
  - {id: s1, key: 4x = 16, text: Add 3 to both sides.}
  - {id: s2, key: x = 4, text: Divide both sides by 4.}
```
:::
