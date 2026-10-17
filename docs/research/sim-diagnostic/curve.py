import random, statistics as st, sys
sys.path.insert(0, '.')
from diag import make_dag, sample_state

def marg_of(parts, w, n):
    m = [0.0]*n
    for s, wi in zip(parts, w):
        for v in s: m[v] += wi
    return m

def run(n, layers, slip, guess, tn, rng, policy, K=3000, qmax=30, stop_err=0.05, q_min=5, q_cap=25):
    layer_of, anc, desc = make_dag(n, layers, 3, rng)
    parts = [sample_state(n, layer_of, anc, rng, 1.0) for _ in range(K)]
    w = [1.0/K]*K
    truth = sample_state(n, layer_of, anc, rng, tn)
    asked = {}; curve = {}; stopped_at = None; stopped_acc = None
    for q in range(qmax+1):
        m = marg_of(parts, w, n)
        acc = sum((m[v] >= .5) == (v in truth) for v in range(n))/n
        curve[q] = acc
        experr = sum(min(x, 1-x) for x in m)/n
        # diagnostic rule (intelligent-tutoring.md §4.2): stop at experr < 5%, but not before q_min questions
        if stopped_at is None and ((q >= q_min and experr < stop_err) or q >= q_cap):
            stopped_at, stopped_acc = q, acc
        if q == qmax: break
        if policy == 'half':
            v = min(range(n), key=lambda x: abs(m[x]-.5) + .15*asked.get(x, 0))
        else:
            v = rng.randrange(n)
        knows = v in truth
        correct = (rng.random() > slip) if knows else (rng.random() < guess)
        asked[v] = asked.get(v, 0)+1
        for i, s in enumerate(parts):
            if v in s: w[i] *= (1-slip) if correct else slip
            else: w[i] *= guess if correct else (1-guess)
        z = sum(w); w = [x/z for x in w]
        if 1/sum(x*x for x in w) < K/4:
            parts = rng.choices(parts, weights=w, k=K); w = [1.0/K]*K
    if stopped_at is None: stopped_at, stopped_acc = q_cap, curve[q_cap]
    return curve, stopped_at, stopped_acc

rng = random.Random(11)
print("n  noise policy | acc@0 @5 @10 @15 @20 @30 | stop(experr<5%): Q mean, p90, acc")
for n, layers in [(30,5),(60,8),(120,10)]:
    for tn in (1.0, 2.0):
        for policy in ('half', 'random'):
            cs, qs, accs = [], [], []
            for _ in range(30):
                c, qst, a = run(n, layers, .1, .2, tn, rng, policy)
                cs.append(c); qs.append(qst); accs.append(a)
            pts = [st.mean(c[k] for c in cs) for k in (0,5,10,15,20,30)]
            qs.sort()
            print(f"{n:3d} {tn:.1f} {policy:6s} | " + " ".join(f"{p:.2f}" for p in pts) + f" | {st.mean(qs):4.1f} {qs[int(.9*len(qs))-1]:2d} {st.mean(accs):.3f}")
