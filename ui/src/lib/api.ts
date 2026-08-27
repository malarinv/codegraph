/**
 * The viewer's side of the read-only JSON API (`src/ui-server/api/`, CG-42).
 *
 * The types below mirror the server's wire shapes rather than re-deriving
 * them: the API is versioned with the binary that serves it, so a field the
 * server stopped sending should break the type-check here, not surface as
 * `undefined` in a rail three screens later.
 *
 * One rule for every call: the API answers JSON for *every* outcome, including
 * refusals. So a non-2xx still has a body worth reading, and `ApiFailure`
 * carries the server's own sentence instead of "Failed to fetch".
 */

import type { WireHighlight } from './highlight';

/* ---------------------------------------------------------------- shapes -- */

export type NodeKind = string;
export type EdgeKind = string;

export interface WireNodeRef {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  /** Project-relative, forward slashes on every platform. */
  file: string;
  line: number;
  endLine: number;
  language: string;
  signature?: string;
  exported?: boolean;
  /** Lives in a file that looks like test or fixture code. */
  test: boolean;
}

export interface WireNodeDetail extends WireNodeRef {
  startColumn: number;
  endColumn: number;
  docstring?: string;
  visibility?: string;
  async?: boolean;
  static?: boolean;
  abstract?: boolean;
  decorators?: string[];
  typeParameters?: string[];
  returnType?: string;
  lines: number;
}

export interface WireMember extends WireNodeRef {
  parentId: string;
  /** 1 = a direct member; 2 = a member of a member (a method inside a file's class). */
  depth: number;
  fanIn: number;
  fanOut: number;
}

export interface WireEdge {
  kind: EdgeKind;
  line?: number;
  col?: number;
  confidence?: number;
  resolvedBy?: string;
  provenance?: string;
  synthesizedBy?: string;
  via?: string;
  registeredAt?: string;
  valueRef?: boolean;
}

/** Every edge between the focal symbol and ONE other symbol, as a single row. */
export interface WireRelation {
  node: WireNodeRef;
  edgeKinds: EdgeKind[];
  edges: WireEdge[];
  edgeCount: number;
  /** Distinct call-site lines, ascending — what the gutter ports anchor to. */
  lines: number[];
  confidence: number | null;
  uncertain: boolean;
  synthesized: boolean;
  fanIn?: number;
  hub?: boolean;
}

export interface WireList<T> {
  total: number;
  shown: number;
  truncated: boolean;
  items: T[];
}

export interface WireTestSummary {
  reached: boolean;
  hops: number | null;
  fileCount: number;
  files: string[];
  /** False weakens the claim to "no test calls this directly" — see the server. */
  exhaustive: boolean;
  hopsSearched: number;
}

export interface WireOutsideIndex {
  total: number;
  byKind: Record<string, number>;
  samples: Array<{ name: string; kind: string; line?: number; col?: number }>;
}

export interface WireBlastSummary {
  direct: number;
  withinHops: number;
  hops: number;
  files: number;
  testFiles: number;
  routes: number;
  topFiles: Array<{ file: string; symbols: number; test: boolean }>;
}

export interface WireSymbolPayload {
  node: WireNodeDetail;
  /** Outermost first: file, then module/class, then the symbol's own parent. */
  ancestors: WireNodeRef[];
  members: WireList<WireMember>;
  incoming: WireList<WireRelation>;
  outgoing: WireList<WireRelation>;
  typesUsed: WireRelation[];
  counts: {
    callers: number;
    callees: number;
    typesUsed: number;
    fanIn: number;
    fanOut: number;
    members: number;
    hub: boolean;
  };
  tests: WireTestSummary;
  outsideIndex: WireOutsideIndex;
  blast: WireBlastSummary | null;
  /** The file changed on disk since the index — line ranges may be shifted. */
  drift: boolean;
}

export interface WireSource {
  file: string;
  language: string;
  drift: boolean;
  /**
   * Which numbering `lines` belong to. `'indexed'` — the file matches the
   * index. `'current'` — it drifted and we asked for the bytes anyway
   * (`ondrift: 'current'`), so nothing the graph holds about this file lines up
   * with them. `'none'` — it drifted and no slice came back.
   */
  showing: 'indexed' | 'current' | 'none';
  contentHash: string;
  indexedAt: number;
  generated: boolean;
  totalLines: number | null;
  from?: number;
  to?: number;
  /** Absent when the file drifted and `ondrift` was left at its default. */
  lines?: string[];
  truncated?: boolean;
  reason?: string;
  /**
   * The same lines, classified by the server's TextMate grammars — one entry
   * per line, each a list of `[classId, text]` pairs indexed into `classes`.
   * Absent whenever `lines` is, and `engine: 'plain'` whenever no grammar
   * covers the file. See `lib/highlight.ts`.
   */
  highlight?: WireHighlight;
}

/* ------------------------------------------------------------- file view -- */

/** A row in the file outline — a symbol, its nesting and its edge counts. */
export interface WireOutlineEntry extends WireNodeRef {
  /** Containing symbol within this file, or null for a top-level one. */
  parentId: string | null;
  /** Nesting depth from the top level of the file, starting at 0. */
  depth: number;
  fanIn: number;
  fanOut: number;
}

/** One file at the far end of an import rail, with the symbols the edges name. */
export interface WireImportRow {
  file: string;
  test: boolean;
  symbols: Array<{ id: string; name: string; kind: string; line: number }>;
  symbolCount: number;
}

export interface WireFilePayload {
  file: {
    path: string;
    language: string;
    size: number;
    modifiedAt: number;
    indexedAt: number;
    contentHash: string;
    nodeCount: number;
    generated: boolean;
    test: boolean;
    errors: string[];
    /** The file node's own id, so the viewer can open the file AS a symbol. */
    id: string | null;
  };
  /** Calls made outside every definition — module-level code. */
  topLevel: { calls: number };
  /** The file changed on disk since it was indexed; the outline's lines shifted. */
  drift: boolean;
  outline: WireList<WireOutlineEntry>;
  /** `imports` edges only — a subset of `dependencies`, with symbol names. */
  imports: WireList<WireImportRow>;
  importedBy: WireList<WireImportRow>;
  /** Import statements that resolved to nothing indexed: packages, builtins. */
  unresolvedImports: Array<{ name: string; line: number }>;
  /** Every file this one reaches by any cross-file edge — `getFileDependencies`. */
  dependencies: string[];
  /** Every file that reaches into this one — `getFileDependents`. */
  dependents: string[];
}

/* ------------------------------------------------ whole-file source view -- */

/** A reference the resolver never landed: a gutter port with no destination. */
export interface WireFileOutsideRef {
  line: number;
  col: number;
  name: string;
  kind: string;
}

/** Every edge from ONE symbol in a file to ONE symbol anywhere. */
export interface WireFileCall {
  /** The symbol making the calls — the file node itself for top-level code. */
  ownerId: string;
  ownerLine: number;
  relation: WireRelation;
}

export interface WireFileCodePayload {
  file: {
    path: string;
    language: string;
    size: number;
    indexedAt: number;
    contentHash: string;
    generated: boolean;
    test: boolean;
    errors: string[];
    id: string | null;
    /** Lines on disk now — the height of the scrolling document. */
    totalLines: number | null;
  };
  drift: boolean;
  reason?: string;
  outline: WireList<WireOutlineEntry>;
  calls: WireList<WireFileCall>;
  outside: WireList<WireFileOutsideRef>;
  /** Calls landing on a definition in this same file — the arc diagram's total. */
  intraFileCalls: number;
  timing: { elapsedMs: number };
}

export interface WireBlastScale {
  maxDirect: number;
  maxWithinHops: number;
  hops: number;
  sampled: number;
  estimated: boolean;
}

/* ------------------------------------------------------- search palette -- */

/** How a result's text matched the query — the server's primary sort key. */
export type MatchKind = 'exact' | 'prefix' | 'substring' | 'qualified' | 'file' | 'related';

export interface WireSearchResult extends WireNodeRef {
  matchKind: MatchKind;
}

export interface WireSearchGroup {
  kind: NodeKind;
  count: number;
  items: WireSearchResult[];
}

export interface WireSearch {
  query: string;
  /** The free-text part, with any `kind:` / `lang:` / `path:` filters removed. */
  text: string;
  filters: { kinds: string[]; languages: string[]; paths: string[]; names: string[] };
  results: WireList<WireSearchResult>;
  /** Kind buckets in ranked order — flattening them reproduces the ranking. */
  groups: WireSearchGroup[];
}

export interface WireNodeRefs {
  items: WireNodeRef[];
  /** Ids that name nothing in this index — a stale link, not an error. */
  missing: string[];
}

/* ---------------------------------------------------------- entry points -- */

export interface WireEntryRoute {
  /** The route node's name, verbatim: "POST /v1/users/{id}". */
  url: string;
  /** The verb, when the name leads with one. Null for a file-routed page. */
  method: string | null;
  /** The URL without the verb — the same string as `url` when there is none. */
  path: string;
  handler: string;
  handlerKind: string;
  /** Where the request is SERVED. */
  file: string;
  line: number;
  handlerId: string | null;
  /** Where the URL is REGISTERED — the router file, which is how routes group. */
  routeFile: string;
  routeLine: number;
  routeId: string;
}

export interface WireEntryFile extends WireNodeRef {
  /** Calls and instantiations made at the top level of the file. */
  calls: number;
  /** Distinct other files this one's symbols reach. */
  reaches: number;
  /** Other files reaching into this one. Zero means nothing imports it. */
  dependents: number;
}

export interface WireEntryHub extends WireNodeRef {
  dependents: number;
}

export interface WireEntryTest extends WireNodeRef {
  /** Distinct other files this test reaches — what it exercises. */
  reaches: number;
  /** References behind that reach. */
  refs: number;
}

export interface WireEntryPoints {
  /** Frameworks the resolver detected — named in the Routes header. */
  frameworks: string[];
  routes: {
    routed: boolean;
    /** Every `route` node in the graph, resolved handler or not. */
    routeCount: number;
    items: WireList<WireEntryRoute>;
  };
  /** `total` is a floor on `files` and `hubs`; on `tests` it is exact. */
  files: WireList<WireEntryFile>;
  tests: WireList<WireEntryTest>;
  hubs: WireList<WireEntryHub>;
  index: { lastIndexedAt: number | null; files: number };
  timing: { elapsedMs: number; cached: boolean };
}

export interface WireStats {
  project: { root: string; name: string };
  index: {
    state: string | null;
    lastIndexedAt: number | null;
    stale: boolean;
    version: string | null;
    extractionVersion: number | null;
    backend: string;
    journalMode: string;
    pendingReferences: number;
    generatedFiles: number;
    watching: boolean;
    watcherDegraded: boolean;
  };
  graph: {
    nodes: number;
    edges: number;
    files: number;
    nodesByKind: Record<string, number>;
    edgesByKind: Record<string, number>;
    filesByLanguage: Record<string, number>;
    dbSizeBytes: number;
    walSizeBytes: number;
  };
  frameworks: string[];
  thresholds: { hub: number; uncertainBelow: number };
  blastScale: WireBlastScale;
}

/* ----------------------------------------------------------------- fetch -- */

/** An error the server described. `guidance` is its "what to do instead" line. */
export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly guidance: string | null;

  constructor(status: number, code: string, message: string, guidance: string | null) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.guidance = guidance;
  }
}

/** What `fail()` in `src/ui-server/api/respond.ts` sends. */
interface ApiErrorBody {
  error?: string;
  code?: string;
  hint?: string;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { signal, headers: { accept: 'application/json' } });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    // The one failure the server cannot describe, because it never heard the
    // request: `codegraph ui` was stopped while the tab stayed open.
    throw new ApiFailure(
      0,
      'unreachable',
      'The codegraph ui server is not answering.',
      'It may have been stopped — restart it with `codegraph ui` and reload this page.'
    );
  }

  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const failure = (body as ApiErrorBody | null) ?? {};
    throw new ApiFailure(
      response.status,
      failure.code ?? 'error',
      failure.error ?? `The server answered ${response.status}.`,
      failure.hint ?? null
    );
  }
  return body as T;
}

/* ------------------------------------------------------------- flow strip -- */

export interface WireFlowEdge extends WireEdge {
  /** The link's label: "calls", "via callback · registered at file:line". */
  label: string;
  /** This hop reads callee → caller — the reader stepped UP into it. */
  upward: boolean;
  /** Confidence below 0.6: the link is dashed `2 3`. */
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
  highlight?: WireHighlight;
  drift: boolean;
  reason?: string;
}

/** The call site a card is opened at — the identifier drawn as an accent link. */
export interface WireFlowCallRef {
  line: number;
  col: number | null;
  name: string;
  targetId: string;
  /** The link points back at the previous card, not on to the next one. */
  backwards: boolean;
}

export interface WireFlowHop {
  node: WireNodeRef;
  /** The edge from the PREVIOUS hop into this one; null on the first. */
  edge: WireFlowEdge | null;
  callRef: WireFlowCallRef | null;
  source: WireFlowSource | null;
}

/** One plausible runtime target of a keyed dispatch — a clickable cap row. */
export interface WireBoundaryCandidate {
  node: WireNodeRef;
  display: string;
  named: boolean;
}

/** A dynamic-dispatch site: the form, the key when it is visible, the targets. */
export interface WireBoundarySite {
  form: string;
  label: string;
  snippet: string;
  line: number;
  key: string | null;
  keyIsType: boolean;
  moreSites: number;
  candidates: WireBoundaryCandidate[];
  candidateNote: string | null;
}

export interface WireFlowContinuation {
  node: WireNodeRef;
  line: number | null;
  confidence: number | null;
}

/** Where the graph stops — the strip's end cap (design spec §3.5). */
export interface WireFlowBoundary {
  node: WireNodeRef;
  sites: WireBoundarySite[];
  uncertain: WireList<WireFlowContinuation>;
  further: WireList<WireFlowContinuation>;
  missed: WireNodeRef[];
}

export interface WireFlow {
  id: string;
  /** "execute → rowToFileRecord", for the header's flow picker. */
  label: string;
  hops: WireFlowHop[];
  /** Null on a flow that reaches everything it was asked about. */
  boundary: WireFlowBoundary | null;
  /** One card at the dispatch site, not a path: the answer ran out here. */
  partial: boolean;
}

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
    symbols: string[];
  };
  flows: WireFlow[];
  ambiguous: WireFlowAmbiguity[];
  /** Tokens that named nothing in this index. */
  unresolved: string[];
  /** Why there is no flow, when there is none. */
  reason: string | null;
  index: { lastIndexedAt: number | null; edges: number; files: number };
  timing: { elapsedMs: number };
}

/* -------------------------------------------------------------- the map -- */

export interface WireMapModule {
  /** Directory path, the `(root files)` bucket, or a façade file's own path. */
  id: string;
  label: string;
  files: number;
  symbols: number;
  languages: Array<{ language: string; files: number }>;
  /** More than half its files are tests. */
  test: boolean;
  /** A single file kept out of the root bucket because it is the façade. */
  facade: boolean;
  /** Its files, capped — the side panel's list when the module is selected. */
  fileList: { total: number; shown: number; truncated: boolean; items: string[] };
}

export interface WireMapLink {
  source: string;
  target: string;
  /** Every confident cross-module edge behind this link. */
  count: number;
  /**
   * The subset resolved through an import, a qualified name, an inheritance
   * clause or a typed receiver — what the layering trusts.
   */
  declared: number;
  byKind: Array<{ kind: EdgeKind; count: number }>;
  topPairs: Array<{ from: string; to: string; count: number; declared: number }>;
}

export interface WireMapCycle {
  size: number;
  files: string[];
  modules: string[];
}

export interface WireMapPayload {
  root: string;
  depth: number;
  roots: Array<{ root: string; label: string; files: number }>;
  modules: WireMapModule[];
  links: WireMapLink[];
  cycles: { total: number; shown: number; truncated: boolean; items: WireMapCycle[] };
  excluded: { uncertainEdges: number; confidenceBelow: number };
  index: { lastIndexedAt: number | null; edges: number; files: number };
  timing: { elapsedMs: number; cached: boolean };
}

export function fetchStats(signal?: AbortSignal): Promise<WireStats> {
  return getJson<WireStats>('api/stats', signal);
}

export function fetchSymbol(id: string, signal?: AbortSignal): Promise<WireSymbolPayload> {
  // Ids carry ':' and '/' (`method:<hash>`, `file:src/mcp/tools.ts`); encode
  // per segment so the path stays readable and still round-trips.
  const encoded = id.split('/').map(encodeURIComponent).join('/');
  return getJson<WireSymbolPayload>(`api/node/${encoded}`, signal);
}

export function fetchSearch(
  query: string,
  opts: { limit?: number } = {},
  signal?: AbortSignal
): Promise<WireSearch> {
  const params = new URLSearchParams({ q: query });
  if (opts.limit) params.set('limit', String(opts.limit));
  return getJson<WireSearch>(`api/search?${params}`, signal);
}

/** Names and locations for ids you already have — what the trail redraws with. */
export function fetchNodeRefs(ids: readonly string[], signal?: AbortSignal): Promise<WireNodeRefs> {
  const params = new URLSearchParams();
  for (const id of ids) params.append('id', id);
  return getJson<WireNodeRefs>(`api/nodes?${params}`, signal);
}

export function fetchEntryPoints(
  opts: { limit?: number; routes?: number } = {},
  signal?: AbortSignal
): Promise<WireEntryPoints> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.routes) params.set('routes', String(opts.routes));
  const query = params.toString();
  return getJson<WireEntryPoints>(`api/entrypoints${query ? `?${query}` : ''}`, signal);
}

export function fetchFile(path: string, signal?: AbortSignal): Promise<WireFilePayload> {
  // Paths carry '/'; encode per segment so `api/file/src/mcp/tools.ts` stays
  // readable and a segment with a reserved character still round-trips.
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return getJson<WireFilePayload>(`api/file/${encoded}`, signal);
}

/**
 * Everything the graph says about the lines of one file: the outline, one row
 * per (caller, callee) pair with its call-site lines, and the references that
 * resolved to nothing. The SOURCE is not in here — it pages through
 * `fetchSource`, so the ports and arcs are complete before any text arrives.
 */
export function fetchFileCode(
  path: string,
  signal?: AbortSignal
): Promise<WireFileCodePayload> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return getJson<WireFileCodePayload>(`api/filecode/${encoded}`, signal);
}

/**
 * A slice of an indexed file.
 *
 * `ondrift` decides what happens when the file has changed since it was
 * indexed. The default omits the slice — an indexed range over rewritten bytes
 * can show a different symbol's code under the right name. `'current'` asks for
 * the file's current lines instead, which is only correct for a caller that is
 * also going to SAY so: the response comes back `showing: 'current'`, and every
 * line-anchored thing the graph knows (ports, arcs, call sites, rail rows) has
 * to be switched off over it.
 */
export function fetchSource(
  file: string,
  from: number,
  to: number,
  signal?: AbortSignal,
  ondrift?: 'current'
): Promise<WireSource> {
  const params = new URLSearchParams({ file, from: String(from) });
  // `to` is 1-based on the wire and absent means "to the end of the file" —
  // sending 0 for that would be out of range, not a synonym.
  if (to > 0) params.set('to', String(to));
  if (ondrift) params.set('ondrift', ondrift);
  return getJson<WireSource>(`api/source?${params}`, signal);
}


/**
 * The module map. `root` selects the subtree (a monorepo's package); `depth`
 * is how many path segments under it name a module. Omitting `root` lets the
 * server pick the repository's source directory.
 */
export function fetchMap(
  opts: { root?: string | null; depth?: number } = {},
  signal?: AbortSignal
): Promise<WireMapPayload> {
  const params = new URLSearchParams();
  if (opts.root !== undefined && opts.root !== null) params.set('root', opts.root);
  if (opts.depth) params.set('depth', String(opts.depth));
  const query = params.toString();
  return getJson<WireMapPayload>(`api/map${query ? `?${query}` : ''}`, signal);
}

/**
 * A flow. Exactly one of the three shapes is sent:
 *
 * - `{ from, to }` — "how does X reach Y", from the search box.
 * - `{ symbols }` — `codegraph_explore`'s own question, verbatim.
 * - `{ trail }` — the hops the reader walked, as `<dir><id>` strings. Each one
 *   is its own parameter, because a node id can be a file path and a file path
 *   can contain a comma.
 */
export function fetchFlow(
  spec: { from?: string; to?: string; symbols?: string; trail?: readonly string[] },
  signal?: AbortSignal
): Promise<WireFlowPayload> {
  const params = new URLSearchParams();
  if (spec.from) params.set('from', spec.from);
  if (spec.to) params.set('to', spec.to);
  if (spec.symbols) params.set('symbols', spec.symbols);
  for (const hop of spec.trail ?? []) params.append('hop', hop);
  return getJson<WireFlowPayload>(`api/flow?${params}`, signal);
}
