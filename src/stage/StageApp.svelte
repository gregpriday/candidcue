<!--
  Stage window shell — placeholder. The read-only text-motion renderer and
  Listener playback replace this (spec §43.2). The stage sets no data-theme,
  so it keeps the dark studio defaults plus the stage palette from stage.css.
-->
<script lang="ts">
  // Placeholder stage surface — no state yet.
</script>

<div class="stage">
  <span class="mark">CandidCue stage</span>
</div>

<style>
  .stage {
    height: 100%;
    display: grid;
    place-items: center;
    background: var(--stage-bg);
  }

  .mark {
    color: var(--stage-text-past);
    font-size: var(--text-lg);
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
  }
</style>
