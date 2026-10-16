# Simulate Bayesian half-split diagnostic over a prerequisite DAG using a particle belief over down-sets.
import random, math, sys, statistics as st

def make_dag(n, layers, maxpar, rng):
    per = [n // layers + (1 if i < n % layers else 0) for i in range(layers)]
    nodes, layer_of, parents = [], {}, {}
    idx = 0
    for L, c in enumerate(per):
        for _ in range(c):
            layer_of[idx] = L; parents[idx] = set()
            if L > 0:
                prev = [v for v in range(idx) if layer_of[v] == L - 1]
                earlier = [v for v in range(idx) if layer_of[v] < L - 1]
                parents[idx].add(rng.choice(prev))
                for _ in range(rng.randint(0, maxpar - 1)):
                    pool = prev + earlier
                    parents[idx].add(rng.choice(pool))
            idx += 1
    anc = {}
    for v in range(n):  # nodes are topologically ordered
        a = set()
        for p in parents[v]:
            a |= {p} | anc[p]
        anc[v] = a
    desc = {v: set() for v in range(n)}
    for v in range(n):
        for a in anc[v]:
            desc[a].add(v)
    return layer_of, anc, desc

def sample_state(n, layer_of, anc, rng, noise):
    # ability threshold over layers + per-node noise, then force down-closure
    ab = rng.uniform(-1, max(layer_of.values()) + 1)
    raw = {v for v in range(n) if layer_of[v] + rng.gauss(0, noise) < ab}
    return frozenset(v for v in raw if anc[v] <= raw)

def run(n, layers, maxpar, slip, guess, K, qmax, lo, hi, rng, true_noise):
    layer_of, anc, desc = make_dag(n, layers, maxpar, rng)
    parts = [sample_state(n, layer_of, anc, rng, 1.0) for _ in range(K)]
    w = [1.0 / K] * K
    truth = sample_state(n, layer_of, anc, rng, true_noise)
    asked = {}
    q = 0
    while q < qmax:
        marg = [0.0] * n
        for s, wi in zip(parts, w):
            for v in s: marg[v] += wi
        unsure = [v for v in range(n) if lo < marg[v] < hi]
        if not unsure: break
        # half-split: node whose marginal is closest to 0.5, penalise re-asking
        v = min(unsure, key=lambda x: abs(marg[x] - 0.5) + 0.15 * asked.get(x, 0))
        knows = v in truth
        correct = (rng.random() > slip) if knows else (rng.random() < guess)
        asked[v] = asked.get(v, 0) + 1; q += 1
        for i, s in enumerate(parts):
            if v in s: w[i] *= (1 - slip) if correct else slip
            else: w[i] *= guess if correct else (1 - guess)
        z = sum(w); w = [x / z for x in w]
        # resample + rejuvenate when degenerate
        ess = 1.0 / sum(x * x for x in w)
        if ess < K / 4:
            parts = rng.choices(parts, weights=w, k=K); w = [1.0 / K] * K
    marg = [0.0] * n
    for s, wi in zip(parts, w):
        for v in s: marg[v] += wi
    pred = {v for v in range(n) if marg[v] >= 0.5}
    acc = sum((v in pred) == (v in truth) for v in range(n)) / n
    return q, acc

if __name__ == "__main__":
    rng = random.Random(7)
    print("n layers slip guess true_noise | Q mean (p90) | node acc mean (p10)")
    for n, layers in [(30, 5), (60, 8), (120, 10), (200, 12)]:
        for slip, guess, tn in [(0.1, 0.2, 1.0), (0.1, 0.25, 2.0)]:
            qs, accs = [], []
            for _ in range(40):
                q, a = run(n, layers, 3, slip, guess, 3000, 30, 0.15, 0.85, rng, tn)
                qs.append(q); accs.append(a)
            qs.sort(); accs.sort()
            print(f"{n:4d} {layers:3d} {slip:.2f} {guess:.2f} {tn:.1f} | {st.mean(qs):5.1f} ({qs[int(.9*len(qs))-1]:2d}) | {st.mean(accs):.3f} ({accs[int(.1*len(accs))]:.3f})")
