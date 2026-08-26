<!--
  Placeholder for the core screen: callers | verbatim source with gutter
  ports | line-anchored callee rail (design spec §3.2, task CG-44). It needs
  the read-only JSON API (CG-42), so until that lands this states the target
  rather than faking a reader.
-->
<script lang="ts">
  interface Props {
    id: string;
    line: number | null;
  }
  let { id, line }: Props = $props();
</script>

<div class="scroll">
  <div class="emptystate">
    <h2>Symbol view</h2>
    <p>
      <span class="mono">{id}</span>{#if line}<span class="dim"> · line {line}</span>{/if}
    </p>
    <p>
      Callers, the symbol's source, and its callees are not wired up in this build yet.
    </p>
  </div>
</div>

<style>
  .scroll {
    height: 100%;
    overflow: auto;
  }
</style>
