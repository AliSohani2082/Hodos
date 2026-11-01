---
name: hodos-course
description: Write a Hodos course (skill graph, lessons, exercises) for the user's Hodos learning workspace in DeepSeek Harness, validate it with Hodos's own validators, and submit it to the Hodos course inbox as a draft the user approves. Use when the user asks to create, generate, draft, extend or fix a Hodos course or learning path.
---

# Writing a Hodos course

You (Claude Code) write the course; Hodos validates it and keeps it as a draft until the user approves it in the Hodos workspace. Hodos itself makes no model calls for this and never sees Claude credentials: everything goes through files and the `hodos` command.

## Steps

1. **Build once** if `packages/dsh-adapter/lib/cli.js` is missing or stale: `pnpm build`.
2. **Read the guide**: `pnpm exec hodos course guide`. It lists the installed environments, every exercise kind with its payload, key and response schemas and a valid example, the lesson tags, and the coverage rules. Treat it as the specification; do not guess fields.
3. **Agree on scope** with the user if the request is vague: the goal, what the learner already knows, and which environment fits (only installed environments can be used).
4. **Write the course** to `courses/<course-id>.json`:
   - a skill graph whose `goal` depends on the other skills (no cycles; prerequisites first);
   - one lesson per skill: the key idea, a worked example, then a `check` question;
   - per skill: at least 3 `practice` items, at least 3 separate `checkpoint` items, and 1-2 easy `diagnostic` items;
   - hints from level 1 (orient) to 5 (bottom-out); only level 5 may state the answer;
   - an `explanation` for every item.
5. **Validate**: `pnpm exec hodos course validate courses/<course-id>.json`. Fix every error and re-run until it reports `0 error(s)`. Read the warnings and fix those that point to real problems.
6. **Check the content yourself.** The validators check structure and what an environment can check (for example legal chess positions and lines); they cannot tell whether a translation, fact or "best move" is right. Re-read every answer key. For chess `best` puzzles, keep to clear tactics where the key move is the only good one.
7. **Submit**: `pnpm exec hodos course submit courses/<course-id>.json`. Add `--data-dir <dir>` when DeepSeek Harness uses a non-default home (the default is `$DSH_HOME/hodos`, else `~/.dsh/hodos`).
8. **Confirm the import**: `pnpm exec hodos course status`. The running Hodos service imports inbox files within a few seconds, or at its next start. If the file was rejected, the status shows why: fix the course, bump `version`, and submit again.
9. **Tell the user** to open the Hodos tab in DeepSeek Harness and review the course under "Proposed courses" before approving it. Say plainly that you wrote it and that it has not been independently verified.

## Rules

- Never put an answer, or anything that gives it away, in an item's `payload`: the payload is sent to the learner's browser. Keys, hints and explanations stay on the server.
- Do not add `provenance` claims such as "verified": Hodos replaces them on import.
- Do not edit the Hodos database or DeepSeek Harness configuration; the inbox is the only way in.
- A new revision of an approved course needs a higher `version`.
