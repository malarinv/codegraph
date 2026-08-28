<script lang="ts">
  /**
   * One screen on the Screens view: its path, and the component that renders
   * it. An origin — a function that navigates but belongs to no screen (a
   * store action after login) — draws dashed, so it reads as a trigger rather
   * than a place. The entry screen (`/`) carries a mark.
   *
   * Hidden handles along the top and bottom, one per link, exactly as the
   * Map's module box does: the layout decided the ports, this only draws them.
   */
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import type { MapNodeLayout } from '../../lib/map-model';
  import type { ScreenNodeInfo } from '../../lib/screens-model';

  let { data }: NodeProps = $props();

  const node = $derived(
    data as unknown as {
      layout: MapNodeLayout;
      info: ScreenNodeInfo;
      selected: boolean;
      dimmed: boolean;
      onSelect: (id: string) => void;
    }
  );
  const layout = $derived(node.layout);
  const info = $derived(node.info);

  function portStyle(index: number, total: number): string {
    return `left:${((index + 1) / (total + 1)) * 100}%`;
  }
</script>

{#each layout.targetHandles as handle, i (handle)}
  <Handle
    type="target"
    id={`t:${handle}`}
    position={Position.Top}
    style={portStyle(i, layout.targetHandles.length)}
    isConnectable={false}
  />
{/each}

<button
  class="snode"
  class:sel={node.selected}
  class:dimmed={node.dimmed}
  class:origin={info.origin}
  class:entry={info.entry}
  class:unreached={info.unreached}
  style={`width:${layout.width}px;height:${layout.height}px`}
  onclick={() => node.onSelect(info.id)}
  aria-pressed={node.selected}
  title={info.origin
    ? `${info.label} — navigates, but no screen reaches it within the walk. In ${info.sub}.`
    : `${info.label} — rendered by ${info.sub}${info.entry ? '. The entry screen.' : ''}${
        info.unreached ? '. No transition in the graph reaches it from the entry.' : ''
      }`}
>
  <span class="name">{#if info.entry}<span class="mark" aria-hidden="true">●</span>{/if}{info.label}</span>
  <span class="sub">{info.sub}</span>
</button>

{#each layout.sourceHandles as handle, i (handle)}
  <Handle
    type="source"
    id={`s:${handle}`}
    position={Position.Bottom}
    style={portStyle(i, layout.sourceHandles.length)}
    isConnectable={false}
  />
{/each}

<style>
  .snode {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    box-sizing: border-box;
    padding: 0 9px;
    border: 1px solid var(--ink);
    border-radius: 0;
    background: var(--paper);
    text-align: left;
    cursor: pointer;
    font: inherit;
    color: var(--ink);
    transition: background 90ms linear;
  }
  .snode:hover,
  .snode.sel {
    border-width: 2px;
    padding: 0 8px;
    background: var(--press);
  }
  .snode.dimmed {
    border-color: var(--ink-4);
    color: var(--ink-4);
  }
  .snode.dimmed .sub {
    color: var(--ink-4);
  }
  .snode.origin {
    border-style: dashed;
    border-color: var(--ink-3);
  }
  .snode.unreached {
    border-color: var(--ink-4);
    color: var(--ink-2);
  }
  .snode:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .name {
    font: 500 13px var(--mono);
    line-height: 15px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mark {
    color: var(--accent);
    margin-right: 5px;
    font-size: 9px;
    vertical-align: 1px;
  }
  .sub {
    font: 400 11px var(--sans);
    line-height: 13px;
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
