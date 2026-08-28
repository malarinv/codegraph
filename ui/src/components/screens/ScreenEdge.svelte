<script lang="ts">
  /**
   * One transition on the Screens view — the Map's cubic, plus a label at the
   * midpoint saying under what condition it happens. A pair with several
   * transitions draws once and counts them; the tooltip and the side panel
   * tell them apart. Dashed when every transition behind it rides a
   * synthesized hop (a helper's return value); accent-dashed when it points
   * back up the layering (Capture → Home).
   */
  import { BaseEdge, type EdgeProps } from '@xyflow/svelte';
  import type { MapEdgeLayout } from '../../lib/map-model';
  import type { ScreenEdgeInfo } from '../../lib/screens-model';

  let { sourceX, sourceY, targetX, targetY, data }: EdgeProps = $props();

  const d = $derived(
    data as unknown as {
      edge: MapEdgeLayout;
      info: ScreenEdgeInfo;
      hot: boolean;
      dimmed: boolean;
      /** Show the label; only the selected screen's edges and the hovered one do. */
      labelled: boolean;
      /**
       * Where along the curve the label sits, 0 = source end, 1 = target end.
       * Close to the selected screen, where its lines are still apart, so a
       * label sits beside the one line it belongs to.
       */
      labelAt: number;
      onHover: (edge: MapEdgeLayout | null, event: MouseEvent | null) => void;
    }
  );

  const midY = $derived((sourceY + targetY) / 2);
  const path = $derived(`M${sourceX},${sourceY} C${sourceX},${midY} ${targetX},${midY} ${targetX},${targetY}`);

  /** The point at `t` on the same cubic the path draws. */
  const label = $derived.by(() => {
    const t = d.labelAt;
    const u = 1 - t;
    const x = u * u * u * sourceX + 3 * u * u * t * sourceX + 3 * u * t * t * targetX + t * t * t * targetX;
    const y = u * u * u * sourceY + 3 * u * u * t * midY + 3 * u * t * t * midY + t * t * t * targetY;
    return { x, y };
  });
  /** IBM Plex Mono at 10.5px: ~6.3px per character, plus the pill's padding. */
  const pillWidth = $derived(d.info.label.length * 6.3 + 12);
</script>

<BaseEdge
  {path}
  class={`sedge${d.edge.back ? ' back' : ''}${d.hot ? ' hot' : ''}${d.dimmed ? ' dimmed' : ''}${d.info.synthesized ? ' synth' : ''}`}
  style={`stroke-width:${Math.min(3, d.edge.width)}px`}
/>
<path
  class="hit"
  d={path}
  role="presentation"
  onmousemove={(event) => d.onHover(d.edge, event)}
  onmouseleave={() => d.onHover(null, null)}
/>
{#if d.info.label && d.labelled}
  <g class="epill" class:hot={d.hot}>
    <rect x={label.x - pillWidth / 2} y={label.y - 9} width={pillWidth} height={17} rx="2" />
    <text x={label.x} y={label.y + 3.5} text-anchor="middle">{d.info.label}</text>
  </g>
{/if}

<style>
  :global(.svelte-flow__edge-path.sedge) {
    stroke: var(--ink);
    stroke-opacity: 0.32;
    fill: none;
  }
  :global(.svelte-flow__edge-path.sedge.hot) {
    stroke-opacity: 0.95;
  }
  :global(.svelte-flow__edge-path.sedge.dimmed) {
    stroke-opacity: 0.06;
  }
  :global(.svelte-flow__edge-path.sedge.synth) {
    stroke-dasharray: 5 3;
  }
  :global(.svelte-flow__edge-path.sedge.back) {
    stroke: var(--accent);
    stroke-opacity: 0.6;
    stroke-dasharray: 4 3;
  }
  .hit {
    stroke: transparent;
    stroke-width: 12;
    fill: none;
    pointer-events: stroke;
    cursor: crosshair;
  }
  .epill {
    pointer-events: none;
  }
  .epill rect {
    fill: var(--paper);
    stroke: var(--rule);
    stroke-width: 1px;
  }
  .epill text {
    font: 400 10.5px var(--mono);
    fill: var(--ink-2);
  }
  .epill.hot rect {
    stroke: var(--ink-3);
  }
  .epill.hot text {
    fill: var(--ink);
  }
</style>
