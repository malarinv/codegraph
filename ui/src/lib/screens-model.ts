/**
 * The Screens view's model — the app's screens and the transitions between
 * them, laid out so that a screen sits above the screens it opens.
 *
 * The layout is the Map's (`buildMapLayout`): the same longest-path layering,
 * the same barycenter ordering, the same ports, the same determinism. A
 * screen graph is a module graph with different words — nodes with names,
 * weighted links that mostly point one way, a few cycles (Home ↔ Capture)
 * that become dashed back-edges rather than being straightened into a lie.
 * Reusing it means a reader who learned the Map reads this without learning
 * anything new, and means this file is mostly translation, not geometry.
 *
 * What is this file's own: which links share a pair (several transitions from
 * Home to Capture, each with its own condition, draw as ONE edge whose label
 * counts them), the words on that edge, and the two lists the side panel
 * shows for a selected screen.
 */

import type { WireMapLink, WireMapModule, WireScreen, WireScreenLink, WireScreensPayload } from './wire';
import { buildMapLayout, linkId, type MapLayout } from './map-model';

/** The longest `when` a connector prints before an ellipsis; the tooltip has the rest. */
const EDGE_LABEL_MAX = 30;

export interface ScreenNodeInfo {
  id: string;
  /** `/object-detail`, or a function name for an origin. */
  label: string;
  /** The component's name for a screen; the file for an origin. */
  sub: string;
  screen: WireScreen | null;
  /** A navigation that could not be attributed to a screen. */
  origin: boolean;
  entry: boolean;
  /** No path of transitions leads here from the entry screen. */
  unreached: boolean;
}

export interface ScreenEdgeInfo {
  id: string;
  from: string;
  to: string;
  /** Every transition between the pair — one connector, several stories. */
  links: WireScreenLink[];
  /** The connector's short label: the condition, or how many transitions. */
  label: string;
  synthesized: boolean;
}

export interface ScreensModel {
  layout: MapLayout;
  nodes: Map<string, ScreenNodeInfo>;
  /** Keyed by the layout edge's id (see `linkId`). */
  edges: Map<string, ScreenEdgeInfo>;
  /** Screens no chain of transitions reaches from the entry. */
  unreached: number;
}

/**
 * Layer = distance from the entry screen: the entry on top, each row down one
 * more transition away. Origins (chrome, triggers outside any screen) count
 * as reachable seeds too, so what they open is placed below them. Whatever
 * nothing reaches sits in a band at the bottom, layered among itself by the
 * same rule from its own sources — a screen the graph cannot see anyone open
 * is a fact worth a place, not a crash.
 */
export function entryLayering(entry: string | null, seeds: readonly string[]) {
  return (ids: string[], links: ReadonlyArray<{ source: string; target: string }>): Map<string, number> => {
    const out = new Map<string, string[]>(ids.map((id) => [id, []]));
    const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const l of links) {
      out.get(l.source)?.push(l.target);
      indeg.set(l.target, (indeg.get(l.target) ?? 0) + 1);
    }
    const depth = new Map<string, number>();
    const bfs = (starts: string[]) => {
      let frontier = starts.filter((s) => !depth.has(s));
      for (const s of frontier) depth.set(s, 0);
      let d = 0;
      while (frontier.length > 0) {
        d++;
        const next: string[] = [];
        for (const id of frontier) {
          for (const t of out.get(id) ?? []) {
            if (depth.has(t)) continue;
            depth.set(t, d);
            next.push(t);
          }
        }
        frontier = next;
      }
    };
    const roots = [entry, ...seeds].filter((s): s is string => s !== null && ids.includes(s));
    bfs(roots);
    const reachedMax = Math.max(0, ...[...depth.values()]);
    // The unreached band: its own sources first, then whatever they open.
    const rest = ids.filter((id) => !depth.has(id));
    const restDepth = new Map<string, number>();
    if (rest.length > 0) {
      const restSources = rest.filter((id) => (indeg.get(id) ?? 0) === 0);
      const seedsRest = restSources.length > 0 ? restSources : [rest[0]!];
      let frontier = seedsRest;
      for (const s of frontier) restDepth.set(s, 0);
      let d = 0;
      while (frontier.length > 0) {
        d++;
        const next: string[] = [];
        for (const id of frontier) {
          for (const t of out.get(id) ?? []) {
            if (restDepth.has(t) || depth.has(t)) continue;
            restDepth.set(t, d);
            next.push(t);
          }
        }
        frontier = next;
      }
      for (const id of rest) if (!restDepth.has(id)) restDepth.set(id, 0);
    }
    const restMax = Math.max(0, ...[...restDepth.values()]);
    // Layer 0 is the bottom. Unreached band occupies [0, restMax]; reached
    // screens sit above it, the entry highest, with one empty row between.
    const base = rest.length > 0 ? restMax + 2 : 0;
    const layer = new Map<string, number>();
    for (const [id, d] of depth) layer.set(id, base + reachedMax - d);
    for (const [id, d] of restDepth) layer.set(id, restMax - d);
    return layer;
  };
}

/** What the connector says. Empty when unconditional and single. */
export function edgeLabel(links: readonly WireScreenLink[]): string {
  if (links.length === 1) {
    const when = links[0]!.when;
    if (!when) return '';
    return when.length > EDGE_LABEL_MAX ? `${when.slice(0, EDGE_LABEL_MAX - 1)}…` : when;
  }
  const conditional = links.filter((l) => l.when).length;
  return conditional > 0 ? `${links.length} ways · ${conditional} conditional` : `${links.length} ways`;
}

export function buildScreensModel(payload: WireScreensPayload): ScreensModel {
  const nodes = new Map<string, ScreenNodeInfo>();
  const modules: WireMapModule[] = [];
  const used = new Set<string>();
  for (const link of payload.links) {
    used.add(link.from);
    used.add(link.to);
  }

  for (const screen of payload.screens) {
    const info: ScreenNodeInfo = {
      id: screen.id,
      label: screen.path,
      sub: screen.component?.name ?? screen.file,
      screen,
      origin: false,
      entry: payload.entry === screen.id,
      unreached: false,
    };
    nodes.set(screen.id, info);
    modules.push(moduleFor(info, screen.incoming + screen.outgoing));
  }
  for (const origin of payload.origins) {
    const info: ScreenNodeInfo = {
      id: origin.id,
      label: origin.node.kind === 'component' ? `<${origin.node.name}>` : `${origin.node.name}()`,
      sub: origin.sharedBy ? `on ${origin.sharedBy} screens` : origin.node.file,
      screen: null,
      origin: true,
      entry: false,
      unreached: false,
    };
    nodes.set(origin.id, info);
    modules.push(moduleFor(info, origin.outgoing));
  }

  // One layout link per (from, to); the transitions behind it stay listed.
  const byPair = new Map<string, WireScreenLink[]>();
  for (const link of payload.links) {
    const key = linkId({ source: link.from, target: link.to });
    const list = byPair.get(key) ?? [];
    list.push(link);
    byPair.set(key, list);
  }
  const links: WireMapLink[] = [];
  const edges = new Map<string, ScreenEdgeInfo>();
  for (const [key, group] of byPair) {
    const first = group[0]!;
    if (!nodes.has(first.from) || !nodes.has(first.to)) continue;
    // A screen that reopens itself (a retry) is a fact for the panel, not an
    // arrow the layout can draw.
    if (first.from === first.to) continue;
    links.push({
      source: first.from,
      target: first.to,
      count: group.length,
      declared: group.length,
      byKind: [{ kind: 'navigates', count: group.length }],
      topPairs: [],
    });
    edges.set(key, {
      id: key,
      from: first.from,
      to: first.to,
      links: group,
      label: edgeLabel(group),
      synthesized: group.every((l) => l.synthesized),
    });
  }

  // Reachability from the entry (and from the origins, which are entries of
  // a kind: chrome is on the screen the user is on).
  const seeds = payload.origins.map((o) => o.id);
  const reachable = new Set<string>();
  {
    const out = new Map<string, string[]>();
    for (const l of payload.links) out.set(l.from, [...(out.get(l.from) ?? []), l.to]);
    const stack = [payload.entry, ...seeds].filter((s): s is string => s !== null);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const t of out.get(id) ?? []) stack.push(t);
    }
  }
  let unreached = 0;
  for (const info of nodes.values()) {
    if (!info.origin && !reachable.has(info.id)) {
      info.unreached = true;
      unreached++;
    }
  }

  const layout = buildMapLayout(
    { modules, links },
    {
      includeTests: true,
      minWeight: 0,
      sizing: (m) => {
        const info = nodes.get(m.id);
        return { label: info?.label ?? m.id, meta: info?.sub ?? '' };
      },
      layering: entryLayering(payload.entry, seeds),
    }
  );
  return { layout, nodes, edges, unreached };
}

function moduleFor(info: ScreenNodeInfo, symbols: number): WireMapModule {
  return {
    id: info.id,
    label: info.label,
    files: 1,
    symbols,
    languages: [],
    test: false,
    generated: 0,
    generatedFiles: [],
    facade: false,
    fileList: { total: 1, shown: 1, truncated: false, items: [info.screen?.file ?? info.sub] },
  };
}

/** The side panel's two lists for a selected node. */
export function neighbourhood(
  payload: WireScreensPayload,
  id: string
): { opensFrom: WireScreenLink[]; goesTo: WireScreenLink[] } {
  const opensFrom = payload.links.filter((l) => l.to === id);
  const goesTo = payload.links.filter((l) => l.from === id);
  return { opensFrom, goesTo };
}

/** `ItemCard → openObjectDetail`, or '' when the screen's own component navigates. */
export function viaText(link: WireScreenLink): string {
  return link.via.map((v) => v.name).join(' → ');
}
