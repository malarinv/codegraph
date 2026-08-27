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
  contentHash: string;
  indexedAt: number;
  generated: boolean;
  totalLines: number | null;
  from?: number;
  to?: number;
  /** Absent when `drift` — a mis-sliced body is worse than no body. */
  lines?: string[];
  truncated?: boolean;
  reason?: string;
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
  url: string;
  handler: string;
  file: string;
  line: number;
  handlerId: string | null;
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

export interface WireEntryPoints {
  routes: { routed: boolean; routeCount: number; items: WireEntryRoute[] };
  /** `total` is a floor on both lists — the server counts what its scan saw. */
  files: WireList<WireEntryFile>;
  hubs: WireList<WireEntryHub>;
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
  opts: { limit?: number } = {},
  signal?: AbortSignal
): Promise<WireEntryPoints> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  const query = params.toString();
  return getJson<WireEntryPoints>(`api/entrypoints${query ? `?${query}` : ''}`, signal);
}

export function fetchSource(
  file: string,
  from: number,
  to: number,
  signal?: AbortSignal
): Promise<WireSource> {
  const params = new URLSearchParams({ file, from: String(from), to: String(to) });
  return getJson<WireSource>(`api/source?${params}`, signal);
}
