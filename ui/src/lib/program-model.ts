/**
 * The Steps picture in the code's ORDER — the same canvas, laid out by when
 * things happen rather than by how far they are from the anchor.
 *
 * The tree's rows are distance: on proshop's login `User.findOne`, `jwt.sign`,
 * `200` and `401` are each one step out of the handler, so they land in one
 * row. True, and not the flow — the token is signed while the reply is being
 * built, so the `200` comes AFTER it, and the `401` is the other side of the
 * same `if`. This model draws that:
 *
 * ```
 *                POST /api/users/login
 *                        |
 *                  User.findOne
 *          +-------------+--------------+
 *   WHEN user AND (await ...)     WHEN NOT (...)
 *          |                            |
 *      jwt.sign                        401
 *          |
 *         200
 * ```
 *
 * **A line here means "then", not "calls"** — that is the whole difference from
 * the other reading, and the key says so. It comes from the block tree the
 * server folds out of the walk (`api/program.ts`): items in source order, forks
 * where the code forks, an arm that answers or leaves ending there. Walking that
 * tree with a set of *tails* — the steps a next step would follow — gives one
 * edge per "and then", carrying the arm's condition where the code branched.
 *
 * Everything else is the canvas's: the same boxes, the same layout engine, the
 * same pills, hover and panel. Only the graph changes.
 */

import { conditionTokens, joinTokens, type WordToken } from './conditions';
import { buildMapLayout, linkId, PORT_PITCH, type MapLayout } from './map-model';
import { samplePolyline, trackedCurves, EDGE_LABEL_MAX, SCREEN_LAYER_GAP, type Point } from './screens-model';
import { stepLabel, stepSub, type StepEdgeInfo, type StepNodeInfo, type StepsModel } from './steps-model';
import type { WireArm, WireBlock, WireItem, WireMapLink, WireMapModule, WireStep, WireStepsPayload } from './wire';

/* ----------------------------------------------------------------- words -- */

/** The construct a fork came from. */
export type ForkForm = Extract<WireItem, { kind: 'fork' }>['form'];

/**
 * What has to hold for an arm to be the one taken, in the words the rest of the
 * view uses. Said in FULL on the line, because a line on a canvas has no head
 * above it to refer back to: `WHEN user AND (await …)`, `WHEN NOT (…)`.
 */
export function whenTokens(when: string): WordToken[] {
  return conditionTokens(when);
}

/** The words on a run that is not plain sequence — said on the line into it. */
export function runWords(item: Extract<WireItem, { kind: 'block' }>): string {
  switch (item.block) {
    case 'inline':
      return item.via ? `via ${item.via.name}` : 'via a helper';
    case 'loop':
      if (!item.by) return item.loop === 'while' ? 'again and again' : 'for each item';
      return item.loop === 'while' ? `again while ${item.by}` : `for each ${item.by}`;
    case 'later':
      return item.by ? `later · ${item.by}` : 'later';
    default:
      return item.by ? `together · ${item.by}` : 'together';
  }
}

/* ----------------------------------------------------------------- graph -- */

/** One "and then": the step it follows, the step that happens, and what had to hold. */
export interface OrderEdge {
  from: string;
  to: string;
  /** The conditions on the way — the arms of the forks crossed, joined by ` && `. */
  when: string;
  /** `via generateToken`, `for each item of items`, `later · then` — the run it happens inside. */
  runs: string[];
}

/** Where a next step would follow from, and under what. */
interface Tail {
  id: string;
  when: string[];
  runs: string[];
}

export interface OrderGraph {
  edges: OrderEdge[];
  /** How many things happen before each step: its row. */
  depth: Map<string, number>;
}

/**
 * The block tree as a graph of what happens next. `anchor` is where the reading
 * starts, so the first thing in the body follows it.
 */
export function orderGraph(program: NonNullable<WireStepsPayload['program']>, anchor: string): OrderGraph {
  const edges: OrderEdge[] = [];
  const seen = new Set<string>([anchor]);
  const at = new Map<string, OrderEdge>();

  const join = (from: string, to: string, tail: Tail): void => {
    if (from === to) return;
    const key = `${from} ${to}`;
    const when = tail.when.filter((w, i) => w && tail.when.indexOf(w) === i).join(' && ');
    const found = at.get(key);
    if (found) {
      // Two ways to the same step: the picture keeps both conditions, the way
      // a link with several sites does.
      if (when !== found.when) found.when = !when || !found.when ? '' : `${found.when} || ${when}`;
      for (const r of tail.runs) if (!found.runs.includes(r)) found.runs.push(r);
      return;
    }
    const edge: OrderEdge = { from, to, when, runs: [...tail.runs] };
    at.set(key, edge);
    edges.push(edge);
  };

  const flow = (block: WireBlock, incoming: readonly Tail[], runs: readonly string[]): Tail[] => {
    let tails: Tail[] = [...incoming];
    for (const item of block) {
      if (item.kind === 'step') {
        seen.add(item.step);
        for (const t of tails) join(t.id, item.step, { ...t, runs: [...t.runs, ...runs] });
        // What the step itself sets in motion happens inside it, so the next
        // thing in the block follows THAT, not the box.
        let inner: Tail[] = [{ id: item.step, when: [], runs: [] }];
        if (item.body && item.body.length > 0) inner = flow(item.body, inner, []);
        tails = inner;
      } else if (item.kind === 'fork') {
        const out: Tail[] = [];
        for (const arm of item.arms) {
          // The arm's condition as the SOURCE has it: the words are made once,
          // at the end, or two ways of arriving would each carry their own WHEN.
          const entry = tails.map((t) => ({ id: t.id, when: [...t.when, arm.when], runs: [...t.runs, ...runs] }));
          // An arm that answers, returns or throws does not rejoin — nothing
          // leaves the last box in it, which is what says so on a canvas.
          const armTails = flow(arm.body, entry, []);
          if (arm.ends === null) out.push(...armTails);
        }
        // An `if` with no `else` runs on either way; a fork with both sides
        // covered runs on only through the arms that did not end.
        if (item.arms.length < 2) out.push(...tails.map((t) => ({ ...t, runs: [...t.runs, ...runs] })));
        tails = out;
      } else if (item.kind === 'block') {
        const label = runWords(item);
        const inner = flow(item.body, tails, [...runs, label]);
        // A helper that answers on one path still returns on another: the code
        // after the call follows the call, not nothing. And what comes after
        // the call is not inside it — a tail that fell through the block drops
        // the block's own words on the way out.
        tails = (inner.length > 0 ? inner : tails).map((t) => (t.runs.includes(label) ? { ...t, runs: t.runs.filter((r) => r !== label) } : t));
      }
    }
    return tails;
  };

  flow(program.root, [{ id: anchor, when: [], runs: [] }], []);

  // Nothing the reading holds may float: a step the walk drew but the fold
  // could not place follows the anchor, unconditionally.
  for (const id of seen) {
    if (id !== anchor && !edges.some((e) => e.to === id)) join(anchor, id, { id: anchor, when: [], runs: [] });
  }

  return { edges, depth: rows(anchor, seen, edges) };
}

/**
 * The row each step sits on: the longest run of "and then" from the anchor to
 * it, so a step never draws above something that has to happen first. Settled
 * by relaxation rather than a topological sort, because a step reached twice
 * (`session.add` before and after a check) can make the graph cyclic.
 */
function rows(anchor: string, nodes: ReadonlySet<string>, edges: readonly OrderEdge[]): Map<string, number> {
  const depth = new Map<string, number>();
  for (const id of nodes) depth.set(id, 0);
  depth.set(anchor, 0);
  for (let pass = 0; pass < nodes.size; pass++) {
    let moved = false;
    for (const e of edges) {
      const next = (depth.get(e.from) ?? 0) + 1;
      if (next > (depth.get(e.to) ?? 0)) {
        depth.set(e.to, next);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return depth;
}

/* ----------------------------------------------------------------- build -- */

/** Points a curve is sampled at for hit-testing (as the other reading's). */
const HIT_SAMPLES = 24;

/**
 * The same picture as `buildStepsModel`, laid out in the code's order. Null
 * when the anchor has no body to read — the view then offers the tree.
 */
export function buildOrderModel(payload: WireStepsPayload): StepsModel | null {
  if (!payload.program) return null;
  const anchorStep = payload.steps.find((s) => s.anchor);
  if (!anchorStep) return null;
  const graph = orderGraph(payload.program, anchorStep.id);

  const nodes = new Map<string, StepNodeInfo>();
  const modules: WireMapModule[] = [];
  const counts: StepsModel['counts'] = { anchor: 0, screen: 0, trigger: 0, bridge: 0, event: 0, store: 0, effect: 0 };
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const byId = new Map(payload.steps.map((s) => [s.id, s]));
  for (const id of [anchorStep.id, ...graph.depth.keys()]) {
    if (nodes.has(id)) continue;
    const step: WireStep | undefined = byId.get(id);
    if (!step) continue;
    counts[step.kind]++;
    const info: StepNodeInfo = { id, step, label: stepLabel(step), sub: stepSub(step, payload.project) };
    nodes.set(id, info);
    modules.push({
      id,
      label: info.label,
      files: 1,
      symbols: degree.get(id) ?? 0,
      languages: [],
      test: false,
      generated: 0,
      generatedFiles: [],
      facade: false,
      fileList: { total: 1, shown: 1, truncated: false, items: [step.node?.file ?? step.sub] },
    });
  }

  const links: WireMapLink[] = [];
  const edges = new Map<string, StepEdgeInfo>();
  for (const e of graph.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    const key = linkId({ source: e.from, target: e.to });
    if (edges.has(key)) continue;
    links.push({ source: e.from, target: e.to, count: 1, declared: 1, byKind: [{ kind: 'calls', count: 1 }], topPairs: [] });
    // The panel and the tooltip still read the walk's own links — the sites,
    // the `via` chain, what fires it — for the step the line arrives at.
    const behind = payload.links.filter((l) => l.to === e.to);
    edges.set(key, {
      id: key,
      from: e.from,
      to: e.to,
      links: behind,
      label: lineWords(e),
      synthesized: behind.length > 0 && behind.every((l) => l.synthesized),
      kind: behind[0]?.kind ?? 'calls',
    });
  }

  // Row 0 is the bottom, so the anchor — nothing happens before it — is on top.
  const deepest = Math.max(0, ...graph.depth.values());
  const layering = (ids: string[]): Map<string, number> =>
    new Map(ids.map((id) => [id, deepest - (graph.depth.get(id) ?? deepest)]));

  const layout: MapLayout = buildMapLayout(
    { modules, links },
    {
      includeTests: true,
      minWeight: 0,
      sizing: (m) => {
        const info = nodes.get(m.id);
        return { label: info?.label ?? m.id, meta: info?.sub ?? '' };
      },
      layering,
      order: (id) => nodes.get(id)?.step.order ?? Number.MAX_SAFE_INTEGER,
      layerGap: SCREEN_LAYER_GAP,
      portPitch: PORT_PITCH,
      ports: 'directional',
    }
  );
  const curves = trackedCurves(layout, SCREEN_LAYER_GAP);
  const polylines = new Map<string, Point[]>();
  for (const [id, curve] of curves) polylines.set(id, samplePolyline(curve, HIT_SAMPLES));
  return { layout, nodes, edges, layerGap: SCREEN_LAYER_GAP, curves, polylines, counts };
}

/**
 * What a line says: the whole condition the step at its end runs under — this
 * picture's lines ARE its conditions, so they are not shortened to the last
 * clause the way the other reading's are — else the run it happens inside
 * (`via generateToken`), and nothing at all when the code simply goes on.
 */
export function lineWords(e: OrderEdge): string {
  if (!e.when) return e.runs.length > 0 ? e.runs[e.runs.length - 1]! : '';
  const text = joinTokens(whenTokens(e.when));
  return text.length > EDGE_LABEL_MAX ? `${text.slice(0, EDGE_LABEL_MAX - 1)}…` : text;
}
