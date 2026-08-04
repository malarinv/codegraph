# Agent A/B — score-proportional explore allocation (#1500 / epic CG-1)

**Date:** 2026-08-04 · **New:** `feature/CG-1` @ `edce18f` · **Baseline:** `main` @ `49c11fc`
· **Harness:** `scripts/agent-eval/ab-new-vs-baseline.sh`, `RUNS=3`, `--model sonnet --effort high`
on every arm · **Both arms codegraph-on.**

This is the epic's pass gate. The deterministic probes (CG-6/CG-14) prove the budget moved;
only an agent A/B proves the agent stopped reading.

**Verdict: the gate does not pass.** Bars 2 and 3 hold; **bar 1 (Read stays at 0) and bar 4
(no regression on the control) fail on express**, with a reproducible, non-agent cause. Per
the CG-15 acceptance rule the allocation design goes back to CG-12 — the budget is *not* to be
widened to compensate. Root cause and the smallest honest fix are in [§Root cause](#root-cause).

---

## Method

`ab-new-vs-baseline.sh` builds and indexes each arm separately (CG-5's generated-file flag is
an index-time decision, so each arm must index with its own build), pre-warms a persistent
daemon per run, and runs the same flow question 3× per arm. Both arms run with
`CODEGRAPH_NO_PROMPT_HOOK=1` — the machine's ambient front-load hook resolves to whatever is
in `dist/` and would inject context through a second, uncontrolled channel.

Each prompt names codegraph as the lookup tool. That is **not** a forced-Read-0: the agent
stays free to Read whenever explore's answer is insufficient, which is exactly what bar 1
measures. It removes the one noise source that would otherwise swamp the signal — in a
pre-run without it, one express run made **0 codegraph calls and 3 Reads**, measuring adoption
(an axis this change does not touch) rather than allocation.

Envelope share is measured with `parse-run.mjs --envelope --answer <glob>`, which parses the
rendered markdown of the responses the agent actually received. The CG-4 diagnostic sidecar
only exists on the new build, so it cannot measure the baseline arm; the markdown parse is the
only instrument that measures both arms the same way.

| Repo | Lang | Files | Generated | Tier | Role |
|---|---|---|---|---|---|
| `kubernetes/client-go` | Go | 2,454 | 2,001 | medium (2 calls / 28K) | **the #1500 shape** — generated CRUD beside hand-written machinery |
| `excalidraw/excalidraw` | TS/React | 672 | 0 | medium (2 calls / 28K) | god-file concentration (`App.tsx`, 450 KB) |
| `expressjs/express` | JS | 147 | 0 | small (1 call / 18K) | **control** |

---

## Results

`explore` = codegraph_explore calls · `Read` = Read tool calls · `answer%` = share of the
source envelope going to the files that answer the question. Three runs per arm, reported as
the range — run-to-run variance is large and a single run means nothing.

### client-go — "how does a shared informer keep its cache in sync and deliver events?"

Answer set `tools/cache/**`; generated set `kubernetes/**`, `listers/**`, `applyconfigurations/**`,
`informers/**`, `**/fake/**`.

| arm | explore | **Read** | duration | answer% | generated% |
|---|---|---|---|---|---|
| **new** | 2 / 2 / 6 | **0 / 0 / 0** | 39–61s (med 50) | 74.2 / 96.9 / 82.6 | 4.0 / 0.0 / 5.2 |
| baseline | 3 / 2 / 3 | 0 / 0 / 0 | 48–52s (med 49) | 78.1 / 97.1 / 71.3 | 10.5 / 0.0 / 5.1 |

No Read in either arm. The medians overlap: on this query `tools/cache/**` already dominates
graph relevance, so the baseline concentrated well without help. The #1500 signal is visible
but small — the generated clientsets and per-resource informers
(`informers/events/v1beta1/interface.go`, `kubernetes/typed/events/v1/fake/…`) take 10.5% of
one baseline run's envelope and **never appear in any new run**.

### excalidraw — "how does updating an element re-render the canvas on screen?"

Answer set: `mutateElement.ts`, `App.tsx`, `renderer/**`, `scene/**`, `components/canvases/**`.

| arm | explore | **Read** | duration | answer% |
|---|---|---|---|---|
| **new** | 2 / 3 / 2 | **0 / 0 / 0** | **23–32s (med 24)** | 74.4 / 67.8 / 84.7 |
| baseline | 3 / 3 / 4 | 0 / 0 / 0 | 33–39s (med 34) | 74.1 / 64.0 / 79.5 |

The clearest win: **29% faster at the median with one fewer explore call per run**, no Read in
either arm. Concentration is why — the new arm resolves the flow in 2 calls where the baseline
takes 3–4. (One baseline run burned a turn on a hallucinated `codegraph_..._explore` tool name;
counted as-is.)

### express — control — "how does res.send decide Content-Type and ETag?"

Answer set `lib/**` (both arms deliver 100%; the whole answer lives in `lib/`, so this repo
tests concentration *within* the answer set, not against noise).

| arm | explore | **Read** | duration | answer% |
|---|---|---|---|---|
| **new** | 1 / 4 / 2 | **0 / 4 / 0** | 18 / 52 / 24s | 100 / 100 / 100 |
| baseline | 2 / 2 / 2 | 1 / 1 / 1 | 23 / 28 / 27s | 100 / 100 / 100 |

Two of three new runs are strictly better than every baseline run (0 Reads vs 1, faster). The
third is the failure: **4 Reads of `lib/utils.js` and 52s**, a fallback the baseline never
made. It is not agent variance — see below.

---

## Root cause

Deterministic replay of the divergent run's own query on both builds, same index, no agent:

```
codegraph explore "res.send Content-Type ETag generateETag setETag" --path <express>
```

| file | baseline | new |
|---|---|---|
| `lib/utils.js` (5,293 B, 272 lines) | **6,380 (46.1%) — whole** | **583 (7.7%) — cluster stub** |
| `lib/response.js` | 3,935 (28.4%) | 6,001 (64.9%) |
| `lib/application.js` | 1,607 (11.6%) | 2,532 (27.4%) |
| `lib/express.js` | 1,927 (13.9%) | — |
| **source envelope** | **13,849** | **9,241** |

`lib/utils.js` is where `compileETag`, `createETagGenerator`, `etag` and `wetag` live — half the
answer. The CG-4 diagnostic on the new build:

```
envelope 10,295 delivered · 10,292 allocated of 13,000 budget
allocation 12,398 reserved of 12,400 pool · cliff at weight 10.00 · nothing cliffed
 #  deliv%   bytes  reserved  score   flags                render     file
 1    5.7%     583     3,870   56.0   named entry central  clusters   lib/utils.js
 2   57.0%   5,868     5,875   91.4   entry                clusters*  lib/response.js
 3   23.0%   2,369     2,653   34.5   entry central        clusters*  lib/application.js
```

`utils.js` is the **top-ranked** file (score 56.0, named + entry + central) and was **reserved
3,870 chars — and spent 583 of them.** Nothing was cliffed. The allocator did its job; the
render loop threw the reservation away.

The mechanism is the whole-file bound at `src/mcp/tools.ts:4008`:

```ts
const WHOLE_FILE_MAX_CHARS = allowance + Math.min(WHOLE_FILE_GRACE_MAX,
                                                  round(allowance * WHOLE_FILE_GRACE_FRACTION));
```

= `3,870 + min(800, 580)` = **4,450** < the file's 5,293 bytes, so the whole-file render is
declined. Pre-CG-12 the bound was `maxCharsPerFile * 3` = 11,400, which the file cleared
comfortably. The fallback cluster render only has 3 matched symbols to work with, so it emits
583 chars and **3,287 chars of the reservation are simply lost** — which is also why the whole
response shrank from 13.8K to 9.2K against an unchanged 13,000-char budget.

This is CG-12's own acceptance criterion — *"no file that was previously unclipped becomes
clipped"* — failing, and here it is the direct cause of an agent Read. CG-14 recorded one
instance of it (`memory-budget.ts`) as a documented exception; this is the same defect
observed in the wild, where it costs a round-trip.

**Not systemic.** On both medium repos the render loop saturates (`[over budget] [TRUNCATED]`,
23,599 of a 23,600 pool reserved), so there is no unspent budget to lose. The failure needs a
file whose proportional reservation lands *below its own size* while its matched-symbol set is
thin — likelier on small repos, where per-file reservations are smallest.

### The fix belongs in CG-12, not here

Per this task's acceptance rule the budget must **not** be widened to compensate. The defect is
that a reservation can go unspent, so the fix is one of:

1. **Let a large-enough reservation buy the whole file.** If `allowance >= k * fileSize` for
   some k < 1 (utils.js: 3,870 / 5,293 = 0.73), render whole and let the bounded overshoot the
   ceiling already tolerates absorb it — the bytes were reserved for this file anyway.
2. **Redistribute what a file cannot spend.** After the render loop knows a file's realised
   size, hand the shortfall to the next-ranked file instead of dropping it. This also fixes the
   shrinking-envelope symptom directly.

(1) is the smaller change and matches the observed shape; (2) is the more complete invariant
("the pool is spent"). They compose.

---

## Bars

| # | Bar | Verdict |
|---|---|---|
| 1 | **Read stays at 0** | **FAIL** — client-go 0/0/0 and excalidraw 0/0/0 both arms, but express run 2 makes 4 Reads the baseline never made, from a reproducible non-agent cause |
| 2 | Correct-file share > 50% | **PASS** — new 67.8–100% across all 9 runs; self-query fixture 16% → 59.9%. (Caveat: on these three repos the *baseline* was already above 50%; the ~16% figure is the self-query fixture, not these repos) |
| 3 | No wall-clock regression | **PASS at the median** — excalidraw 34s → 24s, express 27s → 24s, client-go 49s → 50s. The 52s express outlier is the failing run |
| 4 | No regression on the control | **FAIL** — express, 1 run of 3 |

Bar 1 is the hard gate and it fails, so the epic does not pass on this measurement regardless
of bars 2 and 3.

## Reproduce

```bash
# clone fresh (never eval on a private repo), index, then:
RUNS=3 AGENT_EVAL_OUT=/tmp/ab-express \
  scripts/agent-eval/ab-new-vs-baseline.sh <express> "<question>" main

node scripts/agent-eval/parse-run.mjs /tmp/ab-express/run-new-2.jsonl --answer 'lib/**'

# the deterministic core of the failure, no agent needed:
CODEGRAPH_EXPLORE_DEBUG=1 node dist/bin/codegraph.js \
  explore "res.send Content-Type ETag generateETag setETag" --path <express>
```
