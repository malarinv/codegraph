/**
 * `GET /api/entrypoints` — where to start reading a project you have never
 * opened.
 *
 * The empty state and the resting search palette both have the same problem:
 * a graph of thirteen thousand symbols and no obvious door. Three answers,
 * every one of them derived from the graph rather than from a filename
 * convention:
 *
 * - **Routes** — a request arriving from outside is the most literal entry a
 *   codebase has. Straight from the routing manifest (`/api/routes`), and
 *   absent for a project that is not a routed app.
 * - **Files that run something** — the engine records a statement at the top
 *   level of a file as an edge out of the *file* node, so a CLI, a worker
 *   entry or a build script has `calls` where a library module has none. That
 *   is what makes `src/bin/codegraph.ts` the root of this repo's CLI flow.
 *   Ranked by calls x how many other files they reach, so the file that both
 *   runs and wires the project together outranks a registration table that
 *   makes a hundred module-level calls into itself.
 * - **Hubs** — the most depended-on symbols. Not an entry in the "runs first"
 *   sense; an entry in the sense that reading one tells you the most about
 *   what the project is made of, and a change to one radiates furthest.
 *
 * Tests and fixtures are excluded from both derived lists. They are real code
 * with real callers, but "where do I start reading" never means a test.
 */

import type { CodeGraph } from '../../index';
import type { Node, NodeKind } from '../../types';
import { intParam } from './respond';
import { buildRoutes } from './routes';
import { isTestFile } from '../../search/query-utils';
import { toNodeRef, wireList, type WireList, type WireNodeRef } from './wire';

/** Rows per derived list, and the default for `limit`. */
const DEFAULT_LIMIT = 12;

/**
 * Ranked rows examined before the test filter and the per-directory cap run.
 *
 * Fixed rather than a multiple of `limit` so the same project answers with the
 * same rows whatever the caller asks for. It also means the `total` on the two
 * derived lists is a FLOOR — "at least this many" — because the tests it skips
 * are only recognisable in JavaScript (`isTestFile` reads directory shapes and
 * CamelCase suffixes that do not survive translation into SQL). That is the
 * honest reading, and the viewer prints the rows rather than the count.
 */
const SCAN_ROWS = 400;

/**
 * At most this many executable files from any one directory.
 *
 * Without it a repo with twenty one-off scripts in `scripts/` answers "where do
 * I start" with twenty scripts, and the CLI everybody actually wants falls off
 * the end. Two keeps a directory represented without letting it own the list.
 */
const MAX_FILES_PER_DIR = 2;

/** Kinds that are never a useful hub row: a mention, a container, or a name. */
const NON_HUB_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'file',
  'import',
  'export',
  'parameter',
]);

export interface WireEntryFile extends WireNodeRef {
  /** Calls and instantiations made at the top level of the file. */
  calls: number;
  /** Distinct other files this one's symbols reach. */
  reaches: number;
  /** Other files reaching into this one. Zero means nothing imports it. */
  dependents: number;
}

export interface WireEntryHub extends WireNodeRef {
  /** Distinct symbols that depend on this one. */
  dependents: number;
}

export interface WireEntryPoints {
  routes: {
    routed: boolean;
    routeCount: number;
    items: Array<{ url: string; handler: string; file: string; line: number; handlerId: string | null }>;
  };
  files: WireList<WireEntryFile>;
  hubs: WireList<WireEntryHub>;
}

export function buildEntryPoints(cg: CodeGraph, query: URLSearchParams): WireEntryPoints {
  const limit = intParam(query, 'limit', { min: 1, max: 50, default: DEFAULT_LIMIT });

  return {
    routes: routeEntries(cg, limit),
    files: executableFiles(cg, limit),
    hubs: hubs(cg, limit),
  };
}

/**
 * The routing manifest, trimmed to a starting-points list.
 *
 * `buildRoutes` is reused rather than re-derived so a route row means exactly
 * the same thing here as on the routes endpoint — including its handler id,
 * which is what makes the row navigable.
 */
function routeEntries(cg: CodeGraph, limit: number): WireEntryPoints['routes'] {
  const manifest = buildRoutes(cg, new URLSearchParams()) as {
    routed: boolean;
    routeCount: number;
    entries: WireEntryPoints['routes']['items'];
  };
  return {
    routed: manifest.routed,
    routeCount: manifest.routeCount,
    items: manifest.entries.slice(0, limit),
  };
}

/**
 * Files that do something on the way down, most first.
 *
 * Over-fetched before filtering, because the two things that shrink the list —
 * tests and the per-directory cap — are only knowable after the rows come back,
 * and a project whose noisiest module-level callers are all test files would
 * otherwise answer with an empty list.
 */
function executableFiles(cg: CodeGraph, limit: number): WireList<WireEntryFile> {
  const ranked = cg.getTopCallingFiles(SCAN_ROWS);

  const kept: Array<{ node: Node; calls: number; reaches: number }> = [];
  const perDir = new Map<string, number>();
  let eligible = 0;

  for (const row of ranked) {
    if (isTestFile(row.filePath)) continue;
    eligible += 1;
    if (kept.length >= limit) continue;
    const dir = directoryOf(row.filePath);
    const taken = perDir.get(dir) ?? 0;
    if (taken >= MAX_FILES_PER_DIR) continue;
    const node = cg.getNode(row.nodeId);
    if (!node) continue;
    perDir.set(dir, taken + 1);
    kept.push({ node, calls: row.calls, reaches: row.reaches });
  }

  const dependents = cg.getFileDependentCounts(kept.map((k) => k.node.filePath));
  const items: WireEntryFile[] = kept.map(({ node, calls, reaches }) => ({
    ...toNodeRef(node),
    calls,
    reaches,
    dependents: dependents.get(node.filePath) ?? 0,
  }));

  // `eligible` counts every non-test file the scan saw: a floor, never an
  // overstatement.
  return wireList(items, Math.max(eligible, items.length));
}

/** The most depended-on symbols, tests and non-navigable kinds removed. */
function hubs(cg: CodeGraph, limit: number): WireList<WireEntryHub> {
  const ranked = cg.getTopDependedOn(SCAN_ROWS);

  const items: WireEntryHub[] = [];
  let eligible = 0;
  for (const row of ranked) {
    const node = cg.getNode(row.nodeId);
    if (!node || NON_HUB_KINDS.has(node.kind) || isTestFile(node.filePath)) continue;
    eligible += 1;
    if (items.length >= limit) continue;
    items.push({ ...toNodeRef(node), dependents: row.dependents });
  }

  return wireList(items, Math.max(eligible, items.length));
}

/** `src/bin/codegraph.ts` -> `src/bin`; a root file -> `.`. */
function directoryOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  return cut < 0 ? '.' : normalized.slice(0, cut);
}
