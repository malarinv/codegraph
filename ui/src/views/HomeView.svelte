<script lang="ts">
  interface Props {
    project?: string | null;
  }
  let { project = null }: Props = $props();
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
</div>

<style>
  .scroll {
    height: 100%;
    overflow: auto;
  }
</style>
