/**
 * The read-only JSON API the viewer reads its screens from.
 *
 * Ten endpoints, one per screen, each answering in a single round-trip — the
 * same principle as `codegraph_explore`: return enough that the caller does not
 * have to ask a follow-up question. Everything here is a *reader* of the
 * existing schema; nothing indexes, resolves, or writes.
 *
 * ```
 * GET /api/stats                     what this index is and how much to trust it
 * GET /api/search?q=                 the search palette
 * GET /api/node/<id>                 the Symbol view: rails, members, tests, blast radius
 * GET /api/nodes?id=&id=             names for ids you already have (the trail)
 * GET /api/source?file=&from=&to=    verbatim source, with a drift verdict
 * GET /api/file/<path>               the File view: outline and import rails
 * GET /api/routes                    the URL to handler map, when there is one
 * GET /api/entrypoints               where to start reading: routes, roots, hubs
 * GET /api/map?root=&depth=          the module map: modules, links, cycles
 * GET /api/flow?from=&to=            the flow strip: one card per hop
 * ```
 *
 * It mounts on the `api` seam of `startUiServer`, which means it sits *behind*
 * the loopback boundary in `security.ts`: the `Host` allowlist, the absence of
 * CORS headers and the GET/HEAD restriction are already enforced by the time a
 * handler here runs. The one obligation that remains ours is the read
 * chokepoint — `resolveProjectFile` for anything that touches the repository —
 * and it lives in `source.ts`, the only module here that opens a file.
 */

import type { UiApiHandler, UiRequestContext } from '../index';
import { PathRefusalError } from '../security';
import { GraphSession } from './session';
import { ApiError, badRequest, fail, notFound, ok } from './respond';
import { buildStats } from './stats';
import { buildSearch } from './search';
import { buildNode } from './node';
import { buildSource } from './source';
import { buildFile } from './file';
import { buildRoutes } from './routes';
import { buildEntryPoints } from './entrypoints';
import { buildNodeRefs } from './nodes';
import { buildMap } from './map';
import { buildFlow } from './flow';

export { GraphSession } from './session';
export { ApiError } from './respond';
export * from './wire';
export type { WireEntryPoints, WireEntryFile, WireEntryHub } from './entrypoints';
export type { WireNodeRefs } from './nodes';
export type {
  WireFlowPayload,
  WireFlow,
  WireFlowHop,
  WireFlowEdge,
  WireFlowSource,
  WireFlowCallRef,
  WireFlowAmbiguity,
} from './flow';
export type {
  WireMapPayload,
  WireMapModule,
  WireMapLink,
  WireMapCycle,
} from './map';

/**
 * A mounted API, plus the handle it holds open.
 *
 * `close()` releases the index; the CLI calls it on Ctrl-C so the process does
 * not exit with a live SQLite connection.
 */
export interface GraphApi {
  handler: UiApiHandler;
  close(): void;
}

export interface GraphApiOptions {
  /** Absolute path of the indexed project to read. */
  projectRoot: string;
}

/** What `GET /api` answers: the endpoint list, for anyone poking at it by hand. */
const API_INDEX = {
  name: 'codegraph ui',
  readOnly: true,
  endpoints: [
    { path: '/api/stats', description: 'Index state, graph counts, detected frameworks.' },
    { path: '/api/search', description: 'Ranked symbol search.', params: ['q', 'limit'] },
    { path: '/api/node/<id>', description: 'One symbol: callers, callees, members, tests, blast radius.' },
    { path: '/api/nodes', description: 'Names and locations for ids you already have.', params: ['id'] },
    {
      path: '/api/source',
      description: 'Verbatim source for an indexed file, omitted when it has drifted on disk.',
      params: ['file', 'from', 'to'],
    },
    { path: '/api/file/<path>', description: 'One file: outline and import rails.' },
    { path: '/api/routes', description: 'URL to handler map, when the project is a routed app.', params: ['limit'] },
    {
      path: '/api/map',
      description: 'The repository at module granularity: modules, cross-module links, cycles.',
      params: ['root', 'depth'],
    },
    {
      path: '/api/flow',
      description: 'The call path between symbols: one hop per card, opened at the calling line.',
      params: ['from', 'to', 'symbols', 'hop', 'limit'],
    },
    {
      path: '/api/entrypoints',
      description: 'Where to start reading: routes, files that run something, and hubs.',
      params: ['limit'],
    },
  ],
};

export function createGraphApi(options: GraphApiOptions): GraphApi {
  const session = new GraphSession(options.projectRoot);

  // Async because `/api/source` highlights: everything else answers straight
  // out of SQLite and resolves on the same tick.
  const handler: UiApiHandler = async (_req, res, ctx) => {
    const route = normalize(ctx.pathname);
    try {
      switch (route) {
        case '/api':
          return ok(res, API_INDEX, ctx.method);
        case '/api/stats':
          return ok(res, buildStats(session.acquire(), ctx.projectRoot), ctx.method);
        case '/api/search':
          return ok(res, buildSearch(session.acquire(), ctx.query), ctx.method);
        case '/api/routes':
          return ok(res, buildRoutes(session.acquire(), ctx.query), ctx.method);
        case '/api/map':
          return ok(res, buildMap(session.acquire(), ctx.projectRoot, ctx.query), ctx.method);
        case '/api/entrypoints':
          return ok(res, buildEntryPoints(session.acquire(), ctx.query), ctx.method);
        case '/api/nodes':
          return ok(res, buildNodeRefs(session.acquire(), ctx.query), ctx.method);
        case '/api/source':
          return ok(res, await buildSource(session.acquire(), ctx.projectRoot, ctx.query), ctx.method);
        case '/api/flow':
          return ok(res, await buildFlow(session.acquire(), ctx.projectRoot, ctx.query), ctx.method);
        default:
          return dispatchPathRoutes(route, res, ctx, session);
      }
    } catch (err) {
      // A refusal from the read chokepoint is a 403 with the reason attached —
      // the request asked for something outside the project, and there is no
      // version of it we would serve.
      if (err instanceof PathRefusalError) {
        return fail(res, new ApiError('refused', err.message), ctx.method);
      }
      return fail(res, err, ctx.method);
    }
  };

  return { handler, close: () => session.close() };
}

/**
 * The two endpoints that carry their argument in the path.
 *
 * `ctx.pathname` is already percent-decoded, so a node id or a file path
 * containing `/` (`file:src/a.ts`) arrives whole — the remainder after the
 * prefix IS the argument, slashes and all. Node ids are opaque: they go
 * straight to an exact lookup, and anything that names nothing is a 404. File
 * paths go through the read chokepoint before anything is opened.
 */
function dispatchPathRoutes(
  route: string,
  res: Parameters<UiApiHandler>[1],
  ctx: UiRequestContext,
  session: GraphSession
): boolean {
  const nodeId = suffixAfter(route, '/api/node/');
  if (nodeId !== null) {
    if (nodeId === '') throw badRequest('No symbol id was given. Use /api/node/<id>.');
    return ok(res, buildNode(session.acquire(), ctx.projectRoot, nodeId), ctx.method);
  }

  const filePath = suffixAfter(route, '/api/file/');
  if (filePath !== null) {
    if (filePath === '') throw badRequest('No file path was given. Use /api/file/<path>.');
    return ok(res, buildFile(session.acquire(), ctx.projectRoot, filePath), ctx.method);
  }

  // `/api/node` and `/api/file` with no argument at all, so the message can say
  // what the endpoint wants instead of falling through to a bare 404.
  if (route === '/api/node' || route === '/api/file') {
    throw badRequest(`${route} needs an argument: ${route}/<${route.endsWith('node') ? 'id' : 'path'}>.`);
  }

  throw notFound(
    `No such endpoint: ${route}`,
    'GET /api lists everything this server answers.'
  );
}

/** Drop a single trailing slash, so `/api/stats/` and `/api/stats` are one route. */
function normalize(pathname: string): string {
  return pathname.length > 4 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function suffixAfter(route: string, prefix: string): string | null {
  return route.startsWith(prefix) ? route.slice(prefix.length) : null;
}
