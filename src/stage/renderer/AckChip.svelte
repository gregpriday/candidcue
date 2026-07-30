<!--
  Transient command acknowledgement (spec §33.10): a quiet chip shown for
  700–1200 ms after a recognized command, e.g. "Chapter 1". Visual only —
  control decides when to show it via the `ack` directive.
-->
<script lang="ts">
  import type { StageAckState } from './stageState';

  interface Props {
    ack?: StageAckState | null;
    /**
     * The floor from `ResolvedOptics`, in px.
     *
     * Taken as a number rather than left to a CSS custom property, for the same
     * reason `HoldStatus` takes one: the fallback in a `var()` chain is an `em`,
     * and an `em` on an uncalibrated rig resolves against the root font size —
     * about 11px, which is decoration rather than communication. A value that
     * has to be floored is a value the component should be given, not one it
     * should hope a cascade supplies.
     */
    secondaryMinPx?: number;
  }

  let { ack = null, secondaryMinPx = 0 }: Props = $props();

  let visible = $state(false);
  /**
   * The last thing acknowledged, held past the moment it stops being shown.
   *
   * The chip fades out now rather than vanishing, and clearing the text at the
   * instant the opacity starts falling would empty the box first and shrink it
   * — movement, beside a script somebody is reading, which is the one thing
   * this surface spends its whole design budget avoiding. Same latch, and same
   * reason, as `HoldStatus`.
   */
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

  /**
   * The floor, floored again — the identical rule `HoldStatus` applies.
   *
   * 14px catches a resolved value that came out absurdly small; 18px is what a
   * caller that has not resolved optics at all gets, deliberately larger than
   * the hard floor, because "we know nothing about this rig" must not quietly
   * produce the smallest text on the glass.
   */
  const fontSizePx = $derived(
    typeof secondaryMinPx === 'number' && Number.isFinite(secondaryMinPx) && secondaryMinPx > 0
      ? Math.max(14, secondaryMinPx)
      : 18,
  );
</script>

<!--
  Mounted for the whole take, shown by attribute.

  It used to be an `{#if}`, which gave it an entrance animation and no exit at
  all: the chip faded in over 120ms and then disappeared between two frames.
  Every other overlay on this stage fades both ways, and a single-frame
  disappearance in peripheral vision reads as a glitch rather than as something
  finishing — the one impression a status surface cannot afford beside a script
  somebody is speaking.
-->
<div class="ack" data-visible={visible} role="status" style:font-size="{fontSizePx}px">
  {label}
</div>

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
   * The size now arrives as a resolved pixel value on the element itself (see
   * `fontSizePx`), which is what makes it track the calibrated reading distance
   * even on a rig that has never been calibrated.
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
    font-weight: 550;
    letter-spacing: 0.01em;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    /* `visibility` is what takes the spent label out of the accessibility tree,
       so a screen reader is not left holding the last acknowledgement for the
       rest of the take. Delayed by the fade so the word is still there while it
       is fading. */
    visibility: hidden;
    transition:
      opacity 150ms linear,
      visibility 0s linear 150ms;
  }

  /*
   * A FADE, NOT A RISE.
   *
   * It used to slide up six pixels on the way in. A command acknowledgement is
   * already a new object appearing in the reader's peripheral field — that is
   * the whole signal — and the translation added nothing to the meaning while
   * adding the one thing this surface spends its whole design budget avoiding:
   * something moving beside the words somebody is speaking.
   */
  .ack[data-visible='true'] {
    opacity: 1;
    visibility: visible;
    transition:
      opacity 150ms linear,
      visibility 0s linear 0s;
  }

  @media (prefers-reduced-motion: reduce) {
    .ack,
    .ack[data-visible='true'] {
      transition: none;
    }
  }
</style>
