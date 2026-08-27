<script lang="ts">
  import { untrack } from 'svelte';
  import TopBar from './components/TopBar.svelte';
  import TrailBar from './components/TrailBar.svelte';
  import HomeView from './views/HomeView.svelte';
  import SymbolView from './views/SymbolView.svelte';
  import FileView from './views/FileView.svelte';
  import MapView from './views/MapView.svelte';
  import FlowView from './views/FlowView.svelte';
  import NotFoundView from './views/NotFoundView.svelte';
  import { router, navigate, back, mapHref, flowHref } from './lib/router.svelte';
  import { trail, resolveTrailNames } from './lib/trail.svelte';
  import { project } from './lib/project.svelte';

  // One `/api/stats` for the whole app: the top bar's counts and the Symbol
  // view's blast-radius denominator come out of the same payload.
  $effect(() => {
    void project.ensure();
  });

  let topbar: TopBar | null = $state(null);

  let route = $derived(router.route);

  // Keep the in-memory trail and the `t` param in step. untrack() because the
  // body writes the same store it would otherwise read itself into a loop.
  $effect(() => {
    const current = router.route;
    const encoded = router.params.get('t');
    untrack(() => {
      trail.hydrate(encoded);
      if (current.view === 'symbol' && trail.current?.id !== current.id) {
        trail.push({ id: current.id });
      }
    });
  });

  // Hops restored from a URL carry ids and nothing else; one batched request
  // turns the bar back into names. Runs after every trail change, and does
  // nothing when every hop already has one.
  $effect(() => {
    void trail.hops.length;
    void resolveTrailNames();
  });

  function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    );
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.defaultPrevented) return;

    // Cmd/Ctrl+K reaches the search box even from inside another field.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      topbar?.focusSearch();
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;

    switch (event.key) {
      case '/':
        event.preventDefault();
        topbar?.focusSearch();
        break;
      case 'm':
        event.preventDefault();
        navigate(mapHref());
        break;
      case 'f':
        event.preventDefault();
        navigate(flowHref());
        break;
      case 'Backspace':
      case '[':
        event.preventDefault();
        back();
        break;
    }
  }
</script>

<svelte:window {onkeydown} />

<TopBar bind:this={topbar} project={project.name} stats={project.summary} />
<TrailBar />
<main>
  {#if route.view === 'symbol'}
    <SymbolView id={route.id} line={route.line} />
  {:else if route.view === 'file'}
    <FileView path={route.path} line={route.line} />
  {:else if route.view === 'map'}
    <MapView />
  {:else if route.view === 'flow'}
    <FlowView flowKey={route.key} />
  {:else if route.view === 'unknown'}
    <NotFoundView path={route.path} />
  {:else}
    <HomeView project={project.name} />
  {/if}
</main>

<style>
  /* The shell grid lives on #app (index.html's mount host) in app.css —
     Svelte's scoped styles cannot reach an element this component does not
     render. Only <main>, which it does render, is styled here. */
  main {
    /* min-height:0 lets the row shrink so the view, not the page, scrolls. */
    min-height: 0;
    overflow: hidden;
  }
</style>
