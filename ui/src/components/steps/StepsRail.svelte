<script lang="ts">
  /**
   * The Steps view read in the code's ORDER: the anchor at the top, then its
   * body top to bottom — the calls in the order they are written, a fork where
   * the code forks, its arms side by side, an arm that answers or leaves ending
   * there. It is the same walk the canvas draws, folded by
   * `api/program.ts` and worded by `program-model.ts`; a click selects a step
   * and fills the same panel, a double-click starts the picture there.
   */
  import StepBox from './StepBox.svelte';
  import RailBlock from './RailBlock.svelte';
  import type { Snippet } from 'svelte';
  import type { RailItem } from '../../lib/program-model';
  import { triggerWords, type ProjectKind, type StepNodeInfo } from '../../lib/steps-model';

  interface Props {
    anchor: StepNodeInfo;
    items: RailItem[];
    project: ProjectKind;
    selected: string | null;
    lit: Set<string> | null;
    /** Items the reading could not place — a recursion or a cap it hit. */
    truncated: number;
    onSelect: (id: string) => void;
    onStart: (id: string) => void;
    canStart: (id: string) => boolean;
    /** The key, last in the document — a rail scrolls, so it cannot float over it. */
    children?: Snippet;
  }
  let { anchor, items, project, selected, lit, truncated, onSelect, onStart, canStart, children }: Props = $props();
</script>

<div class="rail">
  <div class="head">
    <StepBox
      info={anchor}
      {project}
      selected={selected === anchor.id}
      dimmed={false}
      onSelect={() => onSelect(anchor.id)}
    />
    {#if anchor.step.trigger}
      <div class="fires"><b class="kw">FIRES FROM</b> {triggerWords(anchor.step.trigger)}</div>
    {/if}
  </div>
  {#if items.length === 0}
    <p class="empty">Nothing in the index happens in this symbol's body — the picture has no order to read.</p>
  {:else}
    <div class="body">
      <RailBlock {items} {project} {selected} {lit} {onSelect} {onStart} {canStart} />
    </div>
  {/if}
  {#if truncated > 0}
    <p class="empty">
      {truncated} place{truncated === 1 ? '' : 's'} the reading stopped: code it had already read, or as deep as it goes.
      Start at a step to read on from there.
    </p>
  {/if}
  {@render children?.()}
</div>

<style>
  .rail {
    height: 100%;
    overflow: auto;
    padding: 20px 24px 64px;
    box-sizing: border-box;
    background: var(--paper);
  }
  .head {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    padding-bottom: 12px;
  }
  .body {
    padding-left: 12px;
    border-left: 1px solid var(--rule-soft);
  }
  .fires {
    font: 400 11.5px var(--sans);
    color: var(--ink-2);
  }
  .kw {
    font: 600 11.5px var(--mono);
  }
  .empty {
    font: 400 12px var(--sans);
    color: var(--ink-3);
    max-width: 60ch;
    margin: 16px 0 0;
  }
</style>
