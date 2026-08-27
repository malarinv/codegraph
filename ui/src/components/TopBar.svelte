<script lang="ts">
  import {
    router,
    mapHref,
    flowHref,
    entryHref,
    symbolHref,
    fileHref,
    navigate,
  } from '../lib/router.svelte';
  import { trail } from '../lib/trail.svelte';
  import { palette } from '../lib/palette.svelte';
  import SearchPalette from './SearchPalette.svelte';
  import type { PaletteItem } from '../lib/search-model';
  import { openEntryTarget, walkTo } from '../lib/walk';
  import { live } from '../lib/live.svelte';

  interface Props {
    /** Indexed project name, e.g. "codegraph/". Null until stats load. */
    project?: string | null;
    /** "13,060 symbols · 46,004 edges · 593 files indexed". Null until loaded. */
    stats?: string | null;
  }

  let { project = null, stats = null }: Props = $props();

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
    palette.show();
  }

  /**
   * Following a result is a `start` hop, never `down` or `up`: nothing on
   * screen was stepped through to get there, and claiming a direction would
   * put a `→` in the trail that describes no call.
   */
  export function pick(item: PaletteItem): void {
    // A flow is not a place in the graph, so it does not join the trail: it is
    // a question about two symbols, and the Flow view answers it.
    if (item.type === 'flow') {
      palette.reset();
      input?.blur();
      navigate(flowHref({ from: item.from, to: item.to }));
      return;
    }
    // An entry-point row already knows where it goes — a handler, a file, a
    // hub — and it is the one row type that can point at a FILE.
    if (item.type === 'entry') {
      if (!item.row.target) return;
      palette.reset();
      input?.blur();
      openEntryTarget(item.row.target);
      return;
    }
    const id = item.type === 'route' ? item.nodeId : item.id;
    // A route whose handler never resolved to a node has nowhere to go; the
    // row stays, because "this URL exists and we could not place it" is true.
    if (!id) return;
    palette.reset();
    input?.blur();
    // A file result opens the File view, not the file node's Symbol view: the
    // outline is there either way, and only the File view carries the import
    // rails. (CG-45 routed these at the Symbol view because #/file was a stub.)
    if (item.type === 'symbol' && item.node.kind === 'file') {
      navigate(fileHref(item.node.file));
      return;
    }
    walkTo(
      item.type === 'route'
        ? { id, name: item.handler, kind: null }
        : { id, name: item.node.name, kind: item.node.kind },
      'start'
    );
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      palette.hide();
      input?.blur();
      return;
    }
    if (!palette.open) {
      // Any other key means the box is being used again after a dismissal.
      if (event.key !== 'Tab') palette.show();
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        palette.move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        palette.move(-1);
        break;
      case 'Enter': {
        event.preventDefault();
        const item = palette.selectedItem;
        if (item) pick(item);
        break;
      }
    }
  }

  /**
   * A click anywhere else closes the panel. `mousedown` on a row calls
   * `preventDefault`, so picking a result never races this.
   */
  function onpointerdown(event: PointerEvent) {
    if (!palette.open) return;
    const target = event.target;
    if (target instanceof Node && searchBox?.contains(target)) return;
    palette.hide();
  }

  let searchBox: HTMLDivElement | null = $state(null);

  /**
   * Why this page has stopped updating itself, when it has.
   *
   * The whole point of the live channel is that the screen keeps up with the
   * project; a screen that has silently stopped keeping up is worse than one
   * that never claimed to. So both ways it can end say so, in the one place
   * that is on every view.
   */
  let liveNote = $derived.by(() => {
    if (live.degraded !== null) {
      return {
        text: 'Live updates off',
        title: `${live.degraded} This page no longer refreshes itself — reload it after a sync.`,
      };
    }
    if (live.stopped) {
      return {
        text: 'Not live',
        title:
          'Lost the connection to codegraph ui and stopped retrying. Focus this tab to try again, or reload the page.',
      };
    }
    return null;
  });
</script>

<svelte:window {onpointerdown} />

<header class="topbar">
  <a class="brand" href="#/" aria-label="CodeGraph home">
    <span class="brand-mark" aria-hidden="true"></span>
    <span class="brand-name">CodeGraph</span>
    <span class="brand-sub">ui</span>
  </a>

  <nav class="views" aria-label="Views">
    <a href={entryHref()} class:active={view === 'entry'}>Entry points</a>
    <a href={mapHref()} class:active={view === 'map'}>Map</a>
    <a href={symbolTabHref} class:active={view === 'symbol' || view === 'home'}>Symbol</a>
    <a href={flowHref()} class:active={view === 'flow'}>Flow</a>
  </nav>

  <div class="search" role="search" bind:this={searchBox}>
    <input
      bind:this={input}
      bind:value={palette.query}
      {onkeydown}
      onfocus={() => palette.show()}
      id="q"
      type="search"
      autocomplete="off"
      spellcheck="false"
      placeholder={'Search a symbol or file, or ask “how does execute reach getFile” — press / to focus'}
      aria-label="Search symbols and files"
      role="combobox"
      aria-expanded={palette.open}
      aria-controls="palette-panel"
      aria-autocomplete="list"
      aria-activedescendant={palette.open ? `palette-row-${palette.selected}` : undefined}
    />
    {#if palette.open}
      <SearchPalette onpick={pick} />
    {/if}
  </div>

  <div class="project" title="Indexed project">
    {#if liveNote}<span class="offline" title={liveNote.title}>{liveNote.text}</span>{/if}
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

  .offline {
    padding: 2px 6px;
    margin-right: 8px;
    border: 1px solid var(--rule-soft);
    background: var(--paper-2);
    color: var(--ink-3);
    font-size: 11.5px;
  }

  /* Below ~1000px the stats are the first thing worth losing — but not the
     note that the page has stopped updating itself. */
  @media (max-width: 1000px) {
    .project .mono,
    .project .dim {
      display: none;
    }
  }
</style>
