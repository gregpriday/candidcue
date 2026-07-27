<!--
  The top rung of the hold ladder, drawn.

  ---------------------------------------------------------------------------
  WHAT THIS IS NOT
  ---------------------------------------------------------------------------
  It is not an alert. A hold is the engine refusing to guess, which is the
  behaviour the whole alignment design is built around, and a presenter who has
  been trained to flinch at it will stop mid-sentence to look at the corner of
  the glass — during a take, on camera. So: never red, never flashing, never
  shaking, never across the script, and never larger than the words it carries.

  It is also not a notification of success. When the hold clears, this fades out
  and nothing takes its place. No tick, no green, no "back on track". The absence
  of a problem is the normal state of the world and does not deserve an
  announcement; celebrating it would make the ordinary case the eventful one.

  ---------------------------------------------------------------------------
  WHERE IT SITS
  ---------------------------------------------------------------------------
  Top left, deliberately away from three things: the text column (centred on the
  lens), the transcript bar (full width along the bottom) and the voice pill
  (bottom right). It also sits above the reading band, so a glance at it is a
  glance the eye can make and return from without losing the line.

  It must be mounted OUTSIDE the mirror plane and inside the safe rectangle.
  Like the voice pill and the transcript bar this is an instrument aimed at the
  presenter rather than part of the read, so a horizontal flip would leave it
  reading backwards — and a chip placed against the raw viewport on a hooded rig
  lands under the bezel, where the one message worth reading is the one nobody
  can see. The offsets below are relative to whatever container it is given.

  Presentational: `resolveHoldStatus` in ./hold-status decides what is said and
  when. This decides only how it looks.
-->
<script lang="ts">
  import type { HoldRung, HoldTone } from './hold-status';

  interface Props {
    rung: HoldRung;
    message: string | null;
    tone: HoldTone;
    /**
     * The floor from `ResolvedOptics`. This is words somebody has to read from
     * where they are standing, so it is sized like the secondary text it is —
     * not at the fixed 12–13 px that made every other stage label decoration
     * rather than communication.
     */
    secondaryMinPx: number;
  }

  let { rung, message, tone, secondaryMinPx }: Props = $props();

  const visible = $derived(rung === 'message' && typeof message === 'string' && message.length > 0);

  /**
   * The last thing that was actually said.
   *
   * Held past the moment the status clears so the chip can FADE with its words
   * intact. Clearing the text at the same instant the opacity starts falling
   * would empty the box first and shrink it, which is movement — on recovery,
   * the one moment the presenter should be able to ignore entirely.
   *
   * Seeded from the prop rather than left null so a server render (and the
   * first client frame) carries the message it was given.
   */
  // svelte-ignore state_referenced_locally
  // Capturing the INITIAL value is the intent: the effect below tracks it from
  // there, and reading it reactively would defeat the whole point of a latch.
  let latched = $state(message ?? '');
  $effect(() => {
    if (typeof message === 'string' && message.length > 0) latched = message;
  });

  /**
   * The floor, floored again.
   *
   * 14 px catches a resolved value that came out absurdly small — a stage
   * measured before layout settled, say — because a chip nobody can read costs
   * the same attention as one they can. 18 px is what a caller that has not
   * resolved optics at all gets: deliberately larger than the hard floor,
   * because "we know nothing about this rig" should not quietly produce the
   * smallest text on the glass.
   */
  const fontSizePx = $derived(
    typeof secondaryMinPx === 'number' && Number.isFinite(secondaryMinPx) && secondaryMinPx > 0
      ? Math.max(14, secondaryMinPx)
      : 18,
  );
</script>

<!-- role="status": the message changes as the take learns things, and a
     presenter using a screen reader needs those changes spoken without the chip
     taking focus from a window that has none to give. -->
<div
  class="hold-status"
  data-visible={visible}
  data-tone={tone}
  role="status"
  aria-live="polite"
  style:font-size="{fontSizePx}px"
>
  {latched}
</div>

<style>
  .hold-status {
    position: absolute;
    top: 24px;
    left: 24px;
    max-width: 40vw;
    padding: 0.45em 0.85em;
    border-radius: var(--radius-pill, 999px);
    background: var(--stage-overlay);
    color: var(--stage-text);
    font-weight: 550;
    letter-spacing: 0.01em;
    line-height: 1.25;
    /* A readout, never a control: it must not eat a click meant for the window
       beneath it. */
    pointer-events: none;
    opacity: 0;
    /* `visibility` is what takes it out of the accessibility tree once it has
       gone, so a screen reader is not left holding the last hold message for
       the rest of the take. Delayed by the fade so the words are still there
       while it is fading. */
    visibility: hidden;
    transition:
      opacity 150ms linear,
      visibility 0s linear 150ms;
  }

  .hold-status[data-visible='true'] {
    opacity: 1;
    visibility: visible;
    transition:
      opacity 150ms linear,
      visibility 0s linear 0s;
  }

  /*
   * Faults use the same warm cue colour the stage already spends on authored
   * cues and on the voice pill's fault mark, so a presenter who has seen one
   * recognises this as the app talking to them rather than as a new kind of
   * event. It is emphatically not red: red on a prompter reads as "stop", and
   * the presenter should keep going while somebody fixes the microphone.
   *
   * §20 — state is never colour alone. Here the words themselves are the
   * distinguishing signal: a fault chip names a condition ("No audio from the
   * microphone"), a hold chip describes the script ("Holding here"), and the
   * two are never confusable even in monochrome.
   */
  .hold-status[data-tone='fault'] {
    color: var(--stage-cue);
  }

  @media (prefers-reduced-motion: reduce) {
    .hold-status,
    .hold-status[data-visible='true'] {
      transition: none;
    }
  }
</style>
