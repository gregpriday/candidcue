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
  Top left, deliberately away from two things: the text column (centred on the
  lens) and the session dock (bottom left, with the audio readout and the
  transcript above it). It also sits above the reading band, so a glance at it
  is a glance the eye can make and return from without losing the line.

  It is mounted INSIDE the mirror plane and inside the safe rectangle. This is
  the only route a fault name has to the presenter — the audio readout in the
  dock is unmirrored operator chrome, and an unmirrored word is the one thing
  guaranteed to be unreadable in a beamsplitter's reflection. A chip placed
  against the raw viewport on a hooded rig lands under the bezel, where the one
  message worth reading is the one nobody can see. The offsets below are
  relative to whatever container it is given.

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
     * A second line naming what the presenter can do about it, or null.
     *
     * Drawn quieter and smaller than the condition above it, because it is the
     * less urgent half of the chip: the message is what is happening and has to
     * be legible at a glance, the hint is what to do about it and is read on
     * purpose by somebody who has already decided to act.
     */
    hint?: string | null;
    /**
     * The floor from `ResolvedOptics`. This is words somebody has to read from
     * where they are standing, so it is sized like the secondary text it is —
     * not at the fixed 12–13 px that made every other stage label decoration
     * rather than communication.
     */
    secondaryMinPx: number;
  }

  let { rung, message, tone, hint = null, secondaryMinPx }: Props = $props();

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
   * The hint latches with the message, and for the same reason.
   *
   * It is latched SEPARATELY rather than folded into the message, because the
   * two clear independently: turning the transport on withdraws the hint while
   * the fault it accompanied is still true, and a single latch would either
   * strand the advice or blank the condition along with it.
   *
   * It is cleared only while something is actually BEING SAID. A hint withdrawn
   * mid-fault has to disappear — it is advice to do a thing already being done.
   * One that is merely fading out with the chip must not, because removing it
   * shrinks the box while the box is fading, and that is movement at the one
   * moment the presenter should be able to ignore entirely. The same rule keeps
   * a spent fault hint from reappearing under the next ordinary hold message,
   * which has no advice to offer and must not borrow the last one's.
   */
  // svelte-ignore state_referenced_locally
  let latchedHint = $state(hint ?? '');
  $effect(() => {
    if (typeof hint === 'string' && hint.length > 0) latchedHint = hint;
    else if (visible) latchedHint = '';
  });
  const hintVisible = $derived(latchedHint.length > 0);

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
  {#if hintVisible}
    <span class="hint">{latchedHint}</span>
  {/if}
</div>

<style>
  .hold-status {
    position: absolute;
    /* The shared chrome geometry, so the chip lines up with the dock's left
       edge and carries the same material as everything else that floats over
       the script. It was 24px against a stage whose other overlays used 18px, a
       spacing token, and a viewport fraction. */
    top: var(--stage-chrome-inset, 20px);
    left: var(--stage-chrome-inset, 20px);
    max-width: 40vw;
    padding: 0.45em 0.85em;
    border: 1px solid var(--stage-chrome-border, rgba(255, 255, 255, 0.13));
    border-radius: var(--stage-chrome-radius, 12px);
    background: var(--stage-chrome-bg, rgba(12, 14, 18, 0.74));
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

  /*
   * The recovery line: its own row, quieter, and never the cue colour.
   *
   * Sized in `em` so it tracks whatever floor the optics resolved rather than
   * pinning itself to a pixel count that is legible on one rig and not on the
   * next — and it inherits the chip's own colour at reduced opacity rather than
   * taking the fault's warm cue, because two lines in the alarm colour make the
   * advice look like a second fault instead of the answer to the first.
   */
  .hint {
    display: block;
    margin-top: 0.25em;
    font-size: 0.82em;
    font-weight: 500;
    color: var(--stage-text);
    opacity: 0.72;
  }

  @media (prefers-reduced-motion: reduce) {
    .hold-status,
    .hold-status[data-visible='true'] {
      transition: none;
    }
  }
</style>
