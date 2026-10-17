# Intelligent tutoring and learning science for Hodos

Status: research, 2026-10-09. Scope: which ITS and learning-science techniques should shape Hodos v1, whether courses need types, the student model, the diagnostic, LLM-tutor guardrails, and the exercise plugin contract. It builds on the locked decisions and on `docs/research/lesson-ir.md`.

**Evidence labels.**
- `[paper]`: the result was checked this session against the paper, its abstract or a faithful summary. Links are in §8.
- `[memory]`: a classic result from prior knowledge, not re-verified this session.
- `[sim]`: I ran it (§4.4). The simulation uses synthetic graphs, so it is not evidence about real learners.
- `[design]`: my reasoning, with no direct evidence.

---

## 0. TL;DR

1. **Keep one mastery contract and put several estimators behind it.** The "one mastery model" decision holds at the interface. Every skill exposes `P(mastered)`, a confidence, a retrievability `R(t)` and a review due date. Behind that interface v1 needs four small estimators, picked by the skill's *knowledge kind*: BKT for binary-graded concepts and procedures, Elo for large pools of perceptual and strategy puzzles, rubric-ordinal for open-ended work, and item-level FSRS for facts. Plain BKT is wrong for drawing, essays and chess judgment.
2. **Course types are justified, and the type belongs to the skill node, not the course.** The Knowledge-Learning-Instruction framework says the right instructional technique depends on the kind of knowledge being learned. Real courses mix kinds: a chess course has facts, patterns and judgment. So use a **pedagogy profile** chosen at course creation. It holds defaults plus required plugins, and each node in `graph.yaml` can override its `kind`. Profiles are declarative data that plugins may contribute. They are not code.
3. **The evidence on LLM tutors is unambiguous about one thing.** Unrestricted answer-giving raises practice scores and lowers later unaided scores. A hint ladder that withholds answers removes most of that harm. Structured, pedagogy-prompted tutors do well. So the platform, not plugins, owns the tutor policy per mode. Checkpoints get no tutor at all. Answer keys never reach the browser.
4. **Raise the default gate from 0.8 to 0.95.** In BKT, 0.95 is the field standard, and a 2025 study found 0.98 better still. A BKT probability of 0.8 means "probably learned", not "gets 80% right". The gate also needs at least one recent *unassisted* correct answer, so hint-gaming cannot open it.
5. **The diagnostic is a Bayesian half-split over down-sets of the DAG.** In my simulation it reached about 93% per-node accuracy in about 15 questions on graphs of 30 to 120 nodes. Recommended rule: stop when expected node error is below 5%, with a minimum of 5 questions and a cap of 25. That cap matches ALEKS, which uses at most 25 questions.

---

## 1. Executive summary: techniques that should shape v1

Effect sizes are in standard deviations. For scale, the median education RCT effect is about 0.10 SD, and 0.20 or more counts as large (Kraft 2020) `[paper]`. Bloom's "2 sigma" has not replicated as a tutoring-only effect. The tutoring meta-analytic mean is about 0.37 SD (Nickow et al. 2020) `[paper]`. Human tutoring is about 0.79 and step-based ITS about 0.76 (VanLehn 2011). Kulik & Fletcher (2016) found a median ITS effect of 0.66 `[paper]`.

| # | Technique | Evidence | Design hook |
|---|---|---|---|
| 1 | **Mastery gating** with a strict, calibrated threshold | Cognitive Tutor, ALEKS and MATHia all gate on mastery `[memory]`. The 0.95 BKT threshold holds up and 0.98 did better on later lessons (EDM 2025). In an ALEKS RCT, a higher threshold meant less forgetting `[paper]`. | **Gate service.** `gate(skill) = P(L) ≥ θ_profile ∧ ≥1 unassisted correct in the last checkpoint`. Default θ is 0.95 for BKT skills. The teacher sees "strictness: lenient / standard / strict" mapped to 0.90 / 0.95 / 0.98, not a raw probability. |
| 2 | **Retrieval practice** as the default exercise form; testing beats re-reading | Roediger & Karpicke 2006, Dunlosky et al. 2013 rate it "high utility" `[memory]`. | **Lesson IR.** Every lesson ends with 2–4 retrieval items (`exercise mode=practice`). Optional pre-questions at the start. The generator's lint fails a lesson that has none. |
| 3 | **Spacing**, made graph-aware | FSRS (open source, trained on large review sets). Math Academy's FIRe passes review credit down "encompassing" edges, so reviewing an advanced topic implicitly reviews its components `[paper: vendor description, not independently evaluated]`. | **Review scheduler.** FSRS state per skill. Add `encompasses: {skill: weight}` edges in `graph.yaml` next to `requires`. A review of X gives fractional credit (or blame) to the skills X encompasses (§3.5). |
| 4 | **Interleaving**, especially of confusable categories | Overall g = 0.42, and it is largest for visual and perceptual discrimination such as painting styles (g = 0.67). The effect in math is small (Brunmair & Richter 2019) `[paper]`. | **Session builder.** Review and late-Practice sessions mix skills and prefer pairs tagged `confusableWith` (a node attribute) or that share misconception tags. Blocked practice stays the default for the first exposures to a skill. |
| 5 | **Worked examples → faded → independent**, adaptively | Expertise reversal: worked examples help novices and hurt experts. Adaptive fading beat fixed fading, which beat plain problem solving (Salden et al. 2010) `[paper: summary]`. | **IR core block** `worked-example` with `steps[]`. Exercise item field `scaffold: worked \| faded(k) \| independent`. The **adaptive layer** picks the scaffold from `P(L)`: worked below 0.3, faded from 0.3 to 0.7, independent above 0.7. |
| 6 | **Self-explanation prompts** | Chi et al. 1989/1994 `[memory]`. Fading itself triggers self-explanation `[paper: summary]`. | Exercise kind `explain`, graded by LLM rubric, **low stakes**: it is Practice-only and carries small evidence weight. It is placed after worked examples and after any wrong answer in Practice. |
| 7 | **Step-level feedback** wherever a domain has steps | Step-based ITS 0.76 vs answer-based 0.31 (VanLehn 2011) `[paper]`. | **Exercise contract.** Optional `steps[]` in the response and per-step grading, each step with its own skill tags (§6). Programming (per test), math (per line) and chess (per move) all have natural steps. |
| 8 | **Misconception-targeted feedback** | Distractor-tagged misconceptions are the core of Eedi and ASSISTments-style feedback `[memory]`. LLM-generated hints carry about 30% errors without verification. Self-consistency checking brings that to near 0% in algebra (Pardos & Bhandari 2024) `[paper]`. | Item field `misconceptions` on distractors and rubric levels. Graded result returns `misconceptionsDetected[]`, which feeds the remedial step of the **adapt pass** and the teacher's **item analysis** view. |
| 9 | **Hint ladder, answer withholding, attempt-first** | Unrestricted GPT-4 gave +48% on practice and −17% on the later exam. A hint-only GPT Tutor gave +127% on practice and about 0 on the exam (Bastani et al., PNAS 2025) `[paper]`. Hint abuse ("gaming") hurts learning. Delaying hints helps gamers `[paper: summary]`. | **Platform-owned tutor policy** per mode (§5). Hint use discounts the evidence passed to the mastery model (§3.2). |
| 10 | **Tutor context = learner history; human-in-the-loop for authored items** | Giving Khanmigo the learner's history: +2.7 to 3.4% next-item correctness (Khan Academy 2026) `[paper: vendor]`. Human-supervised LearnLM matched or beat human tutors, and tutors approved 76% of drafts unedited (Eedi/Google 2025) `[paper]`. Tutor CoPilot: +4 pp mastery, +9 pp for students of weaker tutors `[paper]`. | **MCP tool** `learner.context(skill)` returns the mastery map, recent errors and misconceptions for the tutor prompt. Teacher approval of checkpoint pools is already decided; add a "flagged by grader" queue (§3.4). |

What I would **not** build into v1: DKT or neural knowledge tracing (needs data volume a self-hosted instance won't have), productive-failure sequencing (contested and hard to generate reliably) `[memory]`, and affect detection.

### 1.1 Classic ITS architecture mapped to Hodos

| ITS component | Classic content | Hodos component | Gap to fill |
|---|---|---|---|
| **Domain model** | Expert knowledge, production rules (model tracing) or constraints (constraint-based tutors) | Skill DAG (`graph.yaml`), sources and chunks, Core+Perspectives lessons, **exercise plugins' graders** (unit tests, chess engine, CAS, rubric) | Graders are the domain model for *checking*. Constraint-based checking (Mitrovic) fits LLM-era open answers better than model tracing: state what must be true of a good answer, not every path to it `[design]`. Rubric criteria are constraints. |
| **Student model** | Overlay of mastery on the domain model, plus bug library | Global per-learner skill graph: `P(L)`, FSRS state, misconception tallies | Add `kind` per node and a misconception tally (§3) |
| **Tutor / pedagogical model** | What next (outer loop), how to help in a step (inner loop) | Outer loop: path planner + adapt pass + review scheduler. Inner loop: hint ladder + tutor chat + feedback. | The inner-loop policy must be *platform-owned and mode-dependent* (§5), not left to each plugin or the LLM. |
| **Interface** | Problem-solving UI | Layout plugin + block renderers + exercise UIs in iframes | Exercise UIs must emit step events (§6) |

VanLehn's distinction between the **outer loop** (task selection) and the **inner loop** (within-task help) is the most useful lens `[memory]`. Hodos's planned outer loop is strong already (plan, adapt, gate). The inner loop is where LLMs help most, and also where they cause the harm in the Bastani study.

---

## 2. Course types: a taxonomy based on knowledge kinds

### 2.1 Why types are justified

- **KLI framework** (Koedinger, Corbett & Perfetti 2012) `[memory]`. Knowledge components come in kinds: facts/associations, categories/perceptual patterns, procedures/skills, principles/understanding. Each kind is learned by a different process: memory & fluency, induction & refinement, or understanding & sense-making. Which instructional principle works depends on the kind. Spacing and retrieval help memory; interleaving, worked examples and feedback help induction; self-explanation and dialogue help sense-making.
- **Domain dependence of deliberate practice.** Practice explains 26% of variance in games, 21% in music, 18% in sports, 4% in education and under 1% in professions (Macnamara et al. 2014) `[paper]`. Skill domains with tight feedback loops reward high-volume, targeted practice. Conceptual domains reward explanation and structure.
- **Interleaving** helps most with perceptual discrimination (g = 0.67 for paintings) and least in math `[paper]`.
- **Assessment differs by kind.** A binary right/wrong answer fits facts and procedures. Drawing and essays need rubrics or pairwise judgment. Chess needs an engine. One grading or mastery path cannot serve all of them.

**But the unit of typing is the skill node.** "Learn chess" contains piece-move facts (memory), tactical patterns (perceptual), and positional judgment (strategy). "Learn Spanish" contains vocabulary (memory), grammar (procedure), and speaking (open-ended performance). So:

> **Profile** (course-level, chosen once) = defaults + required plugins + lesson structure.
> **Kind** (node-level, in `graph.yaml`) = which mastery estimator, exercise mix, interleaving and gating rule apply to that node. The profile assigns default kinds; the planner may override a node's kind, and the override is visible in the teacher's diff.

### 2.2 Node kinds: what each changes

| Kind | Examples | Mastery estimator | Evidence | Exercise mix | Gate | Review |
|---|---|---|---|---|---|---|
| `fact` | vocab, anatomy terms, dates, piece moves, shortcuts | **item-level FSRS**. Skill mastery = share of the skill's items with R ≥ 0.9 and stability ≥ 7 d. | recall correctness, latency | cloze, recall, recognition only as a first exposure | ≥ 90% of items "stable" | FSRS per item (the native fit) |
| `concept` | photosynthesis, supply/demand, recursion idea | **BKT** | binary/partial scores | explain, MCQ with misconceptions, predict-the-outcome, transfer questions | P(L) ≥ 0.95 + unassisted correct | FSRS per skill, fresh item each time |
| `procedure` | solving equations, writing a loop, SQL joins, verb conjugation | **BKT** with step evidence | per-step correctness | worked → faded → independent; Parsons problems; write-code with tests | P(L) ≥ 0.95 + unassisted correct | FSRS per skill, interleaved |
| `pattern` (perceptual classification) | chess tactic motifs, bird ID, ECG reading, art style, chord quality by ear | **Elo** (learner θ vs item b) | correct + response time | many short classification trials (Kellman-style perceptual learning modules `[memory]`), interleaved early | θ ≥ b_target + logit(0.8) **and** median latency ≤ fluency target | Elo drift; FSRS on the skill |
| `performance` (open-ended production) | drawing, essays, CAD part design, music playing, speaking | **rubric-ordinal** per dimension (§3.4) | LLM rubric scores (calibrated), comparative judgment, teacher score, self-assessment | brief → attempt → critique → targeted drill → reattempt (deliberate practice loop); drills are often `procedure` or `pattern` sub-nodes | lower confidence bound of each required dimension ≥ target level, over ≥ 2 distinct prompts; optional teacher sign-off | Re-performance on new prompts, not flashcards |
| `judgment` (strategy) | chess middlegame plans, poker decisions, case analysis, design trade-offs | **Elo** on decision items **+** rubric on explanations | engine/oracle evaluation (centipawn or win-probability loss), expert-keyed decisions | "find the best move/option", play vs a level-matched opponent (Maia), annotate own games, case discussions | Elo target + rubric target | Mixed decision sets |

### 2.3 Pedagogy profiles (course-level)

| Profile | Default kinds | Lesson structure | Exercise plugins needed | Feedback loop | Notes |
|---|---|---|---|---|---|
| **conceptual** (STEM theory, humanities concepts) | concept, procedure | Core + Perspectives → worked example → self-explain → retrieval | mcq, short-answer (rubric), numeric/CAS, explain | per-step hints, misconception feedback | The current default design fits this. |
| **programming** | procedure, concept | short concept → worked code → Parsons → fill-in → write-from-spec → debug | code-runner (containerized tests), Parsons, trace-the-output | per-test feedback, hint ladder over failing tests | Tests are a strong, objective grader. Use them. |
| **memorization** | fact | minimal lesson, mnemonic/context card, then drill | flashcard/cloze, audio/image cards | immediate correct answer after attempt | FSRS is the primary engine here. Gating is light. |
| **perceptual** | pattern | contrastive examples ("this vs that"), then many fast trials | classify-image/audio/board, timed | instant right/wrong + the contrastive cue | Interleave from day 2. Track latency. |
| **language** | fact (vocab), procedure (grammar), performance (speak/write), pattern (listening) | comprehensible input text/audio → noticing → controlled practice → free production | flashcards, cloze, TTS listening, ASR speaking, writing (rubric), conversation partner | recasts in conversation, rubric on production | Needs TTS/ASR materializers. CEFR "can-do" goal nodes `[memory]`. |
| **creative / design** (drawing, writing, CAD, music) | performance, procedure (drills) | brief + exemplars (perspectives = different masters/styles) → attempt → critique → drill → reattempt | canvas/upload, rubric grader with anchors, pairwise comparison, CAD constraint checker | critique against rubric, side-by-side with exemplar | Gating is soft (teacher may sign off). Portfolio is the artifact. |
| **strategy** (chess, go, poker, cases) | pattern (tactics), judgment, fact (rules/openings) | principle + annotated example positions → puzzles → play → review own games | board + engine grader (Stockfish), Maia opponent, puzzle Elo | engine eval per move ("best was X, you lost 1.8 pawns") + explanation | Lichess-style puzzle Elo/Glicko-2 is a proven pattern `[paper]`. |

### 2.4 Representation and plugin question

```yaml
# course.yaml (blueprint, versioned)
pedagogy:
  profile: strategy@1          # chosen at course creation; teacher confirms
  overrides:                   # teacher/agent may tune within profile ranges
    gate.strictness: standard  # lenient | standard | strict
    tutor.practice.maxHintLevel: 4
```
```yaml
# graph.yaml (per node)
- id: chess.tactics.fork.knight
  kind: pattern               # overrides profile default if needed
  requires: [chess.rules.knight-move]
  encompasses: {chess.rules.knight-move: 0.5}   # FIRe-style implicit review credit
  confusableWith: [chess.tactics.skewer]
  fluencyTargetSec: 20
```

```ts
interface PedagogyProfile {
  id: string; version: number
  defaultKinds: NodeKind[]                       // used by planner when classifying nodes
  lessonTemplate: string                         // agent guidance: section order for this profile
  exerciseMix: Record<NodeKind, { kind: ExerciseKind; share: number }[]>
  requires: { exercise?: string[]; lesson?: string[]; materializers?: string[] }  // plugin ids
  gate: Record<NodeKind, GateRule>               // references platform estimators only
  tutor: TutorPolicy                             // §5, bounded by platform maxima
  review: { interleave: boolean; dailyCap: number; targetRetention: number }
}
type NodeKind = 'fact' | 'concept' | 'procedure' | 'pattern' | 'performance' | 'judgment'
```

**Should course types be plugins?** Partly.

- Profiles should be **data registered through cordis** (`ctx.pedagogy.profile(spec)`), so a "chess" plugin bundle can ship its board renderer, its engine grader and a `strategy` profile together.
- But **mastery estimators, gate rules and tutor-policy maxima stay platform-owned**, as a closed set. They drive gating, teacher dashboards and comparability across courses in the one global skill graph. A plugin-defined estimator could silently make "mastered" mean anything. Plugins contribute *evidence* (graded results) and *configuration*, not the inference `[design]`.
- Course creation runs a cheap classifier. The LLM proposes profile + node kinds from the goal and sources. The teacher confirms it in the blueprint diff.
- Ship 3 profiles in v1 (conceptual, programming, memorization). They exercise 4 of the 6 kinds with the BKT and FSRS estimators. Add Elo and rubric with the first perceptual, strategy or creative plugin.

---

## 3. Student model

### 3.1 Stress test of BKT-lite + FSRS

| BKT assumption | Where it breaks | Consequence | Fix |
|---|---|---|---|
| Knowledge is binary (learned / not) | drawing, essays, chess judgment, speaking improve continuously with no "learned" moment | P(L) saturates after a few lucky passes. The gate is meaningless. | `performance` and `judgment` kinds use rubric-ordinal / Elo |
| Items within a skill are exchangeable | LLM-generated items vary wildly in difficulty | An easy correct answer is over-credited | Difficulty-adjusted guess/slip (§3.2) + Elo-calibrated item difficulty |
| Observation is right/wrong | partial credit, rubric scores, multi-step | Information loss | Soft-evidence update with score ∈ [0,1] (§3.2) |
| One skill per observation | multi-skill items (most real problems) | Wrong skill blamed | Conjunctive blame assignment (§3.2). In v2, PFA/AFM handles multi-skill natively. |
| No forgetting | everything | P(L) stays at 0.97 for a skill not seen in a year | FSRS R(t) per skill. Display `effective = P(L)·R(t)`. Re-gate prerequisites whose R < 0.7 before a dependent lesson. |
| Parameters fit from data | self-hosted instances have little data | Can't fit per-skill parameters | Fixed defaults per kind. Fit in v2 when instance data > ~1k attempts per skill. |
| Help-seeking is not modeled | hints, tutor chat | Hint-gaming inflates P(L) | Hint discount + "unassisted correct" gate clause |

Comparison to alternatives:
- **PFA** has had higher predictive accuracy than BKT on tutor data (Gong et al. 2011) `[paper]`. Most of the gap between classic models and deep ones is in a skill's *first attempts* (EDM 2021) `[paper]`. PFA is a logistic regression and needs fitted parameters.
- **DKT and LLM-based KT** need data, are opaque to teachers, and the cold-start claims are authors' own results (CLST, LOKT) `[paper]`.
- **Elo** is simple, robust and self-calibrating for items (Pelánek 2016) `[paper]`. But with adaptive item selection plus simultaneous updates it is biased and can fail to converge ("Keeping Elo alive", 2025) `[paper]`.

**Verdict: keep BKT-lite for `concept` and `procedure`, and add three small estimators.** All four estimators write to the same `SkillState`.

```ts
interface SkillState {
  learnerId: string; skillId: string; kind: NodeKind
  pMastered: number          // 0..1, the one number gates and dashboards read
  confidence: number         // 0..1, e.g. 1 - posterior variance proxy; low = "needs more evidence"
  estimator: 'bkt' | 'elo' | 'rubric' | 'fsrs-items'
  est: BktState | EloState | RubricState | ItemSetState   // estimator-private
  fsrs: { stability: number; difficulty: number; lastReview: Date; due: Date }  // skill-level card
  misconceptions: Record<string, { count: number; last: Date }>
  provenance: 'diagnostic' | 'practice' | 'checkpoint' | 'teacher'
}
```

### 3.2 v1 BKT-lite: formulas

Default parameters per kind (no data to fit): `p0` from the diagnostic, otherwise 0.1. Transition `T = 0.15`. Base slip `s0 = 0.10`. Base guess `g0 = 0.15` (open answer) or `max(0.15, 1/k)` for k-option MCQ `[design; standard BKT ranges, memory]`.

```text
# item difficulty b_i in logits (0 = typical for the skill; >0 harder). From the item's
# difficulty field: LLM estimate -> teacher edit -> Elo calibration across the instance.
g_i = σ(logit(g0) − b_i)        # easy item → higher guess → correct counts for less
s_i = σ(logit(s0) + b_i)        # hard item → higher slip  → wrong counts for less

# graded score x ∈ [0,1] from the exercise plugin, then help discount:
#   h = highest hint level used / max level (0..1); bottom-out ⇒ h = 1
#   e = x · (1 − h)            # "evidence of unaided success"
#   (a correct answer after the bottom-out hint gives e = 0, i.e. it counts as a failure)

post_c = P·(1−s_i) / (P·(1−s_i) + (1−P)·g_i)
post_w = P·s_i     / (P·s_i     + (1−P)·(1−g_i))
P_obs  = e·post_c + (1−e)·post_w            # soft evidence (Jeffrey-style mixture)
P_next = P_obs + (1 − P_obs)·T·λ_mode       # learning transition
         # λ_mode: practice 1.0, review 0.5, checkpoint 0 (assessment, not instruction)
```

Multi-skill items (the contract lists `skills: [{id, weight}]`):
```text
correct (e high): apply the update to every tagged skill with weight w_k (interpolate P toward P_next by w_k)
wrong   (e low):  blame ∝ w_k · (1 − P_k); normalise; apply the 'wrong' update scaled by blame_k
                  (conjunctive: the weakest required skill most likely caused the failure)
```

Gate (per BKT node):
```text
gate_open(skill) =
     P(L) ≥ θ                                  # θ = 0.95 default (0.90 / 0.95 / 0.98)
  ∧  exists checkpoint attempt in current gate window with e ≥ 0.8 and h = 0
  ∧  attempts_on_distinct_items ≥ 3           # floor: BKT alone can pass 0.95 after 3 lucky rights
```
With these defaults, a learner starting at `p0 = 0.1` passes 0.95 after 3 clean correct answers on typical practice items (P reaches 0.98), or 2 from `p0 = 0.3` `[measured: arithmetic]`. That matches the "3 in a row" heuristic used in ASSISTments `[paper: summary]`. It is also why the distinct-item floor and the unassisted-checkpoint clause matter: BKT alone opens the gate quickly.

> **M0 update (ADR-0005, spike (e)).** For guessable formats the gate requires **three** unassisted checkpoint successes on distinct items (not one), a **wrong first attempt is recorded as a failure** even if a later hint produces a correct answer, and checkpoints enforce attempt limits or cooldowns. Simulation showed `P(L)` is an **evidence index**, not a calibrated probability of mastery — graded-ability learners pass θ=0.95 at mean true accuracy ≈0.74 — so treat it as such until it is calibrated on real data.

### 3.3 Elo for `pattern` and `judgment`

```text
p      = σ(θ_learner − b_item)                      # logistic, 1 unit ≈ 1 logit
r      = graded correctness after hint discount (e)
θ     += K(n_learner)·(r − p)        K(n) = 0.8 / (1 + 0.05·n)    (Pelánek-style decaying K)
b     -= K(m_item)·(r − p)·[mode == practice ∧ m_item < 200]   # item drifts only in practice, freezes later
pMastered = σ(θ − b_target − logit(0.8))           # P(correct on a target-level item) relative to 0.8
gate   = pMastered ≥ 0.5 ∧ median_latency(last 10) ≤ fluencyTargetSec
```
- Item difficulty is shared across all learners of the instance, so a puzzle pool calibrates over time.
- Seed `b` from the LLM estimate, or from a known source. Lichess puzzles come with Glicko-2 ratings: divide by 400/ln10 to convert to logits `[paper]` `[design]`.
- To avoid the adaptive-selection bias, select items using a *lagged* θ, frozen per session. Update θ live.

### 3.4 Rubric-ordinal for `performance`

```text
rubric dimension d has levels 0..4 with descriptors + anchor exemplars (teacher-scored)
each artifact a gets score x_{a,d} from grader G ∈ {llm, pairwise, teacher, self}
grader reliability r_G,d ∈ (0,1]  (teacher=1; llm=calibrated agreement, see below; self=0.3)
per dimension keep weighted mean μ_d and effective n_d = Σ r_G (recency-weighted, half-life 30 d)
LCB_d = μ_d − 1.0 · σ_d / sqrt(n_d)            # σ_d pooled SD, default 0.8 levels
pMastered = min over required d of  Φ((μ_d − target_d) / (σ_d/sqrt(n_d)))
gate = ∀ required d: LCB_d ≥ target_d   ∧  ≥2 distinct prompts  ∧  (teacherSignOff if profile requires)
```

**LLM-grader calibration**:
- Required before rubric scores can gate.
- Direct LLM rubric scoring agrees only moderately with humans: QWK 0.59 to 0.64 on short answers. It is worst on evaluative and higher-order criteria and best on checklist criteria (Emirtekin & Özarslan 2026). One postgraduate study found ICC as low as 0.09 `[paper]`.
- Pairwise comparative judgment by LLMs is more stable than direct scoring (L@S 2024; AIME-Con 2026) `[paper]`.

So:
1. Write rubrics as **analytic, checklist-like criteria** wherever possible ("perspective lines converge to one vanishing point"), not holistic ones ("good composition").
2. **Anchor sets.** The teacher scores 6 to 10 exemplars per rubric. The grader prompt includes anchors, and the score is produced by *pairwise comparison against anchors*, placing the artifact between adjacent anchors. That uses comparative judgment without needing a pool of peer work.
3. **Calibration job.** On rubric approval, grade the anchors leave-one-out and compute QWK per dimension. Set `r_llm,d = clamp(QWK, 0, 0.9)`. If QWK < 0.6, that dimension is **advisory only**: it gives feedback but cannot gate, and goes to the teacher review queue.
4. **Self-consistency.** Grade 3 times at temperature > 0. If the spread exceeds 1 level, flag the result and down-weight it.
5. **Domain oracles first.** Unit tests, engine eval, CAD constraint checks and ASR alignment beat LLM judgment wherever they exist. The LLM explains, the oracle scores.

For drawing in particular, I found **no peer-reviewed validation of VLM art feedback against expert teachers**. The closest work is 2026 preprints such as Draw2Learn, and VLM judges struggle with object and relation correctness in sketches `[paper]`. Treat drawing feedback as advisory plus teacher or self assessment until a calibration set shows otherwise.

### 3.5 FSRS per skill, plus FIRe-lite

FSRS is designed for *items*. Per skill it is an approximation that holds if each review draws a **fresh item variant** from the skill's pool, so the learner can't memorise the answer. Use `ts-fsrs` (5.4.2, MIT, FSRS-6). Its low-level `next_state(memory_state, t, grade)` and `forgetting_curve(t, S)` work on skill-level state directly `[docs: Context7]`.

```text
grade from evidence e and hint use:
  e < 0.5 or bottom-out hint → Again(1);  assisted correct → Hard(2);
  correct → Good(3);  correct ∧ latency < 0.5·expected ∧ confidence 'sure' → Easy(4)
targetRetention = profile.review.targetRetention (0.9 default; 0.85 for fact-heavy)

# FIRe-lite (implicit credit along encompassing edges)
on review of X with grade g:
  for (Y, w) in encompasses(X):              # hand/LLM-authored, teacher-visible
     if g ≥ Good:  S_Y ← S_Y + w · (S_Y' − S_Y)     # S_Y' = FSRS recall-stability as if Y reviewed with Good
     if g = Again: flag Y as "suspect" → schedule Y review now (failure propagates down)
  choose daily reviews greedily: pick X maximizing (#due skills it implicitly covers) — compresses reviews
```

`effective(skill, now) = pMastered · R(now)` is the number used for the mastery map's "current" view and for re-gating prerequisites (`R < 0.7` ⇒ review before the dependent lesson).

### 3.6 v2

| Upgrade | When | Why |
|---|---|---|
| Fit BKT parameters per skill (EM; pyBKT offline as reference) | instance has >1k attempts per skill | Defaults are crude |
| PFA / AFM as an alternative estimator for multi-skill items | items with ≥2 skills are common | Handles conjunctive items natively. Better accuracy in the literature `[paper]`. |
| FSRS optimizer per learner (`@open-spaced-repetition/binding`) | learner has a few hundred reviews | Personal forgetting curves |
| 2PL IRT calibration of checkpoint pools | pools have >100 responses per item | Teacher item analysis (discrimination), fairer checkpoints |
| LLM-assisted KT for cold start (e.g. text features of items) | only if evals show gains | Results are authors' own so far `[paper]` |
| Dialogue-based evidence (tutor chat turns as soft evidence) | after logging lots of chats | Risky: chat correctness is noisy |

### 3.7 Libraries

| Need | Library | Status |
|---|---|---|
| FSRS | `ts-fsrs` 5.4.2 (MIT, updated 2026-10-09). Optimizer: `@open-spaced-repetition/binding`. | **Use.** |
| BKT | No mature TS library. `masterytrace-cli` 0.1.3 (MIT, BKT+IRT) is too young. pyBKT (Python) is the reference for fitting. | Write about 60 lines yourself. |
| Glicko-2 / Elo | `glicko2` 1.2.2 on npm. Elo is about 10 lines. | Elo is enough for v1. |
| KST reference | R `kstMatrix` (half-split and informative assessment procedures) | Reference only |
| Chess | `chess.js`, Stockfish WASM, Maia (human-like play at Elo 1100–1900, KDD 2020/2022; Maia-2 NeurIPS 2024) `[paper]` | For the strategy profile |

---

## 4. Diagnostic: Bayesian half-split over the skill DAG

### 4.1 Model

- **Knowledge states are down-sets of the prerequisite DAG.** If a learner knows X, they know all of X's prerequisites. This is Knowledge Space Theory, where the states are the down-sets of a surmise relation. ALEKS's initial knowledge check uses at most 25 questions, and KST assessments run about 30–35 problems on large domains `[paper]`.
- **Noise.** Each question carries careless error β (slip) and lucky guess η (guess).
- **Scope.** The goal node's ancestors not already known with confidence from the learner's global graph. This is where a global graph pays off: a second course starts warm.
- **Belief.** A weighted set of K ≈ 3000 particles (sampled down-sets). Exact enumeration of down-sets explodes on wide DAGs.

### 4.2 Pseudocode

```text
diagnose(learner, goal):
  S ← ancestors(goal) ∪ {goal}  minus  {v : learner.state[v].confidence ≥ 0.8}
  prior per node: from learner global graph if present; else self-report bucket
                  ("never seen" 0.05 / "heard of" 0.3 / "used it" 0.6), weight low (self-report is biased)
  particles ← sample K down-sets of S:
      draw ability a; include v if level(v) + N(0,1) < a  (level = depth in S);
      keep only v whose ancestors are all included; bias toward prior marginals (importance weights)
  q ← 0
  loop:
    m[v] ← Σ_{particles containing v} w        # marginal P(v known)
    expErr ← mean_v min(m[v], 1 − m[v])
    if (q ≥ 5 ∧ expErr < 0.05) ∨ q ≥ 25 ∨ learner fatigue (3 consecutive "I don't know" + time > 12 min): break
    v* ← argmin_v |m[v] − 0.5| + 0.15·timesAsked(v)    # half-split; ties → more descendants+ancestors
    item ← fresh diagnostic item for v* (mid difficulty, no hints, MCQ/short/fast-perform)
    r ← grade(item)     # "I don't know" button ⇒ r = wrong with guess = 0 (removes guessing)
    for each particle P: w_P *= (v* ∈ P) ? (r ? 1−β : β) : (r ? η : 1−η)
    normalise; if ESS < K/4: resample (+ small mutation: flip a frontier node, keep down-closure)
    q++
  for v in S: learner.state[v] ← init(estimator(v), m[v]), provenance='diagnostic', confidence = |2m−1|
  pointA ← { v : m[v] ≥ 0.5 } ;  path ← plan(pointA → goal)
```

- **Kind-specific diagnostics.** `fact` nodes: sample 3–5 items from the deck, binomial estimate. `pattern` and `judgment`: Elo placement, about 8 rated puzzles with adaptive difficulty, as on Lichess. `performance`: 1–2 short artifact prompts graded by rubric, which set the dimension priors. Binary-searching these kinds doesn't work.
- **Items.** Each in-scope node needs ≥ 2 diagnostic items, generated at plan time and verified (answer key checked by a second model or solver, self-consistency). Teacher approval is optional.

### 4.3 Stopping rule and expected count

- **Stop when** the expected per-node misclassification `mean min(m, 1−m)` is below 5%, **or** at 25 questions. Minimum 5.
- **Expected count:** about 15 questions, 90th percentile about 20, for graphs of 30–120 nodes `[sim]`. Diminishing returns set in after 10–15.
- **Cold start, small course:** fall back to "skip ahead by checkpoint". The learner can take any lesson's checkpoint to test out, and the adapt pass trims mastered material.

### 4.4 Simulation results `[sim]`

The scripts are in `docs/research/sim-diagnostic/` (`python3 curve.py`, about 3 minutes). Setup: random layered DAGs with up to 3 parents per node, slip 0.10, guess 0.20, K = 3000 particles, 30 runs per row. "Noise 2.0" means the true state comes from a *noisier* process than the prior assumes, i.e. a misspecified prior.

| nodes | true-state noise | policy | node accuracy at q=0 / 5 / 10 / 15 / 20 / 30 | stop at expErr<5%: mean q (p90), accuracy |
|---|---|---|---|---|
| 30 | 1.0 | half-split | 0.74 / 0.88 / 0.93 / 0.94 / 0.95 / 0.97 | 15.3 (21), 0.957 |
| 30 | 1.0 | random | 0.73 / 0.83 / 0.86 / 0.89 / 0.92 / 0.92 | 29.5 (30), 0.920 |
| 60 | 2.0 | half-split | 0.72 / 0.87 / 0.91 / 0.93 / 0.94 / 0.95 | 14.9 (23), 0.935 |
| 60 | 2.0 | random | 0.75 / 0.85 / 0.86 / 0.88 / 0.88 / 0.90 | 28.2 (30), 0.897 |
| 120 | 1.0 | half-split | 0.76 / 0.89 / 0.92 / 0.94 / 0.95 / 0.96 | 14.9 (19), 0.942 |
| 120 | 2.0 | half-split | 0.76 / 0.86 / 0.90 / 0.92 / 0.93 / 0.94 | 15.6 (20), 0.925 |

How to read it:
- The question count barely grows with graph size, because down-closure does most of the work.
- Half-split mainly buys a **reliable stop**. Random questioning rarely becomes confident enough to stop.
- Accuracy plateaus at about 93–96% because of slip and guess. The remaining errors are "fringe" nodes, and the first checkpoint plus the adapt pass mops those up. That is cheaper than asking 10 more diagnostic questions.

Caveats: the graphs are synthetic, not real course graphs. Slip and guess are known to the model, and particles are drawn from a prior that matches the generator in the noise-1.0 rows.

---

## 5. LLM-tutor guardrails

### 5.1 Evidence → rule

| Evidence | Rule |
|---|---|
| Unrestricted GPT-4 harmed later unaided performance by 17%. Hint-only "GPT Tutor" mitigated the harm, despite +127% on practice (Bastani et al. 2025, n≈1000) `[paper]` | No answer-giving before an attempt. A hint ladder with bottom-out only in Practice. Practice scores are never used as mastery evidence without the hint discount. |
| A structured AI tutor built on the course's active-learning pedagogy, with step-by-step scaffolding, beat in-class active learning (Kestin et al. 2025, Harvard, n=194, crossover) `[paper]` | Tutor system prompts are **pedagogy-specific and versioned**, owned by the platform and the profile, and evaluated, not ad hoc. |
| Khanmigo RCT: about 0.06–0.08 SD per year, similar to Khan practice without AI. Many students didn't use it (NBER 2026) `[paper]` | Don't count on voluntary chat. Proactive help on wheel-spinning (≥3 wrong or 2 minutes idle on an item) is offered *inside* the exercise. |
| Learner history in the tutor context improved next-item correctness (Khan 2026) `[paper: vendor]` | Tutor context includes the mastery map, recent misconceptions and the current lesson's cited chunks (MCP `learner.context`). |
| LLM hints had about 30% errors. Self-consistency reduced that to about 0% in algebra and 13% in statistics (Pardos & Bhandari 2024) `[paper]` | Hints and feedback are checked against the server-side answer key or oracle. Math and code are verified by CAS or execution. Generate N and vote for anything shown in Checkpoint feedback. |
| Supervised AI tutoring matched or beat human tutors. Hallucination rate 0.1% under supervision (Eedi/LearnLM 2025, n=165, exploratory) `[paper]` | Teacher-approved checkpoint pools (already decided). Flagged grader outputs go to a teacher queue. |
| Tutor CoPilot raised probing questions and cut generic praise (Wang et al. 2024) `[paper]` | Tutor style rules: ask a probing question before explaining. Specific praise only. |
| LearnLM frames pedagogy as *instruction following*: the system prompt specifies the pedagogy, and experts preferred this by 13–31% (LearnLM 2024/25) `[paper]` | The profile's `TutorPolicy` compiles to explicit system instructions per mode. Keep a small eval set (§7). |
| Gaming the system (hint abuse) is negatively associated with learning. Delaying hints helps gamers `[paper: summary]` | Rate-limit hint escalation (e.g. ≥20 s or a new attempt between levels). Detect rapid hint streams and nudge. |
| Unguided ChatGPT meta-analytic "g=0.87" (Wang & Fan 2025) was **retracted** in April 2026 `[paper]` | Don't cite it. The evidence base for unstructured chat is weak. |

### 5.2 Policy per mode (platform-enforced)

| | **Lesson chat** (free Q&A) | **Practice** | **Checkpoint** | **Review** | **Diagnostic** |
|---|---|---|---|---|---|
| Tutor available | yes | yes | **no** | after attempt only | **no** |
| Before first attempt | explain freely, cite chunks | L1 only (orienting question) | — | nothing | — |
| Hint ladder | n/a | L1→L5, escalation rate-limited | none | one re-explanation after a fail | none |
| Bottom-out answer | n/a | L5 allowed. Item marked assisted (e=0); a sibling item is queued. | after submission, as feedback | after submission | never shown (so items are reusable) |
| Answer key on client | no | no (server grades) | **never** | no | **never** |
| Solve the current graded item in chat | **refuse**: chat sees the active item flagged secret; output is checked for answer leakage | via ladder only | — | — | — |
| Evidence weight | none | e = x·(1−h) | full | full, λ=0.5 | init only |

**Hint ladder (L1–L5)**, with the levels typed in the contract so plugins and the LLM fill them consistently:
1. **L1 Orient.** A Socratic question: "What is the knight attacking now?"
2. **L2 Point.** Name the concept or principle and link the lesson section and its cited chunk.
3. **L3 Analogous worked example** with different surface features.
4. **L4 Partial step.** The next step only, or "the failing test is X because…".
5. **L5 Bottom-out.** The answer with a full explanation, plus a self-explanation prompt ("why does that work?").

**Adult self-learners** (one person in all roles): the teacher role may raise `maxHintLevel` or allow "just tell me" in Practice. Answers are still never available in Checkpoint, and the evidence discount always applies. This respects autonomy without corrupting the mastery signal.

**Metacognition, cheap version.** Before grading in Review, ask "sure / unsure". Confident-wrong answers get extra review, and FSRS grade Easy needs "sure" `[memory: hypercorrection effect]`.

---

## 6. What the exercise plugin contract must include

This extends the locked contract (render item → capture response → grade → score + feedback + skill nodes).

```ts
interface ExerciseSpec {
  name: string; version: number
  kinds: ExerciseKind[]             // 'mcq'|'short'|'numeric'|'code'|'parsons'|'classify'|'board-move'|'artifact'|'explain'|'cloze'|...
  responseKind: 'choice' | 'text' | 'code' | 'moves' | 'image' | 'audio' | 'structured'
  grader: 'deterministic' | 'oracle' | 'llm-rubric' | 'pairwise' | 'human' | 'hybrid'
  supports: { steps: boolean; hints: boolean; partialCredit: boolean; timed: boolean; variants: boolean }
  itemSchema: JSONSchema7           // same contract style as lesson blocks (lesson-ir §4)
  generate?(req: ItemGenRequest): Promise<Item[]>        // optional plugin-side generator/validator
  validateItem?(item: Item): Diagnostic[]                 // e.g. FEN legal, tests pass on reference solution
  grade(item: Item, response: Response, ctx: GradeCtx): Promise<GradeResult>   // server-side, container if code
}

interface Item {
  id: string; isomorphGroup: string           // variants share a group; Review/retake draw a *different* member
  skills: { id: string; weight: number; role: 'target' | 'prereq' }[]
  kind: ExerciseKind
  cognitive: 'recall' | 'recognize' | 'apply' | 'transfer' | 'explain' | 'produce'
  difficulty: { b: number; source: 'llm' | 'teacher' | 'calibrated'; n: number }   // logits; Elo-updated
  scaffold: 'worked' | 'faded' | 'independent'; fadedSteps?: number
  modes: ('practice' | 'checkpoint' | 'review' | 'diagnostic')[]
  expectedTimeSec: number
  prompt: Json                                // renderer payload (no secrets)
  key: Json                                   // SERVER-ONLY: answer, tests, reference solution, engine config
  hints: { level: 1|2|3|4|5; text: string; cites?: string[] }[]   // pre-authored or generated-and-verified; L5 = bottom-out
  distractors?: { id: string; misconception?: string; feedback: string }[]
  steps?: { id: string; skills: string[]; key: Json }[]          // for step-based grading
  rubric?: RubricRef                          // dimensions → levels → descriptors, anchors, skill per dimension
  confusableWith?: string[]                   // skill ids, for interleaving
  cites: string[]                             // source chunks the item is grounded in
  provenance: { generatedBy: string; verifiedBy: ('selfConsistency'|'solver'|'teacher')[]; approvedVersion?: string }
}

interface GradeResult {
  score: number                               // 0..1
  correct?: boolean
  steps?: { id: string; score: number; skills: string[]; misconception?: string }[]
  rubric?: { dim: string; level: number; confidence: number; rationale: string; grader: 'llm'|'pairwise'|'oracle'|'teacher' }[]
  misconceptionsDetected: string[]
  oracle?: Json                               // e.g. { engineEvalLossCp: 180, bestMove: 'Nc7+' } or { testsPassed: 7, total: 9 }
  feedback: { text: string; cites?: string[]; revealsAnswer: boolean }   // platform blocks revealsAnswer in checkpoint
  graderConfidence: number                    // 0..1, feeds evidence weight + human-review flag
  needsHumanReview: boolean
}
// Platform (not plugin) adds: hintsUsed (max level), attempts, latencyMs, confidenceRating, mode, tutorTurns
// → one xAPI statement per attempt and per hint, keyed by item id + isomorphGroup + course version.
```

**Why each field earns its place:**

| Field | Needed by |
|---|---|
| `skills[].weight` and `role` | Multi-skill blame (§3.2), FIRe credit, the item-analysis view |
| `difficulty.b` | BKT guess/slip adjustment, Elo, diagnostic mid-difficulty pick, adaptive scaffolding |
| `isomorphGroup` | FSRS-per-skill validity (fresh variant), checkpoint retakes, diagnostic item reuse |
| `scaffold` | Worked → faded → independent progression |
| `hints[].level` | Hint discount, mode policy, gaming detection |
| `distractors[].misconception`, `steps[].misconception` | Targeted feedback, adapt-pass remediation, teacher misconception heatmap |
| `rubric` + anchors | Calibrated open-ended grading (§3.4) |
| `key` server-only | Answer withholding cannot be bypassed by an iframe |
| `confusableWith` | Interleaving |
| `cites` | Grounded hints and feedback, and fact-checking that ties into the sources design |
| `provenance.verifiedBy` | The LLM item-error rate (~30% unverified) means only verified items can enter checkpoint pools |
| `graderConfidence`, `needsHumanReview` | Teacher queue and evidence weighting |

---

## 7. Risks, open questions

**Risks**
1. **Generated items are wrong.** About 30% of unverified LLM hints and answers were wrong in Pardos & Bhandari `[paper]`. Mitigation: `validateItem`, solver/oracle checks, self-consistency, and teacher-approved checkpoint pools. Practice items can be looser.
2. **Rubric grading is not trustworthy for higher-order criteria** `[paper]`. Gating on LLM rubric scores without calibration would misclassify learners. Mitigation: §3.4 calibration and advisory-only dimensions.
3. **Default parameters are guesses.** BKT and Elo constants are not fit to any real data here. Mitigation: log every attempt in xAPI from day 1 so v2 can fit. Expose "strictness" rather than raw numbers.
4. **Hidden curriculum of the graph.** The diagnostic and FIRe are only as good as `requires` and `encompasses` edges, which LLMs will draft. Mitigation: teacher reviews the graph diff. Use item-analysis signals to detect bad edges: a learner fails X but passes its descendant Y often.
5. **The evidence base for LLM tutors is thin and short-term.** Most studies run 2–6 weeks, several are working papers or vendor reports, and one high-profile meta-analysis was retracted `[paper]`. Build an internal eval set rather than trusting marketing.
6. **Drawing, design and creative types have the weakest assessment story.** Expect teacher or self assessment to carry them in v1.

**Open questions for the user**
1. Is the 0.8 → 0.95 default acceptable, exposed as lenient/standard/strict? I recommend yes.
2. Which 3 profiles ship first? I recommend conceptual, programming and memorization, because they need only BKT and FSRS and their graders are objective.
3. Who authors `encompasses` edges? The agent drafts and the teacher approves, or skip FIRe in v1 and do plain per-skill FSRS. I lean towards plain FSRS in v1 with the field reserved, because FIRe is unvalidated outside Math Academy.
4. Should self-learners be allowed to disable answer withholding in Practice? I recommend allowing it, with the evidence discount always applied.
5. A tutor pedagogy eval: about 40 scripted learner scenarios per profile, judged against LearnLM-style rubrics. Do it before or after v1? I recommend a small version before v1, since the Bastani result shows the cost of getting this wrong.
6. Should the diagnostic be skippable ("start from scratch") and redoable mid-course? I recommend both, with redo limited to once per week.

---

## 8. Sources

**LLM tutors and guardrails**
- Bastani et al., "Generative AI without guardrails can harm learning", PNAS 122(26), 2025: [SSRN](https://papers.ssrn.com/abstract=4895486), [Wharton summary](https://knowledge.wharton.upenn.edu/article/without-guardrails-generative-ai-can-harm-education)
- Kestin, Miller et al., "AI tutoring outperforms in-class active learning", Scientific Reports 15:17458, 2025: [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC12179260/)
- Wang, Demszky et al., "Tutor CoPilot", 2024/25: [arXiv 2410.03017](https://arxiv.org/abs/2410.03017)
- LearnLM Team, "LearnLM: Improving Gemini for Learning": [arXiv 2412.16429](https://arxiv.org/abs/2412.16429)
- Jurenka et al., "Towards Responsible Development of Generative AI for Education": [arXiv 2407.12687](https://arxiv.org/abs/2407.12687)
- Eedi × Google DeepMind supervised LearnLM trial, 2025: [The 74](https://www.the74million.org/article/ai-tutors-with-a-little-human-help-offer-reliable-instruction-study-finds/)
- Khanmigo RCT (Oreopoulos & Low), NBER w35620: [NBER](https://www.nber.org/papers/w35620). Khan Academy learnings: [blog](https://blog.khanacademy.org/?p=21314)
- World Bank Nigeria RCT, "From Chalkboards to Chatbots", WP 11125: [OKR](https://openknowledge.worldbank.org/entities/publication/15e1ff08-15ae-4f7a-b2a8-d146e6c113ee)
- Pardos & Bhandari, ChatGPT vs human hints, PLOS ONE 2024: [PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11125466/)
- Retraction of the Wang & Fan 2025 ChatGPT meta-analysis: [Plagiarism Today](https://www.plagiarismtoday.com/2026/07/15/study-claiming-ai-helps-students-learn-retracted/)

**ITS effectiveness and effect-size context**
- VanLehn 2011, "Relative effectiveness of human tutoring, ITS and other tutoring systems" (Educational Psychologist 46(4)): [slides](https://quality.mit.edu/files/2012/01/Quality-Symposium-Kurt-VanLehn.pdf)
- Kulik & Fletcher 2016, "Effectiveness of ITS: a meta-analytic review": [IDA](https://www.ida.org/research-and-publications/publications/all/e/ef/effectiveness-of-intelligent-tutoring-systems-a-meta-analytic-review)
- Kraft 2020, "Interpreting effect sizes of education interventions": [EdWorkingPapers](https://edworkingpapers.com/ai19-10)
- von Hippel, "Two-sigma tutoring: separating science fiction from science fact": [Education Next](https://www.educationnext.org/two-sigma-tutoring-separating-science-fiction-from-science-fact/)

**Learning science**
- Brunmair & Richter 2019, interleaving meta-analysis: [PDF](https://www.psychologie.uni-wuerzburg.de/fileadmin/06020400/2019/Brunmair_Richter_in_press__2019_META-ANALYSIS_OF_INTERLEAVED_LEARNING.pdf)
- Macnamara, Hambrick & Oswald 2014, deliberate practice meta-analysis: [summary](https://www.sciencedaily.com/releases/2014/07/140716123835.htm), [Hambrick follow-up](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4101876/)
- Expertise reversal and fading (Kalyuga; Renkl & Atkinson; Salden et al. 2010): [Renkl review PDF](https://faculty.engineering.asu.edu/mre/wp-content/uploads/sites/31/2020/02/Exp_Rev_LI06.pdf), [Wikipedia overview](https://en.wikipedia.org/wiki/Expertise_reversal_effect)
- Gaming the system and hints: [arXiv 2512.18659](https://arxiv.org/pdf/2512.18659), [arXiv 2601.04487](https://arxiv.org/pdf/2601.04487)
- `[memory]`, not re-verified: Bloom 1984; Roediger & Karpicke 2006; Dunlosky et al. 2013; Chi et al. 1989/1994; Sweller (cognitive load); Bjork (desirable difficulties); Koedinger, Corbett & Perfetti 2012 (KLI); Kellman (perceptual learning modules); Graesser (AutoTutor); Anderson et al. 1995 (Cognitive Tutors); Mitrovic (constraint-based tutors); Roschelle et al. 2016 (ASSISTments RCT).

**Student modelling and diagnostics**
- Mastery thresholds: [EDM 2025 short paper](https://educationaldatamining.org/edm2025/proceedings/2025.EDM.short-papers.4/2025.EDM.short-papers.4.pdf), [Matayoshi et al. JEDM (ALEKS RCT)](https://jedm.educationaldatamining.org/index.php/JEDM/article/view/900), [Pelánek: mastery criteria](https://www.fi.muni.cz/~xpelanek/publications/mastery-modeling.pdf)
- PFA vs BKT: [Gong et al., JAI 2011](https://journals.sagepub.com/doi/10.3233/JAI-2011-016). [Zhang et al., EDM 2021](https://educationaldatamining.org/EDM2021/virtual/poster_paper126.html)
- Elo: [Pelánek 2016 (PDF)](https://www.fi.muni.cz/~xpelanek/publications/CAE-elo.pdf), ["Keeping Elo alive"](https://pmc.ncbi.nlm.nih.gov/articles/PMC12784335)
- LLM knowledge tracing: [systematic review, arXiv 2412.09248](https://arxiv.org/abs/2412.09248v1), [CLST](https://arxiv.org/abs/2406.10296v1), [LOKT](https://arxiv.org/abs/2410.12872v1)
- KST and ALEKS: [ALEKS shorter knowledge checks (MHE)](https://www.mheducation.com/content/dam/mhe/highered/documents/aleks/innovation-shorter-smarter-knowledge-checks.pdf), [Falmagne et al. 1990](https://stat.cmu.edu/~brian/nynke/726-2021/project%20HCI%20Prereqs%20(Elaine,%20Smeet%20&%20Zhou)/2021-02-23/Falmagne90.pdf), [kstMatrix](https://packages.oit.ncsu.edu/cran/web/packages/kstMatrix/refman/kstMatrix.html)
- Spaced repetition: [ts-fsrs](https://npmjs.com/package/ts-fsrs) (Context7 `/open-spaced-repetition/ts-fsrs`), [Settles & Meeder 2016, HLR](https://preview.aclanthology.org/landing_page/P16-1174), [Math Academy FIRe (Skycak)](https://justinmath.com/individualized-spaced-repetition-in-hierarchical-knowledge-structures/)

**Assessment of open-ended and perceptual skills**
- LLM comparative judgment: [arXiv 2407.05733](https://arxiv.org/html/2407.05733v1), [AIME-Con 2026](https://aclanthology.org/2026.aimecon-main.51.pdf), [LLM essay scoring reliability, arXiv 2508.02442](https://arxiv.org/abs/2508.02442v1)
- Rubric grading agreement: [Emirtekin & Özarslan 2026](https://gcris.yasar.edu.tr/entities/publication/1eeab52d-b73f-42b4-baa8-f2c94edfc8c1), [arXiv 2505.04645](https://arxiv.org/abs/2505.04645v1), [arXiv 2511.10819](https://arxiv.org/pdf/2511.10819v2)
- Drawing feedback: [Draw2Learn, arXiv 2602.01494](https://arxiv.org/html/2602.01494v1), [IWSDS 2026 VLM sketch checking](https://aclanthology.org/2026.iwsds-1.25)
- Chess: [Maia (KDD 2020)](https://csslab.cs.toronto.edu/blog/2020/08/24/maia_chess_kdd/), [personalized Maia (KDD 2022)](https://arxiv.org/abs/2008.10086), [Lichess puzzle Glicko-2](https://lichess.org/blog/X-S6gRUAAGjNX4ki/new-puzzles-are-here)
