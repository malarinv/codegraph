<!--
  Placeholder for the file view: imported by | outline in source order |
  imports (design spec §3.4, task CG-46).
-->
<script lang="ts">
  interface Props {
    path: string;
    line: number | null;
  }
  let { path, line }: Props = $props();
</script>

<div class="scroll">
  <div class="emptystate">
    <h2>File view</h2>
    <p>
      <span class="mono">{path}</span>{#if line}<span class="dim"> · line {line}</span>{/if}
    </p>
    <p>The file's outline and its import rails are not wired up in this build yet.</p>
  </div>
</div>

<style>
  .scroll {
    height: 100%;
    overflow: auto;
  }
</style>
