# Cross-call explore session state

`codegraph_explore` answers every call as if it were the first one. It has no idea what it
already sent this session, so a 4th call happily re-serves the spine the 1st call already
delivered (the #1500 report: 4 calls on a 2-call tier budget), and the tier's call budget
can only be *asked* for in prose the agent ignores.

This document covers the state layer that fixes the "no idea" part — `src/mcp/explore-session-state.ts`
(CG-17). It changes no response. Its consumers are cross-call source dedup (CG-18) and
budget decay past the tier budget (CG-19).

## What is recorded

One `ExploreSessionState` per MCP session. Inside it, per **resolved project root**:

- `callCount` / `responseBytes` — every explore call served this session for that project;
- `calls[]` — the recent ones in detail: query, per-file emitted **line ranges**, source
  bytes, response bytes, and the call's 1-based session index.

Ranges come from the render loop itself — `buildSection` returns the spans it slices
alongside the text, and the whole-file / focused / skeleton paths report theirs at the
point they push source into the response. A separate function mirroring the window and
padding rules would drift, and drift here is not symmetric: see *Which way to be wrong*.

Only files that **survive the final hard-ceiling truncation** are recorded. A section the
ceiling dropped was never delivered.

## Four constraints, and what each one rules out

| Constraint | Why | What it rules out |
|---|---|---|
| Per session, never persisted | A new agent has seen nothing | A disk cache keyed by project |
| Per **resolved** project root | One session can query several projects by `projectPath` | Keying on the path the agent typed — `/repo` and `/repo/internal` are one project |
| Bounded memory | Sessions can run for hours | Unbounded `calls[]` growth |
| Daemon-safe | One daemon shares ONE `ToolHandler` and a pool of worker threads across every connected client | State on the handler, in a worker, or in a module-level singleton |

The daemon constraint is the sharp one. State kept on the shared `ToolHandler` would blend
two agents' histories, and a dedup built on that would withhold source from an agent that
never saw it — which costs a Read, the exact failure this area exists to prevent. So the
state lives on `MCPSession`, and the plumbing is:

```
MCPSession (owns the state)
  └─ ToolHandler.execute(tool, args, sessionState)
       ├─ down: session view attached to args    (survives structured clone → worker)
       └─ up:   emission attached to the result  (survives structured clone ← worker)
            └─ recorded on the MAIN thread, then DELETED from the result
```

Both legs travel as plain properties (`_cgExploreSession`, `_cgExploreEmission`) because
either may cross a worker boundary, where a closure or a handler field could not follow.
The emission is stripped in `execute` **unconditionally** — including for callers that
track nothing, like the CLI — so the agent-facing response is byte-identical. A view a
client spells itself is discarded, not trusted: it decides what a later call may withhold.

## The bounds

`EXPLORE_SESSION_LIMITS`: 4 projects (LRU), 8 retained calls per project, 24 files per
call, 24 ranges per file, 4 calls in the view handed to a call.

Every bound caps **detail**. `callCount` and `responseBytes` keep counting past eviction —
decay (CG-19) reads the count, and a bound that reset it would make decay reset itself
every 8 calls.

## Which way to be wrong

Where a bound forces a choice, the record keeps **fewer** ranges than were emitted, never
more:

- under-report → a later call re-serves something the agent already has. Wasteful.
- over-report → a later call withholds source the agent never saw. The agent Reads the
  file, and one Read costs more than every byte the dedup saved.

So `coalesceRanges` drops the smallest spans when it hits the cap (and flags
`rangesTruncated`), invalid spans are discarded rather than clamped, and truncated file
sections are never recorded.

## Inspecting it

The CG-4 diagnostic (`CODEGRAPH_EXPLORE_DEBUG`, see
[explore-budget-allocation.md](./explore-budget-allocation.md)) carries a `session` block
on every report:

```
  session call #2 for this project · 1 prior call · 18,204 chars already served
    already served internal/usecase/payroll_cycle.go · 4,928 chars · L1-159
```

`callIndex` is this call's position in the session; `priorFiles` unions the ranges already
served per file, most-recent call first. The block is **absent** — not zeroed — when the
caller tracks no state, which is how "untracked" and "first call of a tracked session" stay
distinguishable.

## Coverage

`__tests__/explore-session-state.test.ts`, in three layers: the container (keying, monotonic
index past eviction, every bound), the handler seam (a real explore against a real index
records real ranges; the response is byte-identical to an untracked one; two states on one
handler stay separate), and the session seam (two `MCPSession`s on one engine get their own
state, and each call carries its own session's).

Two things vitest cannot cover, verified by hand against `dist/`:

- **the worker path** — with a `QueryPool` attached, the emission survives the structured
  clone back from the worker, records on the main thread, and is absent from the result;
- **two genuinely different projects in one session** — opening a second index inside vitest
  fails on the lazy `require('../index')`. The in-suite substitute reaches one project two
  ways (bare, and by a `projectPath` pointing at a subdirectory) and asserts both land in one
  bucket; multi-project keying itself is covered at the container level.
