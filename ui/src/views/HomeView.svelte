<script lang="ts">
  /**
   * The empty screen — and the answer to "where do I start".
   *
   * Nothing selected is the normal first state of a viewer opened on a project
   * nobody has read before, so it carries the same entry points the palette
   * shows at rest, at full length: the routes a request arrives on, the files
   * that run something at module level, and the symbols the most code depends
   * on. Every one of them is derived from the graph — see
   * `src/ui-server/api/entrypoints.ts` for what each is derived from.
   */
  import PaletteRows from '../components/PaletteRows.svelte';
  import { palette } from '../lib/palette.svelte';
  import { buildEntryPalette, type PaletteItem } from '../lib/search-model';
  import { fileHref, flowHref, navigate } from '../lib/router.svelte';
  import { walkTo } from '../lib/walk';

  interface Props {
    project?: string | null;
  }
  let { project = null }: Props = $props();

  $effect(() => {
    void palette.ensureEntries();
  });

  let entries = $derived(buildEntryPalette(palette.entries));

  function pick(item: PaletteItem) {
    // The empty screen only ever shows entry points, which are never flows —
    // but the row type is shared, so the branch is here rather than assumed away.
    if (item.type === 'flow') {
      navigate(flowHref({ from: item.from, to: item.to }));
      return;
    }
    const id = item.type === 'route' ? item.nodeId : item.id;
    if (!id) return;
    // A file opens the File view — its outline plus the import rails. The
    // entry-point rows are files far more often than the palette's are.
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
</script>

<div class="scroll">
  <div class="emptystate">
    <h2>Nothing selected</h2>
    <p>
      Search for a symbol or a file to start reading{project ? ` in ${project}` : ''}. Press
      <code>/</code> to focus the search box.
    </p>
    <p>
      Every symbol you open shows who calls it on the left, its verbatim source in the middle, and
      what it calls on the right — each callee lined up with the line that makes the call.
    </p>
  </div>

  {#if entries.sections.length > 0}
    <section class="entries" aria-label="Where to start">
      <h3>Where to start</h3>
      <div class="rows">
        <PaletteRows palette={entries} onpick={pick} />
      </div>
    </section>
  {/if}
</div>

<style>
  .scroll {
    height: 100%;
    overflow: auto;
  }

  /* `.emptystate` itself is global (app.css) and shared with the other views;
     only its bottom padding changes here, to sit against the list below. */
  .scroll :global(.emptystate) {
    padding-bottom: 8px;
  }

  .entries {
    max-width: 720px;
    padding: 8px 40px 48px;
  }

  .entries h3 {
    margin: 0 0 8px;
    font-size: 14px;
    font-weight: 600;
  }

  .rows {
    border: 1px solid var(--rule-soft);
  }
</style>
