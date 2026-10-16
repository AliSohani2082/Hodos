# Agentic tutoring, smart LMSs and similar projects: landscape for Hodos

Status: research, 2026-10-09. Scope: agentic ITS and AI course generation, adaptive LMS evidence, how to evaluate AI-generated courses, interoperability standards, competitors, and a verdict on the pending "4 learning loops + presets" decision. This report builds on `docs/research/intelligent-tutoring.md` (student model, tutor guardrails, exercise contract) and `docs/research/lesson-ir.md` (lesson format, storage) and does not repeat them. Where a point is already covered there, this report links to it instead of repeating it.

**Evidence labels.**
- `[paper]`: checked this session against the paper, its abstract or its full text. Links are in §8.
- `[paper: summary]`: checked only against a secondary summary.
- `[vendor]`: a company's own claim or a company-run study.
- `[repo]`: checked against the GitHub API or the README on 2026-10-09.
- `[memory]`: prior knowledge, not re-verified this session.
- `[design]`: my reasoning, with no direct evidence.

---

## 1. TL;DR: findings that change or confirm the design

| # | Finding | Evidence | Design hook |
|---|---|---|---|
| 1 | **Confirm the 4 loops + presets.** Learning science types *knowledge* rather than courses. Three of the four loops line up with KLI's three learning processes: memory & fluency → **Drill**, induction & refinement → **Recognize fast**, sense-making → **Explain → Check**. The fourth, **Attempt → Critique**, corresponds to 4C/ID's whole-task learning. No literature supports "course type" as the unit of pedagogy. | KLI (Koedinger et al. 2012) `[paper: summary]`; 4C/ID meta-analysis d = 0.79 `[paper]`; Merrill CDT `[memory]` | Keep the decision. Justify each loop in the docs with KLI or 4C/ID terms. The `kind` vocabulary stays at node level (§7). |
| 2 | **Amend: grader type is a separate axis from loop.** Programming's "write from spec" and "debug" tasks are 4C/ID whole tasks. With a test oracle, Loop 4 needs **no AI-rubric calibration**, and calibration was the stated reason for deferring Loop 4. | 4C/ID was designed for complex cognitive skills such as programming and troubleshooting `[memory]`, and it argues against building complex skills purely from part-tasks `[paper: summary]` | The programming preset uses loops **1, 2 and 4**. In v1, Loop 4 ships for nodes whose critique is deterministic (tests). AI review of code stays advisory. (§7) |
| 3 | **A pipeline with separate roles beats a single agent, and teacher checkpoints beat autonomy.** | Instructional Agents (5 courses, 5 expert raters each, 1–5 scale): single agent **2.33**, multi-agent autonomous **3.01**, with a teacher "catalog" 3.52, full co-pilot **3.74** `[paper]`. Decomposed lesson generation was rated above one-shot generation (Lin et al. 2025) `[paper]`. | Pipeline plan → write → verify → critique → simulate → teacher (§2.4). Add a **teacher checkpoint on the skill graph** before lessons are written, and a persistent **teacher catalog** file in the course repo. |
| 4 | **LLM judges cannot be the gate.** | Instructional Agents' LLM reviewers clustered at 2.9–3.1 and could not separate good outputs from weak ones `[paper]`. TutorGym: LLMs were no better than chance at labelling incorrect student steps `[paper]`. Rule-based item-flaw detection found 91% of flaws vs GPT-4's 79% `[paper]`. LLM judges prefer their own output `[paper]`. | Gates are deterministic first: schema, solver or test re-run, item-flaw lint, citation entailment. LLM critics are advisory, use **per-item binary checklists** rather than holistic 1–5 scores, and run in a fresh context, preferably on a different model family. |
| 5 | **Generated citations are wrong about half the time by default.** | About 51.5% of generative-search sentences were fully supported by their citations, and 74.5% of citations supported their sentence (Liu et al. 2023) `[paper]`. The best ALCE models lack full citation support about 50% of the time on ELI5 `[paper]`. | A claim → chunk **entailment check** in the verifier. Show a "citation support rate" per lesson in the teacher's diff, and list the unsupported claims. |
| 6 | **Simulated students are good at screening items, but they cannot show that a course teaches.** | Generative Students: per-item difficulty correlated with 100 real students at r = 0.72. Revising the flagged items raised real scores in a class of 280 `[paper]`. Prompted simulators are poor, and fine-tuned ones are still limited (Scarlatos et al., ACL 2026) `[paper]`. Weaker models simulate students better than strong ones `[paper]`. | Simulated students built from KC profiles run **before teacher approval** to flag items (guessable, ambiguous, wrong key, misconception tags that don't trigger). Show them as warnings only. Never report a "learning gain" from simulation. (§4.3) |
| 7 | **Smart-LMS effects are real but modest and conditional.** | K-12 ITS meta-analysis g = 0.27 `[paper]`. ALEKS overall g = 0.05, and 0.43 when it supplements a teacher `[paper: summary]`. ASSISTments +0.18 and +0.10 in two RCTs `[paper: summary]`. Most headline vendor numbers are unverified. | Position Hodos as a **supplement a teacher steers**, not a replacement. Make the adaptive layer explainable to teachers: Knewton lost teachers' trust partly because they couldn't predict what students saw `[paper: summary]`. |
| 8 | **AI-generated knowledge components can approach expert curricula once humans validate them.** | Campus AI: auto-generated KCs and exercises, validated by experts. Median 7.22 practice opportunities to 80% mastery vs 6.54 for expert curricula (1.8M interactions) `[paper]`. Learn Your Way RCT: 78% vs 67% retention after 3–5 days, n = 60 `[paper, vendor-run]`. | **Opportunities-to-mastery per skill** becomes the platform's main post-launch course-quality metric, compared across course versions. It comes for free from the xAPI log. |
| 9 | **Standards: support few, and support them well.** | xAPI 2.0 is IEEE 9274.1.1-2023 `[paper: summary]`. QTI 3 has no skills, difficulty, steps, misconceptions or hint levels `[paper]`. | v1: xAPI-shaped log (already decided) with optional forwarding to a Learning Record Store (LRS). v1.x: **LTI 1.3 tool**. Later: QTI 3 import/export adapter, CASE graph export, Open Badges 3.0. Skip SCORM and Caliper. (§5) |
| 10 | **"AI course generator" and "bring your own agent" are already taken.** DeepTutor (Apache-2.0, 41k★) and OpenMAIC (MIT, 40k★) both generate courses or books and both connect Claude Code or Codex. | `[repo]` | Hodos's differentiation is a **teacher-approved, versioned blueprint + a platform-owned mastery model with typed loops + sandboxed exercise plugins with server-side graders + one global skill graph** (§6.2). DeepTutor's mastery score is recency-weighted accuracy `[repo]`. |

---

## 2. Agentic ITS: architectures and evidence

### 2.1 Systems

| System | Architecture / roles | What was measured | Result | Label |
|---|---|---|---|---|
| **Instructional Agents** (EACL 2026) | ADDIE roles: Teaching Faculty (authority, final approval), Instructional Designer, TA (writes slides and assessments), Course Coordinator (context), Program Chair (review), Test Student (simulated feedback). Four modes: Autonomous, Catalog-Guided, Feedback-Guided, Co-Pilot (pauses after each subtask). | 5 university courses × 5 expert instructors, adapted Quality Matters rubric, 1–5 scale by "revision effort needed" | Autonomous 3.01, Catalog 3.52, Feedback 3.45, Co-Pilot 3.74. Single-agent ablation 2.33. Co-Pilot cost $0.36 and 30–45 min of human time on gpt-4o-mini. LLM reviewers clustered at 2.9–3.1. Feedback only works by regeneration, not fine edits. | `[paper]` |
| **EduPlanner** | Evaluator, optimizer and question-analyst agents in "adversarial collaboration". CIDDP rubric: clarity, integrity, depth, practicality, pertinence. | Math lesson plans (GSM8K, Algebra) | Claims gains plus ablations. No numbers in the abstract. Preprint. | `[paper]` |
| **Lin et al. 2025**, interactive lessons | RAG plus task decomposition vs single-step generation | 2 human raters, lesson-design rubric | Decomposition rated higher. Weaknesses: generic feedback, unclear sections. | `[paper]` |
| **GenMentor** (WWW'25 oral) | Goal → skills (fine-tuned LLM) → skill gap → learning-path scheduler → content via "exploration–drafting–integration" | Automated and human evaluation, deployment | Positive. The deployment satisfaction figure is second-hand. | `[paper]`, `[repo]` |
| **MAIC / OpenMAIC** (Tsinghua, JCST) | Multi-agent classroom: AI teacher + AI classmates, slides, quizzes, simulations, project-based learning | More than 100k learning records from more than 500 students, Tsinghua courses | Engagement and feasibility. No controlled learning comparison found. | `[paper: summary]` |
| **Learn Your Way** (Google) | LearnLM / Gemini 2.5 Pro re-levels a textbook to the learner's grade and interests, then derives representations: slides via several agents, a fine-tuned illustration model, quizzes. No critic stage is described. | RCT, n = 60, 40 min of study, immediate and 3–5-day tests. Experts rated 10 OpenStax sources. | Retention 78% vs 67%. Expert ratings ≥ 0.85 on all pedagogy criteria. | `[paper, vendor-run]` |
| **DeepTutor** (HKU) | Agent-native workspace: chat, solve, research, quiz, Book (outline review before generation), Mastery Path, memory (L1–L3), "consult_subagent" to Claude Code, Codex and others, MCP, skills | TutorBench (theirs), profile-driven simulated learner, 5 backbones | +10.8% on personalization metrics (simulator-judged) | `[paper]`, `[repo]` |
| **Ruffle&Riley** | Induces a tutoring script from lesson text. Two agents in a learning-by-teaching setup. | Online RCTs, N = 100 and N = 200 | **No significant post-test difference** vs reading or a QA bot. Higher perceived helpfulness. | `[paper: summary]` |
| **Agent4Edu** (AAAI 2025) | Simulated learner = profile (initialized from real data) + memory (reflection) + action | Agreement of agent responses with real learners. Used to test adaptive-testing algorithms. | "Human-like" responses | `[paper: summary]` |
| **Classroom Simulacra** (CHI 2025) | Transferable iterative reflection: predict, compare with ground truth, reflect, re-predict | 6-week course, N = 60, predicting correctness | Beat deep knowledge-tracing baselines with little data | `[paper: summary]` |
| **TeachTune** (CHI 2025) | Teachers review a tutor agent against simulated students with set knowledge and motivation levels | Simulator fidelity, user study with 30 teachers | Simulated behaviour within 5% / 10% of its settings. Lower teacher workload, wider profile coverage. | `[paper: summary]` |
| **Generative Students** (L@S 2024) | Each simulated student is a KC profile: mastered, confused or unknown | 45 GPT-4 students vs 100 real, then revision and a classroom test (n = 280) | Per-item r = 0.72. 3 of 4 real "hard" items flagged. Revised items +0.248. The authors caution that easier ≠ better. | `[paper]` |
| **Pedagogy RL** (Dinucu-Jianu et al., EMNLP 2025) | Online RL of a tutor against a simulated student. Reward = student solve-rate change, leak penalty, pedagogy judge. | BigMath, MathTutorBench | A 7B tutor ≈ LearnLM. A controllable Pareto front between pedagogy and solving. | `[paper: summary]` |
| **Tutor DPO** (Scarlatos et al. 2025) | Candidate tutor turns scored by a simulated student's P(correct) plus a GPT-4o rubric, then DPO | MathDial, simulated students only | Raised simulated P(correct) while keeping rubric quality | `[paper: summary]` |
| **Campus AI** (2026) | Auto-generated KCs and exercises, validated by experts | 1.8M interactions, Additive Factors Model | 7.22 vs 6.54 median opportunities to 80% mastery. Learning-rate regularity replicated. | `[paper]` |
| **EDUMATH** (ACL 2026) | Standards-aligned word-problem generation, joint expert + LLM judge, teacher-annotated data | 11k problems, student study | Students performed the same on model-written and human-written problems and preferred the customized ones | `[paper]` |
| **Graphusion** and prerequisite extraction | Topic modelling → LLM triplet extraction → global fusion. Pairwise "is A a prerequisite of B?" prompts. One 2026 paper drops bidirectional or ambiguous pairs. | Link prediction, TutorQA | Better graph-grounded answers. No standard accuracy for LLM prerequisite edges yet (the ESCO benchmark reports similarity metrics only). | `[paper: summary]` |
| **amosblomqvist/learn** (Hodos's inspiration) | pi config: a "teach" skill, quiz extension, `researcher` subagent for truth verification, SVG and Mermaid subagents | — | Single learner, no license | `[repo]` |

Surveys for wider reading: Chu et al., *LLM Agents for Education* (EMNLP Findings 2025; note that the authors include Squirrel AI staff), and the 2025 agentic-workflows review `[paper]`.

### 2.2 Recurring roles and the evidence for each

| Role | Seen in | Evidence it helps | Hodos mapping |
|---|---|---|---|
| Planner / designer (objectives, structure) | Instructional Agents, GenMentor, DeepTutor Book outline, OpenMAIC editable outlines | Catalog-guided mode won on structure items (objectives, syllabi) `[paper]` | Plan stage → `graph.yaml` + kinds + preset |
| Writer | everywhere | — | Lesson + item writer, one lesson ahead (already decided) |
| Verifier (truth, keys) | amosblomqvist researcher subagent, Oboe "verify" agents `[vendor]` | Self-consistency took LLM hint errors from about 30% to near 0% in algebra (see `intelligent-tutoring.md` §5.1). CoVe reduces hallucination `[paper]`. | A separate verify stage plus deterministic oracles |
| Critic / evaluator (pedagogy) | EduPlanner, Instructional Agents Program Chair | Holistic LLM scores don't discriminate `[paper]`. Per-sample rubric checklists reach F1 0.82 vs 0.91 for the best single human (TutorBench) `[paper]`. | Checklist critic, advisory |
| Simulated student | Instructional Agents Test Student, TeachTune, Generative Students | Item screening validated (r = 0.72). Dialogue simulation weak `[paper]`. | Item screen + tutor-policy regression tests |
| Human approver | Instructional Agents Co-Pilot, Eedi/LearnLM (76% of drafts approved unedited; see `intelligent-tutoring.md` §1) | Co-Pilot +0.73 over Autonomous `[paper]` | Teacher checkpoints A (graph) and B (diff) |

### 2.3 Teacher-in-the-loop patterns that work

| Pattern | Evidence | Hook |
|---|---|---|
| **Approve structure before content.** It is cheap and catches the costliest errors. | Catalog and Co-Pilot modes beat feedback-after-the-fact on structure `[paper]`. DeepTutor and OpenMAIC both review outlines first `[repo]`. | **Checkpoint A:** the teacher approves `graph.yaml` (nodes, kinds, prerequisite edges, objectives) before any lesson is written |
| **Persistent teacher preferences** ("Educator_Catalog") | Catalog-Guided mode cost 10–15 min of human time and scored +0.51 over Autonomous `[paper]` | A `catalog.md` / `catalog.yaml` in the course repo (tone, level, banned topics, exemplars, house rules). Every agent run reads it. Teacher edits to drafts can be distilled into it. |
| **Fine-grained, anchored feedback** | The Instructional Agents limitation: regeneration only, no fine edits `[paper]` | Comments anchored to stable block ids (already in `lesson-ir.md` §7). Regenerate one block, not the lesson. |
| **Show the flagged items first; batch-approve the clean ones** | 76% of tutor drafts approved unedited (Eedi). Teachers spend real time fixing realism and depth, and it does not get much faster with practice (Walkington et al. 2026, 7 teachers, 521 students) `[paper]` | The diff view sorts items by verifier, critic and simulator flags |
| **Cost and time estimate before generation** | DeepTutor shows a cost estimate before a book outline is approved `[repo]` | Show the estimate at Checkpoint A |
| **Teachers must be able to predict what students see** | Knewton: a professor could not anticipate which problems students would get `[paper: summary]` | The blueprint is fixed and the adaptive layer is bounded and logged. Add a "why this item" rationale per adaptive decision in the student mastery map view. |

### 2.4 Recommended course-generation pipeline

The **agent owns drafting and the platform owns the gates.** Every gate is an MCP tool or a platform job, so any harness (Claude Code, Codex, …) hits the same checks `[design]`.

```
Intake ─► 1 PLAN ─► [Checkpoint A: teacher approves graph] ─► 2 WRITE (one lesson ahead)
                                                               │
          ┌────────────────────────────────────────────────────┘
          ▼
   3 VERIFY (fresh context) ─► 4 CRITIQUE (checklist) ─► 5 SIMULATE (item screen)
          │  fail → back to WRITE with diagnostics (max k rounds)          │
          └───────────────────────────────► 6 TEACHER DIFF + quality report ─► approve = commit + tag
Post-launch: 7 OBSERVE (xAPI item analysis, opportunities-to-mastery) ─► adapt pass / flagged-item queue
```

| Stage | Who | Inputs → outputs | Gates (deterministic unless marked) | Evidence |
|---|---|---|---|---|
| 1 Plan | Harness agent (planner role) | Goal, audience, sources, `catalog` → `graph.yaml` (nodes, `kind`, `requires`, objectives, source links), preset choice | DAG acyclic; every node has ≥ 1 cited chunk; kinds allowed by the preset; each prerequisite edge confirmed by a second pairwise query, and bidirectional or ambiguous pairs dropped `[paper: summary]`; graph-size budget | Structure-first review `[paper]` |
| A | Teacher | Graph diff + cost estimate | Approve / edit / comment | §2.3 |
| 2 Write | Harness agent (writer role) | Markdoc lesson + exercise envelopes + checkpoint pool | Markdoc validation and repair loop (`lesson-ir.md`), envelope schema, cite ids resolve, misconception ids resolve, **rule-based item-flaw lint** (absolute terms, "all of the above", longest-option cue, etc.), plugin `validateItem` (reference solution passes the tests, the solver agrees with the key) | Rules beat GPT-4 at flaw detection `[paper]` |
| 3 Verify | **Separate session**, preferably a different model family | Each factual claim + its cited chunk → supported / unsupported. Each answer key → re-solved N times; disagreement fails. CoVe-style questions for uncited claims. | Support rate ≥ threshold; zero key disagreements in checkpoint pools | Citation support is about 50% by default; self-consistency fixes most key errors; self-preference bias `[paper]` |
| 4 Critique | Separate session (critic role) | Lesson → **binary checklist** from the preset (ends with retrieval items, worked example present for `procedure`, no answer leaks in hints, reading level, objective coverage, LearnLM principles) + concrete edit suggestions | Advisory. Failed checklist items are shown to the teacher. | Checklists work; holistic LLM scores don't `[paper]` |
| 5 Simulate | Platform job, small model | KC-profile students take checkpoint items (§4.3) | Warnings only | Generative Students `[paper]` |
| 6 Diff | Teacher | Diff + quality report (support rate, flags, critic misses, simulator warnings) | Approve → commit + tag (already decided) | — |
| 7 Observe | Platform | xAPI → item p-value and discrimination, hint rates, opportunities-to-mastery, review lapses | Items that misbehave go to the teacher queue | Campus AI, Koedinger 2023 `[paper]` |

**Single agent or pipeline?** Pipeline roles, but not necessarily separate products. A harness like Claude Code can run planner and writer in one long session, because they share context deliberately. The **verifier and critic must not share the writer's context**, because LLM judges recognize and favour their own generations `[paper]`. Run them as fresh sessions, or as direct LLM calls through the hot-path adapter with a different model where the admin configured one `[design]`.

---

## 3. Smart LMS landscape

### 3.1 Systems and evidence

| System | Core model | Evidence on outcomes | Label |
|---|---|---|---|
| **ALEKS** (McGraw Hill) | Knowledge space theory, prerequisite structure, ≤ 25-question assessment | Meta-analyses: "as good as, not better than" classroom teaching (Fang 2019). Overall g = 0.05, supplemental use g = 0.43 (Sun 2021). In a 2025 K-12 meta-analysis g = 0.014, n.s. | `[paper: summary]` |
| **ASSISTments** | Teacher-assigned practice with immediate feedback, open research platform | RCTs: Maine +0.18, North Carolina +0.10 (measured a year later, COVID-disrupted). "Top Tier" rating from the Arnold Ventures–backed evidence review, ESSA "Strong". | `[paper: summary]` |
| **MATHia / Cognitive Tutor** | Model tracing + BKT | See `intelligent-tutoring.md` §1 | `[memory]` |
| **ITS in general (US K-12)** | — | 18 studies, 77 effect sizes, 11 products: **g = 0.27**. Moderators: worked examples, duration, immediate testing. Smaller effects in rural schools. | `[paper]` |
| **Squirrel AI** | Fine-grained knowledge graph, adaptive paths | SRI-hosted RCTs (8th-grade math, China) beat teacher-led instruction, but independence is unclear. The company-authored arXiv paper and the Guinness/iResearch "experiment" are not independent. | `[paper: summary]`, `[vendor]` |
| **Knewton** (defunct, assets sold to Wiley in 2019) | Black-box adaptive engine licensed to publishers | No outcome evidence found. Lost teachers' trust ("black box", unpredictable assignments). | `[paper: summary]` |
| **Duolingo Birdbrain** | A neural network predicts P(correct) per exercise and jointly learns learner ability and exercise difficulty. Sessions target about 70% success. Run in shadow mode before launch. | Company engineering reports. In 2025, 148 courses were built with generative AI from a "shared content" base, with expert validation. | `[vendor]` |
| **Math Academy** | Knowledge graph, diagnostic to find the "knowledge frontier", FIRe spaced review | No independent efficacy study found | `[vendor]` |
| **Area9 Rhapsode** | A confidence rating on every response | No independent study found. A preregistered lab replication found no metacognitive training effect, which is a caution for the idea in general. | `[vendor]`, `[paper: summary]` |
| **Khanmigo** | Socratic LLM tutor + teacher tools | NBER RCT about 0.06–0.08 SD (see `intelligent-tutoring.md` §5). Low voluntary use. | `[paper]` |
| **LearnLM / Learn Your Way** | Pedagogy-tuned Gemini; textbook transformation | Arena: experts preferred Gemini 2.5 Pro in 73.2% of comparisons, on 5 learning-science principles. Learn Your Way RCT above. | `[paper, vendor-run]` |
| **NotebookLM** | Source-grounded Q&A and study aids | **No controlled learning study found** | — |
| **Coursera Coach** | In-course LLM assistant | "9.5% higher first-attempt quiz pass rate", comparison group not described | `[vendor]` |
| **Uplimit** | AI course authoring from documents, role-play agents, agents that flag struggling learners | Completion 75–94% | `[vendor]` |
| **ChatGPT Study Mode / Gemini Guided Learning / Claude learning modes** (2025) | Socratic chat modes | No outcome studies. Normal answer-giving is one toggle away. | `[paper: summary]` |
| **OATutor** (CHI 2023) | Open-source ITS: BKT, A/B testing, LTI, CC BY content | Research platform | `[paper: summary]`, `[repo]` |
| **Moodle 4.5+ AI subsystem** | "Placements": editor generate text/image, course assistance summarise/explain | No course generation and no adaptivity | `[paper: summary]` (docs) |
| **Open edX** | AI course creation via a third-party plugin (Blend-ed). Adaptivity is still roadmap. | — | `[paper: summary]` |

### 3.2 Recurring design patterns

| Pattern | Where | Evidence strength | Hodos status / hook |
|---|---|---|---|
| Prerequisite graph + mastery gating | ALEKS, Math Academy, Squirrel AI, Cognitive Tutor | Moderate (ITS meta-analyses) | Have it. Gate at 0.95 per `intelligent-tutoring.md`. |
| **Use as a supplement, with a teacher in charge** | ALEKS supplemental g = 0.43 vs 0.05 overall; ASSISTments is teacher-assigned | Moderate | Product framing: teacher dashboards and assignments come first, not "replace class" |
| Difficulty calibrated from response data; aim for a success rate | Birdbrain (~70%), Elo/Glicko puzzles | Vendor and engineering practice | `difficulty.b` exists. Add a Practice-session `targetSuccess` (default 0.7–0.8) to the session builder `[design]`. |
| Spaced, graph-aware review | Duolingo (HLR), Math Academy (FIRe) | Strong for spacing, weak for FIRe | Have FSRS. FIRe deferred (`intelligent-tutoring.md`). |
| **Shadow mode** before a model drives decisions | Birdbrain | Practice | New estimators and adapt policies log their predictions alongside the live ones before switching over. One flag per estimator. `[design]` |
| Built-in experimentation | ASSISTments, OATutor | Field-standard for research platforms | Reserve an `experiment` / `variant` field on blueprint items and in xAPI context. A/B arrives later. `[design]` |
| Teacher-legible adaptivity | Knewton's failure case | Qualitative | "Why this item" rationale in the adaptive log (§2.3) |
| Proactive help, not voluntary chat | Khanmigo low uptake | RCT | Already in `intelligent-tutoring.md` §5 (wheel-spinning trigger) |

---

## 4. Evaluating AI-generated courses

### 4.1 Methods

| Method | Measures | Validity evidence | Use in Hodos |
|---|---|---|---|
| Expert rubric (Quality Matters, 6-dimension content rubric, LearnLM's 5 principles, CIDDP) | Structure, accuracy, pedagogy | Standard. Costs experts' time. | Teacher review only. Too costly for every lesson. |
| LLM judge, holistic 1–5 | "Quality" | **Fails to discriminate** (clusters at 2.9–3.1) `[paper]` | Don't use it as a gate |
| LLM judge with **per-item binary rubric criteria** | Specific behaviours | TutorBench F1 0.82 vs the best single human's 0.91 `[paper]` | Critic stage (§2.4) |
| Tutor benchmarks: MRBench (8 dimensions), MathTutorBench, MathDial, TutorBench, Pedagogy Benchmark (920 teacher-exam multiple-choice questions, 97 models scored 28–89%) | Tutor behaviour, pedagogical knowledge | Published. MathDial: ChatGPT revealed the answer in 66% of dialogues and gave incorrect feedback in 59% `[paper]`. | Choosing the tutor model. Borrow MRBench dimensions for our tutor regression set. |
| Citation / factuality (ALCE, Liu et al., CoVe) | Claim support | NLI-based metrics agree with humans 78–85% (ALCE) `[paper: summary]` | Verifier support rate |
| Rule-based item-flaw lint | Item-writing flaws | 91% vs GPT-4's 79% `[paper]`. A 2026 review warns that headline accuracy can hide poor recall on flawed items `[paper: summary]`. | Write-stage gate |
| Simulated students → item statistics | Difficulty, ambiguity | r = 0.72 per item (Generative Students). IRT fit from simulated grade-level students correlates 0.75–0.82 with NAEP item statistics; weaker models are better simulators `[paper: summary]`. LLMs misjudge human difficulty systematically, and scale doesn't fix it `[paper: summary]`. | Item screen (§4.3) |
| Simulated students → dialogue | Tutor adaptivity | Prompted simulators "perform poorly". SFT/DPO is better but limited `[paper]`. The "competence paradox": a capable model plays a partial learner badly `[paper]`. | Regression tests for tutor prompts only, with a written epistemic-state specification |
| Real learners: RCT, learning curves, item analysis | Learning | Gold standard. Learning rate ≈ 0.1 logit per opportunity across 27 datasets (Koedinger 2023) `[paper: summary]`, though a 2026 reanalysis says the estimate is sensitive to sequence length `[paper: summary]`. | Post-launch observe stage |
| Engagement / satisfaction | Liking | **Not learning.** Ruffle&Riley got higher perceived helpfulness and no post-test gain `[paper: summary]`. | Never a quality gate |

### 4.2 Proposed eval harness (tiers)

| Tier | When | Checks | Pass rule | Cost |
|---|---|---|---|---|
| **T0 deterministic** | Every save, inside the repair loop | Markdoc and envelope schema; graph DAG; cite, skill and misconception ids resolve; item-flaw lint; plugin `validateItem` (tests pass on the reference solution, CAS agrees, FEN legal); duplicate-item detection by isomorph group | Blocking | Cheap, cached per block hash |
| **T1 per-lesson model checks** | Before the teacher diff | Claim entailment (support rate); key re-solve ×N; critic checklist; simulated-student item screen | Key disagreement in a checkpoint pool blocks. Everything else is a flag. | About 10²–10³ small-model calls per lesson `[design]` |
| **T2 tutor and prompt regression** | Whenever a profile's `TutorPolicy` or prompt version changes (CI) | About 40 scripted scenarios per profile (already proposed in `intelligent-tutoring.md` §7 Q5), with simulated students given a written epistemic state. Metrics: answer-leak rate, mistake identification and location, guidance (MRBench dimensions), checkpoint refusal. | No regression on leak rate. Others reviewed by a human. | Moderate, offline |
| **T3 real data** | Continuous after publish | Item p-value and point-biserial, hint and bottom-out rates, **opportunities-to-mastery per skill**, checkpoint first-pass rate, review lapse rate, simulator-vs-real difficulty correlation (calibrates T1 per instance) | Outliers go to the teacher's flagged queue; compare course versions | Free (xAPI) |

### 4.3 Simulated-student item screen (spec)

Built from what the blueprint already has `[design]`, following Generative Students and the epistemic-state framing:

- **Profiles per checkpoint item:** `unknown(target)` (prerequisites mastered, target not), `mastered(target)`, and `confused(m)` for each misconception `m` tagged on the item's distractors.
- **Epistemic state:** the simulated student's context contains only the lessons for skills in its mastered set, plus the misconception registry entry for `m` when confused. It never sees the current lesson's answer key. Use a **smaller model** (weaker models simulate better).
- **Flags:**
  - `unknown` answers correctly in ≥ 2 of 3 samples → *guessable or answerable without the skill*.
  - `mastered` fails → *key wrong or item ambiguous*.
  - `confused(m)` doesn't pick the distractor tagged `m` → *misconception tag unsupported*.
  - Every profile is right → *too easy for checkpoint use*.
- **Never** turn the result into a score or a "predicted learning gain". Record the simulator-vs-real p-value correlation per instance once real data arrives (T3), and retire the screen if it falls below a threshold, e.g. r < 0.4.

---

## 5. Standards

### 5.1 What to support, and when

| Standard | Status (2026) | Hodos | Why |
|---|---|---|---|
| **xAPI 2.0** | IEEE 9274.1.1-2023, also ISO/IEC/IEEE 39274-1-1:2025 `[paper: summary]` | **v1**: internal event shape (already decided) + optional forwarding to an external LRS | Self-hosters and researchers can plug in any LRS (e.g. SQL LRS, Apache-2.0) `[repo]` |
| **LTI 1.3 + Advantage** (Deep Linking 2.0, Assignment & Grade Services 2.0, Names & Roles 2.0, dynamic registration) | Mature; Moodle can be platform or tool `[paper: summary]` | **v1.x**, as a *tool* | Schools already run an LMS, and the evidence favours supplement use (§3). A teacher deep-links a Hodos course or skill into Moodle or Canvas, and mastery/checkpoint scores flow back. Node library: ltijs (Apache-2.0, active) `[repo]`. |
| **QTI 3.0 / 3.0.1** | Final since 2022 `[paper]` | **Later**: import/export adapter for built-in item kinds | Teachers have existing item banks. Lossy both ways (§5.2). Not the internal format. |
| **CASE 1.1** | Final. CFDocument / CFItem / CFAssociation (extensible types) / CFRubric `[paper]` | **Later**: export the skill graph; import standards frameworks so nodes can align to them | It is the standard way to name competencies. The global skill graph could align to state or national frameworks. |
| **Open Badges 3.0 / CLR 2.0** | Final (Feb 2023), W3C Verifiable Credentials `[paper: summary]` | **Later**: issue a badge on mastering a skill or completing a course | Cheap to add once mastery is trustworthy. Only for gated, non-AI-graded evidence. |
| **cmi5** | IEEE P9274.3.1; ADL expected approval in 2025, not confirmed `[paper: summary]` | Only if asked | Only matters when an LMS launches Hodos content as an assignable unit |
| **Caliper 1.2** | Not equivalent to xAPI; institutional analytics, fragmented adoption `[paper: summary]` | Skip | xAPI covers the need |
| **SCORM** | Legacy | Skip | Static packages can't carry an adaptive layer or server-side grading |

### 5.2 QTI 3 vs the Hodos exercise contract

| Concept | QTI 3 `[paper]` | Hodos (`intelligent-tutoring.md` §6, `lesson-ir.md` §9) | Note |
|---|---|---|---|
| Identity / variants | `identifier`; `qti-template-declaration` + template processing for item cloning | `id` + `isomorphGroup`; generated variants | QTI cloning is parametric. Ours is generative and anchored to the group. |
| Response | `qti-response-declaration` with `cardinality`, `base-type` | `responseKind` | **Borrow** QTI's cardinality/base-type vocabulary for built-in kinds |
| Scoring | `qti-correct-response`, `qti-mapping`, `qti-response-processing` (templates such as `match_correct`, `map_response`) | Server-only `key` + plugin `grade()` | **Borrow** declarative templates as a no-code grader for simple kinds: portable and exportable |
| Interactions | About 20 built-in kinds + `qti-portable-custom-interaction` (a JS module with `getResponse`/`getState`) | Exercise plugins in a sandboxed iframe | A PCI is like our plugin UI, but QTI scoring stays declarative. Our graders are server-side code, so plugin kinds don't export. |
| Feedback | `qti-modal-feedback` driven by outcomes; rubric blocks per audience | `feedback` with `revealsAnswer`, `x-release` schedule, rubric refs | Ours is richer |
| Hints | No native hint ladder. Can be modelled with adaptive items or `end-attempt` `[memory]`. | `hints[]` with levels 1–5 | QTI gap |
| Skills / difficulty / steps / misconceptions / provenance | Not in the item model (alignment lives in metadata) `[memory]` | First-class | QTI gap. Export drops them, or puts them in metadata. |
| Shared stimulus | `qti-assessment-stimulus-ref` | Lesson context + `cites` | Map on export |
| Accessibility | `qti-catalog-info` + learner needs profile (PNP); WAI-ARIA | **Not designed yet** | **Gap on our side.** Add an accessibility-catalog concept (glossary, alternative text, read-aloud) to the envelope before v1 freezes. |
| Format | XML + HTML5 subset. JSON binding only for PCI variables. | Markdoc + JSON AST | Export is a projection |

Verdict: our contract is a superset for adaptive use. QTI is worth an adapter, not adoption. Two things to borrow before v1 freezes: the **response vocabulary and declarative scoring templates** for built-in kinds, and the **accessibility catalog** idea `[design]`.

---

## 6. Similar projects

### 6.1 Table

Star counts and last-push dates were checked on 2026-10-09 `[repo]`.

| Name | License | Activity | What it does | How Hodos differs |
|---|---|---|---|---|
| [HKUDS/DeepTutor](https://github.com/HKUDS/DeepTutor) | Apache-2.0 | 41k★, pushed 2026-10-08, weekly releases | Agent-native learning workspace: chat, solve, research, quiz, Books built from typed blocks (outline review first), Mastery Path with a gate, Course Study, scheduled practice, three-layer memory, multi-engine RAG + `kb eval`, multi-user/admin, MCP, EduHub skills, **consults Claude Code/Codex**, "loop-plugin framework" | Learner-centric. No teacher-approved versioned blueprint, no class tracing. Mastery = recency-weighted accuracy with a confidence cap (`deeptutor/learning/mastery.py`), not BKT/FSRS/Elo. Plugins are tools and skills, not sandboxed exercise graders with server-only keys. |
| [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) | MIT | 40k★, pushed 2026-10-09 | Topic or document → multi-agent classroom: slides, quizzes, generated interactive HTML simulations, project-based learning, AI teacher + classmates, whiteboard, TTS, PPTX/HTML/MP4 export. Agent-workbench skill for OpenClaw/Codex. Server-first with Postgres from 1.2. | Presentation-centric. No mastery model or skill graph found. Generates interactive *code*, where Hodos selects audited registry plugins. No teacher approval flow. |
| [lfnovo/open-notebook](https://github.com/lfnovo/open-notebook) | MIT | 40k★ | Open NotebookLM: sources → chat, notes, podcasts | Study aid. No course, no assessment model. |
| [amosblomqvist/learn](https://github.com/amosblomqvist/learn) | none | 3.4k★, pushed 2026-08 | pi agent config: teach skill, quizzes, researcher subagent for verification, visual subagents | The original inspiration. Single learner, chat-driven. Hodos turns it into a multi-role platform. |
| [GeminiLight/gen-mentor](https://github.com/GeminiLight/gen-mentor) | CC0-1.0 | 133★ | GenMentor research code: goal → skill gap → path → content | Research prototype. No versioning, plugins or mastery estimators. |
| [CAHLR/OATutor](https://github.com/CAHLR/OATutor) | MIT | 264★, active | Open ITS: BKT, A/B tests, LTI, CC BY algebra content | Hand-authored content, no AI generation. Good reference for LTI and experiments. |
| [plastic-labs/tutor-gpt](https://github.com/plastic-labs/tutor-gpt) | GPL-3.0 | 931★ | "Theory of mind" LLM tutor | Chat tutor only |
| [JushBJJ/Mr.-Ranedeer-AI-Tutor](https://github.com/JushBJJ/Mr.-Ranedeer-AI-Tutor) | none | 29.6k★, last push 2025-09 | A GPT-4 tutor prompt | A prompt, not a platform |
| [learnhouse/learnhouse](https://github.com/learnhouse/learnhouse), [frappe/lms](https://github.com/frappe/lms) | AGPL-3.0 | 2.3k★ / 3.3k★ | Conventional open-source LMSs | No adaptive model. Possible LTI hosts. |
| [legostin/learn-almost-anything](https://github.com/legostin/learn-almost-anything) | none | 9★ | Desktop tutor on the Claude Agent SDK / Codex SDK: courses, widgets, tests, TTS | Closest in "BYO agent" spirit. Single user, tiny. |
| Moodle 4.5+ / Open edX (+ Blend-ed AI Course Creator) | GPL / AGPL | — | Classic LMSs with AI text placements or third-party course generation | No adaptivity. Best integrated via LTI, not competed with. |
| **Commercial:** Khanmigo, Learn Your Way / LearnLM, NotebookLM, Oboe (multi-agent course generation, 9 formats, no mastery model `[paper: summary]`), Uplimit (enterprise), Coursera Coach, ALEKS, Math Academy, Squirrel AI, Duolingo, Area9 Rhapsode, Campus AI, ChatGPT/Gemini/Claude study modes | proprietary | — | See §3.1 | Closed, hosted, not self-hostable, no plugin model. Several have stronger proprietary models or data than Hodos will have. |

Worth borrowing:
- DeepTutor's `kb eval` (retrieval regression gate with Recall@k and nDCG) for the sources pipeline.
- DeepTutor's outline-before-book review and cost estimate.
- OpenMAIC's scene types as ideas for layout plugins.
- OATutor's A/B framework and LTI wiring.

### 6.2 Positioning

> **Hodos is the self-hosted platform where a teacher steers any coding agent to build a course, approves it like a pull request, and students then learn from it with a mastery model the platform guarantees.** Generation is commodity: DeepTutor, OpenMAIC and Oboe all do it, and two of them already plug in Claude Code or Codex. What none of them combine is (1) a **versioned, teacher-approved blueprint** with structure-first checkpoints, (2) a **platform-owned mastery model** (BKT/FSRS now, Elo and rubric later) behind typed learning loops, so that "mastered" means the same thing in every course and in one global skill graph, (3) **sandboxed exercise plugins with server-side graders and secret keys**, and (4) **class-level tracing** for the teacher. Lead with those four, not with "AI makes courses".

Risk to watch: DeepTutor ships weekly and has a loop-plugin framework and a mastery gate. If it adds teacher roles and a real student model, the gap narrows to (1) and (3).

---

## 7. Verdict on the course-type design: 4 loops + presets

**Confirm, with two amendments.** Confidence: medium. No study tests "loops as platform primitives" directly. The design is consistent with the main instructional-design theories, and I found nothing that contradicts it.

### 7.1 Evidence

- **The theory-backed unit is the kind of knowledge, not the course.**
  - KLI: the best instructional choice depends on the learning process the knowledge component needs, which depends on its type (constant or variable input and response, verbal or not, with or without a rationale) `[paper: summary]`.
  - Merrill's CDT (fact/concept/procedure/principle × remember/use/find), Bloom-Anderson's knowledge dimension and Gagné's capabilities all classify *learning outcomes* `[memory]`.
  - None of them defines "course types". So the presets are a convenience and the node `kind` is the real switch. This supports the planning agent and `intelligent-tutoring.md` §2.
- **The four loops map onto established processes and proven systems:**

| Loop | KLI process | 4C/ID component | Merrill CDT | Proven systems | Estimator |
|---|---|---|---|---|---|
| Explain → Check | Understanding & sense-making (+ induction, for procedure practice) | Supportive information + learning tasks for recurrent parts | concept / principle / procedure × use | Cognitive Tutor, ALEKS, ASSISTments | BKT |
| Drill | Memory & fluency | Part-task practice | fact × remember | SuperMemo/Anki (FSRS), Duolingo HLR | FSRS per item |
| Recognize fast | Induction & refinement (perceptual) | Part-task practice for recurrent perceptual skills | concept × use (classification) | Kellman's perceptual learning modules `[memory]`, Lichess puzzle Glicko | Elo |
| Attempt → Critique | Integrating many KCs (KLI is weakest here) | **Whole learning tasks** + just-in-time feedback | principle / procedure × find | Deliberate practice, writing feedback, 4C/ID programmes (d = 0.79) | Rubric-ordinal / oracle |

- **The alternatives are weaker.**
  - *7 named profiles*: no literature supports the course as the pedagogical unit, and the KLI-mixing argument applies.
  - *One generic type*: contradicts KLI ("principles effective in some cases are ineffective or counter-productive in others") and the interleaving and deliberate-practice findings already in `intelligent-tutoring.md`.

### 7.2 Amendments

1. **Separate the grader from the loop.** Loops are defined by learning process + evidence model + gate. Graders (deterministic, oracle/engine, LLM rubric, pairwise, human) are an orthogonal plugin property (`ExerciseSpec.grader` already exists). Fix the artifact's loop cards so "Graded by" reads as *allowed evidence types*, not as the definition of the loop.
2. **Programming uses loops 1, 2 and 4, and Loop 4 can ship in v1 for deterministic critique.**
   - In 4C/ID terms, "write from spec", "debug" and small projects are whole tasks. The critique comes from the test oracle (pass/fail per test, per-test feedback), with AI code review shown as advisory only.
   - The reason for deferring Loop 4 was AI-rubric calibration. That reason does not apply when the critique is deterministic.
   - Minimal v1: a `performance` node whose single gated dimension is "functional correctness", gated by tests passing on ≥ 2 distinct specs (the rubric-ordinal rule from `intelligent-tutoring.md` §3.4 with an oracle grader). Style and design dimensions stay advisory.
   - The plugin needed for this (the code-runner) is already the v1 showcase.
3. *(Smaller)* 4C/ID says whole tasks should appear **early and repeatedly**, with heavy scaffolding at first, not only after all the parts. The planner guidance in each preset's `lessonTemplate` should place integration nodes throughout the graph. A lint can warn when a preset that declares Loop 4 has no `performance` node in its first third `[design]`.
4. *(Docs)* Name the loops with KLI and 4C/ID terms in the PRD (e.g. "Drill (memory & fluency)"), so contributors and plugin authors inherit a vocabulary they can look up.

---

## 8. Risks, open questions, sources

### 8.1 Risks

1. **The evidence base is thin and vendor-heavy.** Most agentic-ITS results are preprints judged by simulators or LLMs. The few RCTs are small (Learn Your Way n = 60) or null on learning (Ruffle&Riley). Treat every architecture claim as a hypothesis for our T3 data.
2. **Simulated-student validity.** Even the best simulators are "limited" `[paper]`. The item screen could produce confident false flags. Mitigation: warnings only, plus per-instance calibration against real p-values.
3. **Cost of the pipeline.** Verification, critique and simulation multiply the token spend per lesson. Instructional Agents' Co-Pilot used about 2.4M tokens per course on gpt-4o-mini `[paper]`. Mitigation: tiering, a small model for T1, caching per block hash, and a cost estimate at Checkpoint A.
4. **The quality of LLM prerequisite edges is unmeasured.** No benchmark reports accuracy for LLM-drafted prerequisite edges. Checkpoint A and T3's "fails X but passes descendant Y" signal (`intelligent-tutoring.md` §7) are the only guards.
5. **Competitors move fast** (§6.2).
6. **Standards scope creep.** Each adapter is real work. Hold to the §5.1 schedule.

### 8.2 Open questions for the planning session

I'm listing these in priority order, each with a recommendation. Ask them one at a time.

1. **Add Loop 4 with test-oracle critique to the programming preset in v1?** Recommend yes (§7.2).
2. **Add Checkpoint A (teacher approves the graph before lessons are written)?** Recommend yes. It's cheap and catches the highest-leverage errors.
3. **Must the verifier and critic run on a different model family from the writer?** Recommend "different family when the admin has configured one, otherwise a fresh context". Never the writer's session.
4. **Add an accessibility catalog to the exercise envelope before v1 freezes?** Recommend reserving the field now and implementing it later.
5. **LTI 1.3 tool in v1 or v1.x?** Recommend v1.x, after the core loop works.
6. **Simulated-student item screen in v1?** Recommend yes for checkpoint pools only, as warnings.

### 8.3 Sources

**Agentic ITS, course generation, knowledge graphs**
- Chu et al., *LLM Agents for Education: Advances and Applications*, EMNLP Findings 2025: [arXiv 2503.11733](https://arxiv.org/abs/2503.11733). Agentic workflows review: [arXiv 2504.20082](https://arxiv.org/abs/2504.20082)
- *Instructional Agents*, EACL 2026: [arXiv 2508.19611](https://arxiv.org/abs/2508.19611) ([full text v3](https://arxiv.org/html/2508.19611v3))
- *EduPlanner*: [arXiv 2504.05370](https://arxiv.org/abs/2504.05370)
- Lin et al., *Automatic LLM Creation of Interactive Learning Lessons*: [arXiv 2506.17356](https://arxiv.org/abs/2506.17356). *Learning in Context*: [arXiv 2509.15068](https://arxiv.org/abs/2509.15068)
- *GenMentor*: [arXiv 2501.15749](https://arxiv.org/abs/2501.15749)
- *From MOOC to MAIC*: [arXiv 2409.03512](https://arxiv.org/abs/2409.03512), [JCST](https://jcst.ict.ac.cn/article/doi/10.1007/s11390-025-6000-0)
- *Learn Your Way*: [Google Research blog](https://research.google/blog/learn-your-way-reimagining-textbooks-with-generative-ai/), [arXiv 2509.13348](https://arxiv.org/abs/2509.13348)
- *DeepTutor*: [arXiv 2604.26962](https://arxiv.org/abs/2604.26962)
- *Ruffle&Riley*: [arXiv 2310.01420](https://arxiv.org/abs/2310.01420), [arXiv 2404.17460](https://arxiv.org/abs/2404.17460)
- *Campus AI learning-rate study*: [arXiv 2604.03246](https://arxiv.org/abs/2604.03246)
- *EDUMATH*, ACL 2026: [ACL Anthology](https://aclanthology.org/2026.acl-long.1973/)
- Walkington et al., *Should There be a Teacher In-the-Loop?*: [arXiv 2602.15876](https://arxiv.org/abs/2602.15876)
- *Graphusion*: [arXiv 2407.10794](https://arxiv.org/abs/2407.10794). Prerequisite graphs from slides: [arXiv 2606.10736](https://arxiv.org/abs/2606.10736). ESCO-PrereqSkill: [arXiv 2507.18479](https://arxiv.org/abs/2507.18479)

**Simulated students**
- He-Yueya, Goodman, Brunskill, EDM 2024: [arXiv 2403.02795](https://arxiv.org/abs/2403.02795)
- *Generative Students*, L@S 2024: [arXiv 2405.11591](https://arxiv.org/abs/2405.11591)
- *TeachTune*, CHI 2025: [arXiv 2410.04078](https://arxiv.org/abs/2410.04078). *Classroom Simulacra*, CHI 2025: [arXiv 2502.02780](https://arxiv.org/abs/2502.02780). *Agent4Edu*, AAAI 2025: [arXiv 2501.10332](https://arxiv.org/abs/2501.10332)
- Scarlatos et al., *Simulated Students in Tutoring Dialogues: Substance or Illusion?*, ACL 2026: [arXiv 2601.04025](https://arxiv.org/abs/2601.04025). *Towards Valid Student Simulation*: [arXiv 2601.05473](https://arxiv.org/abs/2601.05473). Review: [arXiv 2511.06078](https://arxiv.org/abs/2511.06078)
- Difficulty via simulation: [SMART, arXiv 2507.05129](https://arxiv.org/abs/2507.05129), [*Take Out Your Calculators*, arXiv 2601.09953](https://arxiv.org/abs/2601.09953), [Li et al., arXiv 2512.18880](https://arxiv.org/abs/2512.18880)
- Tutor training with simulated students: [Dinucu-Jianu et al., arXiv 2505.15607](https://arxiv.org/abs/2505.15607), [Scarlatos et al., arXiv 2503.06424](https://arxiv.org/abs/2503.06424)

**Evaluation and benchmarks**
- MathDial: [arXiv 2305.14536](https://arxiv.org/abs/2305.14536). MRBench / *Unifying AI Tutor Evaluation*, NAACL 2025: [arXiv 2412.09416](https://arxiv.org/abs/2412.09416). MathTutorBench: [arXiv 2502.18940](https://arxiv.org/abs/2502.18940). TutorBench: [arXiv 2510.02663](https://arxiv.org/abs/2510.02663). TutorGym, AIED 2025: [arXiv 2505.01563](https://arxiv.org/abs/2505.01563). Pedagogy Benchmark: [arXiv 2506.18710](https://arxiv.org/abs/2506.18710). LearnLM arena: [arXiv 2505.24477](https://arxiv.org/abs/2505.24477)
- Item-writing flaws: [Moore et al., arXiv 2307.08161](https://arxiv.org/abs/2307.08161). Later AIME-Con 2026 work by Moore et al.: [ACL author page](https://aclanthology.org/people/steven-james-moore/)
- Factuality and citations: [CoVe, arXiv 2309.11495](https://arxiv.org/abs/2309.11495), [ALCE, arXiv 2305.14627](https://arxiv.org/abs/2305.14627), [Liu et al., arXiv 2304.09848](https://arxiv.org/abs/2304.09848)
- Self-preference bias: [Panickssery et al., NeurIPS 2024, arXiv 2404.13076](https://arxiv.org/abs/2404.13076)
- Learning-rate regularity: [Hechinger summary of Koedinger et al., PNAS 2023](https://hechingerreport.org/proof-points-the-myth-of-the-quick-learner/). Reanalysis: [arXiv 2605.01690](https://arxiv.org/abs/2605.01690)

**Learning and instructional-design theory**
- KLI: [Koedinger, Corbett & Perfetti 2012](https://kilthub.cmu.edu/articles/journal_contribution/The_knowledge-learning-instruction_framework_bridging_the_science-practice_chasm_to_enhance_robust_student_learning_/6470522)
- 4C/ID meta-analysis: [Costa, Miranda & Melo 2022](https://link.springer.com/10.1007/s10984-021-09373-y)
- Merrill CDT overview: [instructionaldesign.org](https://www.instructionaldesign.org/?p=112)

**Smart LMS evidence**
- K-12 ITS meta-analysis: [arXiv 2511.04997](https://arxiv.org/abs/2511.04997)
- ALEKS: [Fang et al. meta-analysis](https://digitalcommons.memphis.edu/facpubs/7254), [Sun et al. 2021 (MHE-hosted)](https://www.mheducation.com/prek-12/resources/research/library/math/the-effects-of-aleks-on-mathematics-learning-in-k-12-and-higher-education.html)
- ASSISTments: [Social Programs That Work](https://evidencebasedprograms.org/programs/assistments/), [Arnold Ventures replication](https://www.arnoldventures.org/stories/a-replication-randomized-controlled-trial-rct-of-assistments-an-online-study-tool-to-improve-student-math-outcomes-in-seventh-grade)
- Squirrel AI: [SRI publication](https://sri.com/publication/education-learning-pubs/when-adaptive-learning-is-effective-learning-comparison-of-an-adaptive-learning-system-to-teacher-led-instruction), [company paper arXiv 1901.10268](https://arxiv.org/abs/1901.10268)
- Knewton: [Inside Higher Ed](https://www.insidehighered.com/node/7673), [EdSurge 2017](https://edsurge.com/news/2017-11-30-hitting-reset-knewton-tries-new-strategy-competing-with-textbook-publishers)
- Duolingo: [Birdbrain blog](https://blog.duolingo.com/learning-how-to-help-you-learn-introducing-birdbrain), [IEEE Spectrum](https://spectrum.ieee.org/duolingo), [VentureBeat](https://venturebeat.com/ai/how-duolingo-uses-ai-in-every-part-of-its-app), [148 courses](https://www.maginative.com/article/duolingo-introduces-148-new-language-courses-built-with-ai/)
- Math Academy: [how it works](https://mathacademy.com/how-our-ai-works). Coursera Coach: [blog](https://blog.coursera.org/announcing-ai-powered-capabilities-enabling-educators-to-use-coursera-coach-to-deliver-interactive-personalized-instruction). Uplimit: [announcement](https://resources.uplimit.com/blog/uplimit-ai-learning-agents-announcement). Oboe: [Korben](https://korben.info/en/oboe-ai-generates-courses-seconds.html). Study modes: [TechCrunch](https://techcrunch.com/2025/08/06/google-takes-on-chatgpts-study-mode-with-new-guided-learning-tool-in-gemini/)
- OATutor (CHI 2023, doi 10.1145/3544548.3581574): [summary](https://neverworkintheory.org/2023/05/07/open-source-adaptive-tutoring-system.html). Moodle AI: [docs](https://docs.moodle.org/en/AI_subsystem). Open edX AI Course Creator: [forum](https://discuss.openedx.org/t/introducing-the-ai-course-creator-plugin-for-open-edx/17545)

**Standards**
- QTI 3 implementation guide: [1EdTech](https://www.imsglobal.org/spec/qti/v3p0/impl). [QTI overview](https://www.1edtech.org/standards/qti)
- xAPI as IEEE 9274.1.1: [ADL](https://adlnet.gov/news/2023/11/22/xAPI-Officially-Becomes-a-Published-IEEE-Standard). cmi5 status: [ADL FY24 report](https://adlnet.gov/assets/uploads/DODI-FY24FR.pdf)
- LTI Advantage: [Moodle, Publish as LTI tool](https://docs.moodle.org/en/Publish_as_LTI_tool)
- Caliper vs xAPI: [Downes summary of the IMS/ADL comparison](https://www.downes.ca/post/65890)
- Open Badges 3.0 / CLR 2.0: [1EdTech](https://www.1edtech.org/1edtech-article/new-open-badges-30-standard-provides-enhanced-security-and-mobility/411060), [ecosystem](https://1edtech.org/blog/building-a-bridge-of-trust-three-pillars-of-the-1edtech-digital-credentials-ecosystem)
- CASE 1.1: [information model](https://standards.1edtech.org/case/specifications/standards/v1p1/im)
- Libraries `[repo]`: [ltijs](https://github.com/Cvmcosta/ltijs) (Apache-2.0), [SQL LRS](https://github.com/yetanalytics/lrsql) (Apache-2.0), [qti3-item-player](https://github.com/amp-up-io/qti3-item-player) (MIT, last push 2025-06), [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) (MIT)

**Not found or not verified:** a peer-reviewed Birdbrain paper; any controlled NotebookLM study; independent Area9, Math Academy or Coursera Coach outcome studies; accuracy numbers for LLM prerequisite edges; the full CASE `associationType` enumeration (it is extensible, and only `isTranslationOf` was confirmed); whether cmi5 was ratified by IEEE.
