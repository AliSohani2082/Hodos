# @hodos/testing

Test support for Hodos and for plugin authors. Everything here is deterministic and runs without network access, API keys or paid services.

| Export | What it is |
|---|---|
| `startMockLlm(script)` | A local stand-in for an Anthropic-Messages-compatible model endpoint (`POST /v1/messages`, streaming). A script decides each reply from the request; every request is recorded for assertions. Point DeepSeek Harness at it with `DEEPSEEK_BASE_URL` to drive real sessions in end-to-end tests |
| `tutorScript({ environment })` | A ready-made script that plays the tutor: it starts a journey when the learner states a goal, resumes one or lists the courses when asked, and reports tool results back as text |
| `createQuizPlugin(options)`, `quizCourse()`, `quizPack()` | A small arithmetic environment plugin with choice, free-text and stepwise exercise kinds. Options make it misbehave on purpose, for security tests |
| `correctResponse(item)`, `wrongResponse(item)` | Answers for quiz items |

The repository's end-to-end tests (`tests/e2e/`) show `startMockLlm` and `tutorScript` driving DeepSeek Harness.

## License

MIT. See [LICENSE](LICENSE).
