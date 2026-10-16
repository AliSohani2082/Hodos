"""Exercise (tier 2, "call"): implement `my_sort(xs)` returning the list sorted ascending.

The hidden tests are Python source executed ONLY inside the grader process (uid 10001), never in
the learner's interpreter (uid 10002). The grader namespace provides `learner` (JSON-boundary
proxy), `rnd` (seeded Random) and `LearnerError`. Every object named `test_*` is run as a test.

HIDDEN_SOURCE carries a unique canary and an "answer key" string so the adversarial suite (ALI-62)
has a concrete secret to try to exfiltrate: if either ever shows up in the learner's output or on
its filesystem, isolation has failed."""
import ast

ID = "sort-list"
KIND = "call"
TITLE = "Sort a list ascending"
FUNCTION = "my_sort"

# A unique, greppable secret that lives only in the grader's memory.
HIDDEN_CANARY = "HODOS-CANARY-7a3f9c2e1b8d4056"
ANSWER_KEY = "ANSWER-KEY-sort-list-6f1e8a9c0d2b3e47"

# Shown to the learner on every `run` (EX-5): the public/practice tests.
PRACTICE_SOURCE = '''
def test_sorted_small():
    assert learner.call("my_sort", [3, 1, 2]) == [1, 2, 3]

def test_already_sorted():
    assert learner.call("my_sort", [1, 2, 3]) == [1, 2, 3]

def test_empty():
    assert learner.call("my_sort", []) == []
'''

# Hidden/checkpoint tests: run on `submit`, never shown, never inside the learner sandbox.
HIDDEN_SOURCE = f'''
# secret markers; must never leak to the learner side
HIDDEN_CANARY = "{HIDDEN_CANARY}"
ANSWER_KEY = "{ANSWER_KEY}"

def test_empty():
    assert learner.call("my_sort", []) == []

def test_single():
    assert learner.call("my_sort", [42]) == [42]

def test_three():
    assert learner.call("my_sort", [3, 1, 2]) == [1, 2, 3]

def test_duplicates():
    assert learner.call("my_sort", [5, 1, 5, 1, 3, 3]) == [1, 1, 3, 3, 5, 5]

def test_negatives_and_extremes():
    xs = [0, -1, 2**63, -(2**63), 7, -7]
    assert learner.call("my_sort", list(xs)) == sorted(xs)

def test_random_seeded():
    for _ in range(25):
        n = rnd.randint(0, 40)
        xs = [rnd.randint(-1000, 1000) for _ in range(n)]
        assert learner.call("my_sort", list(xs)) == sorted(xs)

def test_large():
    xs = [rnd.randint(-10**6, 10**6) for _ in range(2000)]
    assert learner.call("my_sort", list(xs)) == sorted(xs)
'''

# A correct reference solution. Used by the ALI-61/62 drivers as a known-good submission. It never
# enters the grader; it is just learner code that happens to be right.
EXAMPLE_SOLUTION = '''
def my_sort(xs):
    xs = list(xs)
    for i in range(1, len(xs)):
        key = xs[i]
        j = i - 1
        while j >= 0 and xs[j] > key:
            xs[j + 1] = xs[j]
            j -= 1
        xs[j + 1] = key
    return xs
'''


def test_names(source):
    """The names the grader will run, in definition order, via `ast` (no code executed)."""
    tree = ast.parse(source)
    return [n.name for n in tree.body if isinstance(n, ast.FunctionDef) and n.name.startswith("test_")]
