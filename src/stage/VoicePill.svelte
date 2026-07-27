<!--
  The voice pill — the stage's corner readout of whether CandidCue is picking up
  what the presenter says.

  Small, low in the corner, and outside the mirror plane on purpose: like the
  Escape hint and the transcript bar it is an instrument aimed at the presenter
  rather than part of the read, so it has to stay legible through a horizontal
  mirror.

  It holds no audio state and no thresholds. Control owns the capture and sends
  a fully resolved view (`StageVoicePillPayload`), so what is drawn here cannot
  drift from what was decided there. The only thing this component knows how to
  do that control does not is turn an array of amplitudes into a waveform.

  Never unmounted while a take is live — `visible` fades it instead. A pill that
  was removed and re-added would pop back into existence at full opacity in the
  corner of a script somebody is reading, which is exactly the kind of movement
  the stage is supposed to be free of.
-->
<script lang="ts">
  import { STAGE_VOICE_PILL_TRACE_SAMPLES, type StageVoicePillPayload } from '../shared/contracts';

  interface Props {
    pill: StageVoicePillPayload;
  }

  let { pill }: Props = $props();

  /**
   * Bars, oldest at the left.
   *
   * Padded to a fixed count from the left so the trace GROWS INTO the pill from
   * the right rather than stretching to fill it. A trace that rescaled as
   * samples accumulated would read as the level changing when it had not, which
   * on the one element whose job is to report a level is the single illusion
   * that cannot be tolerated.
   */
  const BARS = STAGE_VOICE_PILL_TRACE_SAMPLES;
  const bars = $derived.by(() => {
    const levels = pill.levels;
    const padding = Math.max(0, BARS - levels.length);
    return [...new Array<number>(padding).fill(0), ...levels.slice(-BARS)];
  });
</script>

<!-- role="status": the reading changes as the take learns things, and a
     presenter using a screen reader needs those changes announced without the
     pill stealing focus from a window that has none to give. -->
<div
  class="voice-pill"
  data-reading={pill.reading}
  data-visible={pill.visible}
  role="status"
  aria-live="polite"
  aria-label={pill.label}
>
  <!-- aria-hidden: the waveform is the same fact as the label, drawn.
       Announcing two dozen bars would be noise. -->
  <div class="wave" aria-hidden="true">
    {#each bars as level, index (index)}
      <!-- A floor keeps the baseline visible while silent, so the trace reads
           as "listening and hearing nothing" rather than as a component that
           has failed to render. -->
      <span class="bar" style:height="{Math.max(8, level * 100)}%"></span>
    {/each}
  </div>

  <!-- The mark. A tick once the words have come back, a cross when something is
       wrong, and a quiet dot while it is still listening — the dot is what
       makes the pill read as live rather than as a decoration. -->
  <span class="mark" aria-hidden="true">
    {#if pill.reading === 'confirmed'}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <path d="M5 12.8 L10 17.5 L19 7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    {:else if pill.reading === 'fault'}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <path d="M7 7 L17 17 M17 7 L7 17" stroke-linecap="round" />
      </svg>
    {:else}
      <span class="dot"></span>
    {/if}
  </span>

  <!-- §20: state is never colour alone. The words ride along silently while
       things are fine and take up room only when they are not — a fault the
       presenter cannot name is a fault they cannot fix. -->
  {#if pill.reading === 'fault'}
    <span class="label">{pill.label}</span>
  {/if}
</div>

<style>
  .voice-pill {
    position: absolute;
    /* Clear of the transcript bar along the bottom edge, which is a full-width
       strip: the two must never overlap, and the pill is the one that moves. */
    right: 18px;
    bottom: 40px;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    padding: 0 6px 0 14px;
    border-radius: var(--radius-pill, 999px);
    background: var(--stage-overlay);
    /* The stage has no pointer affordances; this one is a readout, not a
       control, and it must never eat a click meant for the window beneath. */
    pointer-events: none;
    opacity: 0;
    /* Slow enough to read as a fade rather than a blink, and the only thing on
       the stage that animates besides the script itself. */
    transition: opacity 420ms ease;
  }

  .voice-pill[data-visible='true'] {
    opacity: 1;
  }

  .wave {
    display: flex;
    align-items: center;
    gap: 2px;
    /* Fixed, so the pill does not resize as the trace fills — a container that
       grew with its contents would drag the mark across the screen. */
    width: 88px;
    height: 18px;
  }

  .bar {
    flex: 1 1 0;
    border-radius: var(--radius-pill, 999px);
    background: var(--stage-text);
    opacity: 0.85;
    /* Just longer than the ~100 ms publish cadence, so the trace flows instead
       of strobing, and short enough that it still reads as a direct response to
       the presenter's voice. */
    transition: height 110ms linear;
  }

  .mark {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: rgb(245 243 239 / 14%);
    color: var(--stage-text);
  }

  .mark svg {
    width: 13px;
    height: 13px;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--stage-text);
    opacity: 0.55;
  }

  /* Confirmed: the mark fills, the way the reference does — a positive state
     reads as solid, not as an outline. */
  .voice-pill[data-reading='confirmed'] .mark {
    background: var(--stage-text);
    color: var(--stage-bg);
  }

  /* Fault: the cue colour the stage already uses for authored cues, so a
     presenter who has seen one knows this is the app talking to them. */
  .voice-pill[data-reading='fault'] .mark {
    background: var(--stage-cue);
    color: var(--stage-bg);
  }
  .voice-pill[data-reading='fault'] .bar {
    background: var(--stage-cue);
    opacity: 0.5;
  }

  .label {
    padding-right: 8px;
    font-size: 12px;
    letter-spacing: var(--ls-caps, 0.06em);
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--stage-cue);
  }

  @media (prefers-reduced-motion: reduce) {
    .voice-pill,
    .bar {
      transition: none;
    }
  }
</style>
