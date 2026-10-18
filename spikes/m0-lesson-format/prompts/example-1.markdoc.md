---
lesson: free-fall
concept: physics.mechanics.free-fall
---

# Free fall

An object in {% term gloss="Motion under gravity alone, with air resistance ignored." %}free fall{% /term %} gains the same speed every second. Near Earth's surface that gain is about 9.8 m/s each second {% cite chunk="src:openstax-physics#c2" %}all objects in free fall accelerate at the same rate, whatever their mass{% /cite %}.

Because speed grows steadily, the distance fallen grows with the square of the time: $d = \tfrac{1}{2} g t^2$.

{% plot id="pl1" title="Distance fallen" kind="line" xLabel="time (s)" yLabel="distance (m)" caption="Distance fallen grows with the square of the time: doubling the time quadruples the distance." series=[{label: "d = 4.9t^2", points: [[0, 0], [1, 4.9], [2, 19.6], [3, 44.1], [4, 78.4]]}] /%}

{% callout type="misconception" %}
Heavier objects do not fall faster in a vacuum. A feather falls slowly in air because of drag, not because it is light {% cite chunk="src:openstax-physics#c3" %}air resistance makes light objects seem to fall more slowly{% /cite %}.
{% /callout %}

{% perspective outlet="src:openstax-physics" role="emphasis" %}
The textbook treats free fall as the clean case: remove drag and every object follows the same equations {% cite chunk="src:openstax-physics#c2" %}the same equations of motion apply to every falling object{% /cite %}.
{% /perspective %}

{% perspective outlet="src:galileo" role="context" %}
Galileo made the same point by thought experiment: tie a light stone to a heavy one, and the pair would have to fall both faster and slower than the heavy stone alone {% cite chunk="src:galileo#c1" %}the combined body would be both slower and faster{% /cite %}.
{% /perspective %}

{% exercise id="e1" group="free-fall-distance-1" kind="numeric" cognitive="apply" scaffold="hinted"
   skills=[{id: "physics.mechanics.free-fall", weight: 1, role: "target"}]
   difficulty={b: 0.4, source: "llm"} modes=["practice"] answer="19.6" expectedTimeSec=90 %}
{% prompt %}A stone is dropped from rest. How far, in metres, has it fallen after 2 seconds? Use g = 9.8 m/s^2.{% /prompt %}
{% hint level=1 %}Which formula links distance, time and g for a dropped object?{% /hint %}
{% hint level=2 %}Use d = ½ g t² with t = 2.{% /hint %}
{% hint level=3 %}Square the time first, then multiply by g/2.{% /hint %}
{% step id="s1" %}Square the time: 2² = 4.{% /step %}
{% step id="s2" %}Multiply by g/2 = 4.9 to get d = 19.6 m.{% /step %}
{% /exercise %}
