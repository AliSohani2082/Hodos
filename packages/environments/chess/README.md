# @hodos/chess

Chess as a question interface for Hodos: the tutor can ask a position to solve on an interactive board, like a puzzle on chess.com, graded by the rules of chess rather than by a language model. Positions the tutor writes are checked by chess.js before the learner sees them; verified positions come from the course below.

## Course: Chess tactics

A question bank for players who know how the pieces move. Skills: moves, captures and check; knight forks; double attacks; pins; skewers; mate in one; spot the tactic. 53 exercises, which the tutor lists with `hodos_bank` and asks by reference.

| Exercise kind | The learner | Graded by |
|---|---|---|
| `chess.puzzle` | plays the solution on the board; multi-move lines get the opponent's reply from the server after each move | chess.js: legality, the line, the goal (check, mate, a free capture) or the theme (a fork attacks two pieces) |
| `chess.identify` | names the tactic in a position | the answer key |

Wrong moves get feedback that names the mistake (a single threat instead of a fork, a missed check, a hanging piece) without revealing the solution. After the answer, the board replays the solution line.

## Renderer

`chess-board` draws positions in a sandboxed iframe: click or use the keyboard (arrow keys, Enter) to move, with promotion choice and move history. It only displays and reports moves; grading happens on the server.

## Content and how it was checked

The puzzles, lessons and hints were written for Hodos with an AI coding assistant.

- **Every position and line** is checked by chess.js on each test run: the position is legal, every move of the line is legal, and the key move does what the puzzle claims.
- **27 of the 53 items** were also checked with Stockfish 17.1 at depth 18 (`pnpm verify:puzzles`). Each solution move is the engine's best move or close to it, equally good alternatives are listed, and the scripted replies are the best defence. The record names the exact puzzle set it checked; changing any puzzle voids it.
- The explanations and hints have not been reviewed by a chess coach. The course's lessons are validated but not shown in learning sessions.

## Install in DeepSeek Harness

Requires [`@hodos/dsh`](../../dsh-adapter/README.md). From a checkout, after `pnpm build`:

```sh
dsh plugin --profile web add "$PWD/packages/environments/chess"
```

Optional: point the grader at a UCI engine so that it also accepts moves as strong as the solution. Add to the profile's `cordis.patch.yml`:

```yaml
- id: hodos-chess
  config:
    stockfishPath: /absolute/path/to/stockfish
```

## Other hosts

`createPlugin({ stockfishPath? })` returns the environment plugin for any Hodos host (see [`@hodos/core`](../../core/README.md)).

## License

MIT. See [LICENSE](LICENSE).
