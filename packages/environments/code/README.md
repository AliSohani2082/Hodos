# @hodos/code

The code environment for Hodos: reading and tracing Python. The learner predicts what a short program prints; nothing the learner types is ever run.

## Course: Python: reading and tracing code

Skills, in order: expressions and operators; variables and assignment; branches; loops; lists; functions. 42 exercises, with lessons that show each program in a highlighted, line-numbered code view.

| Exercise kind | The learner | Graded by |
|---|---|---|
| `code.predict` | types the program's output | comparison with the known output, line by line (line endings, trailing spaces and trailing blank lines do not count) |

A wrong answer that matches a known misreading gets feedback for it: true division versus floor division, `range` including its end, a list alias, `print` versus `return`, and others. The program's output is shown once the exercise is answered correctly or its attempts are used up, never during a checkpoint.

## Renderer

`code-view` shows programs read-only in a sandboxed iframe. It builds the listing from the tokenizer's output with DOM text nodes, so program text can never become markup.

## Content and how it was checked

The programs and lessons were written for Hodos with an AI coding assistant. Every expected output was checked by running the program under CPython 3.13.17 (`pnpm verify:snippets`). The record names the exact program set; changing a program voids it. The lessons and the misreading feedback have not been reviewed by a teacher.

## Writing programs (not in DeepSeek Harness)

`code.write` exercises (the learner writes a program that is run against tests) exist only for hosts that pass `createPlugin({ runner })` an isolated code runner meeting the contract in `src/runner.ts`. No runner ships with Hodos, and the DeepSeek Harness bundle offers none: learner code never runs in the Harness process.

## Install in DeepSeek Harness

Requires [`@hodos/dsh`](../../dsh-adapter/README.md). From a checkout, after `pnpm build`:

```sh
dsh plugin --profile web add "$PWD/packages/environments/code"
```

## License

MIT. See [LICENSE](LICENSE).
