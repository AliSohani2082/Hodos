# @hodos/math

Algebra as a question interface for Hodos: the tutor can ask for an expression in a required form or a number, graded by evaluating expressions rather than by a language model. Expressions the tutor writes are checked by the plugin before the learner sees them (the key parses, is in the required form and equals the formula).

## Courses (question banks)

| Course | Skills |
|---|---|
| Algebra: simplify, expand, factor | combining like terms; expanding brackets; factoring (21 exercises) |
| Algebra: linear equations and slope | solving linear equations; slope (14 exercises) |

| Exercise kind | The learner | Graded by |
|---|---|---|
| `math.expression` | types an expression in a required form (simplified, expanded or factored) | equivalence with the key, tested by evaluating both at random points, plus a check of the form |
| `math.numeric` | types a number (integers, decimals and fractions) | comparison with a tolerance |

An answer that is right but not in the required form gets partial credit and a pointer. A wrong answer to a bank exercise that matches a known mistake (for example `(x + 1)^2 = x^2 + 1`) gets the course's explanation of it, without the answer.

## Renderer

`math-view` shows formulas as MathML and draws graphs (points, lines through them, functions) in a sandboxed iframe. It only draws: the learner types the answer in the panel's own field.

## Content and how it was checked

The exercises were written for Hodos with an AI coding assistant. The plugin's validator checks every item:

- the key parses and is in the required form;
- the key is equal to the formula it rewrites;
- the formula is not already an accepted answer;
- each known mistake differs from the answer.

No teacher has reviewed the exercises or their explanations.

## Install in DeepSeek Harness

Requires [`@hodos/dsh`](../../dsh-adapter/README.md). From a checkout, after `pnpm build`:

```sh
dsh plugin --profile web add "$PWD/packages/environments/math"
```

## License

MIT. See [LICENSE](LICENSE).
