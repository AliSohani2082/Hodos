# @hodos/math

The math environment for Hodos: algebra with formulas and graphs, graded by evaluating expressions rather than by a language model.

## Courses

| Course | Skills |
|---|---|
| Algebra: simplify, expand, factor | combining like terms; expanding brackets; factoring (21 exercises) |
| Algebra: linear equations and slope | solving linear equations; slope (14 exercises) |

| Exercise kind | The learner | Graded by |
|---|---|---|
| `math.expression` | types an expression in a required form (simplified, expanded or factored) | equivalence with the key, tested by evaluating both at random points, plus a check of the form |
| `math.numeric` | types a number (integers, decimals and fractions) | comparison with a tolerance |

An answer that is right but not in the required form gets partial credit and a pointer. A wrong answer that matches a known mistake (for example `(x + 1)^2 = x^2 + 1`) gets feedback for it, without the answer.

## Renderer

`math-view` shows formulas as MathML and draws graphs (points, lines through them, functions) in a sandboxed iframe.

## Content and how it was checked

The lessons and exercises were written for Hodos with an AI coding assistant. The plugin's validator checks every item:

- the key parses and is in the required form;
- the key is equal to the formula it rewrites;
- the formula is not already an accepted answer;
- each known mistake differs from the answer.

No teacher has reviewed the lessons.

## Install in DeepSeek Harness

Requires [`@hodos/dsh`](../../dsh-adapter/README.md). From a checkout, after `pnpm build`:

```sh
dsh plugin --profile web add "$PWD/packages/environments/math"
```

## License

MIT. See [LICENSE](LICENSE).
