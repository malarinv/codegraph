/**
 * The Flow strip's geometry, without a browser.
 *
 * The strip reads left to right: one card per hop, opened at the line that
 * makes the next call, linked by an 86px connector carrying the edge. That is a
 * straight line for one path — but two paths that share endpoints are one
 * picture, not two, so the layout is a small DAG over the union of whatever
 * flows are on screen, and a single chain is just the DAG with one node per
 * column.
 *
 * Two rules make it deterministic, which is the whole point of not using a
 * physics layout (design spec §1):
 *
 * - **A card's column is its longest distance from a start.** Two routes that
 *   rejoin therefore rejoin in the same column, and a card never sits left of
 *   something that calls it.
 * - **A card's height is computed, not measured.** The number of source lines
 *   is known before anything renders, so the rows can be packed without waiting
 *   for a `ResizeObserver` — and the card's CSS pins the same height, so the
 *   arrows land where the arithmetic said they would. The File view's outline
 *   works the same way and for the same reason.
 *
 * Tested in `__tests__/ui-flow-model.test.ts`.
 */

import type { WireFlow, WireFlowEdge, WireFlowHop } from './api';

/* ------------------------------------------------------------ dimensions -- */

/** Card width (design spec §3.5). */
export const CARD_WIDTH = 380;
/** Connector width between two cards, when the label fits inside it. */
export const LINK_WIDTH = 86;
/** Distance between two columns' left edges, for a link with an ordinary label. */
export const COLUMN_PITCH = CARD_WIDTH + LINK_WIDTH;

/**
 * Advance of IBM Plex Mono at the 11px a connector label is set in, and the
 * clear space kept either side of the longest line.
 *
 * A gap only ever GROWS past {@link LINK_WIDTH}: 86px holds `calls` and
 * `line 2029` comfortably, but a synthesized hop's `registered at App.tsx:3764`
 * is twenty-six characters, and at a fixed pitch it ran underneath the cards on
 * both sides of it — on excalidraw's `mutateElement` flow, over the source of
 * the very card the label was explaining. The label is the evidence for a hop
 * nobody can see in the source, so the picture makes room for it.
 */
const LABEL_CHAR_WIDTH = 6.65;
const LABEL_PAD = 18;

/** Card header: `10px 12px 6px` padding around one 18px row, plus a rule. */
export const HEADER_HEIGHT = 35;
/** Source window: `12px/19px` mono with 6px of padding above and below. */
export const CODE_LINE_HEIGHT = 19;
export const CODE_PADDING = 12;
/** A card with no source still says why, in one line of the same height. */
export const NO_SOURCE_HEIGHT = CODE_LINE_HEIGHT + CODE_PADDING;
/** Clear space between two cards stacked in one column. */
export const ROW_GAP = 24;
/** Canvas padding around the whole strip. */
export const PADDING = 32;

/** Exact rendered height of a card, which its CSS then pins. */
export function cardHeight(hop: WireFlowHop): number {
  const lines = hop.source?.lines?.length ?? 0;
  const body = lines > 0 ? lines * CODE_LINE_HEIGHT + CODE_PADDING : NO_SOURCE_HEIGHT;
  return HEADER_HEIGHT + body;
}

/* ----------------------------------------------------------------- model -- */

export interface FlowCardLayout {
  /** Node id — unique in the DAG even when two flows both contain it. */
  id: string;
  hop: WireFlowHop;
  x: number;
  y: number;
  width: number;
  height: number;
  column: number;
  /** Flows this card belongs to, by flow id — what dims when one is picked. */
  flows: string[];
  /** Position in the ACTIVE flow, or -1 when it is not on it. */
  step: number;
}

export interface FlowLinkLayout {
  id: string;
  source: string;
  target: string;
  edge: WireFlowEdge;
  /** Flows this link belongs to. */
  flows: string[];
  /** The full label, for the connector's tooltip. */
  label: string;
  /**
   * The label broken into short centred lines, longest path segments shortened
   * to a basename. Eighty-six pixels is about eleven monospace characters, so a
   * synthesized hop's `via interface impl / registered at payroll.go:37` has to
   * stack rather than run over both cards it sits between.
   */
  labelLines: string[];
  /** `line 2029` — drawn under the connector, when the edge recorded one. */
  lineLabel: string | null;
  /** SVG dasharray, or null for a solid line. */
  dash: string | null;
}

export interface FlowLayout {
  cards: FlowCardLayout[];
  links: FlowLinkLayout[];
  width: number;
  height: number;
  /** Longest chain on screen, in cards. */
  columns: number;
  /** Connector width after each column — {@link LINK_WIDTH} unless a label needed more. */
  gaps: number[];
}

/** Dash pattern for a link (design spec §3.5). Heuristic wins over uncertain. */
export function dashFor(edge: WireFlowEdge): string | null {
  if (edge.synthesized) return '5 3';
  if (edge.uncertain) return '2 3';
  return null;
}

/** Longest a connector label line may be before it is cut. */
export const LABEL_MAX_CHARS = 26;

/** `src/a/b/thing.go:37` reads as `thing.go:37` under an 86px connector. */
function shortenSites(text: string): string {
  return text.replace(/[\w.@$/\\-]+[/\\]([\w.$-]+:\d+)/g, '$1');
}

/**
 * The label, stacked. `\u00b7`-separated clauses become their own lines, and
 * anything still too long is cut with an ellipsis — the connector's tooltip
 * carries the untruncated text.
 */
export function labelLinesFor(edge: WireFlowEdge): string[] {
  return shortenSites(edge.label)
    .split(' \u00b7 ')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      part.length > LABEL_MAX_CHARS ? `${part.slice(0, LABEL_MAX_CHARS - 1)}\u2026` : part
    );
}

/** `line 2029`, or null when the edge carries no line. */
export function lineLabelFor(edge: WireFlowEdge): string | null {
  return typeof edge.line === 'number' && edge.line > 0 ? `line ${edge.line}` : null;
}

/**
 * Lay out the union of `flows`, highlighting `activeId`.
 *
 * Passing one flow gives a single row of cards; passing several gives the DAG
 * where they share hops. The active flow decides the vertical order — it is
 * drawn along the top of its columns — so picking a flow never re-sorts the
 * picture underneath the reader.
 */
export function buildFlowLayout(flows: readonly WireFlow[], activeId: string | null): FlowLayout {
  const active = flows.find((f) => f.id === activeId) ?? flows[0] ?? null;
  const activeSteps = new Map<string, number>();
  active?.hops.forEach((hop, index) => activeSteps.set(hop.node.id, index));

  // ---- collect nodes and edges over every flow on screen -------------------
  const cards = new Map<string, { hop: WireFlowHop; flows: string[]; order: number }>();
  const links = new Map<
    string,
    { source: string; target: string; edge: WireFlowEdge; flows: string[] }
  >();
  const successors = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  let order = 0;
  for (const flow of flows) {
    for (let i = 0; i < flow.hops.length; i++) {
      const hop = flow.hops[i] as WireFlowHop;
      const id = hop.node.id;
      const existing = cards.get(id);
      if (existing) {
        if (!existing.flows.includes(flow.id)) existing.flows.push(flow.id);
      } else {
        cards.set(id, { hop, flows: [flow.id], order: order++ });
        indegree.set(id, 0);
        successors.set(id, new Set());
      }

      const previous = flow.hops[i - 1];
      if (!previous || hop.edge === null) continue;
      // An upward hop is the same edge read backwards; the ARROW still points
      // the way the reader travelled, which is what the strip is describing.
      const from = previous.node.id;
      const key = `${from} ${id}`;
      const link = links.get(key);
      if (link) {
        if (!link.flows.includes(flow.id)) link.flows.push(flow.id);
        continue;
      }
      links.set(key, { source: from, target: id, edge: hop.edge, flows: [flow.id] });
      const outs = successors.get(from);
      if (outs && !outs.has(id)) {
        outs.add(id);
        indegree.set(id, (indegree.get(id) ?? 0) + 1);
      }
    }
  }

  if (cards.size === 0) {
    return { cards: [], links: [], width: 0, height: 0, columns: 0, gaps: [] };
  }

  // ---- column = longest distance from a start -----------------------------
  const column = new Map<string, number>();
  for (const id of cards.keys()) column.set(id, 0);
  // Kahn order, so a node is placed only after everything that reaches it.
  const pending = new Map(indegree);
  const queue = [...cards.keys()].filter((id) => (pending.get(id) ?? 0) === 0);
  const settled = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    settled.add(id);
    for (const next of successors.get(id) ?? []) {
      column.set(next, Math.max(column.get(next) ?? 0, (column.get(id) ?? 0) + 1));
      const left = (pending.get(next) ?? 0) - 1;
      pending.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  // A cycle (a flow that calls back into itself) leaves nodes unsettled. They
  // are still real hops, so they go one column past whatever reached them
  // rather than disappearing.
  for (const id of cards.keys()) {
    if (settled.has(id)) continue;
    let best = 0;
    for (const [from, outs] of successors) {
      if (outs.has(id)) best = Math.max(best, (column.get(from) ?? 0) + 1);
    }
    column.set(id, best);
  }

  // ---- pack each column, active flow first --------------------------------
  const byColumn = new Map<number, string[]>();
  for (const id of cards.keys()) {
    const c = column.get(id) ?? 0;
    const list = byColumn.get(c);
    if (list) list.push(id);
    else byColumn.set(c, [id]);
  }
  for (const list of byColumn.values()) {
    list.sort((a, b) => {
      const onA = activeSteps.has(a) ? 0 : 1;
      const onB = activeSteps.has(b) ? 0 : 1;
      if (onA !== onB) return onA - onB;
      return (cards.get(a)?.order ?? 0) - (cards.get(b)?.order ?? 0);
    });
  }

  const columns = Math.max(...byColumn.keys()) + 1;

  // Each gap is wide enough for the widest label that crosses it. Labels are
  // built here rather than in the render pass because the geometry depends on
  // them — see LABEL_CHAR_WIDTH.
  const labelled = [...links.entries()].map(([key, link]) => ({
    key,
    link,
    lines: labelLinesFor(link.edge),
    lineLabel: lineLabelFor(link.edge),
  }));
  const gaps = Array.from({ length: Math.max(0, columns - 1) }, () => LINK_WIDTH);
  for (const { link, lines, lineLabel } of labelled) {
    const from = column.get(link.source) ?? 0;
    if (from < 0 || from >= gaps.length) continue;
    const widest = Math.max(0, ...lines.map((l) => l.length), lineLabel?.length ?? 0);
    gaps[from] = Math.max(gaps[from] as number, Math.ceil(widest * LABEL_CHAR_WIDTH) + LABEL_PAD);
  }
  const columnX: number[] = [PADDING];
  for (let c = 1; c < columns; c++) {
    columnX[c] = (columnX[c - 1] as number) + CARD_WIDTH + (gaps[c - 1] as number);
  }

  const heights = new Map<string, number>();
  for (const [id, card] of cards) heights.set(id, cardHeight(card.hop));

  // Rows are centred on the tallest column, so a one-card column sits opposite
  // the middle of a two-card one instead of hugging the top of the canvas.
  const columnHeights = new Map<number, number>();
  for (const [c, list] of byColumn) {
    columnHeights.set(
      c,
      list.reduce((sum, id) => sum + (heights.get(id) ?? 0), 0) + ROW_GAP * (list.length - 1)
    );
  }
  const tallest = Math.max(...columnHeights.values());

  const laidOut = new Map<string, FlowCardLayout>();
  for (const [c, list] of byColumn) {
    let y = PADDING + (tallest - (columnHeights.get(c) ?? 0)) / 2;
    for (const id of list) {
      const card = cards.get(id) as { hop: WireFlowHop; flows: string[]; order: number };
      const height = heights.get(id) ?? 0;
      laidOut.set(id, {
        id,
        hop: card.hop,
        x: columnX[c] as number,
        y,
        width: CARD_WIDTH,
        height,
        column: c,
        flows: card.flows,
        step: activeSteps.get(id) ?? -1,
      });
      y += height + ROW_GAP;
    }
  }

  return {
    cards: [...laidOut.values()].sort((a, b) => a.column - b.column || a.y - b.y),
    links: labelled.map(({ link, lines, lineLabel }) => ({
      id: `${link.source}->${link.target}`,
      source: link.source,
      target: link.target,
      edge: link.edge,
      flows: link.flows,
      label: link.edge.label,
      labelLines: lines,
      lineLabel,
      dash: dashFor(link.edge),
    })),
    width: (columnX[columns - 1] as number) + CARD_WIDTH + PADDING,
    height: PADDING * 2 + tallest,
    columns,
    gaps,
  };
}
