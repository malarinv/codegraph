<script lang="ts">
  import type { Snippet } from 'svelte';
  import { router, mapHref, flowHref, symbolHref } from '../lib/router.svelte';
  import { trail } from '../lib/trail.svelte';

  interface Props {
    /** Indexed project name, e.g. "codegraph/". Null until stats load. */
    project?: string | null;
    /** "13,060 symbols · 46,004 edges · 593 files indexed". Null until loaded. */
    stats?: string | null;
    query?: string;
    /** Results panel, owned by the search palette (CG-45). */
    palette?: Snippet;
  }

  let { project = null, stats = null, query = $bindable(''), palette }: Props = $props();

  let input: HTMLInputElement | null = $state(null);

  let view = $derived(router.route.view);

  // The Symbol tab returns you to where you were reading, not to a blank
  // view: the current symbol if you are on one, else the trail's last hop.
  let symbolTabHref = $derived.by(() => {
    const route = router.route;
    if (route.view === 'symbol') return symbolHref(route.id);
    const current = trail.current;
    return current ? symbolHref(current.id) : '#/';
  });

  export function focusSearch(): void {
    input?.focus();
    input?.select();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') input?.blur();
  }
</script>

<header class="topbar">
  <a class="brand" href="#/" aria-label="CodeGraph home">
    <span class="brand-mark" aria-hidden="true"></span>
    <span class="brand-name">CodeGraph</span>
    <span class="brand-sub">ui</span>
  </a>

  <nav class="views" aria-label="Views">
    <a href={mapHref()} class:active={view === 'map'}>Map</a>
    <a href={symbolTabHref} class:active={view === 'symbol' || view === 'home'}>Symbol</a>
    <a href={flowHref()} class:active={view === 'flow'}>Flow</a>
  </nav>

  <div class="search" role="search">
    <input
      bind:this={input}
      bind:value={query}
      {onkeydown}
      id="q"
      type="search"
      autocomplete="off"
      spellcheck="false"
      placeholder={'Search a symbol or file, or ask “how does execute reach getFile” — press / to focus'}
      aria-label="Search symbols and files"
    />
    {@render palette?.()}
  </div>

  <div class="project" title="Indexed project">
    {#if project}<span class="mono">{project}</span>{/if}
    {#if stats}<span class="dim">{stats}</span>{/if}
  </div>
</header>

<style>
  .topbar {
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    align-items: center;
    gap: 22px;
    padding: 0 18px;
    background: var(--paper);
    border-bottom: 1px solid var(--rule);
    position: relative;
    z-index: 30;
  }

  .brand {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .brand-mark {
    display: inline-block;
    width: 10px;
    height: 10px;
    align-self: center;
    border: 1.5px solid var(--ink);
    background: var(--paper);
  }

  .brand-name {
    font-weight: 600;
    font-size: 14px;
    letter-spacing: -0.01em;
  }

  .brand-sub {
    color: var(--ink-3);
    font-size: 12px;
  }

  .views {
    display: flex;
    gap: 2px;
  }

  .views a {
    padding: 5px 10px;
    color: var(--ink-2);
    border-bottom: 2px solid transparent;
  }

  .views a:hover {
    color: var(--ink);
  }

  .views a.active {
    color: var(--ink);
    border-bottom-color: var(--ink);
  }

  .search {
    position: relative;
    max-width: 720px;
  }

  #q {
    width: 100%;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--rule-soft);
    background: var(--paper-2);
    color: var(--ink);
    font: 13px var(--sans);
  }

  #q:focus {
    border-color: var(--ink);
    outline: none;
  }

  #q::placeholder {
    color: var(--ink-3);
  }

  .project {
    color: var(--ink-2);
    font-size: 12px;
    white-space: nowrap;
  }

  /* Below ~1000px the stats are the first thing worth losing. */
  @media (max-width: 1000px) {
    .project {
      display: none;
    }
  }
</style>
