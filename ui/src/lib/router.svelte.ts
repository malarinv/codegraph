/**
 * Hash router for the viewer.
 *
 * The hash — not the path — is the address, so the CLI's static server never
 * needs a history-API fallback: every URL it is ever asked for is `/`.
 *
 * Routes (design spec §3.2–§3.6):
 *   #/                     home / nothing selected
 *   #/s/<id>               symbol view      (?hl=<line> highlights a line, ?t=<trail>)
 *   #/file/<path>          file view        (?hl=<line>)
 *   #/map                  module map       (?root=&depth=&tests=1)
 *   #/flow[/<key>]         flow strip       — reserved, phase 2
 *
 * Node ids are opaque engine strings shaped `<kind>:<hash>` or
 * `<kind>:<relative/path>` (see src/extraction/tree-sitter-helpers.ts), so
 * they can contain both ':' and '/'. Both ids and file paths are therefore
 * encoded *per slash-separated segment* and rejoined on the way out: the URL
 * stays readable (`#/file/src/mcp/tools.ts`) and still round-trips a segment
 * that itself contains a reserved character.
 */

export type Route =
  | { view: 'home' }
  | { view: 'symbol'; id: string; line: number | null }
  | { view: 'file'; path: string; line: number | null }
  | { view: 'map'; root: string | null; depth: number; tests: boolean }
  | { view: 'flow'; key: string | null }
  | { view: 'unknown'; path: string };

export type ViewName = Route['view'];

export interface RouterLocation {
  route: Route;
  /** Query part of the hash (`?t=…&hl=…`), for consumers like the trail. */
  params: URLSearchParams;
  /** The raw hash this was parsed from, minus the leading '#'. */
  raw: string;
}

/** decodeURIComponent that survives a hand-typed, malformed '%' in the bar. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function parseLine(params: URLSearchParams): number | null {
  const raw = params.get('hl');
  if (raw === null) return null;
  const line = Number.parseInt(raw, 10);
  return Number.isFinite(line) && line > 0 ? line : null;
}

export function parseHash(hash: string): RouterLocation {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const q = raw.indexOf('?');
  const pathPart = q < 0 ? raw : raw.slice(0, q);
  const params = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
  const segments = pathPart.split('/').filter(Boolean).map(decodeSegment);
  const line = parseLine(params);

  const [head, ...rest] = segments;
  let route: Route;
  if (head === undefined) {
    route = { view: 'home' };
  } else if (head === 's' && rest.length > 0) {
    route = { view: 'symbol', id: rest.join('/'), line };
  } else if (head === 'file' && rest.length > 0) {
    route = { view: 'file', path: rest.join('/'), line };
  } else if (head === 'map' && rest.length === 0) {
    // The map's shape travels in the URL like the trail does: a link to
    // "src/vs at depth 2, tests on" has to reopen the same picture.
    const root = params.get('root');
    const depth = Number.parseInt(params.get('depth') ?? '', 10);
    route = {
      view: 'map',
      root: root === null ? null : root,
      depth: Number.isFinite(depth) && depth >= 1 && depth <= 4 ? depth : 1,
      tests: params.get('tests') === '1',
    };
  } else if (head === 'flow') {
    route = { view: 'flow', key: rest.length > 0 ? rest.join('/') : null };
  } else {
    route = { view: 'unknown', path: pathPart };
  }

  return { route, params, raw };
}

/* ---------- href builders (the only place hashes are assembled) ---------- */

export function symbolHref(id: string, opts: { line?: number; trail?: string } = {}): string {
  const params = new URLSearchParams();
  if (opts.trail) params.set('t', opts.trail);
  if (opts.line) params.set('hl', String(opts.line));
  const query = params.toString();
  return `#/s/${encodePath(id)}${query ? `?${query}` : ''}`;
}

export function fileHref(path: string, opts: { line?: number } = {}): string {
  const query = opts.line ? `?hl=${opts.line}` : '';
  return `#/file/${encodePath(path)}${query}`;
}

export function mapHref(
  opts: { root?: string | null; depth?: number; tests?: boolean } = {}
): string {
  const params = new URLSearchParams();
  if (opts.root !== undefined && opts.root !== null) params.set('root', opts.root);
  if (opts.depth && opts.depth !== 1) params.set('depth', String(opts.depth));
  if (opts.tests) params.set('tests', '1');
  const query = params.toString();
  return `#/map${query ? `?${query}` : ''}`;
}

export function flowHref(key?: string): string {
  return key ? `#/flow/${encodePath(key)}` : '#/flow';
}

/* ---------- the live route ---------- */

const initial = parseHash(typeof location === 'undefined' ? '' : location.hash);
let current = $state<RouterLocation>(initial);

function sync(): void {
  const next = parseHash(location.hash);
  if (next.raw !== current.raw) current = next;
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', sync);
  // popstate too: `navigate(…, { replace: true })` and history.back() across
  // a replaced entry both move the hash without firing hashchange.
  window.addEventListener('popstate', sync);
}

export const router = {
  get location(): RouterLocation {
    return current;
  },
  get route(): Route {
    return current.route;
  },
  get params(): URLSearchParams {
    return current.params;
  },
};

export function navigate(href: string, opts: { replace?: boolean } = {}): void {
  const target = href.startsWith('#') ? href : `#${href}`;
  if (opts.replace) {
    history.replaceState(history.state, '', target);
    sync();
    return;
  }
  if (location.hash === target) return;
  location.hash = target;
  // hashchange fires asynchronously; sync() is idempotent, so calling it now
  // keeps a navigate() immediately followed by a read consistent.
  sync();
}

export function back(): void {
  history.back();
}
