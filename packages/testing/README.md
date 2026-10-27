# @hodos/testing

Test support for Hodos and for plugin authors. Everything here is deterministic and runs without network access, API keys or paid services.

| Export | What it is |
|---|---|
| `startMockLlm(script)` | A local stand-in for an Anthropic-Messages-compatible model endpoint (`POST /v1/messages`, streaming). A script decides each reply from the request; every request is recorded for assertions. Point DeepSeek Harness at it with `DEEPSEEK_BASE_URL` to drive real sessions in end-to-end tests |
| `learningScript(options)` | A ready-made script that plays the tutor of a learning session: it starts a session when the learner states a goal, asks the probe question you give it, concludes the probe, writes your plan, then takes one scripted teaching step per answer; it runs a practice problem and its conclusion, and answers Hodos's extraction calls with findings built from the teacher's passages. "Call the tool `<name>` with `<JSON>`" in a chat message makes it call exactly that tool, so tests can probe the tool policy or have it ask a particular exercise |
| `createQuizPlugin(options)`, `quizCourse()`, `quizPack()` | A small arithmetic environment plugin with choice, free-text and stepwise exercise kinds. Options make it misbehave on purpose, for security tests |
| `correctResponse(item)`, `wrongResponse(item)` | Answers for quiz items |

The repository's end-to-end tests (`tests/e2e/`) show `startMockLlm` and `learningScript` driving DeepSeek Harness.

## License

MIT. See [LICENSE](LICENSE).
