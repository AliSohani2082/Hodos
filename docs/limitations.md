# Known limitations

What this release does not do, or has not been shown to do. The [security notes](security.md) explain the security-relevant items in more depth.

## Platform

- **Tested on one setup only:** Linux x64, Node.js 24.22.1, pnpm 11.28.5 and DeepSeek Harness 0.2.1-rc.3 with its `web` profile. macOS, Windows, the DSH Desktop app, the terminal and headless profiles, and other DSH versions are untested.
- **DSH's APIs are pre-stable.** The bundles accept DSH `>=0.2.1-rc.3 <0.3.0`; a DSH release can still break the adapter. The end-to-end suite is how to find out.
- **One learner.** DSH has a single owner principal, so everyone who can use the Harness shares one Hodos learner.
- **Not on npm.** Install from a checkout or from the tarballs `pnpm pack:dsh` builds ([install guide](install.md)).

## The tutor

- **No real model in the tests.** Every end-to-end run drives DeepSeek Harness with a scripted model. How well a real DeepSeek model tutors, and whether it follows the prompt rules (no hints during a checkpoint, no answers), has not been measured. The guarantees that matter do not depend on it: the model never sees an unreleased key, cannot relay a checkpoint answer, and cannot mark anything mastered.
- **Course drafting with Claude Code** was tested against a local stand-in for Anthropic's API with a dummy key, never against Anthropic's servers or a real sign-in.
- **Drafting is not available inside a learning session.** A tutoring session may not start subagents; draft from another chat or with `hodos course submit`.

## Security

- **No operating-system confinement** around the QuickJS worker that runs untrusted graders. The interpreter is the only barrier.
- **Third-party DSH bundles run in the Harness process.** Hodos cannot sandbox them; untrusted plugins should use the declarative format.
- **The leak guard misses short and rephrased answers:** fragments under 4 characters, and answers written another way.
- **Checkpoint integrity is advisory.** The chat cannot be switched off during a checkpoint, and a learner can always ask another tool.
- **DSH's `subagent` tool stays visible** to the model in a tutoring session. DSH registers it where restrictions do not reach; Hodos refuses to run it, but the model may still try.
- **The learner database is not encrypted.**

## Content

- **The built-in courses were written with an AI coding assistant.** Chess positions and lines are checked by chess.js, and 27 of the 53 chess items also with Stockfish. Every program's output in the Python course is checked with CPython. Math keys are checked against their formulas by the plugin. The Spanish and algebra material and all lesson texts and hints have not been reviewed by a teacher or a native speaker.
- **The courses are small:** chess tactics (53 exercises), Spanish basics (61), Python tracing (42) and two algebra courses (35). They demonstrate the platform; they are not a curriculum.
- **No listening or speaking exercises.** Hodos does not assess pronunciation.
- **No code-writing exercises in DeepSeek Harness.** They need an isolated code runner, and none ships.
- **Goal matching is by keywords.** A goal phrased very differently from a course's title, keywords and skill names, or in another language, may not find the course; the tutor can name the course instead.

## Product scope

The PRD describes a larger platform. This release leaves out, by [ADR-0006](adr/0006-hodos-as-dsh-plugin-ecosystem.md):

- teacher and admin roles and Course Studio;
- the plugin hub;
- Postgres and retrieval;
- xAPI forwarding;
- multiple learners.

The workspace is in English only, and its accessibility has not been audited with assistive technology.
