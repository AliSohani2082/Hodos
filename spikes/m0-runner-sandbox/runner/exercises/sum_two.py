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

# A correct solution, used by tests and as the baseline for timing. NOT used for grading and not
# present in the sandbox; the grading-time reference lives in reference_sum_two.py (host side).
EXAMPLE_SOLUTION = "a, b = map(int, input().split())\nprint(a + b)\n"
