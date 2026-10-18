"""Exercise (tier 1, I/O): read two integers from stdin, print their sum.

The expected output is *never* inside the sandbox: the runner compares outside. `PRACTICE` is the
public set shown to learners on every run (EX-5). Hidden cases are added in ALI-61."""
ID = "sum-two"
KIND = "io"
TITLE = "Sum of two integers"

PRACTICE = [
    {"name": "small numbers", "stdin": "2 3\n", "expected": "5\n"},
    {"name": "negative number", "stdin": "-4 1\n", "expected": "-3\n"},
    {"name": "zeros", "stdin": "0 0\n", "expected": "0\n"},
]

# A correct solution, used by tests and as the baseline for timing.
EXAMPLE_SOLUTION = "a, b = map(int, input().split())\nprint(a + b)\n"

# The grading-time reference. On `submit`, the runner generates random inputs, runs THIS source in
# a *separate* sandbox container (same learner-code profile, no network, non-root) to produce the
# expected stdout, and compares outside the sandbox. The reference therefore never shares a process
# or a container with the learner's code, and the expected values never enter the learner sandbox.
REFERENCE_SOLUTION = "a, b = map(int, input().split())\nprint(a + b)\n"


def gen_hidden(rng):
    """~6 randomized hidden stdin cases (incl. big / negative numbers). Returns [{name, stdin}];
    the expected output is computed by running REFERENCE_SOLUTION in its own sandbox, never here."""
    cases = [{"name": "both negative", "stdin": "-1000000 -2000000\n"},
             {"name": "large magnitude", "stdin": "999999999999 1\n"}]
    for i in range(4):
        a = rng.randint(-10**12, 10**12)
        b = rng.randint(-10**12, 10**12)
        cases.append({"name": f"random {i}", "stdin": f"{a} {b}\n"})
    return cases
