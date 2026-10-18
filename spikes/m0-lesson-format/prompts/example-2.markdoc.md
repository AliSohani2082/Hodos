---
lesson: two-step-equations
concept: math.algebra.two-step-equations
---

# Two-step equations

A {% term gloss="An equation that needs two inverse operations to isolate the unknown." %}two-step equation{% /term %} such as $3x + 5 = 20$ is solved by undoing the operations in reverse order {% cite chunk="src:openstax-algebra#c5" %}undo addition or subtraction first, then multiplication or division{% /cite %}.

{% worked-example id="w1" title="Solve 3x + 5 = 20" skills=["math.algebra.two-step-equations"] %}
{% step id="s1" %}
Subtract 5 from both sides to undo the addition: $3x = 15$.
{% /step %}
{% step id="s2" %}
Divide both sides by 3 to undo the multiplication: $x = 5$.
{% /step %}
{% step id="s3" %}
Check by substituting: $3 \cdot 5 + 5 = 20$.
{% /step %}
{% /worked-example %}

{% callout type="tip" %}
Do exactly the same thing to both sides {% cite chunk="src:openstax-algebra#c2" %}equality is preserved when the same operation is applied to both sides{% /cite %}.
{% /callout %}

{% perspective outlet="src:openstax-algebra" role="emphasis" %}
The textbook builds equation solving on inverse operations and a balance picture {% cite chunk="src:openstax-algebra#c3" %}each step keeps the two sides balanced{% /cite %}.
{% /perspective %}

{% perspective outlet="src:mactutor" role="context" %}
The history adds that symbolic equations are recent: for centuries equations were written out in words {% cite chunk="src:mactutor#c1" %}Recorde introduced the equals sign in 1557{% /cite %}.
{% /perspective %}

{% timeline id="t1" caption="How the notation for equations developed." events=[{year: 820, label: "Al-Khwarizmi writes the first algebra text"}, {year: 1557, label: "Recorde introduces the equals sign"}, {year: 1591, label: "Viète uses letters for unknowns"}] /%}

{% exercise id="e1" group="two-step-solve-1" kind="mcq" cognitive="apply" scaffold="independent"
   skills=[{id: "math.algebra.two-step-equations", weight: 1, role: "target"}, {id: "math.algebra.inverse-operations", weight: 0.4, role: "prereq"}]
   difficulty={b: -0.3, source: "llm"} modes=["formative", "practice"] expectedTimeSec=60 cites=["src:openstax-algebra#c5"] %}
{% prompt %}Solve $4x - 3 = 13$.{% /prompt %}
{% choice id="a" correct=true %}$x = 4${% /choice %}
{% choice id="b" misconception="math.misc.wrong-inverse-order" %}$x = 2.5$
{% feedback %}You divided before adding 3 to both sides.{% /feedback %}{% /choice %}
{% choice id="c" misconception="math.misc.sign-error" %}$x = 2${% /choice %}
{% choice id="d" misconception="math.misc.one-side-only" %}$x = 16${% /choice %}
{% hint level=1 %}Which operation was applied last to x?{% /hint %}
{% hint level=2 %}Undo the subtraction first.{% /hint %}
{% hint level=3 %}Add 3 to both sides to get $4x = 16$.{% /hint %}
{% hint level=4 %}Now undo the multiplication by 4.{% /hint %}
{% hint level=5 %}Divide both sides of $4x = 16$ by 4 and check in the original equation.{% /hint %}
{% step id="s1" key="4x = 16" %}Add 3 to both sides.{% /step %}
{% step id="s2" key="x = 4" %}Divide both sides by 4.{% /step %}
{% /exercise %}
