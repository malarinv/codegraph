<script lang="ts">
  /**
   * A run of the rail: the items of one block, top to bottom, on a hairline.
   *
   * Recursive, because the code is: a fork is a row of arm columns, each arm a
   * block of its own; a helper drawn where it is called, a loop's body, work
   * that runs later and calls started together are bracketed blocks with a
   * label in `--ink-3`. No layout engine and no measuring — the browser lays a
   * column of boxes out, which is all a rail is.
   */
  import StepBox from './StepBox.svelte';
  import Self from './RailBlock.svelte';
  import type { RailItem } from '../../lib/program-model';
  import type { ProjectKind } from '../../lib/steps-model';
  import type { WordToken } from '../../lib/conditions';

  interface Props {
    items: RailItem[];
    project: ProjectKind;
    selected: string | null;
    /** Steps not on the selected step's line, dimmed; null = nothing is selected. */
    lit: Set<string> | null;
    onSelect: (id: string) => void;
    onStart: (id: string) => void;
    /** Whether a step may become the next anchor — false for an effect. */
    canStart: (id: string) => boolean;
  }
  let { items, project, selected, lit, onSelect, onStart, canStart }: Props = $props();
</script>

{#snippet words(tokens: WordToken[])}
  {#each tokens as t, i (i)}{#if i > 0}{' '}{/if}{#if t.kw}<b class="kw">{t.text}</b>{:else}{t.text}{/if}{/each}
{/snippet}

<div class="run">
  {#each items as item, i (i)}
    {#if item.kind === 'step'}
      <div class="line">
        {#if item.within}<span class="note">inside {item.within}(…)</span>{/if}
        {#if item.info}
          <StepBox
            info={item.info}
            {project}
            selected={selected === item.id}
            dimmed={lit !== null && !lit.has(item.id)}
            note={item.again ? 'It happens here too; what it does is read above.' : ''}
            onSelect={() => onSelect(item.id)}
            onStart={canStart(item.id) ? () => onStart(item.id) : undefined}
          />
        {:else}
          <span class="note">a step the picture left out</span>
        {/if}
        {#if item.again}<span class="note">as above</span>{/if}
      </div>
      {#if item.body.length > 0}
        <div class="nested">
          <Self items={item.body} {project} {selected} {lit} {onSelect} {onStart} {canStart} />
        </div>
      {/if}
    {:else if item.kind === 'fork'}
      {@const guard = item.arms.length <= 2 && item.arms[0]?.body.length === 0 && item.arms[0]?.ends !== null}
      {#if guard}
        <!--
          An early exit is a fork with nothing on one side: `if (!user) return`.
          A reader takes it as a guard, not as a branch — one line saying where
          the code leaves, and everything below it running when it did not — so
          it is drawn as one, and the rail does not step right for it.
        -->
        <div class="guard">
          <span class="cond mono">{@render words(item.words)}</span>
          <span class="ends inline">{item.arms[0]!.ends}</span>
        </div>
        {#if item.arms[1] && item.arms[1].body.length > 0}
          <Self items={item.arms[1].body} {project} {selected} {lit} {onSelect} {onStart} {canStart} />
        {/if}
        {#if item.arms[1]?.ends}<div class="ends">{item.arms[1].ends}</div>{/if}
      {:else}
        <div class="fork">
          <div class="cond mono">{@render words(item.words)}</div>
          <div class="arms">
            {#each item.arms as arm, a (a)}
              <div class="arm">
                <div class="armh mono">{@render words(arm.words)}</div>
                {#if arm.body.length > 0}
                  <Self items={arm.body} {project} {selected} {lit} {onSelect} {onStart} {canStart} />
                {/if}
                {#if arm.ends}<div class="ends">{arm.ends}</div>{/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {:else if item.kind === 'group'}
      <div class="group" class:again={item.again}>
        <div class="label">
          <span>{item.label}</span>{#if item.within}<span class="note">&nbsp;· inside {item.within}(…)</span>{/if}{#if item.again}<span class="note">&nbsp;· read above</span>{/if}
        </div>
        {#if item.body.length > 0}
          <Self items={item.body} {project} {selected} {lit} {onSelect} {onStart} {canStart} />
        {/if}
      </div>
    {:else}
      <div class="line"><span class="note">{item.text}</span></div>
    {/if}
  {/each}
</div>

<style>
  .run {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
  }
  /* The rail: a hairline down the left of every run but the outermost. */
  .line {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    max-width: 100%;
    min-width: 0;
  }
  .nested,
  .group {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding-left: 12px;
    border-left: 1px solid var(--rule-soft);
    max-width: 100%;
    min-width: 0;
  }
  .group.again {
    border-left-style: dashed;
  }
  .label {
    font: 400 11px var(--sans);
    color: var(--ink-3);
  }
  .note {
    font: 400 11px var(--sans);
    color: var(--ink-3);
  }
  .fork {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    max-width: 100%;
    min-width: 0;
  }
  .cond {
    font-size: 12px;
    line-height: 16px;
    padding: 2px 7px;
    border: 1px solid var(--rule-soft);
    background: var(--paper-2);
    color: var(--ink-2);
    max-width: 640px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .arms {
    display: flex;
    align-items: flex-start;
    gap: 18px;
    min-width: 0;
  }
  .arm {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 0 0 12px;
    border-left: 1px solid var(--rule-soft);
    border-top: 1px solid var(--rule-soft);
    min-width: 0;
  }
  .armh {
    font-size: 11.5px;
    line-height: 15px;
    color: var(--ink-2);
    max-width: 520px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ends {
    font: 400 11px var(--sans);
    color: var(--ink-3);
    border-top: 1px solid var(--rule-faint);
    padding-top: 4px;
    align-self: stretch;
  }
  /* An early exit: the condition and where it leaves, on one line. */
  .guard {
    display: flex;
    align-items: baseline;
    gap: 8px;
    max-width: 100%;
    min-width: 0;
  }
  .ends.inline {
    border-top: 0;
    padding-top: 0;
    align-self: auto;
    white-space: nowrap;
  }
  .kw {
    font-weight: 600;
  }
</style>
