<!--
  The microphone check, drawn on the stage (spec §29.2, between full screen and
  the transport opening).

  This is the last thing the presenter sees before the script, so it is built to
  the same rules as the script: the stage's own typeface at teleprompter scale,
  near-black ground, nothing that moves except the thing that is meant to move.
  It reads as the same surface — not as a dialog that has landed on top of one.

  It holds no audio state and no thresholds. Control owns the capture and sends
  a fully resolved view (`StageMicCheckPayload`), so what is drawn here cannot
  drift from what was decided there. The only thing this component knows how to
  do that control does not is turn an array of amplitudes into a waveform.

  Outside the mirror plane on purpose, exactly like the Escape hint: it is an
  instruction TO the presenter rather than part of the read, so it has to stay
  legible through a horizontal mirror.
-->
<script lang="ts">
  import {
    STAGE_MIC_CHECK_TRACE_SAMPLES,
    type StageMicCheckPayload,
  } from '../shared/contracts';
  import { stageFontStack } from './renderer/text';

  interface Props {
    check: StageMicCheckPayload;
    /** The session's typeface, so the check looks like the teleprompter. */
    fontFamilyId: string;
  }

  let { check, fontFamilyId }: Props = $props();

  const fontStack = $derived(stageFontStack(fontFamilyId));

  /**
   * Bars, oldest at the left.
   *
   * Padded to a fixed count from the left so the trace GROWS INTO the frame
   * from the right rather than stretching to fill it. A trace that rescales as
   * samples accumulate reads as the level changing when it has not, which on a
   * screen whose entire job is to report the level is the one illusion that
   * cannot be tolerated.
   */
  const BARS = STAGE_MIC_CHECK_TRACE_SAMPLES;
  const bars = $derived.by(() => {
    const levels = check.levels;
    const padding = Math.max(0, BARS - levels.length);
    return [...new Array<number>(padding).fill(0), ...levels.slice(-BARS)];
  });

  /**
   * Fault states take the cue colour, a pass takes full white, and everything
   * else stays in the ordinary future-text tone. Colour is never the only
   * signal — the headline says the same thing in words (§20).
   */
  const tone = $derived(
    check.state === 'unheard' || check.state === 'too_low' || check.state === 'clipping'
      ? 'warn'
      : check.state === 'passed'
        ? 'good'
        : 'neutral',
  );
</script>

<!-- role="status": the headline changes as the check learns things, and a
     presenter using a screen reader needs those changes announced without the
     overlay stealing focus from a window that has none to give. -->
<div class="mic-check" data-tone={tone} role="status" aria-live="polite">
  <div class="inner" style:font-family={fontStack}>
    <p class="headline">{check.headline}</p>

    <!-- aria-hidden: the waveform is the same fact as the headline, drawn.
         Announcing 72 bars would be noise, and the words already carry it. -->
    <div class="wave" aria-hidden="true">
      {#each bars as level, index (index)}
        <!-- A floor of 2% keeps the baseline visible while silent, so the
             trace reads as "listening and hearing nothing" rather than as a
             component that has failed to render. -->
        <span class="bar" style:height="{Math.max(2, level * 100)}%"></span>
      {/each}
    </div>

    <p class="detail">{check.detail}</p>

    <p class="keys">
      {#if check.canOverride}
        <span><kbd>Enter</kbd> start anyway</span>
        <span class="sep">·</span>
      {/if}
      <span><kbd>Esc</kbd> cancel</span>
    </p>
  </div>
</div>

<style>
  .mic-check {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    /* Opaque, not a scrim: the script is already hydrated underneath and a
       half-visible paragraph behind the check would invite the presenter to
       start reading it. */
    background: var(--stage-bg);
    z-index: 40;
    /* The stage has no pointer affordances; this one is keyboard-only too. */
    pointer-events: none;
  }

  .inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3vh;
    width: min(78vw, 1100px);
    text-align: center;
  }

  .headline {
    margin: 0;
    /* Teleprompter scale, viewport-relative for the same reason the script is:
       the stage runs on displays from a 13" laptop to a wall, and a fixed size
       is only ever right on one of them. */
    font-size: clamp(28px, 4.2vw, 68px);
    line-height: 1.2;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--stage-text);
    text-wrap: balance;
  }

  /*
   * The waveform.
   *
   * Bars grow from a centre line in both directions — the shape people already
   * read as "audio" — and the whole row is a flex box rather than a canvas so
   * it costs nothing to render and cannot get out of step with a paint. The
   * height transition is short and linear: long enough that the trace does not
   * strobe at the 100 ms publish cadence, short enough that it still reads as
   * a direct response to the presenter's voice.
   */
  .wave {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    width: 100%;
    height: clamp(80px, 16vh, 200px);
  }

  .bar {
    flex: 1 1 0;
    min-width: 2px;
    max-width: 10px;
    border-radius: var(--radius-pill, 999px);
    background: var(--stage-text-future);
    opacity: 0.75;
    transition: height 90ms linear;
  }

  .detail {
    margin: 0;
    font-size: clamp(14px, 1.5vw, 24px);
    line-height: 1.4;
    color: var(--stage-text-past);
    /* Reserve the row: the detail line changes with every state, and letting
       it resize would move the waveform above it while the presenter is
       watching the waveform. */
    min-height: 1.4em;
  }

  .keys {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: clamp(11px, 1vw, 14px);
    letter-spacing: var(--ls-caps, 0.06em);
    text-transform: uppercase;
    color: var(--stage-text-past);
    opacity: 0.6;
  }

  .keys .sep {
    opacity: 0.5;
  }

  kbd {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 0.95em;
    padding: 2px 6px;
    margin-right: 4px;
    border-radius: 5px;
    border: 1px solid rgb(245 243 239 / 22%);
    color: var(--stage-text);
  }

  /* Fault: the cue colour the stage already uses for authored cues, so a
     presenter who has seen one knows this is the app talking to them. */
  .mic-check[data-tone='warn'] .headline {
    color: var(--stage-cue);
  }
  .mic-check[data-tone='warn'] .bar {
    background: var(--stage-cue);
    opacity: 0.55;
  }

  .mic-check[data-tone='good'] .bar {
    background: var(--stage-text);
    opacity: 0.9;
  }

  @media (prefers-reduced-motion: reduce) {
    .bar {
      transition: none;
    }
  }
</style>
