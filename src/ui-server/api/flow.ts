/**
 * `GET /api/flow` — the call path between two symbols, as cards.
 *
 * The Flow strip answers "how does A reach B" (design spec §3.5): one card per
 * hop, each opened at the exact line that makes the next call, with the
 * synthesized dynamic-dispatch hops drawn dashed and carrying the site they
 * were wired at. This endpoint produces that path and the source windows for
 * it; the geometry is a pure function in the viewer (`ui/src/lib/flow-model.ts`).
 *
 * **The path finder is not ours.** It is `resolveNamedSymbolFlow` in
 * `src/graph/named-symbol-flow.ts` — literally the search `codegraph_explore`
 * leads its answer with, extracted so both callers ride one implementation.
 * A viewer that drew a different path from the one the MCP tool describes would
 * be worse than no viewer: the two would be quoted against each other in a code
 * review and one of them would be wrong.
 *
 * Three questions arrive here, and they are one question with different
 * bindings:
 *
 * - `?from=&to=` — a directed question, from the search box's flow grammar.
 *   Both ends pinned, shortest path wins.
 * - `?symbols=a,b,c` — explore's own question, verbatim. Longest chain among
 *   the named symbols wins, at most one unnamed bridge.
 * - `?hop=s<id>&hop=d<id>…` — the trail, read as a flow. Nothing is searched:
 *   the hops are the ones the reader walked, and the work is finding the edge
 *   that already connects each consecutive pair.
 *
 * **Nothing here is cached.** Every other multi-symbol endpoint memoises on the
 * index version, and this one deliberately does not: a flow card carries source
 * read from disk, and the drift verdict on it changes without the index
 * changing. A cached "no drift" is exactly the failure `/api/source` exists to
 * prevent. The search itself costs tens of milliseconds; the windows are seven
 * lines each.
 */

import type CodeGraph from '../../index';
import type { Edge, Node } from '../../types';
import {
  resolveNamedSymbolFlow,
  normalizeToken,
  DIRECTED_MAX_HOPS,
} from '../../graph/named-symbol-flow';
import { highlightLines, type HighlightResult } from '../highlight';
import { badRequest, intParam } from './respond';
import { findIndexedFile, hasDriftedOnDisk, splitLines, toRequestPath } from './source';
import { resolveProjectFile } from '../security';
import { toNodeRef, toWireEdge, UNCERTAIN_BELOW, type WireEdge, type WireNodeRef } from './wire';
import * as fs from 'fs';

/** Lines shown either side of the call site on a card (design spec §3.5). */
export const SOURCE_WINDOW = 3;

/**
 * How far above a window the highlighter is allowed to start reading.
 *
 * Seven lines tokenised on their own do not know they are inside a block
 * comment or a template literal, and a window that opens under a JSDoc would
 * render the prose as code. Leading in from the enclosing symbol's first line
 * fixes that for every ordinary body; the cap stops a thousand-line god
 * function from costing a full-file tokenisation for one card. Past it a window
 * can still open mid-construct — rare, and cheaper than the alternative.
 */
const HIGHLIGHT_LEAD_MAX = 200;

/** Distinct paths returned. The header's flow picker is a short list or nothing. */
export const MAX_FLOWS = 4;

/** Hops accepted from a trail. The trail bar itself is not much longer than this. */
const MAX_TRAIL_HOPS = 24;

// =============================================================================
// Wire shapes
// =============================================================================

export interface WireFlowEdge extends WireEdge {
  /** The link's label: "calls", "via callback · registered at file:line". */
  label: string;
  /** This hop reads callee → caller — the reader stepped UP into it. */
  upward: boolean;
  /** `metadata.confidence` below {@link UNCERTAIN_BELOW}: dashed `2 3`. */
  uncertain: boolean;
  /** A synthesized dynamic-dispatch bridge: dashed `5 3`. */
  synthesized: boolean;
}

export interface WireFlowSource {
  file: string;
  language: string;
  from: number;
  to: number;
  /** Absent when `drift` — a mis-sliced window is worse than an empty card. */
  lines?: string[];
  highlight?: HighlightResult;
  drift: boolean;
  /** Why there are no lines, when there are none. */
  reason?: string;
}

/**
 * The call site this card is opened at — the identifier the strip draws as a
 * link, and the line the source window is centred on.
 *
 * It is not always a call to the NEXT card. Reading a trail backwards steps
 * from a callee up to its caller, and the line that connects them then lives in
 * the caller's body and names the symbol on the PREVIOUS card. Either way the
 * rule is the same: a card opens at the line that ties it to its neighbour.
 */
export interface WireFlowCallRef {
  line: number;
  /** 0-based column the edge recorded, or null when it carries none. */
  col: number | null;
  /** The identifier as the graph names it — what the token must match. */
  name: string;
  /** The symbol at the other end of the edge. */
  targetId: string;
  /** The link points back at the previous card, not on to the next one. */
  backwards: boolean;
}

export interface WireFlowHop {
  node: WireNodeRef;
  /** The edge from the PREVIOUS hop into this one; null on the first. */
  edge: WireFlowEdge | null;
  /** Where this card is opened, and what it links to. Null when it is neither. */
  callRef: WireFlowCallRef | null;
  /** The window this card shows, centred on `callRef` or the definition. */
  source: WireFlowSource | null;
}

export interface WireFlow {
  /** Stable within a payload: the hop ids joined. Used as the picker's value. */
  id: string;
  /** "execute → rowToFileRecord", for the header's flow picker. */
  label: string;
  hops: WireFlowHop[];
}

/** An endpoint that named more than one definition, and which one was taken. */
export interface WireFlowAmbiguity {
  token: string;
  chosen: WireNodeRef | null;
  others: WireNodeRef[];
}

export interface WireFlowPayload {
  query: {
    kind: 'directed' | 'symbols' | 'trail';
    from: string | null;
    to: string | null;
    /** The tokens the search actually used. */
    symbols: string[];
  };
  flows: WireFlow[];
  ambiguous: WireFlowAmbiguity[];
  /** Tokens that named nothing in this index. */
  unresolved: string[];
  /** Why there is no flow, when there is none. Null when there is one. */
  reason: string | null;
  index: { lastIndexedAt: number | null; edges: number; files: number };
  timing: { elapsedMs: number };
}

// =============================================================================
// Query
// =============================================================================

export type FlowQuery =
  | { kind: 'directed'; from: string; to: string }
  | { kind: 'symbols'; text: string }
  | { kind: 'trail'; hops: Array<{ id: string; dir: 'start' | 'down' | 'up' }> };

const DIR_CHARS: Record<string, 'start' | 'down' | 'up'> = { s: 'start', d: 'down', u: 'up' };

/**
 * Read the question out of the query string.
 *
 * A trail hop arrives as its own `hop` parameter rather than in one joined
 * list, for the same reason `/api/nodes` repeats `id`: a node id can be a file
 * path and a file path can contain a comma. The one-character direction prefix
 * mirrors `ui/src/lib/trail-codec.ts`, which owns the format.
 */
export function parseFlowQuery(query: URLSearchParams): FlowQuery {
  const rawHops = query.getAll('hop').filter((h) => h.length > 1);
  if (rawHops.length > 0) {
    if (rawHops.length > MAX_TRAIL_HOPS) {
      throw badRequest(
        `A trail of ${rawHops.length} hops is longer than this endpoint reads (${MAX_TRAIL_HOPS}).`
      );
    }
    const hops = rawHops.map((raw) => ({
      id: raw.slice(1),
      dir: DIR_CHARS[raw[0] as string] ?? ('down' as const),
    }));
    if (hops.length < 2) {
      throw badRequest('A trail needs at least two hops to be read as a flow.');
    }
    return { kind: 'trail', hops };
  }

  const from = (query.get('from') ?? '').trim();
  const to = (query.get('to') ?? '').trim();
  if (from && to) {
    if (normalizeToken(from) === normalizeToken(to)) {
      throw badRequest('"from" and "to" name the same symbol, so there is no path to draw.');
    }
    return { kind: 'directed', from, to };
  }

  const symbols = (query.get('symbols') ?? '').trim();
  if (symbols) return { kind: 'symbols', text: symbols };

  throw badRequest(
    'No flow was asked for.',
    'Use /api/flow?from=<symbol>&to=<symbol>, ?symbols=a,b,c, or ?hop=s<id>&hop=d<id>.'
  );
}

// =============================================================================
// Edges
// =============================================================================

/**
 * The sentence under a link.
 *
 * A synthesized hop must never read as a plain `calls`: it is a bridge the
 * resolver inferred, and the wiring site is the evidence for it. Design spec
 * §3.5 fixes the phrasing — "via callback · registered at file:line".
 */
export function flowEdgeLabel(edge: Edge, upward: boolean): string {
  const meta = (edge.metadata ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (edge.provenance === 'heuristic' && typeof meta.synthesizedBy === 'string') {
    const mechanism = meta.synthesizedBy.replace(/-/g, ' ');
    parts.push(`via ${mechanism}`);
    if (typeof meta.via === 'string' && meta.via) parts.push(meta.via);
    if (typeof meta.registeredAt === 'string' && meta.registeredAt) {
      parts.push(`registered at ${meta.registeredAt}`);
    }
  } else {
    parts.push(upward ? 'called by' : edge.kind);
  }
  return parts.join(' · ');
}

function toFlowEdge(edge: Edge, upward: boolean): WireFlowEdge {
  const meta = (edge.metadata ?? {}) as Record<string, unknown>;
  const confidence = typeof meta.confidence === 'number' ? meta.confidence : null;
  return {
    ...toWireEdge(edge),
    label: flowEdgeLabel(edge, upward),
    upward,
    uncertain: confidence !== null && confidence < UNCERTAIN_BELOW,
    synthesized: edge.provenance === 'heuristic',
  };
}

// =============================================================================
// Source windows
// =============================================================================

/** One read + one hash per file, however many cards land in it. */
interface FileCache {
  lines: string[] | null;
  language: string;
  drift: boolean;
  reason?: string;
}

function loadFile(
  cg: CodeGraph,
  projectRoot: string,
  cache: Map<string, FileCache>,
  filePath: string
): FileCache | null {
  const posix = toRequestPath(filePath);
  const hit = cache.get(posix);
  if (hit) return hit;

  const found = findIndexedFile(cg, posix);
  if (!found) return null;

  let entry: FileCache;
  if (hasDriftedOnDisk(projectRoot, found.storedPath, found.record)) {
    entry = {
      lines: null,
      language: found.record.language,
      drift: true,
      reason:
        'This file changed on disk after the last index sync, so the recorded call ' +
        'line no longer reliably points at this call. The window returns after the next sync.',
    };
  } else {
    try {
      // The chokepoint, before anything is opened — see `source.ts`.
      const absolute = resolveProjectFile(projectRoot, found.storedPath);
      entry = {
        lines: splitLines(fs.readFileSync(absolute, 'utf-8')),
        language: found.record.language,
        drift: false,
      };
    } catch {
      entry = {
        lines: null,
        language: found.record.language,
        drift: false,
        reason: 'This file is in the index but could not be read.',
      };
    }
  }
  cache.set(posix, entry);
  return entry;
}

/**
 * The ±{@link SOURCE_WINDOW} lines a card shows.
 *
 * Anchored on the line that makes the next call. The last card has no next
 * call, so it anchors on the definition instead — a reader who followed seven
 * hops to get there wants to see what they arrived at.
 */
async function windowFor(
  cg: CodeGraph,
  projectRoot: string,
  cache: Map<string, FileCache>,
  node: Node,
  anchor: number
): Promise<WireFlowSource | null> {
  const file = loadFile(cg, projectRoot, cache, node.filePath);
  if (!file) return null;
  const posix = toRequestPath(node.filePath);
  if (file.lines === null) {
    return {
      file: posix,
      language: file.language,
      from: anchor,
      to: anchor,
      drift: file.drift,
      ...(file.reason ? { reason: file.reason } : {}),
    };
  }

  const total = file.lines.length;
  const from = Math.max(1, Math.min(anchor - SOURCE_WINDOW, total));
  const to = Math.max(from, Math.min(anchor + SOURCE_WINDOW, total));
  // Tokenise with the lead-in, then keep only the window — see HIGHLIGHT_LEAD_MAX.
  const leadFrom = Math.max(1, Math.min(from, Math.max(node.startLine, from - HIGHLIGHT_LEAD_MAX)));
  const highlighted = await highlightLines(file.lines.slice(leadFrom - 1, to), {
    language: file.language,
    cacheKey: `${posix}:${leadFrom}:${to}`,
  });
  return {
    file: posix,
    language: file.language,
    from,
    to,
    lines: file.lines.slice(from - 1, to),
    highlight: {
      ...highlighted,
      lines: highlighted.lines.slice(from - leadFrom),
    },
    drift: false,
  };
}

// =============================================================================
// Building the flows
// =============================================================================

/** The steps of one chain, plus the edge that brought the reader into each. */
interface RawHop {
  node: Node;
  edge: Edge | null;
  upward: boolean;
}

async function toWireFlow(
  cg: CodeGraph,
  projectRoot: string,
  cache: Map<string, FileCache>,
  raw: readonly RawHop[]
): Promise<WireFlow> {
  const hops: WireFlowHop[] = [];
  for (let i = 0; i < raw.length; i++) {
    const step = raw[i] as RawHop;
    const previous = raw[i - 1];
    const next = raw[i + 1];
    // Forward: the edge into the NEXT hop was recorded at the line inside THIS
    // body that makes the call. Backwards (a trail read from a callee up to its
    // caller): this card IS the caller, and its own incoming edge carries the
    // line where it calls the card before it.
    let callRef: WireFlowCallRef | null = null;
    if (next !== undefined && !next.upward && next.edge?.line) {
      callRef = {
        line: next.edge.line,
        col: typeof next.edge.column === 'number' ? next.edge.column : null,
        name: next.node.name,
        targetId: next.node.id,
        backwards: false,
      };
    } else if (step.upward && previous !== undefined && step.edge?.line) {
      callRef = {
        line: step.edge.line,
        col: typeof step.edge.column === 'number' ? step.edge.column : null,
        name: previous.node.name,
        targetId: previous.node.id,
        backwards: true,
      };
    }
    hops.push({
      node: toNodeRef(step.node),
      edge: step.edge === null ? null : toFlowEdge(step.edge, step.upward),
      callRef,
      source: await windowFor(
        cg,
        projectRoot,
        cache,
        step.node,
        callRef?.line ?? step.node.startLine
      ),
    });
  }
  const first = raw[0]?.node.name ?? '?';
  const last = raw[raw.length - 1]?.node.name ?? '?';
  return {
    id: raw.map((h) => h.node.id).join('>'),
    label: `${first} → ${last}`,
    hops,
  };
}

/**
 * The edge that already connects two symbols the reader walked between.
 *
 * A trail is not searched — the hops are given — so all that is missing is
 * which recorded edge the reader crossed. A `down` hop is a call out of the
 * previous symbol; an `up` hop is the same edge read backwards, which is why
 * `upward` exists and why the link says "called by" rather than "calls".
 */
function edgeBetween(
  cg: CodeGraph,
  from: Node,
  to: Node
): { edge: Edge; upward: boolean } | null {
  let best: Edge | null = null;
  for (const { node, edge } of cg.getCallees(from.id)) {
    if (node.id !== to.id) continue;
    if (best === null || (edge.kind === 'calls' && best.kind !== 'calls')) best = edge;
  }
  if (best) return { edge: best, upward: false };
  for (const { node, edge } of cg.getCallers(from.id)) {
    if (node.id !== to.id) continue;
    if (best === null || (edge.kind === 'calls' && best.kind !== 'calls')) best = edge;
  }
  return best ? { edge: best, upward: true } : null;
}

function ambiguitiesOf(
  tokenNodes: ReadonlyMap<string, string[]>,
  named: ReadonlyMap<string, Node>,
  chosen: ReadonlySet<string>,
  tokens: readonly string[]
): WireFlowAmbiguity[] {
  const out: WireFlowAmbiguity[] = [];
  for (const token of tokens) {
    const ids = tokenNodes.get(token) ?? [];
    if (ids.length < 2) continue;
    const picked = ids.find((id) => chosen.has(id)) ?? null;
    out.push({
      token,
      chosen: picked ? toNodeRef(named.get(picked) as Node) : null,
      others: ids
        .filter((id) => id !== picked)
        .map((id) => named.get(id))
        .filter((n): n is Node => !!n)
        .map(toNodeRef),
    });
  }
  return out;
}

export async function buildFlow(
  cg: CodeGraph,
  projectRoot: string,
  query: URLSearchParams
): Promise<WireFlowPayload> {
  const started = Date.now();
  const parsed = parseFlowQuery(query);
  const maxFlows = intParam(query, 'limit', { min: 1, max: MAX_FLOWS, default: MAX_FLOWS });
  const stats = cg.getStats();
  const cache = new Map<string, FileCache>();

  const base = {
    flows: [] as WireFlow[],
    ambiguous: [] as WireFlowAmbiguity[],
    unresolved: [] as string[],
    reason: null as string | null,
    index: {
      lastIndexedAt: cg.getLastIndexedAt() ?? null,
      edges: stats.edgeCount,
      files: stats.fileCount,
    },
  };

  if (parsed.kind === 'trail') {
    const byId = cg.getNodesByIds(parsed.hops.map((h) => h.id));
    const raw: RawHop[] = [];
    const missing: string[] = [];
    for (const hop of parsed.hops) {
      const node = byId.get(hop.id);
      if (!node) {
        missing.push(hop.id);
        continue;
      }
      const previous = raw[raw.length - 1];
      const link = previous ? edgeBetween(cg, previous.node, node) : null;
      raw.push({ node, edge: link?.edge ?? null, upward: link?.upward ?? hop.dir === 'up' });
    }
    const flows = raw.length >= 2 ? [await toWireFlow(cg, projectRoot, cache, raw)] : [];
    return {
      ...base,
      query: { kind: 'trail', from: null, to: null, symbols: [] },
      flows,
      unresolved: missing,
      reason:
        flows.length > 0
          ? null
          : 'None of the symbols on this trail are still in the index. Re-index, or start a new trail.',
      timing: { elapsedMs: Date.now() - started },
    };
  }

  const directed = parsed.kind === 'directed';
  const text = directed ? `${parsed.from} ${parsed.to}` : parsed.text;
  const flow = resolveNamedSymbolFlow(
    cg,
    text,
    directed
      ? { mode: 'directed', from: parsed.from, to: parsed.to, maxChains: maxFlows }
      : { mode: 'named', maxChains: maxFlows }
  );

  const unresolved = flow.tokens.filter((t) => (flow.tokenNodes.get(t) ?? []).length === 0);
  const chosen = new Set(flow.chains.flatMap((c) => c.steps.map((s) => s.node.id)));
  const flows: WireFlow[] = [];
  for (const chain of flow.chains) {
    flows.push(
      await toWireFlow(
        cg,
        projectRoot,
        cache,
        chain.steps.map((s) => ({ node: s.node, edge: s.edge, upward: false }))
      )
    );
  }

  return {
    ...base,
    query: {
      kind: parsed.kind,
      from: directed ? parsed.from : null,
      to: directed ? parsed.to : null,
      symbols: flow.tokens,
    },
    flows,
    ambiguous: ambiguitiesOf(flow.tokenNodes, flow.named, chosen, flow.tokens),
    unresolved,
    reason: flows.length > 0 ? null : noFlowReason(parsed, flow.tokens.length, unresolved),
    timing: { elapsedMs: Date.now() - started },
  };
}

/**
 * Why there is no strip, in the words that say what to do next.
 *
 * "Not connected" is a real answer about this index, not a failure — a flow
 * that runs through a dynamic dispatch the resolver could not bridge genuinely
 * has no static path, and saying so is the honest end of the search. CG-51
 * turns this sentence into the boundary end cap that names the dispatch site.
 */
function noFlowReason(
  parsed: FlowQuery,
  tokenCount: number,
  unresolved: readonly string[]
): string {
  if (unresolved.length > 0) {
    return `${unresolved.join(' and ')} ${unresolved.length > 1 ? 'name' : 'names'} nothing in this index.`;
  }
  if (parsed.kind === 'directed') {
    return (
      `No chain of calls reaches ${parsed.to} from ${parsed.from} within ${DIRECTED_MAX_HOPS} hops. ` +
      'The path may run through a dynamic dispatch — a callback, a registry, a reflective ' +
      'call — that no static edge records.'
    );
  }
  if (tokenCount < 2) {
    return 'Name at least two symbols: a flow is a path between them.';
  }
  return 'Those symbols do not call one another, directly or through one intermediate.';
}
