<script lang="ts">
  /**
   * One step on the Steps view. The box is the Screens view's screen box with
   * a kind: a screen is drawn exactly as there; a handler is a plain box; a
   * native call or a native event carries an accent rule on its left, where
   * the language changes under the code — and so does an endpoint the code
   * crosses to (`⇢ POST /api/users`) or a job, an event, a message arriving;
   * a store action sits on `--paper-2`;
   * a call that leaves the index is dashed, like a trigger no screen reaches
   * on the Screens view — a place the graph cannot follow into. The anchor
   * carries the entry mark. A step the walk was cut at ends its name with an
   * ellipsis, and its tooltip says which cap.
   *
   * Hidden handles along the top and bottom, one per port the layout decided
   * (`directional` ports), exactly as the screen box.
   */
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import type { MapNodeLayout } from '../../lib/map-model';
  import { kindWord, type ProjectKind, type StepNodeInfo } from '../../lib/steps-model';

  let { data }: NodeProps = $props();

  const node = $derived(
    data as unknown as {
      layout: MapNodeLayout;
      info: StepNodeInfo;
      project: ProjectKind;
      selected: boolean;
      dimmed: boolean;
      onSelect: (id: string) => void;
    }
  );
  const layout = $derived(node.layout);
  const info = $derived(node.info);
  const step = $derived(info.step);

  const cutNote = $derived.by(() => {
    switch (step.cut) {
      case 'depth':
        return ' More happens past the depth of this picture — start here to see it.';
      case 'fan-out':
        return ' It reaches more than the walk follows from one node.';
      case 'folded':
        return ' The walk folded as much plumbing as it allows from one step.';
      case 'steps':
        return ' The picture reached its size limit here.';
      case 'screen':
        return ` Another ${kindWord('screen', node.project, step)} — a chapter of its own. Start here to see what happens on it.`;
      case 'component':
        return ' The event lands in a component of another screen — a picture of its own. Start here to see it.';
      default:
        return '';
    }
  });

  function portStyle(index: number, total: number): string {
    return `left:${((index + 1) / (total + 1)) * 100}%`;
  }
</script>

{#each layout.ports.top as port, i (`${port.type}:${port.id}`)}
  <Handle
    type={port.type}
    id={`${port.type === 'source' ? 's' : 't'}:${port.id}`}
    position={Position.Top}
    style={portStyle(i, layout.ports.top.length)}
    isConnectable={false}
  />
{/each}

<button
  class={`snode k-${step.kind}`}
  class:sel={node.selected}
  class:dimmed={node.dimmed}
  class:anchor={step.anchor}
  style={`width:${layout.width}px;height:${layout.height}px`}
  onclick={() => node.onSelect(info.id)}
  aria-pressed={node.selected}
  title={`${info.label} — ${step.anchor ? 'where this picture starts; ' : ''}${kindWord(step.kind, node.project, step)}. ${info.sub}.${cutNote}`}
>
  <span class="name"
    >{#if step.anchor}<span class="mark" aria-hidden="true">●</span>{/if}{info.label}{#if step.cut !== null}<span
        class="more"
        aria-hidden="true"> …</span
      >{/if}</span
  >
  <span class="sub">{info.sub}</span>
</button>

{#each layout.ports.bottom as port, i (`${port.type}:${port.id}`)}
  <Handle
    type={port.type}
    id={`${port.type === 'source' ? 's' : 't'}:${port.id}`}
    position={Position.Bottom}
    style={portStyle(i, layout.ports.bottom.length)}
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
  /* The language changes under the code: a rule where it does. */
  .snode.k-bridge,
  .snode.k-event {
    border-left: 3px solid var(--accent);
    padding-left: 7px;
  }
  .snode.k-bridge:hover,
  .snode.k-bridge.sel,
  .snode.k-event:hover,
  .snode.k-event.sel {
    border-left-width: 3px;
    padding-left: 7px;
  }
  .snode.k-bridge.dimmed,
  .snode.k-event.dimmed {
    border-left-color: var(--accent-line);
  }
  .snode.k-store {
    background: var(--paper-2);
  }
  .snode.k-store:hover,
  .snode.k-store.sel {
    background: var(--press);
  }
  /* Outside the index: a place the graph cannot follow into. */
  .snode.k-effect {
    border-style: dashed;
    border-color: var(--ink-3);
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
  .more {
    color: var(--ink-3);
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
