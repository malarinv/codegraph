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

## The regression fixtures (CG-6)

Two fixtures pin the failure mode so it can never silently return. Both **fail today** —
that is what they are for. They become the pass gate for CG-10 + CG-12.

They are declared in `scripts/agent-eval/allocation-fixtures.json` and run by
`scripts/agent-eval/probe-allocation.mjs`, which drives the CG-4 diagnostic through a JSONL
sidecar (so it measures the shipping allocator, not a re-derivation), groups the rendered
files into `answer` vs `incidental`, and checks declared share thresholds. Needs a current
`npm run build`; exits 1 while any assertion fails.

```bash
node scripts/agent-eval/probe-allocation.mjs                # both
node scripts/agent-eval/probe-allocation.mjs payroll-go     # one
node scripts/agent-eval/probe-allocation.mjs --json         # machine-readable
```

### 1. `payroll-go` — the reporter's shape

`__tests__/fixtures/payroll-go/` is a synthetic Go service: generated FKIT CRUD beside a
hand-written payroll use-case, entered from an HTTP route. Full description in that
directory's README. The essentials:

- Generated files with **ordinary names** carrying `// Code generated ... DO NOT EDIT.` —
  invisible to path-only detection, which is what makes this a #1500 fixture rather than a
  `.pb.go` one — beside `payrollpb/*.pb.go` covering the path-detectable channel.
- Deliberate collisions: `BuildPayslip`, `Upsert` and `Store` each exist twice, generated
  and hand-written, and the generated layer name-collides on every query term.
- `cycle.go` (227 lines) sits above the whole-file window so it clips; the generated files
  sit below it so they ship whole.

Query — an architecture question naming none of the answering symbols: *"how does payroll
cycle create and calculate payslips?"*

| | allocated | delivered |
|---|---|---|
| hand-written | 48.4% | **25.6%** (all of it domain types) |
| generated CRUD | 39.9% | **57.4%** |

`cycle.go` is allocated the single largest slice (7,052 chars, 30.6%) and delivers **zero**
— the 19,500 hard ceiling drops its whole section. `payslip_builder.go` (rank #8) never
renders. So `runPayrollCycleAll`, the hand-written `BuildPayslip` and the real `Upsert`
never reach the agent, and every byte that did arrive describes either CRUD or types.

This fixture is hermetic: the probe copies the tree to a temp dir and re-indexes per run,
so two runs on one build are byte-identical (verified). `__tests__/explore-allocation-1500.test.ts`
runs the same assertions in vitest — the fixture-shape half green, the allocation half as
`it.fails` so the suite stays green while the bug is open and goes **red when it is fixed**.

**Finding, deliberately left unfixed:** `runPayrollCycleAll` calls `s.store.Upsert` on a
`*payslipstore.Store`, but the graph resolves that edge to the **generated**
`internal/gen/fkit/payroll/store.go` `Store.Upsert`. Same-name method resolution across two
packages that both define `Store.Upsert` picks the wrong receiver. It is upstream of the
allocation bug — a wrong edge pulls the generated store into the subgraph and inflates its
score — so it belongs with CG-10's scoring work, not with the fixture.

### 2. `self-query` — the same bug with no generated code in sight

The baseline above, promoted to a fixture: this repo, *"how does explore allocate its output
budget across files"*. `scripts/agent-eval/*.mjs` mention `explore` and `BUDGET`
incidentally — they are eval harnesses, not the allocator — and they are small enough to
ship whole, while `src/mcp/tools.ts` is large enough to be clipped.

At 493 indexed files (small tier): the script corpus takes **71.8%** of the delivered
envelope (79.4% allocated) against `tools.ts`'s **18.5%**, despite `tools.ts` scoring 46 vs
10, carrying 2.3× the graph mass and 3× the distinct term hits.

This fixture reads the **live** index of this repo, so unlike `payroll-go` its exact numbers
move as the repo changes. Its assertions are relative for that reason (answer group vs
incidental group, largest delivered file), never fixed percentages. Two things to know:

- The `<500`-file tier boundary is close. This repo indexes 493 files including the new
  fixture; crossing 500 flips `maxOutputChars` 18,000 → 24,000, `maxFiles` 5 → 8 and
  `maxCharsPerFile` 3,800 → 6,500, which moves every number in the table above. Re-baseline
  after the crossing rather than treating the drift as a regression.
- Adding the `payroll-go` fixture itself moved the count 472 → 493. Its Go files match none
  of this query's terms, so they change the tier arithmetic and nothing else.

### Reproducing

The query explores this repo, so **uncommitted edits to `src/mcp/tools.ts` change the
result** — the index picks them up and scores shift (the same query on the CG-4 working
tree reported tools.ts at 13–19% depending on the sync state). Measure against a clean
tree: restore `src/mcp/tools.ts` from `main`, remove `src/mcp/explore-diagnostics.ts`,
`codegraph sync`, then run the built `dist/` binary (which still carries the instrument).
Restore afterwards.
