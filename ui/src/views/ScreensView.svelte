<!--
  The Screens view (`#/screens`): the app as its user meets it — one box per
  screen, an arrow for every way of getting from one to another, and on each
  arrow the condition under which it happens.

  Everything drawn comes from `/api/screens`: routes the framework resolver
  found, `navigates` edges the extractor bound, attribution back through the
  render/call chain to the screen a transition starts on, and branch guards
  read from the source. The canvas is the Map's machinery with different
  words (see `screens-model.ts`); the side panel is where the sentences are.
-->
<script lang="ts">
  import { SvelteFlow, Controls, type Node, type Edge } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import ScreenNode from '../components/screens/ScreenNode.svelte';
  import ScreenEdge from '../components/screens/ScreenEdge.svelte';
  import KindGlyph from '../components/KindGlyph.svelte';
  import { fetchScreens, type WireScreensPayload, type WireScreenLink } from '../lib/api';
  import { live } from '../lib/live.svelte';
  import { symbolHref, fileHref } from '../lib/navigation';
  import { isEdgeVisible, type MapEdgeLayout } from '../lib/map-model';
  import { buildScreensModel, neighbourhood, viaText, type ScreensModel } from '../lib/screens-model';

  let payload = $state<WireScreensPayload | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let selected = $state<string | null>(null);
  let hovered = $state<{ edge: MapEdgeLayout; x: number; y: number } | null>(null);
  let stage = $state<HTMLDivElement | null>(null);

  // The key stays open until the reader closes it; the choice survives a
  // reload but is per browser — a preference, not a fact about the project.
  const LEGEND_KEY = 'codegraph-ui:screens-legend';
  let legendOpen = $state(readLegendOpen());
  function readLegendOpen(): boolean {
    try {
      return localStorage.getItem(LEGEND_KEY) !== 'closed';
    } catch {
      return true;
    }
  }
  $effect(() => {
    try {
      localStorage.setItem(LEGEND_KEY, legendOpen ? 'open' : 'closed');
    } catch {
      // Storage refused (private mode): the key simply reopens next time.
    }
  });

  const FIT = { fitViewOptions: { padding: 0.1, maxZoom: 1, minZoom: 0.4 } };
  const nodeTypes = { screen: ScreenNode };
  const edgeTypes = { screen: ScreenEdge };

  $effect(() => {
    void live.indexTick;
    const controller = new AbortController();
    loading = true;
    error = null;
    fetchScreens(controller.signal)
      .then((next) => {
        payload = next;
        loading = false;
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        error = err instanceof Error ? err.message : String(err);
        loading = false;
      });
    return () => controller.abort();
  });

  const model = $derived<ScreensModel | null>(
    payload === null || !payload.routed ? null : buildScreensModel(payload)
  );

  const neighbours = $derived.by(() => {
    if (model === null || selected === null) return null;
    const set = new Set<string>([selected]);
    for (const edge of model.layout.edges) {
      if (edge.source === selected) set.add(edge.target);
      if (edge.target === selected) set.add(edge.source);
    }
    return set;
  });

  const nodes = $derived.by<Node[]>(() => {
    if (model === null) return [];
    return model.layout.nodes.map((node) => ({
      id: node.id,
      type: 'screen',
      position: { x: node.x, y: node.y },
      draggable: false,
      selectable: false,
      connectable: false,
      data: {
        layout: node,
        info: model.nodes.get(node.id)!,
        selected: selected === node.id,
        dimmed: neighbours !== null && !neighbours.has(node.id),
        onSelect: (id: string) => {
          selected = selected === id ? null : id;
          hovered = null;
        },
      },
    }));
  });

  const edges = $derived.by<Edge[]>(() => {
    if (model === null) return [];
    return model.layout.edges
      .filter((edge) => isEdgeVisible(edge, selected))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        type: 'screen',
        selectable: false,
        deletable: false,
        data: {
          edge,
          info: model.edges.get(edge.id)!,
          hot: hovered?.edge.id === edge.id || (selected !== null && (edge.source === selected || edge.target === selected)),
          dimmed: selected !== null && edge.source !== selected && edge.target !== selected,
          // A label only where it can be read as belonging to one line: the
          // selected screen's own edges (near that screen) and the hovered
          // edge (near its source). Unselected, the picture is lines and
          // boxes; the conditions are one click away.
          labelled: hovered?.edge.id === edge.id || (selected !== null && (edge.source === selected || edge.target === selected)),
          labelAt: selected !== null && edge.target === selected && edge.source !== selected ? 0.72 : 0.28,
          onHover: onEdgeHover,
        },
      }));
  });

  const selectedInfo = $derived(selected === null || model === null ? null : (model.nodes.get(selected) ?? null));
  const lists = $derived(
    selected === null || payload === null ? null : neighbourhood(payload, selected)
  );
  const hoveredInfo = $derived(hovered === null || model === null ? null : (model.edges.get(hovered.edge.id) ?? null));

  function onEdgeHover(edge: MapEdgeLayout | null, event: MouseEvent | null): void {
    if (edge === null || event === null || stage === null) {
      hovered = null;
      return;
    }
    const box = stage.getBoundingClientRect();
    hovered = {
      edge,
      x: Math.min(event.clientX - box.left + 14, box.width - 360),
      y: event.clientY - box.top + 14,
    };
  }

  function nameOf(id: string): string {
    return model?.nodes.get(id)?.label ?? id;
  }

  /** The row the panel prints for one transition, seen from `side`. */
  function sentence(link: WireScreenLink, side: 'from' | 'to'): string {
    const other = side === 'from' ? nameOf(link.from) : nameOf(link.to);
    return other;
  }
</script>

<div class="screens">
  <div class="stage" bind:this={stage}>
    {#if error !== null}
      <div class="state">
        <h2>The screens could not be read</h2>
        <p>{error}</p>
      </div>
    {:else if loading && payload === null}
      <div class="state"><p class="dim">Reading screens and transitions…</p></div>
    {:else if payload !== null && !payload.routed}
      <div class="state">
        <h2>No screen navigation in this graph</h2>
        <p>
          This view draws the routes a UI framework binds to components and the navigation calls
          that reach them. The index has {payload.screens.length === 0 ? 'no routes' : 'routes'} but no
          navigation between them — it is not an app with screens, or its router is one CodeGraph
          does not read yet.
        </p>
      </div>
    {:else if model !== null}
      <SvelteFlow
        {nodes}
        {edges}
        {nodeTypes}
        {edgeTypes}
        fitView
        {...FIT}
        minZoom={0.2}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        proOptions={{ hideAttribution: true }}
        onpaneclick={() => {
          selected = null;
          hovered = null;
        }}
      >
        <Controls position="bottom-right" showLock={false} />
      </SvelteFlow>

      <!-- The key, on the picture it explains. Each row draws the actual
           stroke or box, not a word for it — a reader matches shapes, not
           descriptions. Collapsible, remembered per browser. -->
      <div class="legend" class:open={legendOpen}>
        <button class="legend-h" onclick={() => (legendOpen = !legendOpen)} aria-expanded={legendOpen}>
          Key <span class="dim">{legendOpen ? '▾' : '▸'}</span>
        </button>
        {#if legendOpen}
          <div class="legend-body">
            <div class="lrow">
              <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line" /></svg>
              <span>Transition — the destination is written at the call</span>
            </div>
            <div class="lrow">
              <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line k-synth" /></svg>
              <span>Destination inferred from a helper's return value</span>
            </div>
            <div class="lrow">
              <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line k-back" /></svg>
              <span>Goes back up the picture (returning)</span>
            </div>
            <div class="lrow">
              <span class="k-label mono">when x</span>
              <span>Runs only under that condition (shown on the selected screen's lines); none = always</span>
            </div>
            <div class="lrow">
              <span class="k-box mono">/path</span>
              <span>A screen — its path and the component that renders it</span>
            </div>
            <div class="lrow">
              <span class="k-box k-entry mono"><span class="mark">●</span>/</span>
              <span>The entry screen; each row down is one more transition away</span>
            </div>
            <div class="lrow">
              <span class="k-box k-origin mono">fn()</span>
              <span>Not a screen: shared chrome, or a trigger no screen reaches</span>
            </div>
            <div class="lrow">
              <span class="k-box k-unreached mono">/path</span>
              <span>Nothing reaches it from the entry (bottom band)</span>
            </div>
          </div>
        {/if}
      </div>

      {#if hovered !== null && hoveredInfo !== null}
        <div class="tip" style={`left:${hovered.x}px;top:${hovered.y}px`}>
          <div class="mono"><b>{nameOf(hoveredInfo.from)}</b> → {nameOf(hoveredInfo.to)}</div>
          {#each hoveredInfo.links.slice(0, 5) as link (link.id)}
            <div class="tiprow">
              {#if link.when}<span class="when">when {link.when}</span>{:else}<span class="dim">always</span>{/if}
              {#if link.via.length > 0}<span class="mono dim">via {viaText(link)}</span>{/if}
            </div>
          {/each}
          {#if hoveredInfo.links.length > 5}<div class="dim">+{hoveredInfo.links.length - 5} more</div>{/if}
        </div>
      {/if}
    {/if}
  </div>

  {#if payload !== null && model !== null}
    <aside class="side">
      {#if selectedInfo !== null && lists !== null}
        <div class="head">
          <div>
            <div class="mono big">{selectedInfo.label}</div>
            {#if selectedInfo.screen?.component}
              <a class="sub" href={symbolHref(selectedInfo.screen.component.id)}>
                <KindGlyph kind={selectedInfo.screen.component.kind} />
                {selectedInfo.screen.component.name}
              </a>
            {:else if selectedInfo.origin}
              <span class="sub dim">navigates from outside any screen</span>
            {/if}
            {#if selectedInfo.screen}
              <a class="sub dim" href={fileHref(selectedInfo.screen.file)}>{selectedInfo.screen.file}</a>
            {/if}
          </div>
          <button class="clear" onclick={() => (selected = null)}>clear</button>
        </div>

        <h4>Opens from <span class="dim">{lists.opensFrom.length}</span></h4>
        {#if lists.opensFrom.length === 0}
          <p class="dim">
            {selectedInfo.entry ? 'The entry screen — the app starts here.' : 'Nothing in the graph navigates here.'}
          </p>
        {/if}
        {#each lists.opensFrom as link (link.id)}
          <div class="row">
            <button class="peer mono" onclick={() => (selected = link.from)}>{sentence(link, 'from')}</button>
            {#if link.when}<div class="when">when {link.when}</div>{/if}
            {#if link.via.length > 0}<div class="via dim">via {viaText(link)}</div>{/if}
            {#each link.sites as site (site.file + site.line)}
              <a class="site dim" href={symbolHref(link.via[link.via.length - 1]?.id ?? selectedInfo.id, { line: site.line })}
                >{site.method} {site.href} · {site.file.slice(site.file.lastIndexOf('/') + 1)}:{site.line}</a
              >
            {/each}
          </div>
        {/each}

        <h4>Goes to <span class="dim">{lists.goesTo.length}</span></h4>
        {#if lists.goesTo.length === 0}<p class="dim">No navigation leaves this screen.</p>{/if}
        {#each lists.goesTo as link (link.id)}
          <div class="row">
            <button class="peer mono" onclick={() => (selected = link.to)}>{sentence(link, 'to')}</button>
            {#if link.when}<div class="when">when {link.when}</div>{/if}
            {#if link.via.length > 0}<div class="via dim">via {viaText(link)}</div>{/if}
            {#each link.sites as site (site.file + site.line)}
              <a
                class="site dim"
                href={symbolHref(link.via[link.via.length - 1]?.id ?? selectedInfo.screen?.component?.id ?? selectedInfo.id, { line: site.line })}
                >{site.method} {site.href} · {site.file.slice(site.file.lastIndexOf('/') + 1)}:{site.line}</a
              >
            {/each}
          </div>
        {/each}
      {:else}
        <div class="head"><div class="big">Screens</div></div>
        <p>
          <b>{payload.screens.length}</b> screens · <b>{payload.links.length}</b> transitions{#if payload.origins.length > 0}
            · <b>{payload.origins.length}</b> triggered outside a screen{/if}.
        </p>
        <p class="dim">
          <span class="mark">●</span> The entry screen is at the top; each row down is one more
          transition away from it. An arrow's label is the condition under which that transition
          happens, read from the code around the navigation call; hover it for the chain the call
          travels through, click a screen for everything in and out of it.
        </p>
        <p class="dim">
          Solid: the destination is written at the call. Dashed grey: it comes back from a
          helper's return value (inferred). Dashed accent: a transition back up the picture
          (returning). Dashed box: a trigger that is not a screen — shared chrome, or code no
          screen's render chain reaches.
        </p>
        {#if model.unreached > 0}
          <p class="dim">
            <b>{model.unreached}</b> screen{model.unreached === 1 ? '' : 's'} in the band at the bottom: no
            transition in the graph reaches {model.unreached === 1 ? 'it' : 'them'} from the entry — opened
            by something the graph cannot see (a layout's initial route, a deep link), or unused.
          </p>
        {/if}
        {#if payload.dropped > 0}
          <p class="dim">{payload.dropped} navigation{payload.dropped === 1 ? '' : 's'} could not be attributed: the walk back to a screen hit a hub.</p>
        {/if}
        <h4>Most connected</h4>
        {#each [...payload.screens].sort((a, b) => b.incoming + b.outgoing - (a.incoming + a.outgoing)).slice(0, 8) as screen (screen.id)}
          <button class="peer mono" onclick={() => (selected = screen.id)}
            >{screen.path} <span class="dim">←{screen.incoming} →{screen.outgoing}</span></button
          >
        {/each}
      {/if}
    </aside>
  {/if}
</div>

<style>
  .screens {
    display: grid;
    grid-template-columns: minmax(600px, 1fr) 340px;
    height: 100%;
    min-height: 0;
  }
  .stage {
    position: relative;
    overflow: hidden;
    background: var(--paper);
  }
  .stage :global(.svelte-flow) {
    background: var(--paper);
  }
  .stage :global(.svelte-flow__handle) {
    opacity: 0;
    width: 1px;
    height: 1px;
    min-width: 0;
    min-height: 0;
    border: 0;
    pointer-events: none;
  }
  .stage :global(.svelte-flow__controls-button) {
    background: var(--paper);
    border: 0;
    border-bottom: 1px solid var(--rule-soft);
    border-radius: 0;
    color: var(--ink-2);
  }
  .stage :global(.svelte-flow__controls-button svg) {
    fill: var(--ink-2);
  }
  .state {
    padding: 48px 40px;
    max-width: 560px;
  }
  .state h2 {
    font: 600 20px var(--sans);
    margin: 0 0 8px;
  }
  .legend {
    position: absolute;
    left: 12px;
    bottom: 12px;
    z-index: 4;
    max-width: 380px;
    border: 1px solid var(--rule);
    background: var(--paper);
    font-size: 11.5px;
    color: var(--ink-2);
  }
  .legend-h {
    display: block;
    width: 100%;
    border: 0;
    background: transparent;
    padding: 5px 10px;
    text-align: left;
    color: var(--ink);
    font: 600 12px var(--sans);
    cursor: pointer;
  }
  .legend-body {
    padding: 2px 10px 8px;
    border-top: 1px solid var(--rule-soft);
  }
  .lrow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 3px 0;
  }
  .lrow > :first-child {
    flex: 0 0 44px;
    display: inline-flex;
    justify-content: center;
  }
  .k-line {
    stroke: var(--ink);
    stroke-opacity: 0.6;
    stroke-width: 1.5;
    fill: none;
  }
  .k-line.k-synth {
    stroke-dasharray: 5 3;
  }
  .k-line.k-back {
    stroke: var(--accent);
    stroke-opacity: 0.8;
    stroke-dasharray: 4 3;
  }
  .k-label {
    font-size: 10.5px;
    color: var(--ink-3);
  }
  .k-box {
    box-sizing: border-box;
    padding: 1px 5px;
    border: 1px solid var(--ink);
    font-size: 10.5px;
    color: var(--ink);
    line-height: 14px;
  }
  .k-box.k-origin {
    border-style: dashed;
    border-color: var(--ink-3);
  }
  .k-box.k-unreached {
    border-color: var(--ink-4);
    color: var(--ink-2);
  }
  .k-entry .mark {
    font-size: 8px;
    margin-right: 3px;
    vertical-align: 1px;
  }

  .tip {
    position: absolute;
    z-index: 5;
    width: 340px;
    padding: 8px 10px;
    border: 1px solid var(--ink);
    background: var(--paper);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
    font-size: 12px;
    pointer-events: none;
  }
  .tiprow {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--rule-soft);
  }
  .side {
    border-left: 1px solid var(--rule);
    padding: 14px 16px;
    overflow: auto;
    font-size: 12.5px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 10px;
  }
  .big {
    font-size: 15px;
    font-weight: 600;
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 3px;
    color: var(--ink-2);
    text-decoration: none;
  }
  .sub:hover {
    text-decoration: underline;
  }
  .clear {
    border: 1px solid var(--rule);
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    font-size: 11.5px;
    padding: 1px 7px;
    cursor: pointer;
  }
  h4 {
    margin: 16px 0 6px;
    font: 600 12.5px var(--sans);
  }
  .row {
    padding: 7px 0;
    border-top: 1px solid var(--rule-soft);
  }
  .peer {
    display: block;
    width: 100%;
    border: 0;
    background: transparent;
    padding: 2px 0;
    text-align: left;
    color: var(--ink);
    font: 500 12.5px var(--mono);
    cursor: pointer;
  }
  .peer:hover {
    text-decoration: underline;
  }
  .when {
    color: var(--ink);
    font: 400 11.5px var(--mono);
    margin-top: 2px;
  }
  .via {
    font: 400 11px var(--mono);
    margin-top: 2px;
  }
  .site {
    display: block;
    font: 400 11px var(--mono);
    margin-top: 2px;
    text-decoration: none;
  }
  .site:hover {
    text-decoration: underline;
  }
  .mono {
    font-family: var(--mono);
  }
  .dim {
    color: var(--ink-3);
  }
  .mark {
    color: var(--accent);
  }
</style>
