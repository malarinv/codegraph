/**
 * `GET /api/screens` — the app as a reader experiences it: screens, and the
 * transitions between them, each labelled with what has to be true for it to
 * happen.
 *
 * The graph already holds the pieces: a `route` node per screen file (Expo
 * Router, and any framework that binds a route to the component that renders
 * it), and a `navigates` edge from the function that pushes a path to the
 * route it names. What a reader wants is neither of those nodes — it is
 * "from the Home screen, tapping an object card opens Object Detail, but only
 * for a collected object". That sentence is three hops away from the edge:
 *
 *   HomeScreen ─renders→ ItemsGrid ─renders→ ItemCard ─calls→ openObjectDetail ─navigates→ /object-detail
 *
 * So for every `navigates` edge this walks BACKWARDS from its source through
 * `calls` edges (the JSX-render synthesizer's edges among them) until it
 * reaches a component that a route renders. That component's screen is where
 * the transition starts; the nodes passed on the way are the `via` chain, and
 * the branch conditions at each call site along it (`graph/branch-guards.ts`)
 * are joined into the link's `when`. A navigation whose walk reaches no screen
 * within the hop cap — a store action, a service that runs after login — is
 * kept as an `origin` rather than dropped: it is a real transition with a real
 * trigger, just not a screen.
 *
 * Read from the graph at request time, never cached: the `when` labels are
 * read from the source as it stands. Seventy-odd transitions and a few
 * hundred guarded call sites resolve in tens of milliseconds.
 */

import type CodeGraph from '../../index';
import type { Edge, Node } from '../../types';
import { createWhenReader } from './when';
import { toNodeRef, type WireNodeRef } from './wire';

// =============================================================================
// Wire shapes
// =============================================================================

export interface WireScreen {
  /** The route node's id — what a link's `from`/`to` name. */
  id: string;
  /** The screen's path: `/object-detail`, `/item/[id]`. */
  path: string;
  file: string;
  line: number;
  /** The component the route renders, when the graph bound one. */
  component: WireNodeRef | null;
  /** Transitions into and out of this screen. */
  incoming: number;
  outgoing: number;
}

/**
 * A navigation whose start is not one screen: a function no screen reaches
 * (a store action after login), or a component so many screens render (a
 * top bar) that attributing its navigation to each of them would draw the
 * same three arrows from every box.
 */
export interface WireScreenOrigin {
  id: string;
  node: WireNodeRef;
  outgoing: number;
  /** For shared chrome: how many screens render it. */
  sharedBy?: number;
}

export interface WireScreenSite {
  file: string;
  line: number;
  /** The href as written at the call, `${…}` for interpolations. */
  href: string;
  /** `push`, `replace`, `navigate`, or `return` for a helper's return value. */
  method: string;
  /** Branch conditions at this site alone. */
  when: string;
}

export interface WireScreenLink {
  id: string;
  /** A screen id, or an origin id. */
  from: string;
  /** Always a screen id. */
  to: string;
  /** True when `from` is an origin, not a screen. */
  fromOrigin: boolean;
  /**
   * The symbols the transition passes through, from just below the screen's
   * component down to the one that holds the navigation call. Empty when the
   * screen's own component navigates.
   */
  via: WireNodeRef[];
  /** Conditions along the whole chain, joined; '' when unconditional. */
  when: string;
  /** Every call site behind this link (same screen, same chain end). */
  sites: WireScreenSite[];
  /**
   * The destination was inferred, not written at the call: it came back from
   * a helper's return value. (A synthesized render hop on the way — every
   * parent → child component step is one — does not count: that would dash
   * nearly every arrow.)
   */
  synthesized: boolean;
}

export interface WireScreensPayload {
  /** False when the graph holds no screen navigation at all. */
  routed: boolean;
  /** The route named `/`, when there is one. */
  entry: string | null;
  screens: WireScreen[];
  origins: WireScreenOrigin[];
  links: WireScreenLink[];
  /** Navigations dropped because the backwards walk hit a cap. */
  dropped: number;
  index: { lastIndexedAt: number | null; edges: number; files: number };
  timing: { elapsedMs: number };
}

// =============================================================================
// Caps
// =============================================================================

/** Hops walked back from a navigation call before giving up on a screen. */
const MAX_DEPTH = 7;
/** Callers expanded per node — a hub (`useToast`) is a dead end, not a path. */
const MAX_CALLERS_PER_NODE = 30;
/** Nodes visited per navigation. */
const MAX_VISITED = 800;
/** Call sites labelled with conditions per request. */
const MAX_WHEN_SITES = 600;

/**
 * Edges walked backwards from a navigation call. `contains` because a handler
 * declared inside a screen component (`function handleContinue() {…}` in the
 * body) is reached from the component by containment, not by a call; a
 * `references` edge is followed only when it passes the function as a value
 * (`onPress={handleContinue}`), never for a type mention.
 */
const WALK_KINDS: Edge['kind'][] = ['calls', 'instantiates', 'contains', 'references'];

/** A component rendered by at least this many screens is chrome, not a screen's own behaviour. */
const SHARED_CHROME_MIN = 3;

// =============================================================================
// The endpoint
// =============================================================================

export async function buildScreens(cg: CodeGraph, projectRoot: string): Promise<WireScreensPayload> {
  const started = Date.now();
  const stats = cg.getStats();
  const index = { lastIndexedAt: cg.getLastIndexedAt() ?? null, edges: stats.edgeCount, files: stats.fileCount };

  const routes = cg.getNodesByKind('route');
  const routeIds = routes.map((r) => r.id);
  const navEdges = routeIds.length === 0 ? [] : cg.getIncomingEdgesTo(routeIds, ['navigates']);
  if (navEdges.length === 0) {
    return {
      routed: false,
      entry: null,
      screens: [],
      origins: [],
      links: [],
      dropped: 0,
      index,
      timing: { elapsedMs: Date.now() - started },
    };
  }

  // Route → the component it renders; component → its route.
  const routeById = new Map(routes.map((r) => [r.id, r]));
  const routeByFile = new Map(routes.map((r) => [r.filePath, r.id]));
  const renders = cg.getOutgoingEdgesFrom(routeIds, ['calls', 'instantiates']);
  const componentIds = new Set(renders.map((e) => e.target));
  const nodesById = cg.getNodesByIds([...componentIds, ...navEdges.map((e) => e.source)]);
  const componentOf = new Map<string, Node>();
  const screenOfComponent = new Map<string, string>();
  for (const edge of renders) {
    const component = nodesById.get(edge.target);
    if (!component || componentOf.has(edge.source)) continue;
    componentOf.set(edge.source, component);
    screenOfComponent.set(component.id, edge.source);
  }

  const readWhen = createWhenReader(cg, projectRoot, MAX_WHEN_SITES);
  const whenAt = (caller: Node, edge: Edge): Promise<string> => readWhen(caller, { line: edge.line, column: edge.column });
  const links = new Map<string, WireScreenLink>();
  const origins = new Map<string, WireScreenOrigin>();
  const counts = new Map<string, { incoming: number; outgoing: number }>();
  const bump = (id: string, key: 'incoming' | 'outgoing') => {
    const c = counts.get(id) ?? { incoming: 0, outgoing: 0 };
    c[key]++;
    counts.set(id, c);
  };
  let dropped = 0;

  for (const nav of navEdges) {
    const holder = nodesById.get(nav.source);
    const target = routeById.get(nav.target);
    if (!holder || !target) continue;
    const meta = (nav.metadata ?? {}) as Record<string, unknown>;
    const site: WireScreenSite = {
      file: toPosix(holder.filePath),
      line: nav.line ?? holder.startLine,
      href: typeof meta.href === 'string' ? meta.href : target.name,
      method: nav.provenance === 'heuristic' ? 'return' : typeof meta.navMethod === 'string' ? meta.navMethod : 'push',
      when: nav.provenance === 'heuristic' ? '' : await whenAt(holder, nav),
    };

    let starts = await attribute(cg, holder, screenOfComponent, routeByFile, nodesById);
    if (starts === null) {
      dropped++;
      continue;
    }
    starts = collapseSharedChrome(starts, origins);
    const attributions =
      starts.length > 0
        ? starts
        : [{ screenId: null as string | null, path: [{ node: holder, edge: null }] as Array<{ node: Node; edge: Edge | null }> }];

    for (const start of attributions) {
      let fromId: string;
      let fromOrigin = false;
      if (start.screenId !== null) fromId = start.screenId;
      else {
        // The origin is the chain's head: the holder itself, or the shared
        // component the chain was collapsed onto.
        const head = start.path[0]!.node;
        fromId = head.id;
        fromOrigin = true;
        if (!origins.has(head.id)) origins.set(head.id, { id: head.id, node: toNodeRef(head), outgoing: 0 });
      }

      // `path` is [screen component, …, holder]; `path[i].edge` is the call
      // from `path[i-1]` into `path[i]`, so its site is in `path[i-1]`'s file.
      // The component itself is not "via" — it IS the screen.
      const via = start.path.slice(1).map((h) => toNodeRef(h.node));
      const whens: string[] = [];
      const synthesized = nav.provenance === 'heuristic';
      for (let i = 1; i < start.path.length; i++) {
        const edge = start.path[i]!.edge;
        if (!edge) continue;
        const w = await whenAt(start.path[i - 1]!.node, edge);
        if (w && !whens.includes(w)) whens.push(w);
      }
      if (site.when && !whens.includes(site.when)) whens.push(site.when);

      const viaKey = via.map((v) => v.id).join('>');
      if (fromOrigin && start.path[0]!.node.id !== holder.id) {
        // A collapsed chain: the origin's own name is not "via".
      }
      const id = `${fromId} ${target.id} ${viaKey}`;
      const existing = links.get(id);
      if (existing) {
        existing.sites.push(site);
        const mine = whens.join(' && ');
        if (mine !== existing.when) {
          // `if (x) push(A) else push(A)`: the two arms together are "always".
          if (complementary(mine, existing.when)) existing.when = '';
          else if (mine && existing.when) existing.when = `${existing.when} || ${mine}`;
          else if (!mine) existing.when = '';
        }
        continue;
      }
      links.set(id, {
        id,
        from: fromId,
        to: target.id,
        fromOrigin,
        via,
        when: whens.join(' && '),
        sites: [site],
        synthesized,
      });
      bump(target.id, 'incoming');
      if (fromOrigin) origins.get(fromId)!.outgoing++;
      else bump(fromId, 'outgoing');
    }
  }

  const screens: WireScreen[] = routes
    .map((route) => {
      const component = componentOf.get(route.id) ?? null;
      const c = counts.get(route.id) ?? { incoming: 0, outgoing: 0 };
      return {
        id: route.id,
        path: route.name,
        file: toPosix(route.filePath),
        line: route.startLine,
        component: component ? toNodeRef(component) : null,
        incoming: c.incoming,
        outgoing: c.outgoing,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const entry = screens.find((s) => s.path === '/')?.id ?? null;
  const ordered = [...links.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    routed: true,
    entry,
    screens,
    origins: [...origins.values()].sort((a, b) => a.node.name.localeCompare(b.node.name)),
    links: ordered,
    dropped,
    index,
    timing: { elapsedMs: Date.now() - started },
  };
}

// =============================================================================
// Attribution: which screen does this navigation start from?
// =============================================================================

interface Attribution {
  screenId: string | null;
  /** [screen component, …, holder], each with the edge that led INTO it from the previous. */
  path: Array<{ node: Node; edge: Edge | null }>;
}

/**
 * Every screen whose component reaches `holder` through calls, each with the
 * shortest chain (breadth-first). `[]` when none does within the caps but the
 * walk completed; `null` when the walk was cut short — a hub so wide the
 * answer would be a guess.
 */
async function attribute(
  cg: CodeGraph,
  holder: Node,
  screenOfComponent: Map<string, string>,
  routeByFile: Map<string, string>,
  known: Map<string, Node>
): Promise<Attribution[] | null> {
  // The holder IS a screen component: the transition starts on that screen.
  const own = screenOfComponent.get(holder.id);
  if (own) return [{ screenId: own, path: [{ node: holder, edge: null }] }];

  const parent = new Map<string, { prev: string | null; edge: Edge | null }>();
  parent.set(holder.id, { prev: null, edge: null });
  const nodes = new Map<string, Node>([[holder.id, holder]]);
  let frontier = [holder.id];
  const found: Attribution[] = [];
  let truncated = false;

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const incoming = cg.getIncomingEdgesTo(frontier, WALK_KINDS);
    const byTarget = new Map<string, Edge[]>();
    for (const e of incoming) {
      if (e.kind === 'references' && (e.metadata as Record<string, unknown> | undefined)?.fnRef !== true) continue;
      const list = byTarget.get(e.target) ?? [];
      list.push(e);
      byTarget.set(e.target, list);
    }
    const nextIds: string[] = [];
    const wanted = new Set<string>();
    for (const [, edges] of byTarget) {
      if (edges.length > MAX_CALLERS_PER_NODE) {
        truncated = true;
        continue;
      }
      for (const e of edges) if (!parent.has(e.source)) wanted.add(e.source);
    }
    if (parent.size + wanted.size > MAX_VISITED) truncated = true;
    const fetched = wanted.size === 0 ? new Map<string, Node>() : cg.getNodesByIds([...wanted]);
    for (const [, edges] of byTarget) {
      if (edges.length > MAX_CALLERS_PER_NODE) continue;
      for (const e of edges) {
        if (parent.has(e.source)) continue;
        const caller = fetched.get(e.source) ?? known.get(e.source);
        // A file's top level or a route node is not a place a user is.
        if (!caller || caller.kind === 'file' || caller.kind === 'route') continue;
        parent.set(e.source, { prev: e.target, edge: e });
        nodes.set(e.source, caller);
        const screen = screenOfComponent.get(caller.id);
        if (screen) {
          found.push({ screenId: screen, path: pathFrom(caller.id, parent, nodes) });
          continue; // a screen is where the walk stops
        }
        nextIds.push(e.source);
        if (parent.size >= MAX_VISITED) break;
      }
    }
    frontier = nextIds;
    if (parent.size >= MAX_VISITED) {
      truncated = true;
      break;
    }
  }
  if (found.length > 0) return found;
  // No screen component reached, but the chain passed through a screen's
  // FILE: a component that file defines for itself (a wrapper the render
  // synthesizer did not see through) belongs to that screen. Nearest first,
  // so the holder's own file wins over a helper's.
  for (const [id] of parent) {
    const node = nodes.get(id);
    const screen = node ? routeByFile.get(node.filePath) : undefined;
    if (screen) return [{ screenId: screen, path: pathFrom(id, parent, nodes) }];
  }
  return truncated ? null : [];
}

/**
 * Shared chrome: when the same first-hop component carries this navigation
 * to {@link SHARED_CHROME_MIN} or more screens, those attributions collapse
 * into ONE from that component, marked with how many screens render it. A top
 * bar's "Account settings" link is one fact about the top bar, not twelve
 * facts about twelve screens.
 */
function collapseSharedChrome(starts: Attribution[], origins: Map<string, WireScreenOrigin>): Attribution[] {
  const byFirstHop = new Map<string, Attribution[]>();
  for (const s of starts) {
    if (s.screenId === null || s.path.length < 2) continue;
    const key = s.path[1]!.node.id;
    byFirstHop.set(key, [...(byFirstHop.get(key) ?? []), s]);
  }
  const out: Attribution[] = [];
  const collapsed = new Set<Attribution>();
  for (const [, group] of byFirstHop) {
    const screens = new Set(group.map((g) => g.screenId));
    if (screens.size < SHARED_CHROME_MIN) continue;
    const head = group[0]!.path[1]!.node;
    const existing = origins.get(head.id);
    if (existing) existing.sharedBy = Math.max(existing.sharedBy ?? 0, screens.size);
    else origins.set(head.id, { id: head.id, node: toNodeRef(head), outgoing: 0, sharedBy: screens.size });
    // One attribution, headed by the shared component, chain continuing below it.
    out.push({ screenId: null, path: group[0]!.path.slice(1) });
    for (const g of group) collapsed.add(g);
  }
  for (const s of starts) if (!collapsed.has(s)) out.push(s);
  return out;
}

/** The chain from `start` down to the holder, following `prev` links. */
function pathFrom(
  start: string,
  parent: Map<string, { prev: string | null; edge: Edge | null }>,
  nodes: Map<string, Node>
): Array<{ node: Node; edge: Edge | null }> {
  const out: Array<{ node: Node; edge: Edge | null }> = [];
  let id: string | null = start;
  let edgeInto: Edge | null = null;
  while (id !== null) {
    const node = nodes.get(id)!;
    out.push({ node, edge: edgeInto });
    const step: { prev: string | null; edge: Edge | null } = parent.get(id)!;
    edgeInto = step.edge;
    id = step.prev;
  }
  return out;
}

// =============================================================================
// Conditions
// =============================================================================

/** `x` and `!x`, or `a && x` and `a && !x`. */
function complementary(a: string, b: string): boolean {
  if (!a || !b) return false;
  const pa = a.split(' && ');
  const pb = b.split(' && ');
  if (pa.length !== pb.length) return false;
  let flips = 0;
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] === pb[i]) continue;
    if (pa[i] === `!${pb[i]}` || pb[i] === `!${pa[i]}`) flips++;
    else return false;
  }
  return flips === 1;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
