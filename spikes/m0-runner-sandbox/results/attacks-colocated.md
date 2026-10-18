| ID | Category | Attack | Expected | Actual | Result |
|---|---|---|---|---|---|
| read-fs-walk | read | walk the filesystem for the hidden-test canary / answer key | COMPROMISED (leaked True / leak / forged pass): isolation absent | leaked=True needle=False verdict=failed | PASS |
| read-env | read | dump own env and /proc/1/environ for the nonce | COMPROMISED (env_leak True / leak / forged pass): isolation absent | env_leak=True needle=False verdict=failed | PASS |
| steal-nonce | forge | steal the per-run nonce from own env / grader env / grader mem | COMPROMISED (nonce_found True / leak / forged pass): isolation absent | nonce_found=True needle=False verdict=failed | PASS |
| forge-colocated-pass | forge | read the nonce + hidden test names, print a fully valid forged pass frame, exit before the grader runs | COMPROMISED (forged True / leak / forged pass): isolation absent | forged=None needle=False verdict=passed | PASS |
