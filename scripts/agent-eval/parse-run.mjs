#!/usr/bin/env node
// Parse Claude Code stream-json run log(s): tool-call sequence, token usage, and
// RESIDUAL CONTEXT OCCUPANCY — how many tokens of the context window each tool
// family's responses still occupy when the run ends.
//
// Usage: parse-run.mjs <run.jsonl> [run.t2.jsonl ...]
//   Multiple files = one multi-turn session's segments, IN ORDER (run-all.sh
//   writes run-<label>.jsonl, run-<label>.t2.jsonl, … for a `Q1||Q2||Q3` set).
//   `--resume` does not replay prior messages, so the segments concatenate
//   cleanly and token accounting carries across the boundary.
//
// ---------------------------------------------------------------------------
// Why occupancy, and how it's measured
// ---------------------------------------------------------------------------
// A single-question A/B reports cost/tokens/time/tool-calls for ONE answer. It
// cannot see what issue #1500 measured: a tool response stays in the window for
// everything that follows, so it is charged against every later turn's headroom.
// That is a per-session cost our single-question runs structurally miss.
//
// Tokens are MEASURED, not estimated at bytes/4. For assistant request k,
//   ctx_k = usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens
// is the exact token count of that request's whole prompt. So
//   gap_k = ctx_k - ctx_{k-1}
// is exactly the tokens appended since the previous request: the previous
// assistant output (thinking + text + tool_use JSON) plus the tool_results and
// user text that followed it. We split gap_k across those blocks in proportion
// to their characters, which attributes each tool_result its measured share.
// (Measured on real runs, explore output lands near 2.3 chars/token — bytes/4
// under-counts it by ~40%, which is why the estimate isn't good enough.)
//
// Two traps this file works around, both verified against real logs:
//   * Claude Code emits ONE assistant event PER CONTENT BLOCK, all carrying the
//     same message.id and the same `usage`. Summing usage per event double-counts
//     every turn that emits both thinking and a tool_use — dedupe by message.id.
//   * The streamed `output_tokens` is a partial snapshot (observed `out=2` on a
//     turn that really generated ~1100). Never trust it; the char-proportional
//     split doesn't need it.
//
// Residual ≠ contributed. Content leaves the window two ways, and both are
// tracked: a `compact_boundary` system event (everything prior is replaced by a
// summary) and micro-compaction (ctx drops mid-run — oldest tool results are
// dropped first, so eviction is applied FIFO).
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

// Nominal window for the share-of-window column. Override for a [1m] context.
const WINDOW_TOKENS = Number(process.env.CG_WINDOW_TOKENS || 200_000);
const CHARS_PER_TOKEN_FALLBACK = 3.0;

/** Which tool family a tool_use belongs to. */
function familyOf(name) {
  if (/codegraph/.test(name)) return 'codegraph';
  if (name === 'Read' || name === 'NotebookRead') return 'read';
  if (name === 'Grep' || name === 'Glob') return 'search';
  if (name === 'Bash' || name === 'BashOutput') return 'bash';
  return 'other';
}
const FAMILIES = ['codegraph', 'read', 'search', 'bash', 'other'];
// The without-arm's way of getting the same bytes: reading and searching files.
const FILE_ACCESS = ['read', 'search', 'bash'];

// A Bash command that INVOKES the codegraph CLI, in any command position and by
// any path. Mentions are not invocations: `grep codegraph src/`, `ls .codegraph`
// and `which codegraph` all pass. Kept in step with run-all.sh's blocking hook.
const CG_CLI_RE = /(^|[;&|(]|&&|\|\||\$\(|`)\s*(?:[A-Za-z_]\w*=\S*\s+)*[\w./~-]*codegraph(\s|$)/;

const textOf = (content) =>
  Array.isArray(content) ? content.map((c) => c.text ?? (typeof c === 'string' ? c : JSON.stringify(c))).join('')
    : typeof content === 'string' ? content
      : content == null ? '' : JSON.stringify(content);

/** Characters an assistant content block occupies once it is back in the prompt. */
function assistantBlockChars(b) {
  if (b.type === 'text') return (b.text || '').length;
  if (b.type === 'thinking') return (b.thinking || '').length;
  if (b.type === 'tool_use') return JSON.stringify(b.input ?? {}).length + (b.name || '').length;
  return JSON.stringify(b).length;
}

/**
 * Parse one session (its segment files, in order) into tool + occupancy stats.
 * Exported so parse-bench-readme.mjs can aggregate without duplicating any of
 * this — deliberately NOT a separate module file: a new scripts/agent-eval/*.mjs
 * scores into the self-query eval fixture's own corpus and moves its numbers.
 */
export function parseSession(files) {
  const events = [];
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* partial line */ }
    }
  }

  const toolCalls = [];          // display sequence
  const nameById = new Map();    // tool_use_id -> tool name
  const counts = {};             // tool name -> calls
  let initTools = null, result = null, raced = false, cliCalls = 0;
  const results = [];  // one `result` event per session segment (multi-turn)
  let compactions = 0;

  // A timeline of everything appended to the context, in order. `req` entries
  // are assistant requests (carrying that request's ctx); `add` entries are
  // characters appended (assistant output blocks, tool results, user text).
  const timeline = [];
  const seenMsgIds = new Set();

  for (const ev of events) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      initTools = (ev.tools || []).filter((t) => /codegraph/.test(t));
    }
    if (ev.type === 'system' && (ev.subtype === 'compact_boundary' || ev.subtype === 'compaction')) {
      compactions++;
      timeline.push({ kind: 'compact' });
    }
    if (ev.type === 'assistant' && ev.message) {
      const id = ev.message.id;
      // One event per content block, same id + same usage: count usage once,
      // but take the content blocks from every event that carries the id.
      if (id && !seenMsgIds.has(id)) {
        seenMsgIds.add(id);
        const u = ev.message.usage || {};
        const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        timeline.push({ kind: 'req', ctx, out: u.output_tokens || 0 });
      }
      for (const b of ev.message.content || []) {
        timeline.push({ kind: 'add', family: null, chars: assistantBlockChars(b) });
        if (b.type === 'tool_use') {
          nameById.set(b.id, b.name);
          counts[b.name] = (counts[b.name] || 0) + 1;
          let detail = '';
          if (b.name === 'Task') detail = ` [subagent_type=${b.input?.subagent_type ?? '?'}] ${(b.input?.description ?? '').slice(0, 40)}`;
          else if (/codegraph/.test(b.name)) detail = ` ${JSON.stringify(b.input?.query ?? b.input?.task ?? b.input?.symbol ?? '').slice(0, 60)}`;
          else if (b.name === 'Bash') {
            detail = ` ${(b.input?.command ?? '').slice(0, 50)}`;
            // An arm with no codegraph MCP can still shell out to the CLI — the
            // target repo carries the .codegraph/ index and the binary is on
            // PATH. That silently turns a "without" arm into codegraph-over-CLI.
            if (CG_CLI_RE.test(b.input?.command ?? '')) cliCalls++;
          }
          else if (b.name === 'Read') detail = ` ${(b.input?.file_path ?? '').split('/').slice(-1)[0]}`;
          toolCalls.push(`${b.name}${detail}`);
        }
      }
    }
    if (ev.type === 'user' && ev.message) {
      const content = ev.message.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_result') {
            const t = textOf(b.content);
            // MCP cold-start race: the agent fired before `serve --mcp` had
            // registered its tools, so it floundered into grep/Read. That
            // measures startup latency, not steady-state value — flag it.
            if (/No such tool available/.test(t)) raced = true;
            const name = nameById.get(b.tool_use_id) || '';
            timeline.push({ kind: 'add', family: familyOf(name), chars: t.length, tool: name });
          } else {
            timeline.push({ kind: 'add', family: null, chars: textOf([b]).length });
          }
        }
      } else if (typeof content === 'string') {
        timeline.push({ kind: 'add', family: null, chars: content.length });
      }
    }
    if (ev.type === 'result') { result = ev; results.push(ev); }
  }

  // ---- Pass 1: chars/token, calibrated on tool-result-dominated gaps. ------
  // Splitting a gap in proportion to characters over-attributes to tool results
  // whenever the assistant's own output is under-represented in the transcript
  // (redacted/empty thinking blocks are the common case — a gap whose only
  // visible chars were a 73-char tool_result charged it the whole 830-token
  // delta, 5.5 tok/char). So calibrate the ratio on gaps that are ≥80% tool
  // result by characters, then price every result at that ratio.
  const reqIdx = timeline.map((t, i) => (t.kind === 'req' ? i : -1)).filter((i) => i >= 0);
  const gaps = [];
  for (let k = 1; k < reqIdx.length; k++) {
    const prev = timeline[reqIdx[k - 1]], cur = timeline[reqIdx[k]];
    let chars = 0, toolChars = 0, compacted = false;
    const byFamily = {};
    for (let i = reqIdx[k - 1] + 1; i < reqIdx[k]; i++) {
      const t = timeline[i];
      if (t.kind === 'compact') { compacted = true; continue; }
      if (t.kind !== 'add') continue;
      chars += t.chars;
      if (t.family) { toolChars += t.chars; byFamily[t.family] = (byFamily[t.family] || 0) + t.chars; }
    }
    gaps.push({ delta: cur.ctx - prev.ctx, chars, toolChars, byFamily, compacted });
  }
  const clean = gaps.filter((g) => !g.compacted && g.delta > 0 && g.chars > 500 && g.toolChars / g.chars >= 0.8);
  // A gap where the window also SHED content has a delta far below what was
  // added, which reads as absurdly dense text and would drag the whole run's
  // ratio with it. Shedding can only push a gap's chars/token UP, so take the
  // lower median as the honest centre and drop anything well above it, then
  // pool the survivors. (On runs that never shed, every ratio is within a few
  // percent of the others and this changes nothing.)
  const ratios = clean.map((g) => g.toolChars / g.delta).sort((a, b) => a - b);
  const lowerMedian = ratios.length ? ratios[Math.floor((ratios.length - 1) / 2)] : 0;
  let sumD = 0, sumC = 0;
  for (const g of clean) {
    if (lowerMedian > 0 && g.toolChars / g.delta > lowerMedian * 1.5) continue;  // shed
    sumD += g.delta; sumC += g.toolChars;
  }
  if (sumD === 0) { // no clean gap — fall back to every growing gap, all chars
    for (const g of gaps) if (!g.compacted && g.delta > 0 && g.chars > 0) { sumD += g.delta; sumC += g.chars; }
  }
  const charsPerToken = sumD > 0 ? sumC / sumD : CHARS_PER_TOKEN_FALLBACK;
  const calibrated = sumD > 0;

  // How far a single result's token density strays from the run-level ratio.
  // On a gap that is almost entirely one tool result, `delta` IS that result's
  // token count, so |chars/ratio - delta| / delta is the attribution error for
  // that result. The median over such gaps is the metric's real error bar.
  const errs = [];
  for (const g of gaps) {
    if (g.compacted || g.delta <= 0 || g.chars <= 500) continue;
    if (g.toolChars / g.chars < 0.95) continue;
    errs.push(Math.abs(g.toolChars / charsPerToken - g.delta) / g.delta);
  }
  errs.sort((a, b) => a - b);
  const dispersion = errs.length ? errs[(errs.length - 1) >> 1] : null;

  // ---- Pass 2: attribute gap tokens, then apply evictions FIFO. ------------
  const contributed = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
  const resultChars = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
  const resultCount = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
  for (const t of timeline) if (t.kind === 'add' && t.family) { resultChars[t.family] += t.chars; resultCount[t.family]++; }

  let queue = [];        // resident contributions, oldest first
  let evicted = 0;
  const evict = (tokens) => {
    let left = tokens;
    while (left > 0 && queue.length) {
      const head = queue[0];
      if (head.tokens <= left) { left -= head.tokens; evicted += head.tokens; queue.shift(); }
      else { head.tokens -= left; evicted += left; left = 0; }
    }
  };

  for (const g of gaps) {
    if (g.compacted) {
      // Everything before the boundary is gone; the summary replaces it.
      evicted += queue.reduce((s, q) => s + q.tokens, 0);
      queue = [];
    }
    let toolTokens = 0;
    for (const [fam, ch] of Object.entries(g.byFamily)) {
      const tok = ch / charsPerToken;
      toolTokens += tok;
      contributed[fam] += tok;
      queue.push({ family: fam, tokens: tok });
    }
    // The gap grew by `delta`; the tool results account for `toolTokens` of it.
    // A shortfall means the window also shed content — micro-compaction drops
    // the OLDEST tool results first, so evict FIFO. The tolerance keeps
    // attribution noise (a run-level ratio priced against one gap's delta,
    // typically ±2%) from reading as an eviction; real shedding is thousands.
    const shortfall = toolTokens - g.delta;
    if (!g.compacted && shortfall > Math.max(200, toolTokens * 0.05)) evict(shortfall);
  }

  const residual = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
  for (const q of queue) residual[q.family] += q.tokens;

  const ctxFinal = reqIdx.length ? timeline[reqIdx[reqIdx.length - 1]].ctx : 0;
  // The FIRST request's prompt is system + tool schemas + the question, before
  // any tool has answered. Differencing the arms' ctxBase prices codegraph's
  // FIXED occupancy — its tool schema and MCP `initialize` instructions — which
  // it pays whether or not the agent ever calls it.
  const ctxBase = reqIdx.length ? timeline[reqIdx[0]].ctx : 0;
  // Multi-turn: duration/cost/tokens are per-segment, so sum them. `result.usage`
  // is cumulative WITHIN a segment (verified: its in+cache+out equals the sum of
  // that segment's per-request prompts), so summing segments is correct and does
  // NOT double-count. It is a "tokens processed" figure — every request re-counts
  // the whole prefix — which is exactly why it can't answer the occupancy question.
  const sumUsage = (k) => results.reduce((s, r) => s + (r.usage?.[k] || 0), 0);
  const processed = sumUsage('input_tokens') + sumUsage('cache_read_input_tokens')
    + sumUsage('cache_creation_input_tokens') + sumUsage('output_tokens');

  return {
    files, toolCalls, counts, initTools, result, results, raced, cliCalls,
    ok: results.length > 0 && results.every((r) => r.subtype === 'success'),
    turns: reqIdx.length,
    tools: toolCalls.filter((t) => !t.startsWith('ToolSearch')).length,
    reads: counts.Read || 0,
    grep: (counts.Grep || 0) + (counts.Glob || 0),
    cg: Object.entries(counts).filter(([n]) => /codegraph/.test(n)).reduce((s, [, v]) => s + v, 0),
    dur: results.reduce((s, r) => s + (r.duration_ms || 0), 0) / 1000,
    cost: results.reduce((s, r) => s + (r.total_cost_usd || 0), 0),
    processed,
    occupancy: {
      ctxFinal, ctxBase, windowTokens: WINDOW_TOKENS,
      charsPerToken, calibrated, compactions, dispersion, evicted: Math.round(evicted),
      residual: Object.fromEntries(FAMILIES.map((f) => [f, Math.round(residual[f])])),
      contributed: Object.fromEntries(FAMILIES.map((f) => [f, Math.round(contributed[f])])),
      chars: resultChars, results: resultCount,
      residualFileAccess: Math.round(FILE_ACCESS.reduce((s, f) => s + residual[f], 0)),
      contributedFileAccess: Math.round(FILE_ACCESS.reduce((s, f) => s + contributed[f], 0)),
      charsFileAccess: FILE_ACCESS.reduce((s, f) => s + resultChars[f], 0),
    },
  };
}

/** The occupancy block, as printed under a run and reused by the aggregator. */
export function formatOccupancy(s, indent = '  ') {
  const o = s.occupancy;
  const n = (x) => x.toLocaleString('en-US');
  const pctCtx = (t) => (o.ctxFinal > 0 ? ((t / o.ctxFinal) * 100).toFixed(1) : '0.0');
  const pctWin = (t) => ((t / o.windowTokens) * 100).toFixed(1);
  const rows = [];
  const row = (label, tok, chars, results) => rows.push(
    `${indent}  ${label.padEnd(18)}${(n(tok) + ' tok').padStart(12)}  ${(pctCtx(tok) + '%').padStart(6)} of ctx  ` +
    `${(pctWin(tok) + '%').padStart(6)} of ${Math.round(o.windowTokens / 1000)}k win` +
    (chars !== undefined ? `   (${n(chars)} chars, ${results} result${results === 1 ? '' : 's'})` : '')
  );
  const out = [`${indent}Residual context occupancy at end of run:`];
  out.push(`${indent}  ${'final context'.padEnd(18)}${(n(o.ctxFinal) + ' tok').padStart(12)}  ${(pctWin(o.ctxFinal) + '%').padStart(6)} of ${Math.round(o.windowTokens / 1000)}k window`);
  row('codegraph', o.residual.codegraph, o.chars.codegraph, o.results.codegraph);
  row('Read', o.residual.read, o.chars.read, o.results.read);
  row('Grep/Glob', o.residual.search, o.chars.search, o.results.search);
  row('Bash', o.residual.bash, o.chars.bash, o.results.bash);
  row('→ file-access', o.residualFileAccess, o.charsFileAccess,
    o.results.read + o.results.search + o.results.bash);
  row('other tools', o.residual.other, o.chars.other, o.results.other);
  const toolTotal = Object.values(o.residual).reduce((a, b) => a + b, 0);
  row('base (prompt+prose)', Math.max(0, o.ctxFinal - toolTotal));
  out.push(`${indent}  ${'  of which fixed'.padEnd(18)}${(n(o.ctxBase) + ' tok').padStart(12)}  system + tool schemas + question, before any tool answered`);
  out.push(...rows);
  const dropped = o.contributed.codegraph + o.contributedFileAccess + o.contributed.other
    - (o.residual.codegraph + o.residualFileAccess + o.residual.other);
  out.push(
    `${indent}  measure: ${o.charsPerToken.toFixed(2)} chars/tok ${o.calibrated ? 'measured' : '(FALLBACK — no clean gap to calibrate on)'}` +
    (o.dispersion !== null ? ` ±${(o.dispersion * 100).toFixed(1)}%` : '') +
    ` · turns ${s.turns} · compactions ${o.compactions}` +
    (o.evicted > 0 || dropped > 1 ? ` · evicted ${n(o.evicted)} tok` : '')
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// `--selftest`: the occupancy math over synthetic transcripts with known
// answers. It lives here rather than in a test file on purpose — a new
// scripts/agent-eval/*.mjs scores into the self-query eval fixture's corpus.
function selftest() {
  const { writeFileSync, mkdtempSync } = require0('fs');
  const { join } = require0('path');
  const { tmpdir } = require0('os');
  const dir = mkdtempSync(join(tmpdir(), 'cg-occ-'));
  let n = 0, failures = 0;
  const check = (name, got, want, tol) => {
    n++;
    const ok = Math.abs(got - want) <= tol;
    if (!ok) failures++;
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}: got ${Math.round(got)}, want ${want} ±${tol}`);
  };
  // Builders for the event shapes Claude Code actually emits.
  const req = (ctx, id, blocks) => blocks.map((b) => JSON.stringify({
    type: 'assistant',
    message: { id, content: [b], usage: { input_tokens: ctx, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 } },
  }));
  const use = (id, name) => ({ type: 'tool_use', id, name, input: {} });
  const res = (id, chars) => JSON.stringify({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'x'.repeat(chars) }] }] },
  });
  const done = () => JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1000, total_cost_usd: 0.1, usage: {} });
  const write = (name, lines) => { const f = join(dir, name); writeFileSync(f, lines.join('\n') + '\n'); return f; };

  // 1. Attribution: ratio 2.5 chars/tok, two families, no shedding.
  //    10,000 explore chars over a 4,000-tok gap; 5,000 Read chars over 2,000.
  let f = write('basic.jsonl', [
    ...req(10000, 'm1', [use('t1', 'mcp__codegraph__codegraph_explore')]),
    res('t1', 10000),
    ...req(14000, 'm2', [use('t2', 'Read')]),
    res('t2', 5000),
    ...req(16000, 'm3', [{ type: 'text', text: 'done' }]),
    done(),
  ]);
  let o = parseSession([f]).occupancy;
  check('chars/token', o.charsPerToken * 1000, 2500, 30);
  check('codegraph residual', o.residual.codegraph, 4000, 60);
  check('Read residual', o.residual.read, 2000, 40);
  check('file-access residual', o.residualFileAccess, 2000, 40);
  check('final context', o.ctxFinal, 16000, 0);
  check('fixed base', o.ctxBase, 10000, 0);
  check('nothing evicted', o.evicted, 0, 1);

  // 2. Dedupe: thinking + tool_use are two events sharing one id and one usage.
  //    Counting usage per event would report 5 requests instead of 3.
  f = write('dupe.jsonl', [
    ...req(10000, 'm1', [{ type: 'thinking', thinking: '' }, use('t1', 'mcp__codegraph__codegraph_explore')]),
    res('t1', 10000),
    ...req(14000, 'm2', [{ type: 'thinking', thinking: '' }, use('t2', 'Read')]),
    res('t2', 5000),
    ...req(16000, 'm3', [{ type: 'text', text: 'done' }]),
    done(),
  ]);
  let s = parseSession([f]);
  check('turns deduped by message.id', s.turns, 3, 0);
  check('codegraph residual (deduped)', s.occupancy.residual.codegraph, 4000, 60);

  // 3. Compaction: the boundary clears everything resident before it.
  f = write('compact.jsonl', [
    ...req(10000, 'm1', [use('t1', 'mcp__codegraph__codegraph_explore')]),
    res('t1', 10000),
    ...req(14000, 'm2', [use('t2', 'mcp__codegraph__codegraph_explore')]),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
    res('t2', 5000),
    ...req(8000, 'm3', [{ type: 'text', text: 'done' }]),
    done(),
  ]);
  o = parseSession([f]).occupancy;
  check('post-compaction residual = last result only', o.residual.codegraph, 2000, 40);
  check('contributed still counts both', o.contributed.codegraph, 6000, 80);

  // 4. Micro-compaction: context grows less than the results added, so the
  //    oldest result is shed first (FIFO) — here explore, leaving Read.
  f = write('micro.jsonl', [
    ...req(10000, 'm1', [use('t1', 'mcp__codegraph__codegraph_explore')]),
    res('t1', 10000),
    ...req(14000, 'm2', [use('t2', 'Read')]),
    res('t2', 10000),
    ...req(14500, 'm3', [{ type: 'text', text: 'done' }]),  // +500 for 4,000 tok of Read
    done(),
  ]);
  o = parseSession([f]).occupancy;
  check('FIFO evicted the older codegraph result', o.residual.codegraph, 500, 60);
  check('newer Read result survives', o.residual.read, 4000, 60);
  check('eviction recorded', o.evicted, 3500, 60);

  // 5. Multi-turn stitching: a resumed segment continues the same context, and
  //    a turn that calls no tool leaves the earlier residual in place.
  const a = write('seg1.jsonl', [
    ...req(10000, 'm1', [use('t1', 'mcp__codegraph__codegraph_explore')]),
    res('t1', 10000),
    ...req(14000, 'm2', [{ type: 'text', text: 'answer one' }]),
    done(),
  ]);
  const b = write('seg2.jsonl', [
    ...req(14600, 'm3', [{ type: 'text', text: 'answer two, from what is already here' }]),
    done(),
  ]);
  s = parseSession([a, b]);
  check('stitched turns', s.turns, 3, 0);
  check('residual carries into turn 2', s.occupancy.residual.codegraph, 4000, 60);
  check('stitched final context', s.occupancy.ctxFinal, 14600, 0);
  check('stitched cost sums segments', s.cost * 100, 20, 0.1);

  console.log(`\n${n - failures}/${n} checks passed`);
  return failures;
}
// `--selftest` needs sync fs helpers the module path doesn't import at top level.
function require0(m) { return process.getBuiltinModule(m); }

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv.includes('--selftest')) process.exit(selftest() ? 1 : 0);
if (isMain) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!files.length) { console.error('usage: parse-run.mjs <run.jsonl> [run.t2.jsonl ...]  |  --selftest'); process.exit(1); }
  const s = parseSession(files);

  console.log(`\n=== ${files.map((f) => f.split('/').pop()).join(' + ')} ===`);
  console.log(`codegraph tools exposed: ${s.initTools ? s.initTools.length : '?'}${s.raced ? '  [MCP COLD-START RACE — tool call hit "No such tool available"]' : ''}`);
  if (s.cliCalls) console.log(`!! ${s.cliCalls} Bash call${s.cliCalls === 1 ? '' : 's'} invoked the codegraph CLI — if this is a without-arm, the run is CONTAMINATED`);
  console.log(`\nTool calls (${s.toolCalls.length}):`);
  console.log('  by type:', JSON.stringify(s.counts));
  s.toolCalls.forEach((tc, i) => console.log(`  ${i + 1}. ${tc}`));

  if (s.result) {
    const seg = s.results.length > 1 ? ` | ${s.results.length} segments (${s.results.map((r) => r.subtype).join(',')})` : '';
    console.log(`\nResult: ${s.result.subtype} | duration ${s.dur.toFixed(0)}s | turns ${s.turns}${seg}`);
    console.log(`  tokens processed: ${s.processed.toLocaleString('en-US')} | cost $${s.cost.toFixed(3)}`);
  }
  console.log('');
  console.log(formatOccupancy(s));
}
