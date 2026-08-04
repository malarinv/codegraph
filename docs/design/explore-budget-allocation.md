# Explore budget allocation — the instrument and the baseline

`codegraph_explore` has a fixed byte envelope (`getExploreOutputBudget().maxOutputChars`,
hard-capped at 25K so the host never externalizes the result). **How that envelope gets
divided among files** is decided by a long chain of gates, tiers and caps spread across
`handleExplore` — and until CG-4 that chain was unobservable. You could read an explore
response and guess; you could not say "this file took 16% and that one took 20%."

This document covers the diagnostic that makes it measurable, and the baseline it recorded.

## The diagnostic

Set `CODEGRAPH_EXPLORE_DEBUG` and every `codegraph_explore` call (MCP tool or
`codegraph explore` CLI) emits one report:

| value | sink |
|---|---|
| `1` / `true` / `on` / `yes` / `stderr` | human-readable table on stderr |
| `json` | one pretty-printed JSON report on stderr |
| anything else | treated as a path — one JSON report per line, appended (JSONL) |
| unset / `0` / `false` / `off` / `no` / empty | **off** |

Per file it reports: relevance score, graph (RWR) mass, distinct query-term hits, ranking
flags (named / entry / central / spine / low-value / generated), render mode, bytes of
source allocated, bytes actually delivered, both shares, and whether it was clipped. For
files that never rendered it reports why (`max-files`, `budget-90pct`, `budget-whole-file`,
`budget-clusters`, `unreadable`, `no-ranges`). Totals cover the envelope (delivered vs
allocated vs `maxOutputChars` vs hard ceiling), the source/meta split, the file-selection
funnel at each stage, and the thresholds applied (score floor, graph-relevance gate).

**It is off by default and produces byte-identical output when off** — it ships in the
product binary, and a diagnostic that perturbs the response by one byte would invalidate
every A/B measurement taken with it on. `ExploreDiagnostics.start()` returns `null` unless
the env var is set, so every call site is a `diag?.` no-op. Pinned by
`__tests__/explore-diagnostics.test.ts`.

Two envelope numbers, deliberately kept separate:

- **allocated** — what the render loop chose to emit, before the final hard-ceiling cut.
  This is the allocator's own decision, and the number budget work is about.
- **delivered** — what the agent actually received.

They diverge exactly when the ceiling truncates. Conflating them is how a dropped trailing
file goes unnoticed.

## Baseline (2026-08-03, this repo at `main`)

```
codegraph explore "how does explore allocate its output budget across files" --path .
```

469 files indexed → small tier (`maxOutputChars` 18,000, `maxCharsPerFile` 3,800,
`defaultMaxFiles` 5). Envelope: **23,196 delivered / 23,193 allocated against an 18,000
budget — 29% over**, absorbed only because the 25K hard ceiling sits above it.

| # | share | bytes | score | graph | hits | flags | render | file |
|---|---|---|---|---|---|---|---|---|
| 4 | 21.2% | 4,928 | 10 | 0.125 | 1 | entry | whole | `scripts/agent-eval/offload-eval-hook.mjs` |
| 5 | 20.1% | 4,665 | 10 | 0.125 | 1 | entry | whole | `scripts/agent-eval/offload-eval-metrics.mjs` |
| 3 | 19.8% | 4,585 | 22 | 0.125 | 1 | entry central | whole | `scripts/agent-eval/parse-session.mjs` |
| 1 | **15.8%** | 3,659 | **54** | **0.322** | **4** | entry central | clusters* | `src/mcp/tools.ts` |
| 2 | 15.0% | 3,479 | 34 | 0.082 | 2 | entry | clusters* | `src/index.ts` |

\* clipped. Ranked but never rendered: `scripts/agent-eval/offload-eval-cost.mjs` (#6) and
`src/resolution/lru-cache.ts` (#7), both cut by `maxFiles`.

Files: 17 grouped → 10 past the score floor (≥3) → 10 past the low-value filter → 7 past
the relevance gate (graph ≥ 0.0193, 6% of max 0.3215) → 5 in the output.

### What the baseline shows

**Score does not drive allocation.** `src/mcp/tools.ts` — the file that actually answers
the query — carries 5.4× the relevance score, 2.6× the graph mass and 4× the term hits of
any `.mjs` script, and gets a *smaller* share than each of them. The three agent-eval
scripts take **61%** of the envelope between them; the answer file takes 16%.

The mechanism is that the two allocation paths are decided by **file size, not relevance**:
a small file clears `WHOLE_FILE_MAX_LINES`/`WHOLE_FILE_MAX_CHARS` and ships entirely, while
a large file falls through to cluster selection and is clipped at `maxCharsPerFile`. So a
weakly-relevant 130-line script gets 100% of itself; the strongly-relevant 5,000-line file
gets 3,800 chars. Rank ordering is correct (tools.ts sorts #1) and buys nothing, because
rank has no effect on how many bytes a file receives.

**The envelope is over-subscribed.** 23,193 allocated against an 18,000 budget means the
per-file caps do not compose into the total cap; the total is enforced only by the 25K
ceiling silently dropping whole trailing sections. Under a slightly different index state
(one more candidate file) the same query allocated 27,518 chars and the ceiling dropped a
7,678-char section — the single largest allocation in the response — with the only trace
being the truncation notice at the end.

This is the gap the rest of the epic closes: relevance-proportional allocation with a
relative cliff (CG-12), on top of scoring that stops rewarding incidental name collisions
(CG-10).

### Reproducing

The query explores this repo, so **uncommitted edits to `src/mcp/tools.ts` change the
result** — the index picks them up and scores shift (the same query on the CG-4 working
tree reported tools.ts at 13–19% depending on the sync state). Measure against a clean
tree: restore `src/mcp/tools.ts` from `main`, remove `src/mcp/explore-diagnostics.ts`,
`codegraph sync`, then run the built `dist/` binary (which still carries the instrument).
Restore afterwards.
