/**
 * The Steps view's model — what happens from an anchor, as typed steps laid
 * out so that a step sits above the steps it sets in motion.
 *
 * Everything geometric is the Screens view's (`screens-model.ts`): the Map's
 * layout with directional ports, a curve per edge on a track of its own, the
 * pills that label a selected step's links at the far end of each line, and
 * the nearest-line pointer. What is this file's own is small: the row a step
 * sits on is its distance from the anchor, which the server already counted
 * (`WireStep.depth`), so the layering is a lookup rather than a search; the
 * words in a box come from the step's kind; and the side panel's two lists
 * are the links into and out of the selected step.
 */

import type { WireMapLink, WireMapModule, WireStep, WireStepLink, WireStepsPayload } from './wire';
import { buildMapLayout, linkId, PORT_PITCH, type MapLayout } from './map-model';
import {
  edgeLabel,
  samplePolyline,
  trackedCurves,
  SCREEN_LAYER_GAP,
  type Curve,
  type Picture,
  type Point,
} from './screens-model';

export interface StepNodeInfo {
  id: string;
  step: WireStep;
  /** What the box prints on its first line. */
  label: string;
  /** …and on its second. */
  sub: string;
}

export interface StepEdgeInfo {
  id: string;
  from: string;
  to: string;
  /** Every link between the pair — one connector, several stories. */
  links: WireStepLink[];
  /** The connector's short label: the innermost condition, or how many links. */
  label: string;
  /** Every link behind it was synthesized (a dynamic-dispatch bridge). */
  synthesized: boolean;
  /** The kind the links agree on, or `calls` when they differ. */
  kind: WireStepLink['kind'];
}

export interface StepsModel extends Picture {
  layout: MapLayout;
  nodes: Map<string, StepNodeInfo>;
  edges: Map<string, StepEdgeInfo>;
  layerGap: number;
  curves: Map<string, Curve>;
  polylines: Map<string, Point[]>;
  /** Steps per kind, for the panel's summary. */
  counts: Record<WireStep['kind'], number>;
}

/** Points a curve is sampled at for hit-testing (as the Screens view's). */
const HIT_SAMPLES = 24;

/* ---------------------------------------------------------------- words -- */

/** A short word for a step's kind, as the panel and the legend say it. */
export function kindWord(kind: WireStep['kind']): string {
  switch (kind) {
    case 'screen':
      return 'screen';
    case 'trigger':
      return 'handler';
    case 'bridge':
      return 'native call';
    case 'event':
      return 'native event';
    case 'store':
      return 'store action';
    case 'effect':
      return 'outside the index';
    default:
      return 'start';
  }
}

/** The first line of a step's box. Boundary crossings carry an arrow for which way the code goes. */
export function stepLabel(step: WireStep): string {
  switch (step.kind) {
    case 'bridge':
      return `⇢ ${step.label}`;
    case 'event': {
      const events = step.events ?? (step.event ? [step.event] : []);
      if (events.length === 0) return `⇠ ${step.label}`;
      return events.length === 1 ? `⇠ ${events[0]}` : `⇠ ${events[0]} +${events.length - 1}`;
    }
    default:
      return step.label;
  }
}

/** The second line: what the step is, then where it is. */
export function stepSub(step: WireStep): string {
  const file = step.node ? step.node.file.slice(step.node.file.lastIndexOf('/') + 1) : '';
  switch (step.kind) {
    case 'screen':
      return step.sub;
    case 'trigger':
      return `handler · ${file}`;
    case 'bridge':
      return `native · ${file}`;
    case 'event':
      return `${step.label} · ${file}`;
    case 'store':
      return `store · ${file}`;
    case 'effect':
      return step.sub;
    default:
      return step.sub;
  }
}

/* ---------------------------------------------------------------- build -- */

export function buildStepsModel(payload: WireStepsPayload): StepsModel {
  const nodes = new Map<string, StepNodeInfo>();
  const modules: WireMapModule[] = [];
  const counts: Record<WireStep['kind'], number> = {
    anchor: 0,
    screen: 0,
    trigger: 0,
    bridge: 0,
    event: 0,
    store: 0,
    effect: 0,
  };
  const degree = new Map<string, number>();
  for (const link of payload.links) {
    degree.set(link.from, (degree.get(link.from) ?? 0) + 1);
    degree.set(link.to, (degree.get(link.to) ?? 0) + 1);
  }
  for (const step of payload.steps) {
    counts[step.kind]++;
    const info: StepNodeInfo = { id: step.id, step, label: stepLabel(step), sub: stepSub(step) };
    nodes.set(step.id, info);
    modules.push({
      id: step.id,
      label: info.label,
      files: 1,
      symbols: degree.get(step.id) ?? 0,
      languages: [],
      test: false,
      generated: 0,
      generatedFiles: [],
      facade: false,
      fileList: { total: 1, shown: 1, truncated: false, items: [step.node?.file ?? step.sub] },
    });
  }

  // One layout link per (from, to); the links behind it stay listed.
  const byPair = new Map<string, WireStepLink[]>();
  for (const link of payload.links) {
    if (!nodes.has(link.from) || !nodes.has(link.to) || link.from === link.to) continue;
    const key = linkId({ source: link.from, target: link.to });
    const list = byPair.get(key) ?? [];
    list.push(link);
    byPair.set(key, list);
  }
  const links: WireMapLink[] = [];
  const edges = new Map<string, StepEdgeInfo>();
  for (const [key, group] of byPair) {
    const first = group[0]!;
    links.push({
      source: first.from,
      target: first.to,
      count: group.length,
      declared: group.length,
      byKind: [{ kind: 'calls', count: group.length }],
      topPairs: [],
    });
    edges.set(key, {
      id: key,
      from: first.from,
      to: first.to,
      links: group,
      label: edgeLabel(group),
      synthesized: group.every((l) => l.synthesized),
      kind: group.every((l) => l.kind === first.kind) ? first.kind : 'calls',
    });
  }

  // Layer = distance from the anchor, counted by the server. Layer 0 is the
  // bottom, so the deepest row is 0 and the anchor is on top.
  const depthOf = new Map(payload.steps.map((s) => [s.id, s.depth]));
  const deepest = Math.max(0, ...payload.steps.map((s) => s.depth));
  const layering = (ids: string[]): Map<string, number> =>
    new Map(ids.map((id) => [id, deepest - (depthOf.get(id) ?? deepest)]));

  const layout = buildMapLayout(
    { modules, links },
    {
      includeTests: true,
      minWeight: 0,
      sizing: (m) => {
        const info = nodes.get(m.id);
        return { label: info?.label ?? m.id, meta: info?.sub ?? '' };
      },
      layering,
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

/** The side panel's two lists for a selected step. */
export function stepNeighbourhood(
  payload: WireStepsPayload,
  id: string
): { arrivesFrom: WireStepLink[]; leadsTo: WireStepLink[] } {
  return {
    arrivesFrom: payload.links.filter((l) => l.to === id),
    leadsTo: payload.links.filter((l) => l.from === id),
  };
}

/** `useReviewHandlers → handleApproveAllImages`, or '' when nothing was folded. */
export function stepViaText(link: WireStepLink): string {
  return link.via.map((v) => v.name).join(' → ');
}

/** The layout edge a link draws as, or null when it is a self-loop. */
export function stepPairId(link: WireStepLink): string | null {
  return link.from === link.to ? null : linkId({ source: link.from, target: link.to });
}
