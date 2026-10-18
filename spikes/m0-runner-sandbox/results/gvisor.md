| ID | Claim | Expected | Actual | Result |
|---|---|---|---|---|
| GV-RUN-0 | runsc is present, checksum-verified, and runs on this kernel | runsc --version prints a release | runsc version release-20261005.0 | PASS |
| GV-CALL-1 | under gVisor, a correct solution passes the hidden tests and a wrong one fails (honest grading) | good -> all ok; wrong -> some fail | good_all_ok=True (problem=None) wrong_all_ok=False (problem=None) | PASS |
| GV-ISO-1 | under gVisor, the hidden tests remain unreadable from the learner and no pass is forged | leaked=False and not a forced pass | leaked=False forged_pass=False grader_pid=2 grader_access={'environ': 'EACCES', 'mem': 'EACCES', 'maps': 'EACCES', 'fd': 'EACCES', 'cmdline': 'READ:62'} | PASS |
| GV-NET-1 | under gVisor, no network is reachable and no host canary is hit | net_ok=False, 0 canary hits | net_ok=False canary_hits=[] | PASS |
| GV-ESC-1 | under gVisor, no host container-engine socket or pid-1 root is reachable | sockets_exist=False | sockets_exist=False | PASS |
