# @hodos/language

Typed-answer language exercises for Hodos, with a first question bank for English speakers starting Spanish. Exercises are text: the learner answers in the workspace's own accessible form.

## Course: Spanish basics

A question bank. Skills: greetings and courtesy; articles and gender; the verb *ser*; the verb *estar*; *ser* or *estar*; simple sentences. 61 exercises.

| Exercise kind | The learner |
|---|---|
| `language.recall` | types the word or phrase for a meaning |
| `language.choice` | picks the right option |
| `language.cloze` | fills the gap in a sentence |
| `language.order` | puts words in order |
| `language.translate` | translates a short sentence |
| `language.conjugate` | gives the verb form |

Grading is deterministic. It ignores case, spacing and punctuation (including ¿ and ¡). A missing accent gets partial credit and a pointer; ñ counts as its own letter. The grader names swapped article gender, word order and *ser*/*estar* confusions, without giving the answer away.

There are no listening or speaking exercises: Hodos does not judge pronunciation.

## Content and how it was checked

The exercises were written for Hodos with an AI coding assistant. The course validator and unit tests check their structure and the grader's behaviour. No native speaker or Spanish teacher has reviewed them.

## Install in DeepSeek Harness

Requires [`@hodos/dsh`](../../dsh-adapter/README.md). From a checkout, after `pnpm build`:

```sh
dsh plugin --profile web add "$PWD/packages/environments/language"
```

## License

MIT. See [LICENSE](LICENSE).
