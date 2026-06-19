/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * MCP clients (Claude Code, Cursor, opencode, LangChain, OpenAI Agent
 * SDK, …) surface this text in the agent's system prompt automatically,
 * giving the agent a high-level playbook for the codegraph toolset
 * before it sees individual tool descriptions.
 *
 * Goals when editing this:
 *   - Lead the agent to codegraph_explore for any structural/flow question
 *   - Reinforce "explore instead of Read/Grep" for indexed code
 *   - Anti-patterns (don't re-verify with grep; don't hand-reconstruct flows)
 *
 * Keep it tight. The agent reads this every session — long instructions
 * burn tokens. The DEFAULT MCP surface is `codegraph_explore` ALONE (see
 * DEFAULT_MCP_TOOLS in tools.ts) — reference only that tool here. The other
 * tools (node/search/callers/…) stay defined and are re-enablable via
 * CODEGRAPH_MCP_TOOLS, but they are NOT listed to agents, so don't name them.
 */
export const SERVER_INSTRUCTIONS = `# Codegraph — code intelligence over an indexed knowledge graph

Codegraph is a SQLite knowledge graph of every symbol, edge, and file in
the workspace — pre-computed structure you would otherwise re-derive by
reading files (cached intelligence: thousands of parse/trace decisions you
don't pay to re-reason each run). Reads are sub-millisecond; the index lags
writes by ~1s through the file watcher. Reach for it BEFORE *and* while
writing or editing code — not just for questions: one call returns the
verbatim source PLUS who calls it and what it affects, so you edit with the
blast radius in view. More accurate context, in far fewer tokens and
round-trips than reading files yourself.

## One tool: codegraph_explore — use it instead of reading files

There is a single tool, \`codegraph_explore\`, and it is Read-equivalent. It
takes either a natural-language question or a bag of symbol/file names and
returns the **verbatim, line-numbered source** of the relevant symbols
grouped by file — the same \`<n>\\t<line>\` shape \`Read\` gives you, safe to
\`Edit\` from — PLUS the call path among them (including dynamic-dispatch hops
like callbacks, React re-render, and JSX children that grep can't follow) and
a blast-radius summary of what depends on them.

Whether you're answering "how does X work" or implementing a change (fixing a
bug, adding a feature), call \`codegraph_explore\` before you Read. ONE call
usually answers the whole question. Codegraph IS the pre-built search index —
so running your own grep + read loop, or delegating the lookup to a separate
file-reading sub-task/agent, repeats work codegraph already did and costs more
for the same answer. A direct codegraph answer is typically one to a few
calls; a grep/read exploration is dozens.

## How to query

- **Almost any question — "how does X work", architecture, a bug, "what/where is X", or surveying an area** → \`codegraph_explore\` with a natural-language question or the relevant names. ONE capped call returns the verbatim source grouped by file; most often the ONLY call you need.
- **"How does X reach/become Y? / the flow / the path from X to Y"** → \`codegraph_explore\`, naming the symbols that span the flow (e.g. \`mutateElement renderScene\`) — it surfaces the call path among them, riding dynamic-dispatch hops, and returns their source.
- **Reading or editing a file/symbol you can name** → put its name or file path in the \`codegraph_explore\` query — it returns that current line-numbered source (safe to \`Edit\` from) with the call path and blast radius attached, so you don't Read it separately. For an overloaded name it returns every matching definition's body in one call.
- **Need more?** Call \`codegraph_explore\` again with more specific names — treat the source it returns as already Read.

## Anti-patterns

- **Trust codegraph's results — don't re-verify them with grep.** They come from a full AST parse; re-checking with grep is slower, less accurate, and wastes context.
- **Don't grep or Read first** to find or understand indexed code — ONE \`codegraph_explore\` returns the relevant symbols' source together in a single round-trip. Reach for raw \`Read\`/\`Grep\` only to confirm a specific detail codegraph didn't cover, or for what codegraph doesn't index (configs, docs).
- **Don't reconstruct a flow by hand** — name the endpoints in one \`codegraph_explore\` and it surfaces the path between them, dynamic-dispatch hops included.
- **After editing, check the staleness banner.** When a tool response starts with "⚠️ Some files referenced below were edited since the last index sync…", the listed files are pending re-index — Read those specific files for accurate content. Every file NOT in that banner is fresh, so still trust codegraph. A different, rarer banner — "⚠️ CodeGraph auto-sync is DISABLED…" — means live watching stopped entirely (the whole index is frozen, not just a few files); until it's resolved, Read files directly to confirm anything that may have changed.

## Limitations

- If a tool reports a project isn't indexed (no \`.codegraph/\`), stop calling codegraph tools for that project for the rest of the session and use your built-in tools there instead. Indexing is the user's decision — mention they can run \`codegraph init\` if it comes up, but don't run it yourself.
- Index lags file writes by ~1 second.
- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. Codegraph supplements those with structural context they don't have.
`;

/**
 * Instructions variant sent when the workspace has NO codegraph index.
 *
 * Sending the full playbook ("lean on codegraph for everything") into a
 * session where every call would fail wastes the agent's calls and — worse —
 * the failures teach it codegraph is broken. The unindexed variant is a
 * short, unambiguous "inactive this session" note; `tools/list` is gated to
 * empty in the same state, so the agent has nothing to mis-call. Indexing is
 * deliberately left to the user: the agent is told NOT to run init itself.
 */
export const SERVER_INSTRUCTIONS_UNINDEXED = `# Codegraph — inactive (workspace not indexed)

This workspace has no codegraph index (no \`.codegraph/\` directory), so no
codegraph tools are available this session. Work with your built-in tools as
usual.

Indexing is the user's decision — do not run it yourself. If the user asks
about codegraph, they can enable it by running \`codegraph init\` in the
project root and starting a new session.
`;
