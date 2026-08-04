# Residual context occupancy

**What it measures:** how many tokens of the context window a tool's responses
still occupy once the question has been answered — and therefore how much
headroom every following turn has to work in.

This is the metric issue [#1500](https://github.com/colbymchenry/codegraph/issues/1500)
was actually about. The reporter was looking at a live Cursor session: explore's
output was still resident after the answer, so it was charged against everything
that came next. Our A/B harness ran one headless question to completion and
reported cost, tokens, time, and tool calls — none of which can see that. A
single-question run reports *throughput*; occupancy is a *stock*, and it only
starts costing anything on the turns that follow.

The harness now measures it, over multi-turn sessions.

---

## Running it

```bash
# One repo, one three-turn session, both arms:
scripts/agent-eval/run-all.sh /tmp/codegraph-corpus/gin \
  "How does gin route requests through its middleware chain?||\
Where is the 404 / no-route case handled in that same chain?||\
What would I change to add a per-route middleware that runs before the global ones?"

# The 7 README repos (default: 3 turns per session, RUNS=4 per arm):
CORPUS=/tmp/codegraph-corpus RUNS=2 scripts/agent-eval/bench-readme.sh
node scripts/agent-eval/parse-bench-readme.mjs /tmp/ab-readme
```

`||` separates turns. Turn 1 runs normally; each later turn `--resume`s the same
session, so the earlier turns' tool output is still in the window — which is the
entire point. Segments land in `run-<label>.jsonl`, `run-<label>.t2.jsonl`, …
and `parse-run.mjs` stitches them back into one session (`--resume` does not
replay prior messages, so they concatenate cleanly).

`CG_TURNS=1` restores the original single-question A/B. `CG_WINDOW_TOKENS`
overrides the 200k nominal window for the share-of-window column.

Every arm prints:

```
Residual context occupancy at end of run:
  final context       54,950 tok   27.5% of 200k window
  codegraph           13,941 tok   25.4% of ctx    7.0% of 200k win   (31,312 chars, 2 results)
  Read                     0 tok    0.0% of ctx    0.0% of 200k win   (0 chars, 0 results)
  Grep/Glob                0 tok    0.0% of ctx    0.0% of 200k win   (0 chars, 0 results)
  Bash                     0 tok    0.0% of ctx    0.0% of 200k win   (0 chars, 0 results)
  → file-access            0 tok    0.0% of ctx    0.0% of 200k win   (0 chars, 0 results)
  other tools             33 tok    0.1% of ctx    0.0% of 200k win   (73 chars, 1 result)
  base (prompt+prose)  40,976 tok   74.6% of ctx   20.5% of 200k win
    of which fixed    37,726 tok  system + tool schemas + question, before any tool answered
  measure: 2.25 chars/tok measured ±0.9% · turns 6 · compactions 0
```

The comparison is codegraph's residual in the with-arm against **file-access**
(Read + Grep/Glob + Bash) in the without-arm — the two ways an agent gets the
same bytes into its head. Bash matters: on small repos the without-arm often
reaches for `cat`/`grep` through Bash rather than the Read tool, and counting
only Read would score those runs as reading nothing.

---

## How the tokens are measured

**Measured, not estimated.** For each assistant request,

```
ctx_k = usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

is the exact token count of that request's entire prompt. So `ctx_k − ctx_{k−1}`
is exactly what was appended since the previous request: the previous assistant
output plus the tool results and user text that followed it. Each gap's measured
delta is priced against the characters in it.

The ratio is calibrated on gaps that are **≥80% tool result by characters**, then
every result is priced at that ratio. Calibrating on *all* gaps was wrong: when
the assistant's own output is under-represented in the transcript — redacted or
empty thinking blocks are the common case — a proportional split hands the tool
result the whole delta. One 73-character `ToolSearch` result was charged the
entire 830-token gap, 5.5 tokens per character.

Getting this right matters more than it sounds. Explore output measures around
**2.2–2.3 chars/token** — it is dense, line-numbered source. The usual bytes/4
rule of thumb would under-count it by roughly 40%.

**Error bar.** On a gap that is ≥95% one tool result, the measured delta *is*
that result's token count, so the distance from the run-level ratio is the
attribution error for that result. The median over such gaps is printed after
the ratio: **±1–2%** on real runs.

### Residual is not the same as contributed

Content leaves the window two ways, and both are tracked:

- a `compact_boundary` system event — everything before it is replaced by a
  summary, so the resident set is cleared;
- **micro-compaction** — the context drops mid-run without a boundary event.
  Claude Code sheds the oldest tool results first, so eviction is applied FIFO.

A shortfall only counts as eviction past a tolerance (the larger of 200 tokens or
5%); below that it is attribution noise, and real shedding is thousands of tokens.

### Two transcript traps

Both were verified against real logs and are worth knowing before writing
anything else that reads these files:

1. **Claude Code emits one `assistant` event per content block**, all carrying
   the same `message.id` *and the same `usage`*. Summing usage per event
   double-counts every turn that emits both a thinking block and a tool_use.
   `parseSession()` dedupes by `message.id`.
2. **The streamed `output_tokens` is a partial snapshot** — observed as `out=2`
   on a turn that really generated ~1,100 tokens. It is unusable; the
   char-proportional method deliberately does not need it.

For the record, `result.usage` in Claude Code 2.1.198 is cumulative *within a
segment* (its in+cache+out equals the sum of that segment's per-request prompts),
not last-turn-only as it was when `CLAUDE.md` was written. `parseSession()` sums
per segment either way. That figure is "tokens processed" — every request
re-counts the whole prefix — which is exactly why it cannot answer the occupancy
question.

---

## The without-arm was never actually without codegraph

Establishing this baseline turned up a contamination channel that had been open
the whole time, and it invalidates any number this harness produced for an arm
that had Bash.

The without-arm gets an empty MCP config, so it has no codegraph tool. It still
has **Bash** — and the target repo still carries the `.codegraph/` index the
with-arm needs, with the `codegraph` binary on PATH. Agents find that. In the
first clean-looking 7-repo pass, **14 of 15 without-arm runs ran `codegraph
explore` through Bash**, one of them by way of `ls .codegraph && codegraph
explore …`. That arm was measuring codegraph-over-CLI against codegraph-over-MCP,
not codegraph against its absence.

It cuts the other way too. When the *with*-arm shells out, the output arrives as
a Bash result and is attributed to Bash — understating what codegraph itself
occupies. One of 15 with-arm runs did this.

The fix is in `run-all.sh`: both arms now run on a PATH where the CLI is hidden,
so the MCP server is the only way to reach codegraph and stays the A/B's single
variable. The binary usually shares a directory with tools the run needs — here
`claude` sits right next to it — so the directory is substituted in place by one
of symlinks to every entry except `codegraph`, which keeps PATH order and
precedence intact. The run aborts if `claude` or `node` did not survive.

Prevention alone would fail silently the next time the binary lands somewhere
new, so there is detection as well: `parse-run.mjs` flags any Bash command naming
codegraph, and `parse-bench-readme.mjs` drops contaminated without-arm runs from
the aggregate (`CG_INCLUDE_CONTAMINATED=1` keeps them).

**Anyone re-reading older A/B results from this harness should assume the
without-arm may have been using codegraph.**

---

## Baseline: the 7 README repos

<!-- RESULTS -->

---

## What this settles, and what it does not

**Settled.** The metric exists, it is measured rather than estimated, it runs over
multi-turn sessions — the regime where occupancy is actually charged — and there
is a baseline across the 7 README repos to compare future changes against.

**Not settled, and deliberately not claimed:**

- **A different host.** The reporter was in Cursor. We measure Claude Code.
  Window size, system prompt, and compaction policy all differ, so the *share*
  numbers do not transfer host to host; the ratio between the arms is the part
  that travels.
- **Three turns is short.** It is long enough for the residual to be charged
  against something, which single-turn runs could not do at all. It is not long
  enough to reach compaction on a 200k window, so the compaction and
  micro-compaction paths are implemented and instrumented but effectively
  untested by this baseline — no run here triggered either.
- **Deferred tool schemas land in `base`.** `codegraph_explore` is a deferred
  tool: the initial listing carries its name, and `ToolSearch` pulls the full
  schema in later. That injection is not a tool result, so its tokens are
  counted as base rather than attributed to codegraph. The fixed-overhead line
  (with-arm `ctxBase` minus without-arm `ctxBase`) prices the part that is
  present from the start.
- **Subagent contexts are not counted.** A `Task` subagent has its own window;
  only its summary returns to the parent. Runs that delegate are measured on the
  parent's window alone.
- **Occupancy is not sufficiency.** A small residual is only good if the answer
  was still right. This metric says nothing about answer quality — that is
  CG-8's job (sufficiency) and CG-9's (how much of the returned bytes the answer
  actually used).
