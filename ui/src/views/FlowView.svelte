<!--
  Reserved route. The flow strip (design spec §3.5) is phase 2.
-->
<script lang="ts">
  interface Props {
    flowKey: string | null;
  }
  let { flowKey = null }: Props = $props();
</script>

<div class="scroll">
  <div class="emptystate">
    <h2>Flow</h2>
    <p>
      Reading a trail as a left-to-right flow — one card per hop, showing the line that makes each
      call — is not part of this release.
    </p>
    {#if flowKey}
      <p class="dim">Requested flow: <span class="mono">{flowKey}</span></p>
    {/if}
  </div>
</div>

<style>
  .scroll {
    height: 100%;
    overflow: auto;
  }
</style>
