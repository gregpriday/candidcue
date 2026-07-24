<!--
  Coach strip (companion Part VIII, A.5) — placeholder surface only.

  The coach *engine* (tip generation, arbitration, rate limiting, Luna-sourced
  codes) lives on the control side. The stage's entire job is the stage-calm
  contract (§3.7): one concise strip in a reserved safe area, at most one
  visible tip, no diagnostic scores, no raw transcript, no model prose.

  A tip clears itself after its display time so a stalled control side can never
  leave text on the presenter's glass.
-->
<script lang="ts">
  import type { StageCoachTip } from '../../shared/contracts';

  let {
    tip = null,
    reducedMotion = false,
  }: {
    tip?: StageCoachTip | null;
    reducedMotion?: boolean;
  } = $props();

  const DEFAULT_DURATION_MS = 2000;

  let visible = $state<StageCoachTip | null>(null);

  $effect(() => {
    const next = tip;
    if (!next) {
      visible = null;
      return;
    }
    // Maximum visible tips: 1 (A.5). A new tip replaces the old one outright
    // rather than stacking.
    visible = next;
    const timer = window.setTimeout(
      () => {
        if (visible?.id === next.id) visible = null;
      },
      Math.max(600, next.durationMs ?? DEFAULT_DURATION_MS),
    );
    return () => clearTimeout(timer);
  });
</script>

{#if visible}
  <div
    class="coach-strip"
    class:attention={visible.severity === 'attention'}
    class:instant={reducedMotion}
    data-tip-code={visible.code}
    aria-hidden="true"
  >
    {visible.text}
  </div>
{/if}

<style>
  /* Reserved safe area near the lower edge: out of the reading corridor and
     out of the camera-facing centre. */
  .coach-strip {
    position: absolute;
    left: 50%;
    bottom: 6vh;
    transform: translateX(-50%);
    max-width: min(60ch, 70%);
    padding: 0.5em 1.1em;
    border-radius: 999px;
    background: var(--stage-overlay);
    color: var(--stage-text-future);
    font-size: 0.34em;
    line-height: 1.35;
    letter-spacing: 0.01em;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
    animation: coach-in 180ms var(--ease-out, ease-out);
  }
  .coach-strip.attention {
    color: var(--stage-cue);
  }
  .coach-strip.instant {
    animation: none;
  }

  @keyframes coach-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
