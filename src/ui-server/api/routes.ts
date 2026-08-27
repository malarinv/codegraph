/**
 * `GET /api/routes` — the URL to handler map, when the project has one.
 *
 * The engine's routing manifest is a flat list of (url, handler, file, line)
 * rows; it deliberately carries no node ids, because its own consumer (the MCP
 * context builder) renders text. A reader needs to *navigate*, so each entry is
 * matched back to its handler's node id here — batched by file, never a lookup
 * per route.
 *
 * `null` from the engine means "fewer than three real routes", i.e. this
 * project is not a routed app. That is reported as an empty manifest with
 * `routed: false` rather than as an error: "this isn't a web app" is an
 * answer, not a failure.
 *
 * Two things about the manifest shape the numbers here have to work around.
 * Its `limit` is applied in SQL *before* the three-route test, so asking for
 * fewer than three would make every routed project look unrouted — hence the
 * floor on the parameter. And its own `totalRoutes` counts only the rows inside
 * that window, so the headline count comes from the graph's `route` nodes
 * instead, which is the number a reader means by "how many routes are there".
 */

import type { CodeGraph } from '../../index';
import { intParam } from './respond';
import { toPosixPath } from './wire';

/** Distinct handler files we will resolve node ids for. */
const MAX_HANDLER_FILES = 60;

/**
 * The engine needs three surviving rows to call a project routed, and applies
 * `limit` before that test — so anything below three is a question that cannot
 * be answered truthfully rather than a small page.
 */
const MIN_LIMIT = 3;

export function buildRoutes(cg: CodeGraph, query: URLSearchParams): unknown {
  const limit = intParam(query, 'limit', { min: MIN_LIMIT, max: 500, default: 200 });

  // One row over the limit, purely to learn whether there were more.
  const manifest = cg.getRoutingManifest(limit + 1);
  const routeCount = cg.getStats().nodesByKind.route ?? 0;

  if (!manifest) {
    return {
      routed: false,
      routeCount,
      shown: 0,
      truncated: false,
      topHandlerFile: null,
      topHandlerFileCount: 0,
      entries: [],
    };
  }

  const truncated = manifest.entries.length > limit;
  const rows = manifest.entries.slice(0, limit);

  // One `getNodesInFile` per distinct handler file — typically one or two, and
  // capped so a project that scatters handlers across hundreds of files cannot
  // turn one request into hundreds of queries.
  const handlerFiles = [...new Set(rows.map((e) => e.handlerFile))].slice(0, MAX_HANDLER_FILES);
  const byFileLineName = new Map<string, string>();
  for (const file of handlerFiles) {
    for (const node of cg.getNodesInFile(file)) {
      // Keyed on what the manifest actually knows: file, line and name. Two
      // symbols can share a line (a decorator and its method); the name breaks
      // the tie, and a miss simply leaves that entry unlinked.
      byFileLineName.set(`${node.filePath} ${node.startLine} ${node.name}`, node.id);
    }
  }

  const entries = rows.map((entry) => ({
    url: entry.url,
    handler: entry.handler,
    handlerKind: entry.handlerKind,
    file: toPosixPath(entry.handlerFile),
    line: entry.handlerLine,
    handlerId:
      byFileLineName.get(`${entry.handlerFile} ${entry.handlerLine} ${entry.handler}`) ?? null,
  }));

  return {
    routed: true,
    /** Every URL the index holds, whether or not its handler resolved. */
    routeCount,
    /** Rows in `entries` — the ones whose handler the manifest could name. */
    shown: entries.length,
    truncated,
    topHandlerFile: manifest.topHandlerFile ? toPosixPath(manifest.topHandlerFile) : null,
    topHandlerFileCount: manifest.topHandlerFileCount,
    entries,
  };
}
