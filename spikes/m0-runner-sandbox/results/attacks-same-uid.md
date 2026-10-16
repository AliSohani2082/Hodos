| ID | Category | Attack | Expected | Actual | Result |
|---|---|---|---|---|---|
| kill-grader | kill | SIGKILL/SIGSTOP/SIGTERM the grader | COMPROMISED (killed True / leak / forged pass): isolation absent | killed=True needle=False verdict=error | PASS |
