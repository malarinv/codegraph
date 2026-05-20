/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * MCP clients (Claude Code, Cursor, opencode, LangChain, OpenAI Agent
 * SDK, …) surface this text in the agent's system prompt automatically,
 * giving the agent a high-level playbook for the codegraph toolset
 * before it sees individual tool descriptions.
 *
 * Goals when editing this:
 *   - Tool selection by intent (which tool for which question)
 *   - Common chains (refactor planning = X then Y)
 *   - Anti-patterns (don't grep when codegraph_search is faster)
 *
 * Keep it tight. The agent reads this every session — long instructions
 * burn tokens. Reference only tools that exist on `main`; gate any
 * conditional tools behind feature checks if/when they ship.
 */
export const SERVER_INSTRUCTIONS = `# Codegraph — code intelligence over an indexed knowledge graph

Codegraph is a SQLite knowledge graph of every symbol, edge, and file
in the workspace. Reads are sub-millisecond; the index lags writes by
about a second through the file watcher. Consult it BEFORE writing or
editing code, not during.

## Tool selection by intent

- **"How does X work? / trace X end to end / explain the Y system / architecture?"** → \`codegraph_explore\` (PRIMARY for understanding — seed it with the key symbol names, read its output, don't grep+Read your way there)
- **"What is the symbol named X? / where is X defined?"** → \`codegraph_search\` (pinpoint lookups)
- **"What's the deal with this task / feature / area?"** → \`codegraph_context\` (lighter composed view of search + node + callers + callees)
- **"What calls this?"** → \`codegraph_callers\`
- **"What does this call?"** → \`codegraph_callees\`
- **"What would changing this break?"** → \`codegraph_impact\`
- **"Show me this symbol's source / signature / docstring."** → \`codegraph_node\`
- **"What's in directory X?"** → \`codegraph_files\`
- **"Is the index ready / what's its size?"** → \`codegraph_status\`

## Common chains

- **Understanding / onboarding**: feed \`codegraph_explore\` the key symbol/file names and read its output (line-numbered source from many files in one call). If the question names nothing concrete, do ONE quick \`codegraph_search\` / \`codegraph_context\` to surface the names, then explore with them. Fill remaining gaps with \`codegraph_node\` / Read — don't drop back to grep+Read for the whole topic.
- **Refactor planning**: \`codegraph_search\` → \`codegraph_callers\` → \`codegraph_impact\`. The blast-radius answer comes from impact, not from walking callers manually.
- **Debugging a regression**: \`codegraph_callers\` of the suspected symbol; widen with \`codegraph_impact\` if an unexpected call appears.

## Anti-patterns

- **Don't search-then-Read your way through an understanding question** — feed the names you find into \`codegraph_explore\` instead of Reading the files one by one; it does that whole loop in one call and returns line numbers you can cite directly.
- **Don't grep first** when looking up a symbol by name — \`codegraph_search\` is faster and returns kind + location + signature.
- **Don't reach for \`codegraph_explore\` on a pinpoint "where is X defined" lookup** — \`codegraph_search\` is one cheap call.
- **Don't query the index immediately after editing a file** — the watcher needs ~500ms to debounce + sync. Wait for the next turn.

## Limitations

- Index lags file writes by ~1 second.
- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. Codegraph supplements those with structural context they don't have.
`;
