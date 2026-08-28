<!--
  The Steps view (`#/steps?anchor=…`): what happens from here. One box per
  step — a screen, a handler, a call into native code, a native event landing
  back in JS, a store action, a call that leaves the index — an arrow for
  every way one leads to the next, and on each arrow the condition under
  which it happens, with the plumbing between two steps folded into the arrow
  and listed in the panel.

  Everything drawn comes from `/api/steps`: the anchor's forward walk through
  calls, renders, handler bindings and navigations, classified as it goes, and
  branch guards read from the source. The canvas is the Screens view's
  machinery with a different node universe (see `steps-model.ts`); the side
  panel is where the sentences are, and where a step becomes the next anchor
  or a Flow strip between two steps.
-->
<script lang="ts">
  import { SvelteFlow, Controls, type Node, type Edge, type Viewport } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import StepNode from '../components/steps/StepNode.svelte';
  import ScreenEdge from '../components/screens/ScreenEdge.svelte';
  import KindGlyph from '../components/KindGlyph.svelte';
  import {
    canDrawSteps,
    fetchScreens,
    fetchSteps,
    type WireScreen,
    type WireStepLink,
    type WireStepsPayload,
  } from '../lib/api';
  import { live } from '../lib/live.svelte';
  import { fileHref, flowHref, navigate, stepsHref, symbolHref } from '../lib/navigation';
  import { isEdgeVisible, type MapEdgeLayout } from '../lib/map-model';
  import { hoverPill, nearestEdge, placeLabels } from '../lib/screens-model';
  import { commonTokens, conditionTokens, restTokens, scenarios, whenWords, type WordToken } from '../lib/conditions';
  import {
    buildStepsModel,
    kindWord,
    stepNeighbourhood,
    stepPairId,
    stepViaText,
    type StepsModel,
  } from '../lib/steps-model';

  interface Props {
    anchor: string | null;
    symbol: string | null;
    depth: number | null;
    /** Enter the screens the walk reaches, instead of drawing them as boundaries. */
    through: boolean;
  }
  let { anchor, symbol, depth, through }: Props = $props();

  let payload = $state<WireStepsPayload | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let selected = $state<string | null>(null);
  let hovered = $state<{ edge: MapEdgeLayout; x: number; y: number } | null>(null);
  /** The panel row under the pointer: its edge on the canvas, and the one link it names. */
  let panelHot = $state<{ edge: string; link: WireStepLink } | null>(null);
  let stage = $state<HTMLDivElement | null>(null);
  let viewport = $state<Viewport | undefined>(undefined);
  const HOVER_REACH = 10;

  /** The chooser's list, when the view opens without an anchor. */
  let screens = $state<WireScreen[] | null>(null);

  const LEGEND_KEY = 'codegraph-ui:steps-legend';
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
  const nodeTypes = { step: StepNode };
  const edgeTypes = { screen: ScreenEdge };
  const DEPTHS = [4, 6, 8, 10, 12];

  const asked = $derived(anchor !== null || symbol !== null);
  const supported = canDrawSteps();

  $effect(() => {
    void live.indexTick;
    const request =
      anchor !== null
        ? { anchor, depth: depth ?? undefined, through }
        : symbol !== null
          ? { symbol, depth: depth ?? undefined, through }
          : null;
    const controller = new AbortController();
    selected = null;
    hovered = null;
    panelHot = null;
    if (request === null) {
      payload = null;
      loading = false;
      error = null;
      fetchScreens(controller.signal)
        .then((next) => {
          screens = next.routed ? next.screens : [];
        })
        .catch(() => {
          screens = [];
        });
      return () => controller.abort();
    }
    loading = true;
    error = null;
    fetchSteps(request, controller.signal)
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

  const model = $derived<StepsModel | null>(payload === null ? null : buildStepsModel(payload));

  const neighbours = $derived.by(() => {
    if (model === null || selected === null) return null;
    const set = new Set<string>([selected]);
    for (const edge of model.layout.edges) {
      if (edge.source === selected) set.add(edge.target);
      if (edge.target === selected) set.add(edge.source);
    }
    return set;
  });

  const pills = $derived(model === null ? null : placeLabels(model, selected));
  const focusId = $derived(hovered?.edge.id ?? panelHot?.edge ?? null);
  const focusPill = $derived.by(() => {
    if (model === null || focusId === null || pills?.pills.has(focusId)) return null;
    const full = panelHot?.edge === focusId ? fullText(panelHot.link) : undefined;
    return hoverPill(model, focusId, selected, full, pills ?? undefined);
  });

  const nodes = $derived.by<Node[]>(() => {
    if (model === null) return [];
    return model.layout.nodes.map((node) => ({
      id: node.id,
      type: 'step',
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
          panelHot = null;
        },
      },
    }));
  });

  const edges = $derived.by<Edge[]>(() => {
    if (model === null) return [];
    const focus = focusId;
    return model.layout.edges
      .filter((edge) => isEdgeVisible(edge, selected))
      .map((edge) => {
        const touches = selected !== null && (edge.source === selected || edge.target === selected);
        const isFocus = focus === edge.id;
        const hot = isFocus || touches;
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          type: 'screen',
          selectable: false,
          deletable: false,
          zIndex: isFocus ? 3 : hot ? 2 : 1,
          data: {
            edge,
            info: model.edges.get(edge.id)!,
            curve: model.curves.get(edge.id)!,
            hot,
            soft: hot && focus !== null && !isFocus,
            focus: isFocus,
            dimmed: selected !== null && !touches,
            pill: pills?.pills.get(edge.id) ?? (isFocus ? focusPill : null),
            full: panelHot?.edge === edge.id ? fullText(panelHot.link) : null,
            onHover: onEdgeHover,
          },
        };
      });
  });

  const selectedInfo = $derived(selected === null || model === null ? null : (model.nodes.get(selected) ?? null));
  const lists = $derived(selected === null || payload === null ? null : stepNeighbourhood(payload, selected));
  const hoveredInfo = $derived(hovered === null || model === null ? null : (model.edges.get(hovered.edge.id) ?? null));
  const edgeById = $derived(
    model === null ? new Map<string, MapEdgeLayout>() : new Map(model.layout.edges.map((e) => [e.id, e]))
  );
  const visibleIds = $derived(new Set(edges.map((e) => e.id)));

  /** The same picture with one setting changed: the anchor as the URL asked for it, the rest kept. */
  function rewrite(changes: { depth?: number; through?: boolean }): string {
    const opts = {
      anchor: anchor ?? undefined,
      symbol: anchor === null ? (symbol ?? undefined) : undefined,
      depth: changes.depth ?? depth ?? undefined,
      through: changes.through ?? through,
    };
    return stepsHref(opts);
  }

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

  function onStageMove(event: MouseEvent): void {
    if (model === null || stage === null) return;
    const target = event.target as Element | null;
    if (target?.closest('.spill')) return;
    if (target?.closest('.snode, .legend, .tip, .svelte-flow__controls')) {
      hovered = null;
      return;
    }
    const view = viewport ?? readViewport();
    if (!view) return;
    const box = stage.getBoundingClientRect();
    const point = {
      x: (event.clientX - box.left - view.x) / view.zoom,
      y: (event.clientY - box.top - view.y) / view.zoom,
    };
    const hit = nearestEdge(model, point, visibleIds, HOVER_REACH / view.zoom);
    const edge = hit === null ? undefined : edgeById.get(hit.id);
    if (!edge) {
      hovered = null;
      return;
    }
    hovered = {
      edge,
      x: Math.min(event.clientX - box.left + 14, box.width - 360),
      y: event.clientY - box.top + 14,
    };
  }

  function readViewport(): Viewport | null {
    const el = stage?.querySelector<HTMLElement>('.svelte-flow__viewport');
    const m = el?.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/);
    return m ? { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) } : null;
  }

  function onRowHover(link: WireStepLink | null): void {
    const edge = link === null ? null : stepPairId(link);
    panelHot = link === null || edge === null ? null : { edge, link };
  }

  /** The words a panel row puts on its line: the arrow, and the whole condition. */
  function fullText(link: WireStepLink): string {
    const arriving = selected !== null && link.to === selected && link.from !== selected;
    return `${arriving ? '←' : '→'} ${whenWords(link.when) || 'always'}`;
  }

  function rowHot(link: WireStepLink): boolean {
    if (panelHot !== null) return panelHot.link.id === link.id;
    return hovered !== null && stepPairId(link) === hovered.edge.id;
  }

  function nameOf(id: string): string {
    return model?.nodes.get(id)?.label ?? id;
  }

  /** A Flow strip between the two symbols of a link, when both are symbols. */
  function stripHref(link: WireStepLink): string | null {
    const from = payload?.steps.find((s) => s.id === link.from)?.node;
    const to = payload?.steps.find((s) => s.id === link.to)?.node;
    if (!from || !to) return null;
    return flowHref({ from: from.name, to: to.name });
  }

  /** The symbol a site's line belongs to: the last folded symbol, else the step's own. */
  function siteHref(link: WireStepLink, site: { file: string; line: number }, fallback: string | null): string | null {
    const last = link.via[link.via.length - 1];
    const id = last?.id ?? fallback;
    return id === null ? null : symbolHref(id, { line: site.line });
  }

  function basename(file: string): string {
    return file.slice(file.lastIndexOf('/') + 1);
  }

  /** `SecureStore.setItemAsync('userEmail', values.email)` — the site, with what it passes when that could be read. */
  function siteWords(site: { text: string; args?: string }): string {
    return site.args === undefined ? site.text : `${site.text}(${site.args})`;
  }
</script>

{#snippet words(tokens: WordToken[])}
  {#each tokens as t, i (i)}{#if i > 0}{' '}{/if}{#if t.kw}<b class="kw">{t.text}</b>{:else}{t.text}{/if}{/each}
{/snippet}

<div class="steps">
  <div class="stage" bind:this={stage} role="presentation" onmousemove={onStageMove} onmouseleave={() => (hovered = null)}>
    {#if !supported}
      <div class="state">
        <h2>This viewer cannot draw steps</h2>
        <p>The host it runs in has not wired the steps question. The Screens and Flow views still work.</p>
      </div>
    {:else if !asked}
      <div class="state chooser">
        <h2>What happens from where?</h2>
        <p>
          Pick a screen and this view draws everything it sets in motion — its handlers, the calls that
          cross into native code, the events that come back, the state it writes, the requests that leave
          the app — one box per step, an arrow for every way one leads to the next, and on each arrow the
          condition under which it happens. Or search a symbol and choose <i>What happens from here</i>.
        </p>
        {#if screens === null}
          <p class="dim">Reading screens…</p>
        {:else if screens.length === 0}
          <p class="dim">
            No screens in this graph. Open a symbol from the search box and follow <i>What happens from here</i>,
            or link here directly with <span class="mono">#/steps?symbol=&lt;name&gt;</span>.
          </p>
        {:else}
          <div class="chooser-list">
            {#each [...screens].sort((a, b) => b.outgoing + b.incoming - (a.outgoing + a.incoming) || a.path.localeCompare(b.path)) as screen (screen.id)}
              <a class="pick mono" href={stepsHref({ anchor: screen.id })}
                >{screen.path} <span class="dim sans">{screen.component?.name ?? basename(screen.file)}</span></a
              >
            {/each}
          </div>
        {/if}
      </div>
    {:else if error !== null}
      <div class="state">
        <h2>The steps could not be read</h2>
        <p>{error}</p>
      </div>
    {:else if loading && payload === null}
      <div class="state"><p class="dim">Walking from the anchor…</p></div>
    {:else if model !== null && payload !== null}
      <SvelteFlow
        {nodes}
        {edges}
        {nodeTypes}
        {edgeTypes}
        fitView
        {...FIT}
        bind:viewport
        minZoom={0.2}
        maxZoom={3}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        proOptions={{ hideAttribution: true }}
        onpaneclick={() => {
          selected = null;
          hovered = null;
          panelHot = null;
        }}
      >
        <Controls position="bottom-right" showLock={false} />
      </SvelteFlow>

      <div class="legend" class:open={legendOpen}>
        <button class="legend-h" onclick={() => (legendOpen = !legendOpen)} aria-expanded={legendOpen}>
          Key <span class="dim">{legendOpen ? '▾' : '▸'}</span>
        </button>
        {#if legendOpen}
          <div class="legend-body">
            <div class="lrow">
              <span class="k-box k-anchor mono"><span class="mark">●</span>start</span>
              <span>Where the picture starts; each row down is one more step away</span>
            </div>
            <div class="lrow">
              <span class="k-box mono">/path</span>
              <span>A screen, or a handler — a function wired to a tap or a listener</span>
            </div>
            <div class="lrow">
              <span class="k-box k-cross mono">⇢ fn</span>
              <span>The code crosses into native (⇢ a bridge call) or comes back from it (⇠ an event)</span>
            </div>
            <div class="lrow">
              <span class="k-box k-store mono">set</span>
              <span>A store action — a function in a store file</span>
            </div>
            <div class="lrow">
              <span class="k-box k-effect mono">api</span>
              <span>A call that leaves the index: the network, storage, the device, telemetry</span>
            </div>
            <div class="lrow">
              <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line" /></svg>
              <span>Leads to — the plumbing between the two is folded into the line</span>
            </div>
            <div class="lrow">
              <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line k-synth" /></svg>
              <span>Established by a synthesized hop (an event channel, a callback, a helper's return value)</span>
            </div>
            <div class="lrow">
              <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line k-back" /></svg>
              <span>Goes back up the picture — leaves the top of its box, arrives at the bottom of the other</span>
            </div>
            <div class="lrow">
              <span class="k-label mono">→ …x</span>
              <span>The last condition checked before the step, beside the box at the other end of the selected step's line; ← when it arrives there. None = always</span>
            </div>
            <div class="lrow">
              <span class="k-label mono">name …</span>
              <span>Not entered: another screen (a chapter of its own), or a cap the walk hit — start there to see on</span>
            </div>
          </div>
        {/if}
      </div>

      {#if hovered !== null && hoveredInfo !== null}
        <div class="tip" style={`left:${hovered.x}px;top:${hovered.y}px`}>
          <div class="mono"><b>{nameOf(hoveredInfo.from)}</b> → {nameOf(hoveredInfo.to)}</div>
          {#each hoveredInfo.links.slice(0, 5) as link (link.id)}
            <div class="tiprow">
              {#if link.sites.length > 1}<span class="dim">{link.sites.length} ways</span>{/if}
              <span class="when">{@render words(conditionTokens(link.when))}</span>
              {#if link.via.length > 0}<span class="mono dim">via {stepViaText(link)}</span>{/if}
              {#if link.label}<span class="dim">{link.label}</span>{/if}
              {#if link.sites[0]}<span class="mono">{siteWords(link.sites[0])}</span>{/if}
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
            <div class="sub dim">{kindWord(selectedInfo.step.kind)}{#if selectedInfo.step.anchor} · where the picture starts{/if}</div>
            {#if selectedInfo.step.screen?.component}
              <a class="sub" href={symbolHref(selectedInfo.step.screen.component.id)}>
                <KindGlyph kind={selectedInfo.step.screen.component.kind} />
                {selectedInfo.step.screen.component.name}
              </a>
            {:else if selectedInfo.step.node && selectedInfo.step.kind !== 'screen'}
              <a class="sub" href={symbolHref(selectedInfo.step.node.id)}>
                <KindGlyph kind={selectedInfo.step.node.kind} />
                {selectedInfo.step.node.name}
              </a>
            {/if}
            {#if selectedInfo.step.effect}
              <a class="sub" href={symbolHref(selectedInfo.step.effect.by.id, { line: selectedInfo.step.effect.line })}>
                <KindGlyph kind={selectedInfo.step.effect.by.kind} />
                {selectedInfo.step.effect.by.name} · line {selectedInfo.step.effect.line}
              </a>
            {/if}
            {#if selectedInfo.step.node}
              <a class="sub dim" href={fileHref(selectedInfo.step.node.file)}>{selectedInfo.step.node.file}</a>
            {/if}
            {#if selectedInfo.step.node && !selectedInfo.step.anchor}
              <a class="sub act" href={stepsHref({ anchor: selectedInfo.step.node.id })}>Start here →</a>
            {/if}
          </div>
          <button class="clear" onclick={() => (selected = null)}>clear</button>
        </div>
        {#if selectedInfo.step.cut === 'screen'}
          <p class="dim note">Another screen — a chapter of its own. Start here to see what happens on it, or continue through screens from the summary.</p>
        {:else if selectedInfo.step.cut === 'component'}
          <p class="dim note">The event lands in a component of another screen — a picture of its own. Start here to see it, or continue through screens from the summary.</p>
        {:else if selectedInfo.step.cut !== null}
          <p class="dim note">
            The walk was cut at this step ({selectedInfo.step.cut === 'depth'
              ? 'the picture’s depth'
              : selectedInfo.step.cut === 'fan-out'
                ? 'more calls than the walk follows from one node'
                : selectedInfo.step.cut === 'folded'
                  ? 'as much plumbing as it folds from one step'
                  : 'the picture’s size'}). Start here to see on.
          </p>
        {/if}
        {#if selectedInfo.step.effect && selectedInfo.step.effect.apis.length > 1}
          <p class="dim note mono">{selectedInfo.step.effect.apis.join(' · ')}</p>
        {/if}
        {#if selectedInfo.step.events && selectedInfo.step.events.length > 1}
          <p class="dim note mono">⇠ {selectedInfo.step.events.join(' · ')}</p>
        {/if}
        {#if pills !== null && pills.hidden > 0}
          <p class="dim note">
            {pills.hidden} condition{pills.hidden === 1 ? '' : 's'} not drawn on the picture for want of
            room — hover a row below to see {pills.hidden === 1 ? 'it' : 'each'} on its line.
          </p>
        {/if}

        <h4>Arrives from <span class="dim">{lists.arrivesFrom.length}</span></h4>
        {#if lists.arrivesFrom.length === 0}
          <p class="dim">{selectedInfo.step.anchor ? 'The anchor — the picture starts here.' : 'Nothing in the picture leads here.'}</p>
        {/if}
        {#each lists.arrivesFrom as link (link.id)}
            {@const sc = scenarios(link.sites)}
            {@const fallback = payload.steps.find((s) => s.id === link.from)?.node?.id ?? null}
          <div
            class="row"
            class:hot={rowHot(link)}
            role="presentation"
            onmouseenter={() => onRowHover(link)}
            onmouseleave={() => onRowHover(null)}
            onfocusin={() => onRowHover(link)}
            onfocusout={() => onRowHover(null)}
          >
            <button class="peer mono" onclick={() => (selected = link.from)}>{nameOf(link.from)}</button>
            {#if sc.common.length > 0}<div class="when">{@render words(commonTokens(sc.common))}</div>{/if}
            {#if link.via.length > 0}<div class="via dim">via {stepViaText(link)}</div>{/if}
            {#if link.label}<div class="via dim">{link.label}</div>{/if}
            {#if sc.rows.length > 1}<div class="ways dim">{sc.rows.length} ways</div>{/if}
            {#each sc.rows as row (row.site.file + row.site.line)}
              {@const href = siteHref(link, row.site, fallback)}
              <div class="scenario" class:many={sc.rows.length > 1}>
                {#if sc.rows.length > 1}<div class="when">{@render words(restTokens(row.rest, sc.common.length > 0))}</div>{/if}
                {#if href}
                  <a class="site" {href}>{siteWords(row.site)} <span class="dim">· {basename(row.site.file)}:{row.site.line}</span></a>
                {:else}
                  <span class="site">{siteWords(row.site)} <span class="dim">· {basename(row.site.file)}:{row.site.line}</span></span>
                {/if}
              </div>
            {/each}
            {#if stripHref(link)}<a class="site act" href={stripHref(link)}>Open as a flow →</a>{/if}
          </div>
        {/each}

        <h4>Leads to <span class="dim">{lists.leadsTo.length}</span></h4>
        {#if lists.leadsTo.length === 0}
          <p class="dim">
            {selectedInfo.step.kind === 'effect' ? 'Outside the index: the graph cannot follow it further.' : 'Nothing the walk follows leaves this step.'}
          </p>
        {/if}
        {#each lists.leadsTo as link (link.id)}
            {@const sc = scenarios(link.sites)}
            {@const fallback = selectedInfo.step.screen?.component?.id ?? selectedInfo.step.node?.id ?? null}
          <div
            class="row"
            class:hot={rowHot(link)}
            role="presentation"
            onmouseenter={() => onRowHover(link)}
            onmouseleave={() => onRowHover(null)}
            onfocusin={() => onRowHover(link)}
            onfocusout={() => onRowHover(null)}
          >
            <button class="peer mono" onclick={() => (selected = link.to)}>{nameOf(link.to)}</button>
            {#if sc.common.length > 0}<div class="when">{@render words(commonTokens(sc.common))}</div>{/if}
            {#if link.via.length > 0}<div class="via dim">via {stepViaText(link)}</div>{/if}
            {#if link.label}<div class="via dim">{link.label}</div>{/if}
            {#if sc.rows.length > 1}<div class="ways dim">{sc.rows.length} ways</div>{/if}
            {#each sc.rows as row (row.site.file + row.site.line)}
              {@const href = siteHref(link, row.site, fallback)}
              <div class="scenario" class:many={sc.rows.length > 1}>
                {#if sc.rows.length > 1}<div class="when">{@render words(restTokens(row.rest, sc.common.length > 0))}</div>{/if}
                {#if href}
                  <a class="site" {href}>{siteWords(row.site)} <span class="dim">· {basename(row.site.file)}:{row.site.line}</span></a>
                {:else}
                  <span class="site">{siteWords(row.site)} <span class="dim">· {basename(row.site.file)}:{row.site.line}</span></span>
                {/if}
              </div>
            {/each}
            {#if stripHref(link)}<a class="site act" href={stripHref(link)}>Open as a flow →</a>{/if}
          </div>
        {/each}
      {:else}
        <div class="head">
          <div>
            <div class="big">What happens from <span class="mono">{payload.anchor.name}</span></div>
            <a class="sub" href={symbolHref(payload.anchor.id)}>
              <KindGlyph kind={payload.anchor.kind} />
              {payload.anchor.qualifiedName}
            </a>
            <a class="sub dim" href={fileHref(payload.anchor.file)}>{payload.anchor.file}</a>
          </div>
        </div>
        {#if payload.ambiguous.length > 0}
          <p class="dim note">
            {payload.ambiguous.length} other symbol{payload.ambiguous.length === 1 ? '' : 's'} share this name:
            {#each payload.ambiguous as other, i (other.id)}
              {#if i > 0},{/if}
              <a href={stepsHref({ anchor: other.id })}>{other.kind} in {basename(other.file)}</a>
            {/each}
          </p>
        {/if}
        <p>
          <b>{payload.steps.length}</b> steps · <b>{payload.links.length}</b> links · depth
          <select
            class="depth"
            value={String(payload.depth)}
            onchange={(e) => navigate(rewrite({ depth: Number((e.currentTarget as HTMLSelectElement).value) }))}
          >
            {#each DEPTHS as d (d)}
              <option value={String(d)}>{d}</option>
            {/each}
            {#if !DEPTHS.includes(payload.depth)}<option value={String(payload.depth)}>{payload.depth}</option>{/if}
          </select>
        </p>
        <p>
          <label class="opt">
            <input type="checkbox" checked={payload.through} onchange={(e) => navigate(rewrite({ through: (e.currentTarget as HTMLInputElement).checked }))} />
            Continue through screens
          </label>
          <span class="dim">— otherwise another screen is drawn as a boundary, and is a click from being the next anchor.</span>
        </p>
        <p class="counts">
          {#each ['screen', 'trigger', 'bridge', 'event', 'store', 'effect'] as const as kind (kind)}
            {#if model.counts[kind] > 0}
              <span><b>{model.counts[kind]}</b> {kindWord(kind)}{model.counts[kind] === 1 ? '' : 's'}</span>
            {/if}
          {/each}
        </p>
        <p class="dim">
          <span class="mark">●</span> The anchor is at the top; each row down is one more step away from
          it. Click a step and each of its links is labelled at the far end of its line with the last
          condition checked before it happens; hover the line, or its row here, for the whole chain and the
          plumbing it travels through. A step is the next anchor, and any link opens as a Flow strip.
        </p>
        {#if payload.truncated.steps > 0 || payload.truncated.hubs > 0 || payload.truncated.chrome > 0}
          <p class="dim">
            Not drawn:
            {#if payload.truncated.steps > 0}<b>{payload.truncated.steps}</b> step{payload.truncated.steps === 1 ? '' : 's'} past the picture’s size limit;{/if}
            {#if payload.truncated.hubs > 0}<b>{payload.truncated.hubs}</b> walk{payload.truncated.hubs === 1 ? '' : 's'} that reached a hub;{/if}
            {#if payload.truncated.chrome > 0}<b>{payload.truncated.chrome}</b> into shared chrome.{/if}
          </p>
        {/if}
        <h4>Most connected</h4>
        {#each [...payload.steps].sort((a, b) => (model.layout.nodes.find((n) => n.id === b.id)?.ports.top.length ?? 0) + (model.layout.nodes.find((n) => n.id === b.id)?.ports.bottom.length ?? 0) - ((model.layout.nodes.find((n) => n.id === a.id)?.ports.top.length ?? 0) + (model.layout.nodes.find((n) => n.id === a.id)?.ports.bottom.length ?? 0))).slice(0, 8) as step (step.id)}
          <button class="peer mono" onclick={() => (selected = step.id)}>{model.nodes.get(step.id)?.label ?? step.label} <span class="dim sans">{kindWord(step.kind)}</span></button>
        {/each}
      {/if}
    </aside>
  {/if}
</div>

<style>
  .steps {
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
  .stage :global(.svelte-flow__edge-labels) {
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
  .chooser {
    max-width: 720px;
    overflow: auto;
    height: 100%;
    box-sizing: border-box;
  }
  .chooser-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 0;
    margin-top: 12px;
    border-top: 1px solid var(--rule-soft);
  }
  .pick {
    display: block;
    padding: 7px 8px;
    border-bottom: 1px solid var(--rule-soft);
    color: var(--ink);
    text-decoration: none;
    font-size: 12.5px;
  }
  .pick:hover {
    background: var(--press);
  }
  .legend {
    position: absolute;
    left: 12px;
    bottom: 12px;
    z-index: 4;
    max-width: 400px;
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
  .k-box.k-cross {
    border-left: 3px solid var(--accent);
  }
  .k-box.k-store {
    background: var(--paper-2);
  }
  .k-box.k-effect {
    border-style: dashed;
    border-color: var(--ink-3);
  }
  .k-anchor .mark {
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
    /* An effect's label is a call with its arguments — one long token. */
    overflow-wrap: anywhere;
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 3px;
    color: var(--ink-2);
    text-decoration: none;
  }
  a.sub:hover {
    text-decoration: underline;
  }
  .act {
    color: var(--accent);
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
  .note {
    margin: 0 0 6px;
  }
  .opt {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    cursor: pointer;
  }
  .opt input {
    margin: 0;
    accent-color: var(--accent);
  }
  .depth {
    font: inherit;
    font-size: 12px;
    border: 1px solid var(--rule-soft);
    background: var(--paper-2);
    color: var(--ink);
    padding: 0 4px;
  }
  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    color: var(--ink-2);
  }
  h4 {
    margin: 16px 0 6px;
    font: 600 12.5px var(--sans);
  }
  .row {
    padding: 7px 8px;
    margin: 0 -8px;
    border-top: 1px solid var(--rule-soft);
    transition: background 90ms linear;
  }
  .row.hot {
    background: var(--press);
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
  /* The joins we add — WHEN, AND, OR, NOT — a little bolder than the code between them. */
  .kw {
    font-weight: 600;
  }
  .via {
    font: 400 11px var(--mono);
    margin-top: 2px;
  }
  .ways {
    font: 500 11px var(--sans);
    margin-top: 6px;
  }
  /* One scenario per row under a link: its own tail of conditions, then its site. */
  .scenario.many {
    margin: 4px 0 0 8px;
    padding-left: 8px;
    border-left: 1px solid var(--rule-soft);
  }
  .site {
    display: block;
    font: 400 11px var(--mono);
    margin-top: 2px;
    color: var(--ink-2);
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  a.site:hover {
    text-decoration: underline;
  }
  .mono {
    font-family: var(--mono);
  }
  .sans {
    font-family: var(--sans);
  }
  .dim {
    color: var(--ink-3);
  }
  .mark {
    color: var(--accent);
  }
</style>
