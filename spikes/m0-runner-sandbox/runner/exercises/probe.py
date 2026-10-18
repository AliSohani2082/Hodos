"""Operator-only probe exercise: a single public case so that limit/attack probes run exactly once
per container. Registered only when ALI40_ENABLE_PROBE_EXERCISE=1 (never in a normal runner)."""
ID = "probe-1"
KIND = "io"
TITLE = "probe"
PRACTICE = [{"name": "probe", "stdin": "2 3\n", "expected": "5\n"}]
