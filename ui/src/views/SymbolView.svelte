<!--
  The Symbol view: callers | verbatim source with gutter ports | line-anchored
  callee rail (design spec §3.2, task CG-44).

  The geometry is the point of the screen, and it is the one thing that cannot
  be derived from the payload: where a callee row belongs depends on where its
  call-site line ended up, which depends on the font, the window width, whether
  a fold is open. So this component measures — after every render, on every
  resize — and hands the rail and the overlay their coordinates. Everything
  else it does is plumbing around that.

  Two scroll containers, deliberately. The left rail scrolls alone; the centre
  and the right rail scroll together inside the stage, because a callee row
  that drifts away from its line is worse than no rail at all.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import CalleeRail from '../components/symbol/CalleeRail.svelte';
  import CallersRail from '../components/symbol/CallersRail.svelte';
  import Connectors from '../components/symbol/Connectors.svelte';
  import BlastStrip from '../components/symbol/BlastStrip.svelte';
  import MembersOutline from '../components/symbol/MembersOutline.svelte';
  import SourceBlock from '../components/symbol/SourceBlock.svelte';
  import SymbolHeader from '../components/symbol/SymbolHeader.svelte';
  import { ApiFailure, fetchSource, fetchSymbol, type WireNodeRef, type WireSource, type WireSymbolPayload } from '../lib/api';
  import { hot, railFocus } from '../lib/focus.svelte';
  import { project } from '../lib/project.svelte';
  import {
    buildCalleeRail,
    buildCallerRail,
    buildCodeBlock,
    buildOutline,
    graphCallLines,
    refsByLine,
    showsBody,
    synthesizedBy,
    type Connector,
    type LineRef,
  } from '../lib/symbol-model';
  import { trail } from '../lib/trail.svelte';
  import { arrivedFrom, walkTo } from '../lib/walk';

  interface Props {
    id: string;
    line: number | null;
  }

  let { id, line }: Props = $props();

  /* ------------------------------------------------------------ geometry -- */

  /** Row height and the gap between two rows pushed apart — spec §3.2. */
  const ROW_HEIGHT = 34;
  const ROW_GAP = 6;
  /** Fallback for the sticky rail header before it has been measured. */
  const RAIL_HEADER_FALLBACK = 38;

  /* --------------------------------------------------------------- state -- */

  let payload = $state<WireSymbolPayload | null>(null);
  let source = $state<WireSource | null>(null);
  let failure = $state<ApiFailure | null>(null);
  let loading = $state(true);

  let innerEl = $state<HTMLDivElement | null>(null);
  let centerEl = $state<HTMLElement | null>(null);
  let railEl = $state<HTMLElement | null>(null);
  let leftRailEl = $state<HTMLElement | null>(null);

  let tops = $state<number[]>([]);
  let foldTop = $state(0);
  let noteTop = $state(0);
  let stageMinHeight = $state(0);
  let connectors = $state<Connector[]>([]);
  let overlay = $state({ width: 0, height: 0 });

  /* ---------------------------------------------------------------- data -- */

  $effect(() => {
    const wanted = id;
    const controller = new AbortController();
    untrack(() => load(wanted, controller.signal));
    return () => controller.abort();
  });

  async function load(nodeId: string, signal: AbortSignal): Promise<void> {
    loading = true;
    failure = null;
    payload = null;
    source = null;
    railFocus.reset();
    hot.set(null);
    void project.ensure();

    let node: WireSymbolPayload;
    try {
      node = await fetchSymbol(nodeId, signal);
    } catch (cause) {
      if (signal.aborted) return;
      failure = asFailure(cause);
      loading = false;
      return;
    }
    if (signal.aborted) return;
    payload = node;
    loading = false;
    trail.resolve(nodeId, { name: node.node.name, kind: node.node.kind });

    // The body is only fetched when it will be drawn: a 2,000-line file node
    // shows its outline, and asking for 2,000 lines to throw them away is the
    // difference between a screen that settles at once and one that does not.
    if (!showsBody(node.node.kind, node.node.lines) || node.drift) return;
    try {
      const slice = await fetchSource(node.node.file, node.node.line, node.node.endLine, signal);
      if (!signal.aborted) source = slice;
    } catch {
      // No slice: the header, the rails and the blast strip are all still
      // true, so the screen loses the body and says so rather than erroring.
    }
  }

  function asFailure(cause: unknown): ApiFailure {
    if (cause instanceof ApiFailure) return cause;
    return new ApiFailure(0, 'error', cause instanceof Error ? cause.message : String(cause), null);
  }

  /* -------------------------------------------------------------- models -- */

  let callers = $derived(payload ? buildCallerRail(payload) : null);
  let callees = $derived(payload ? buildCalleeRail(payload) : null);
  let refs = $derived(payload ? refsByLine(payload) : new Map<number, LineRef[]>());
  let outline = $derived(payload ? buildOutline(payload) : []);

  let wantsBody = $derived(payload ? showsBody(payload.node.kind, payload.node.lines) : false);

  let codeBlock = $derived.by(() => {
    if (!payload || !source?.lines) return null;
    const from = source.from ?? payload.node.line;
    return buildCodeBlock(from, source.lines, graphCallLines(payload));
  });

  let origin = $derived(arrivedFrom());
  let originLeft = $derived(origin?.rail === 'left' ? origin.id : null);
  let originRight = $derived(origin?.rail === 'right' ? origin.id : null);

  let emptyCalleeReason = $derived.by(() => {
    if (!payload) return '';
    if (!wantsBody) {
      return `A ${payload.node.kind.replace(/_/g, ' ')} makes no calls itself — its members do. Open one from the outline.`;
    }
    return 'This symbol makes no resolved calls — a leaf.';
  });

  /* ------------------------------------------------------------ movement -- */

  /**
   * Follow a call. No line is carried across: the call-site line belongs to the
   * symbol being left, and the destination opens at its own definition.
   */
  function stepDown(node: WireNodeRef): void {
    walkTo(node, 'down');
  }

  /** Go to a caller, landing on the line that makes the call when one is named. */
  function stepUp(node: WireNodeRef, at?: number): void {
    walkTo(node, 'up', at);
  }

  /** A jump that is neither up nor down: a breadcrumb, a chip, a member. */
  function open(node: WireNodeRef): void {
    walkTo(node, 'start');
  }

  function followRef(ref: LineRef): void {
    if (!ref.targetId) return;
    const target = payload?.outgoing.items.find((r) => r.node.id === ref.targetId)?.node
      ?? payload?.typesUsed.find((r) => r.node.id === ref.targetId)?.node;
    if (target) walkTo(target, 'down');
  }

  /* ------------------------------------------------------------ keyboard -- */

  function leftRows(): WireNodeRef[] {
    return (callers?.groups ?? []).flatMap((group) => group.rows.map((row) => row.relation.node));
  }

  function rightRows(): WireNodeRef[] {
    return (callees?.rows ?? []).map((row) => row.relation.node);
  }

  function activeRows(): WireNodeRef[] {
    return railFocus.rail === 'left' ? leftRows() : rightRows();
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement)
    ) {
      return;
    }
    if (!payload) return;

    switch (event.key) {
      case 'ArrowLeft':
        railFocus.switchTo('left');
        break;
      case 'ArrowRight':
        railFocus.switchTo('right');
        break;
      case 'ArrowDown':
      case 'j':
        railFocus.step(1, activeRows().length);
        break;
      case 'ArrowUp':
      case 'k':
        railFocus.step(-1, activeRows().length);
        break;
      case 'Enter': {
        const node = activeRows()[railFocus.index];
        if (node) {
          event.preventDefault();
          if (railFocus.rail === 'left') stepUp(node);
          else stepDown(node);
        }
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    // Keep the selection on screen; the rails are the only thing that scrolls
    // out from under the keyboard.
    void tick().then(() => {
      const scope = railFocus.rail === 'left' ? leftRailEl : railEl;
      // Rows are the only focusable buttons in a rail, and they render in the
      // same order the keyboard walks them.
      scope?.querySelectorAll('[role="button"]')[railFocus.index]?.scrollIntoView({
        block: 'nearest',
      });
    });
  }

  /* ----------------------------------------------------------- measuring -- */

  /**
   * Place every callee row beside its call site, then draw the connectors.
   *
   * Rows are laid out in source order and never allowed to overlap: a row wants
   * to sit at the centre of its first call-site line, but takes
   * `previous + height + gap` when that would collide. Order beats exactness —
   * a rail whose rows jump around relative to the body stops being a reading of
   * the code — and the connector still runs to the line, so the displacement is
   * visible rather than silent.
   */
  function relayout(): void {
    const inner = innerEl;
    const center = centerEl;
    const rail = railEl;
    const rows = callees?.rows ?? [];
    if (!inner || !center || !rail) return;

    const headerHeight =
      rail.querySelector<HTMLElement>('[data-rail-header]')?.offsetHeight ?? RAIL_HEADER_FALLBACK;

    const lineCentre = (n: number): number | null => {
      const el = center.querySelector<HTMLElement>(`[data-line="${n}"]`);
      return el ? el.offsetTop + el.offsetHeight / 2 : null;
    };

    let y = headerHeight + 14;
    const nextTops: number[] = [];
    const rowCentres: Array<number | null> = [];
    for (const row of rows) {
      const centre = row.anchor !== null ? lineCentre(row.anchor) : null;
      const wanted = centre !== null ? centre - ROW_HEIGHT / 2 : y;
      y = Math.max(wanted, y);
      nextTops.push(y);
      rowCentres.push(y + ROW_HEIGHT / 2);
      y += ROW_HEIGHT + ROW_GAP;
    }

    const nextFoldTop = y + 8;
    if ((callees?.uncertain.length ?? 0) > 0) {
      const fold = rail.querySelector<HTMLElement>('[data-rail-fold]');
      y = nextFoldTop + (fold?.offsetHeight ?? 30);
    }
    const nextNoteTop = y + 14;

    tops = nextTops;
    foldTop = nextFoldTop;
    noteTop = nextNoteTop;
    stageMinHeight = Math.max(center.offsetHeight, nextNoteTop + 60);

    // Connectors: one per call site, from the centre column's right edge to the
    // row's own centre. Both coordinate systems are the stage's, so the port
    // and the row agree even when the stage is scrolled.
    const x0 = center.offsetLeft + center.offsetWidth - 10;
    const x1 = rail.offsetLeft + 14;
    const cx = (x0 + x1) / 2;
    const next: Connector[] = [];
    rows.forEach((row, index) => {
      const ry = rowCentres[index];
      if (ry == null) return;
      const via = synthesizedBy(row.relation);
      for (const callLine of row.lines) {
        const ly = lineCentre(callLine);
        if (ly === null) continue;
        next.push({
          d: `M${x0},${ly} C${cx},${ly} ${cx},${ry} ${x1},${ry}`,
          targetId: row.relation.node.id,
          uncertain: row.relation.uncertain,
          heuristic: via !== null,
          origin: row.relation.node.id === originRight,
        });
      }
    });
    connectors = next;
    overlay = { width: inner.scrollWidth, height: Math.max(inner.offsetHeight, stageMinHeight) };
  }

  let scheduled = false;
  function scheduleRelayout(): void {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      relayout();
    });
  }

  // Re-measure whenever what is drawn changes. The dependencies are the INPUTS
  // (the models and the block); the outputs it writes are read untracked inside
  // relayout(), so this cannot feed itself.
  $effect(() => {
    void codeBlock;
    void callees;
    void outline;
    void payload;
    void tick().then(scheduleRelayout);
  });

  // Layout is a function of pixels, not of data: a resized window, a loaded
  // font and an opened fold all move the lines without changing the payload.
  $effect(() => {
    const inner = innerEl;
    const center = centerEl;
    const rail = railEl;
    if (!inner || !center || !rail) return;
    const observer = new ResizeObserver(scheduleRelayout);
    observer.observe(inner);
    observer.observe(center);
    observer.observe(rail);
    // Opening a fold moves the rail's contents without resizing any box the
    // observer watches — the folds are absolutely positioned. `toggle` does not
    // bubble, so it is caught on the way down.
    inner.addEventListener('toggle', scheduleRelayout, true);
    void document.fonts?.ready.then(scheduleRelayout);
    return () => {
      observer.disconnect();
      inner.removeEventListener('toggle', scheduleRelayout, true);
    };
  });

  // Scroll the highlighted call site into view once, when it first appears —
  // and not again, so a later resize does not yank the reader back to it.
  let scrolledTo: string | null = null;
  $effect(() => {
    const key = line === null ? null : `${id}:${line}`;
    const center = centerEl;
    if (!key || !center || !codeBlock || scrolledTo === key) return;
    const el = center.querySelector(`[data-line="${line}"]`);
    if (!el) return;
    scrolledTo = key;
    el.scrollIntoView({ block: 'center' });
  });
</script>

<svelte:window {onkeydown} />

{#if failure}
  <div class="scroll">
    <div class="emptystate">
      <h2>{failure.code === 'not-found' ? 'No such symbol' : 'Could not load this symbol'}</h2>
      <p>{failure.message}</p>
      {#if failure.guidance}<p class="dim">{failure.guidance}</p>{/if}
    </div>
  </div>
{:else if loading || !payload || !callers || !callees}
  <div class="scroll">
    <div class="emptystate"><p class="dim">Loading…</p></div>
  </div>
{:else}
  <div class="focus">
    <aside class="rail-left" bind:this={leftRailEl} aria-label="Called by">
      <CallersRail
        model={callers}
        originId={originLeft}
        exported={payload.node.exported === true}
        onstepUp={stepUp}
      />
    </aside>

    <div class="stage">
      <div class="stage-inner" bind:this={innerEl} style:min-height={`${stageMinHeight}px`}>
        <Connectors {connectors} width={overlay.width} height={overlay.height} />

        <section class="center" bind:this={centerEl}>
          <SymbolHeader {payload} onopen={open} />

          {#if payload.drift}
            <div class="drift">
              {payload.node.file} changed on disk after the last index sync — the body is not shown, because
              the line ranges the graph holds no longer match the file. Run <code>codegraph sync</code>
              to bring it up to date.
            </div>
          {:else if codeBlock}
            <SourceBlock
              block={codeBlock}
              language={payload.node.language}
              {refs}
              defLine={payload.node.line}
              defName={payload.node.name}
              highlight={line}
              onfollow={followRef}
            />
          {:else if !wantsBody}
            <!-- The outline below IS the body for a container this size. -->
          {:else if source}
            <div class="note">{source.reason ?? 'Source is not available for this symbol.'}</div>
          {/if}

          {#if outline.length > 0}
            <MembersOutline
              rows={outline}
              total={payload.members.total}
              truncated={payload.members.truncated}
              onopen={open}
            />
          {/if}

          {#if payload.blast}
            <BlastStrip
              blast={payload.blast}
              scale={project.stats?.blastScale ?? null}
              testCalls={callers.tests.calls}
              testFiles={callers.tests.files.length}
            />
          {/if}
        </section>

        <aside class="rail-right" bind:this={railEl} aria-label="Calls">
          <CalleeRail
            model={callees}
            {tops}
            {foldTop}
            {noteTop}
            focalFile={payload.node.file}
            originId={originRight}
            emptyReason={emptyCalleeReason}
            onstepDown={stepDown}
          />
        </aside>
      </div>
    </div>
  </div>
{/if}

<style>
  .scroll {
    height: 100%;
    overflow: auto;
  }

  .focus {
    display: grid;
    grid-template-columns: 300px minmax(520px, 1fr);
    height: 100%;
    min-height: 0;
  }

  .rail-left {
    overflow: auto;
    border-right: 1px solid var(--rule-soft);
    background: var(--paper);
  }

  .stage {
    position: relative;
    overflow: auto;
  }

  /* The positioning context every measured coordinate is expressed in: line
     offsets, rail row tops and the SVG overlay all share this origin. */
  .stage-inner {
    position: relative;
    display: grid;
    grid-template-columns: minmax(480px, 1fr) 320px;
    min-height: 100%;
  }

  .center {
    min-width: 0;
    padding: 18px 22px 40px;
  }

  .rail-right {
    position: relative;
    border-left: 1px solid var(--rule-faint);
  }

  .drift {
    margin-top: 16px;
    padding: 10px 12px;
    border: 1px solid var(--amber);
    background: var(--amber-soft);
    color: var(--amber);
    font-size: 12.5px;
    line-height: 1.5;
  }

  .drift code {
    font-family: var(--mono);
    font-size: 12px;
  }

  .note {
    padding: 12px 0;
    color: var(--ink-3);
    font-size: 12px;
  }

  @media (max-width: 1100px) {
    .focus {
      grid-template-columns: 240px minmax(360px, 1fr);
    }

    .stage-inner {
      grid-template-columns: minmax(360px, 1fr) 260px;
    }
  }
</style>
