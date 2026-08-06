# Index drift: incremental sync vs. full rebuild (CG-33)

Measured 2026-08-06. A live, auto-sync-maintained index **does not converge** to
a clean full rebuild of the identical working tree. On codegraph's own repo,
**4.3% of distinct edges were wrong**, in both directions, overwhelmingly
`calls` edges.

This matters because it is silent: nothing warns, nothing surfaces it, and the
README tells users the index is never stale and there is nothing to re-run.
Retrieval quality decays invisibly, and the user-visible symptom — an agent
falling back to Read — reads as "codegraph isn't very good" rather than "this
index needs rebuilding."

## Result

Subject: codegraph's own `.codegraph/codegraph.db`, long-lived and
incrementally synced, against a full rebuild of the same tree with the same
build. Edges compared as distinct `(source, target, kind)` triples.

| | count |
|---|---|
| distinct edge triples (rebuild) | 28,809 |
| in rebuild but **missing** from live | **751** |
| in live but **absent** from rebuild (stale) | **476** |
| **total divergent** | **1,227 — 4.3%** |

Missing edges by kind: `calls=635`, `contains=38`, `references=34`,
`instantiates=21`, `imports=13`, `extends=10`.

### Raw counts hide it

Raw edge **rows** were 39,845 live vs 40,122 rebuilt — a benign-looking +0.7%.
The divergence is bidirectional, so a net-count check nets it out and reports
almost nothing wrong. **Any drift detector must compare edge sets, not totals.**

### The indexer is deterministic

Control, rebuild vs rebuild on the same tree and build: **0 differing edges**
(28,809 both runs). So the live-vs-rebuild delta is not run-to-run noise.

### It is resolution, not residue

Node sets are identical — `files` 501 = 501, `nodes` 10,110 = 10,110,
heuristic edges 36 = 36 — and every integrity check is 0 on *both* indexes:
no duplicate nodes, no orphan edges, no nodes referencing a missing file row.

Nothing accumulates. Cross-file **resolution** goes stale.

## Likely mechanism

`ReferenceResolver` resolves calls and imports by name-matching and the import
graph across the **whole** project. Incremental sync re-parses and re-resolves
only the changed file, so:

- edges from *other* files into changed symbols are never recomputed → stale
  edges retained (the 476);
- edges that should newly form from unchanged files into changed symbols are
  never created → missing edges (the 751).

Start in `src/sync/` and `src/resolution/` — specifically what scope is
re-resolved on a single-file change.

## Why it degrades retrieval

Graph mass (RWR) is **relative and normalized**, so call edges missing elsewhere
inflate an unaffected file's share of the mass. Explore ranks files by that mass
(`allocateExploreBudget` weights on it), so drift silently promotes files that
should rank low.

Observed on a private application repo under heavy development: a generated
ambient-types file carried graph mass **0.24750** on the drifted index vs
**0.13119** on a clean rebuild (~1.9×), and score **49.0** vs **27.0**. On the
drifted index it took **60.7%** of an explore envelope and starved the file the
agent had actually named by symbol, which rendered **251 chars of a 10,970
reservation**. After a full re-index — no code change — the same query answers
correctly. That incident is what prompted this measurement; see CG-24.

Severity scales with churn and index age. codegraph's own repo shows 4.3%;
a repo under heavier active development plausibly drifts further.

## Reproducing

`scripts/agent-eval/diff-index-drift.mjs` is read-only and diffs two indexes.
Snapshot the live index **before** rebuilding — the original artifact for this
investigation was destroyed by re-indexing over it:

```bash
cp .codegraph/codegraph.db /tmp/live.db          # snapshot FIRST
node dist/bin/codegraph.js index .               # full rebuild
node scripts/agent-eval/diff-index-drift.mjs /tmp/live.db .codegraph/codegraph.db
```

Exit code is 0 when converged, 1 when drifted. To re-confirm determinism, diff
two consecutive rebuilds — that must report 0.

## Note on probing an index

The index file is `.codegraph/codegraph.db`. There is no `graph.db`. `sqlite3`
against a mistyped path **creates an empty database** rather than failing, and
every subsequent query then answers from an empty schema — which reads exactly
like a stale pre-migration index. That produced a wrong root cause during this
investigation. `diff-index-drift.mjs` checks `existsSync` before opening for
exactly this reason.
