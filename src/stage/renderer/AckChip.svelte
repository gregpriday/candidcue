<!--
  Transient command acknowledgement (spec §33.10): a quiet chip shown for
  700–1200 ms after a recognized command, e.g. "Chapter 1". Visual only —
  control decides when to show it via the `ack` directive.
-->
<script lang="ts">
  import type { StageAckState } from './stageState';

  let { ack = null }: { ack?: StageAckState | null } = $props();

  let visible = $state(false);
  let label = $state('');

  $effect(() => {
    if (!ack) return;
    label = ack.label;
    visible = true;
    const timer = setTimeout(() => {
      visible = false;
    }, ack.durationMs);
    return () => clearTimeout(timer);
  });
</script>

{#if visible}
  <div class="ack" role="status">{label}</div>
{/if}

<style>
  /*
   * Sized against the body text, not against the viewport.
   *
   * This was `clamp(15px, 1.6vw, 22px)`, which is a control-window size: at
   * 1.5 m through glass, 22px is the upper bound on something a presenter can
   * only just make out, and 15px is not readable at all. An acknowledgement
   * nobody can read is worse than none, because it occupies attention without
   * delivering the one word it exists to deliver.
   *
   * `--stage-secondary-min` is resolved from the optical profile, so this
   * tracks the calibrated reading distance rather than the window width.
   */
  .ack {
    position: absolute;
    left: 50%;
    bottom: 7vh;
    transform: translateX(-50%);
    padding: 0.5em 1.1em;
    border-radius: 999px;
    background: var(--stage-overlay);
    color: var(--stage-text);
    font-size: var(--stage-secondary-min, 0.67em);
    font-weight: 550;
    letter-spacing: 0.01em;
    white-space: nowrap;
    pointer-events: none;
    animation: ack-in 160ms var(--ease-out, ease-out);
  }

  /* An acknowledgement is a confirmation, not an entrance. */
  @media (prefers-reduced-motion: reduce) {
    .ack {
      animation: none;
    }
  }

  @keyframes ack-in {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }
</style>
