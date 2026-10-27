# @hodos/code

Code interfaces for Hodos: the tutor can ask the learner to predict what a program prints, or to write Python in a small sandbox that runs in the learner's own browser. Nothing the learner types ever runs in the DeepSeek Harness process.

| Exercise kind | The learner | Graded by | Mastery evidence |
|---|---|---|---|
| `code.predict` | reads a program and types its output | comparison with the known output, line by line (line endings, trailing spaces and trailing blank lines do not count) | yes (`deterministic`) |
| `code.sandbox` | writes Python, runs it with the exercise's tests, and submits | the number of tests that passed, reported by the browser | no (`self-report`) |

## The Python sandbox

The `code-sandbox` renderer is an editor with **Run tests** and **Submit**. Python runs with [Pyodide](https://pyodide.org) 0.29.4 (CPython compiled to WebAssembly, MPL-2.0) in a Web Worker started inside the renderer's sandboxed iframe:

- each run executes the learner's code, then each test (Python statements, usually `assert`s) in a fresh namespace, and shows the output and which tests passed;
- a run that takes longer than 8 seconds is stopped by terminating the worker, so an endless loop cannot freeze the page; loading Python on the first run may take up to 60 seconds;
- the frame is in an opaque origin with no access to the workspace or the Harness. Its policy lets it run WebAssembly, start the worker from a `blob:` URL, and fetch Pyodide's files from the Hodos server; requests to the Hodos API fail;
- submitting sends the code and the number of tests that passed. The server cannot check that number, so the grade is self-reported: the tutor and the learner get feedback, and the plan node's mastery estimate does not move;
- after the answer, the tutor's reference solution is shown.

The renderer needs the `run-code` capability, which Hodos grants only to trusted plugins. The build copies Pyodide's runtime (about 12 MB) from the `pyodide` npm package into the renderer; its licence notice is in `renderer/static/THIRD-PARTY-NOTICES.txt`.

A sandbox exercise has a prompt, optional starter code and standard input, and up to 20 tests; the key is a reference solution. The tutor writes them; Hodos checks their shape and size.

## Course: Python: reading and tracing code

Skills, in order: expressions and operators; variables and assignment; branches; loops; lists; functions. 42 `code.predict` exercises, which the tutor can ask from the question bank. A wrong answer that matches a known misreading gets the course's explanation of it: true division versus floor division, `range` including its end, a list alias, `print` versus `return`, and others.

The `code-view` renderer shows programs read-only, built from the tokenizer's output with DOM text nodes, so program text can never become markup.

## Content and how it was checked

The programs were written for Hodos with an AI coding assistant. Every expected output was checked by running the program under CPython 3.13.17 (`pnpm verify:snippets`). The record names the exact program set; changing a program voids it. The misreading explanations have not been reviewed by a teacher.

## Code graded on a server (not in DeepSeek Harness)

`code.write` exercises (the learner's program is run against hidden tests) exist only for hosts that pass `createPlugin({ runner })` an isolated code runner meeting the contract in `src/runner.ts`. No runner ships with Hodos, and the DeepSeek Harness bundle offers none.

## Install in DeepSeek Harness

Requires [`@hodos/dsh`](../../dsh-adapter/README.md). From a checkout, after `pnpm build`:

```sh
dsh plugin --profile web add "$PWD/packages/environments/code"
```

## License

MIT. See [LICENSE](LICENSE). Pyodide, bundled into the renderer at build time, is MPL-2.0.
