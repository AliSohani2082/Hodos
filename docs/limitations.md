# Known limitations

What this release does not do, or has not been shown to do. The [security notes](security.md) explain the security-relevant items in more depth.

## Platform

- **Tested on one setup only:** Linux x64, Node.js 24.22.1, pnpm 11.28.5, DeepSeek Harness 0.2.1-rc.3 with its `web` profile, and Playwright's Chromium. macOS, Windows, other browsers, the DSH Desktop app, the terminal and headless profiles, and other DSH versions are untested.
- **DSH's APIs are pre-stable.** The bundles accept DSH `>=0.2.1-rc.3 <0.3.0`; a DSH release can still break the adapter. The end-to-end suite is how to find out.
- **One learner.** DSH has a single owner principal, so everyone who can use the Harness shares one Hodos learner.
- **Not on npm.** Install from a checkout or from the tarballs `pnpm pack:dsh` builds ([install guide](install.md)).

## Self-hosting

- **The Docker image was not built.** The environment it was written in had no Docker daemon. Its steps were run outside a container ([self-hosting](self-hosting.md#in-a-container)).
- **Not tested on a real phone, behind a real proxy or over a real VPN.** The end-to-end test uses an iPhone-sized touch browser and a made-up host name on one machine. A restart with signed-in phones, DSH's terminal tab, and the Knowledge graph tab, Python sandbox and practice sessions on a phone-sized screen were not checked.
- **TLS is yours to manage.** DeepSeek Harness serves a certificate you give it and does not renew it.
- **Reaching the Harness is reaching a shell.** DSH's chat has shell and file tools; the sign-in link and cookie are the only protection. See [security](security.md#remote-access).

## The tutor

- **No real model in the tests.** Every end-to-end run drives DeepSeek Harness with a scripted model. How well a real DeepSeek model probes, plans and teaches, how often it writes a wrong question or a wrong key, and whether it follows the prompt rules, has not been measured. The guarantees that matter most do not depend on it: keys stay out of the browser, bank keys stay out of the model, and only Hodos's grading moves a mastery estimate.
- **Model-written questions are not verified.** Interface questions pass their plugin's checks (a legal chess position, a math key equal to its formula); multiple-choice questions are checked only for shape. The panel marks them "Written by the tutor". A wrong key makes a wrong grade, and a wrong grade of a `check` moves the estimate.
- **The method lives in the prompt.** Probing precision, one-step-at-a-time teaching and predict → teach → check are instructions to the model. Hodos enforces the phases (no teaching questions before the probe is concluded, every teaching question tagged with a plan node) but not the quality of each step.
- **Course drafting with Claude Code** was tested against a local stand-in for Anthropic's API with a dummy key, never against Anthropic's servers or a real sign-in.
- **Drafting is not available inside a Hodos session.** A learning or practice session may not start subagents; draft from another chat or with `hodos course submit`.

## Compared with LearnHarness

Hodos follows LearnHarness 0.3.8's process ([ADR-0007](adr/0007-learning-harness-on-dsh.md)) but does not have all of it:

- **No research, visual explanations or interactive demos** running in the background. Demos would need a renderer that runs model-written scripts, which this release does not take on.
- **No dictation.** The think-out-loud fields take typed text only; DSH has no speech-to-text service to reuse.
- **Practice is tutor-run only.** Problems, hints and verdicts come from the tutor in a practice chat, as in LearnHarness's practice sessions; there are no pre-built problem sets and no rubric scores.
- **The knowledge graph's prompts are Hodos's own**, written after LearnHarness's design notes, and have only been run against scripted replies.
- **The plan map accepts a subset of mermaid** (nodes, labels, arrows; no subgraphs or styling), at most 30 nodes.

## Security

- **No operating-system confinement** around the QuickJS worker that runs untrusted graders. The interpreter is the only barrier.
- **Third-party DSH bundles run in the Harness process.** Hodos cannot sandbox them; untrusted plugins should use the declarative format.
- **The leak guard misses short and rephrased answers:** fragments under 4 characters, and answers written another way.
- **DSH's `subagent` tool stays visible** to the model in a Hodos session. DSH registers it where restrictions do not reach; Hodos refuses to run it, but the model may still try.
- **The learner database is not encrypted.**

## Plugins and content

- **The Python sandbox is self-reported.** It runs in the learner's browser, so Hodos cannot check the number of tests that passed; a sandbox answer is feedback and never mastery evidence. The first run downloads about 12 MB of Pyodide from the Hodos server. Only Python is supported, with Pyodide's standard library and no extra packages.
- **The built-in courses were written with an AI coding assistant.** Chess positions and lines are checked by chess.js, and 27 of the 53 chess items also with Stockfish. Every program's output in the Python course is checked with CPython. Math keys are checked against their formulas by the plugin. The Spanish and algebra material and all explanations and hints have not been reviewed by a teacher or a native speaker.
- **The question banks are small:** chess tactics (53 exercises), Spanish basics (61), Python tracing (42) and two algebra courses (35).
- **Course lessons are not shown.** Courses still contain lessons, which are validated, but a learning session teaches through the tutor's prose; only a course's exercises are used, as a question bank.
- **No listening or speaking exercises.** Hodos does not assess pronunciation.
- **No server-graded code-writing exercises in DeepSeek Harness.** They need an isolated code runner, and none ships.

## Product scope

The PRD describes a larger platform. This release leaves out, by [ADR-0006](adr/0006-hodos-as-dsh-plugin-ecosystem.md):

- teacher and admin roles and Course Studio;
- the plugin hub;
- Postgres and retrieval;
- xAPI forwarding;
- multiple learners.

The workspace is in English only, and its accessibility has not been audited with assistive technology.
