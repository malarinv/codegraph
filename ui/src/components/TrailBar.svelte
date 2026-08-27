<script lang="ts">
  import KindGlyph from './KindGlyph.svelte';
  import { trail, hopLabel, encodeTrail } from '../lib/trail.svelte';
  import { navigate, symbolHref, flowHref } from '../lib/navigation';

  let hops = $derived(trail.hops);

  function step(index: number) {
    const hop = hops[index];
    if (!hop) return;
    trail.truncateTo(index);
    navigate(symbolHref(hop.id, { trail: encodeTrail(trail.hops) }));
  }

  /**
   * The walk itself IS the flow: the Flow view does not search for a path, it
   * looks up the edge already joining each consecutive pair and draws the cards
   * at those lines. So the trail travels under the same `t` param it uses
   * everywhere else — a flow read from a trail is one walk under two lenses.
   */
  function readAsFlow() {
    navigate(flowHref({ trail: encodeTrail(hops) }));
  }

  /**
   * Clear the path, keep the place.
   *
   * Emptying the trail while you are reading a symbol would also throw the
   * symbol away, which is not what "Clear" says. It restarts the trail at
   * where you are — one `start` hop — and only leaves for the empty screen
   * when there is nowhere to stay.
   */
  function clear() {
    const here = trail.current;
    trail.clear();
    if (!here) {
      navigate('#/');
      return;
    }
    trail.push({ id: here.id, name: here.name, kind: here.kind, dir: 'start' });
    navigate(symbolHref(here.id, { trail: encodeTrail(trail.hops) }), { replace: true });
  }
</script>

<div class="trailbar">
  <span class="label">Trail</span>

  {#if hops.length === 0}
    <span class="empty"
      >Step into a call on the right, or up to a caller on the left — the trail records the
      path.</span
    >
  {:else}
    {#each hops as hop, i (hop.id)}
      {#if i > 0}
        <span
          class="hop-arrow"
          class:up={hop.dir === 'up'}
          title={hop.dir === 'up'
            ? 'stepped up to a caller'
            : hop.dir === 'down'
              ? 'stepped down into a call'
              : 'jumped here'}
          aria-hidden="true"
        >
          {hop.dir === 'up' ? '←' : hop.dir === 'down' ? '→' : '·'}
        </span>
      {/if}
      <button
        type="button"
        class="hop"
        class:cur={i === hops.length - 1}
        aria-current={i === hops.length - 1 ? 'true' : undefined}
        onclick={() => step(i)}
      >
        <KindGlyph kind={hop.kind} />
        <span>{hopLabel(hop)}</span>
      </button>
    {/each}
  {/if}

  <span class="spacer"></span>

  {#if hops.length > 1}
    <button type="button" class="tb-btn" onclick={readAsFlow}>Read as flow</button>
  {/if}
  {#if hops.length > 0}
    <button type="button" class="tb-btn" onclick={clear}>Clear</button>
  {/if}
</div>

<style>
  .trailbar {
    display: flex;
    align-items: center;
    gap: 0;
    padding: 0 18px;
    background: var(--paper-2);
    border-bottom: 1px solid var(--rule-soft);
    overflow-x: auto;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 12px;
  }

  .label {
    margin-right: 10px;
    color: var(--ink-3);
    font-family: var(--sans);
  }

  .empty {
    color: var(--ink-3);
    font-family: var(--sans);
  }

  .hop {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    color: var(--ink-2);
    border: 1px solid transparent;
    font-family: var(--mono);
    font-size: 12px;
  }

  .hop:hover {
    color: var(--ink);
    background: var(--press);
  }

  .hop.cur {
    color: var(--accent);
    border-color: var(--accent-line);
    background: var(--paper);
  }

  .hop-arrow {
    padding: 0 2px;
    color: var(--ink-3);
  }

  .hop-arrow.up {
    color: var(--ink-2);
  }

  .spacer {
    flex: 1;
  }

  .tb-btn {
    margin-left: 8px;
    padding: 4px 8px;
    color: var(--ink-2);
    background: var(--paper);
    border: 1px solid var(--rule-soft);
    font-family: var(--sans);
  }

  .tb-btn:hover {
    color: var(--ink);
    border-color: var(--ink);
  }
</style>
