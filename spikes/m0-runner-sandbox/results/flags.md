| ID | Claim | Expected | Actual | Result |
|---|---|---|---|---|
| F-LEAK-U1 | leak detector fires output_contains_test_source when the learner's output contains the hidden canary | flag present | flags=['output_contains_test_source'] | PASS |
| F-LEAK-U2 | leak detector fires on an echoed >=24-char line of the hidden source | flag present | flags=['output_contains_test_source'] | PASS |
| F-LEAK-U3 | benign output raises no leak flag (true negative) | no flags | flags=[] | PASS |
| F-LEAK-E1 | end-to-end: a run whose captured output contains the hidden canary is flagged (teacher-only) | output_contains_test_source in teacher.flags | verdict=passed flags=['output_contains_test_source'] | PASS |
| F-ZERO-1 | a passing submit with no prior passing practice run is flagged pass_after_zero_passing_runs | flag present, verdict passed | verdict=passed flags=['pass_after_zero_passing_runs'] | PASS |
| F-ZERO-2 | a passing submit AFTER a passing run is NOT flagged (true negative) | pass_after_zero_passing_runs absent | verdict=passed flags=[] | PASS |
| F-RES-1 | an output flood raises the resource_limit_hit / output_flood teacher signals and never passes | resource_limit_hit present, verdict != passed | verdict=failed flags=['resource_limit_hit', 'output_flood'] | PASS |
