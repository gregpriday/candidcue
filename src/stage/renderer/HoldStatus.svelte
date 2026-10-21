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
  import type { HoldHint, HoldRung, HoldTone } from './hold-status';

  interface Props {
    rung: HoldRung;
    message: string | null;
    tone: HoldTone;
    /**
     * A second line naming what the presenter can do about it, or null.
     *
     * Drawn quieter than the condition above it, because it is the less urgent
     * half of the chip: the message is what is happening and has to be legible
     * at a glance, the hint is what to do about it and is read on purpose by
     * somebody who has already decided to act. Quieter in weight and tone, NOT
     * in size — it is still words read from the presenter's mark, and it is
     * held to the same optical floor as everything else on the glass.
     */
    hint?: HoldHint | null;
    /**
     * The floor from `ResolvedOptics`. This is words somebody has to read from
     * where they are standing, so it is sized like the secondary text it is —
     * not at the fixed 12–13 px that made every other stage label decoration
     * rather than communication.
     */
    secondaryMinPx: number;
    /**
     * Draw a mark instead of the sentence — `hold-status.ts` decides when, and
     * only ever for the plain hold. See the note on `HoldStatus.glyph`.
     *
     * The words are still latched and still announced: this changes what the
     * GLASS shows, not what a screen reader is told. A presenter reading by ear
     * gets "Holding here" exactly as before, which a pause mark cannot say.
     */
    glyph?: 'held' | null;
    /**
     * The stage's resolved reduced-motion preference — the app's own setting
     * OR the system's. The media query below only knows the second, and a
     * presenter who turned motion off in Speaking Glass should not still get a fade.
     */
    reducedMotion?: boolean;
    /**
     * The chip's height while it is showing, 0 while it is not — for the
     * reading window's offer, which sits below this row rather than over a
     * two-line message.
     */
    heightPx?: number;
  }

  let {
    rung,
    message,
    tone,
    hint = null,
    secondaryMinPx,
    glyph = null,
    reducedMotion = false,
    heightPx = $bindable(0),
  }: Props = $props();

  /**
   * The mark latches with the message, and it has to.
   *
   * `glyph` clears the instant following resumes while `latched` holds its
   * sentence for the length of the fade — so an unlatched mark turned the
   * compact badge back into the full-width slab at nearly full opacity and then
   * faded THAT, which is the one moment the chip exists not to draw the eye to.
   */
  // svelte-ignore state_referenced_locally
  let latchedGlyph = $state(glyph);
  $effect(() => {
    if (typeof message === 'string' && message.length > 0) latchedGlyph = glyph;
  });

  const visible = $derived(rung === 'message' && typeof message === 'string' && message.length > 0);

  /**
   * The tone latches with the words, for the same reason they do.
   *
   * Following resumes with a NEUTRAL tone while the fault's sentence is still
   * fading, so an unlatched tone repainted "No audio" from the cue colour to
   * plain text in the middle of its own exit — a second change at the moment
   * the chip exists to make none.
   */
  // svelte-ignore state_referenced_locally
  let latchedTone = $state(tone);
  $effect(() => {
    if (typeof message === 'string' && message.length > 0) latchedTone = tone;
  });

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
  let latchedHint = $state<HoldHint | null>(hint);
  $effect(() => {
    if (hint !== null && hint.keys.length > 0) latchedHint = hint;
    else if (visible) latchedHint = null;
  });

  let drawnHeight = $state(0);
  $effect(() => {
    heightPx = visible ? drawnHeight : 0;
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
  data-tone={latchedTone}
  data-glyph={latchedGlyph ?? undefined}
  data-reduced-motion={reducedMotion ? 'true' : undefined}
  role="status"
  aria-live="polite"
  style:font-size="{fontSizePx}px"
  bind:offsetHeight={drawnHeight}
>
  {#if latchedGlyph === 'held'}
    <!--
      The reading cue's own two marks, facing each other, at chip size — and
      drawn the way the cue is drawn while it holds: OUTLINED. The cue has gone
      hollow by the time this appears, so a filled pair here asked the presenter
      to learn a second picture of the same state.

      NOT a pause symbol, and that is deliberate: this app already draws two
      upright bars for the transport's Pause, bound to Space (`Live.svelte`), so
      the same shape on the glass would tell a presenter that capture had
      stopped — and the response to that is to stop speaking, which is the one
      thing that will not clear an alignment hold. These are the ticks that
      bracket the reading line every take, so the badge reads as what it is:
      that mark, parked.

      aria-hidden, with the sentence kept beside it for anybody listening: the
      mark is for the eye, and "Holding here" is what the status says. Sized in
      `em` so it tracks the chip's own resolved floor.
    -->
    <svg class="glyph" viewBox="0 0 22 14" aria-hidden="true">
      <path d="M3.2 2.6 L9 7 L3.2 11.4 Z" />
      <path d="M18.8 2.6 L13 7 L18.8 11.4 Z" />
    </svg>
    <span class="sr-only">{latched}</span>
  {:else}
    <span class="condition">
      {#if latchedTone === 'fault'}
        <!--
          The audio readout's fault mark: a cue-coloured disc with a cross cut
          out of it. A fault and a wait were both a dark box of light words,
          and telling them apart meant reading the words or catching the
          colour; this gives the one that needs the presenter a SHAPE of its
          own, the same shape the dock already uses for the same news.
        -->
        <svg class="fault-mark" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="11" />
          <path d="M8 8 L16 16 M16 8 L8 16" />
        </svg>
      {/if}
      <span class="message">{latched}</span>
    </span>
  {/if}
  {#if latchedHint !== null}
    <span class="hint">
      <!-- The key first, as a key: it is the part the presenter acts on, and a
           cap is recognisable in peripheral vision before it is read. -->
      <span class="legend" aria-hidden="true"
        >{#each latchedHint.keys as key, i (i)}<kbd class="cap">{key}</kbd>{/each}<span
          class="action">{latchedHint.action}</span
        ></span
      >
      <span class="sr-only">{latchedHint.spoken}</span>
    </span>
  {/if}
</div>

<style>
  .hold-status {
    position: absolute;
    /* The shared chrome geometry, so the chip lines up with the dock's left
       edge and carries the same material as everything else that floats over
       the script. It was 24px against a stage whose other overlays used 18px, a
       spacing token, and a viewport fraction.

       `--stage-hold-top` is the one exception, set by the stage only where
       something else already owns the corner the chip would land in. */
    top: var(--stage-hold-top, var(--stage-chrome-inset, 20px));
    left: var(--stage-chrome-inset, 20px);
    /*
     * One row per line, as far as the glass allows.
     *
     * This was 40vw, which on a 9-inch panel is 410px against a 34px floor: a
     * three-word condition wrapped, "Two matching places — holding here" took
     * three rows, and the card grew DOWN toward the reading line it exists to
     * stay clear of. Every string the chip carries is a few words, so the cap
     * is the plane's own width, and wrapping is left for a window too narrow to
     * hold one row.
     */
    max-width: calc(100% - 2 * var(--stage-chrome-inset, 20px));
    box-sizing: border-box;
    padding: 0.38em 0.68em;
    border: 1px solid var(--stage-chrome-border, rgba(255, 255, 255, 0.13));
    border-radius: var(--stage-chrome-radius, 12px);
    /*
     * The near-opaque fill the dock's popovers and the audio readout's label
     * use, not the translucent one, laid over the stage's own field colour.
     *
     * The chip sits over lines the presenter has already read. Through a 74%
     * fill those lines showed as a second layer of words — ghosted script
     * between "No audio" and its hint — and even at 92% the large type behind
     * stayed legible enough to read. Compositing onto an opaque `--stage-bg`
     * gives exactly the colour the shared fill has over an empty field, with
     * nothing of the script left in it.
     */
    background:
      linear-gradient(
        var(--stage-chrome-bg-solid, rgb(12 14 18 / 92%)),
        var(--stage-chrome-bg-solid, rgb(12 14 18 / 92%))
      ),
      var(--stage-bg, #000);
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
   * The mark alone needs no reading room around it: the sentence padding made
   * a 136px slab around a 50px glyph, reaching into the first word of the line.
   */
  .hold-status[data-glyph='held'] {
    padding: 0.36em 0.42em;
  }

  /*
   * Faults use the same warm cue colour the stage already spends on authored
   * cues and on the voice pill's fault mark, so a presenter who has seen one
   * recognises this as the app talking to them rather than as a new kind of
   * event. It is emphatically not red: red on a prompter reads as "stop", and
   * the presenter should keep going while somebody fixes the microphone.
   *
   * §20 — state is never colour alone. A fault carries the readout's crossed
   * disc and names a condition in words ("No audio"); an ordinary hold is a
   * mark and no words at all; a wait that is worded has no disc. The three are
   * never confusable in monochrome.
   */
  .hold-status[data-tone='fault'] .condition {
    color: var(--stage-cue);
  }

  .condition {
    display: flex;
    align-items: center;
    gap: 0.38em;
  }

  /* The readout's fault mark at the chip's own size: the FIELD's colour cut out
     of a cue-coloured disc, as `VoicePill.svelte` draws it. */
  .fault-mark {
    flex: none;
    width: 0.92em;
    height: 0.92em;
  }
  .fault-mark circle {
    fill: var(--stage-cue);
  }
  .fault-mark path {
    fill: none;
    stroke: var(--stage-mark-ink, #000);
    stroke-width: 3;
    stroke-linecap: round;
  }

  /*
   * The parked ticks, sized against the chip's own resolved floor rather than a
   * pixel count, so it tracks the rig exactly as the words it replaces did.
   *
   * `display: block` and a matched height are what keep the chip a square-ish
   * badge instead of a line box with a glyph adrift in it — the padding is in
   * `em`, so with no text to set the line height the box would otherwise
   * collapse to something the border draws a slot around.
   *
   * Outlined with a stroke heavy enough to survive the glass: the cue's own
   * held state, not a thinner cousin of it.
   */
  .glyph {
    display: block;
    width: 1.55em;
    height: 1em;
  }
  .glyph path {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linejoin: round;
  }

  /*
   * Present for the ear, absent from the glass.
   *
   * `role="status"` on the chip announces whatever is inside it, and the mark
   * says nothing — so the sentence stays here for a presenter reading by ear.
   * Not `display: none`, which would take it out of the accessibility tree and
   * leave the status silent.
   */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /*
   * The recovery line: its own row, quieter, and never the cue colour.
   *
   * Quieter in WEIGHT and TONE, never in size. It was 0.82em, which put the one
   * actionable line on the glass 18% under the optical floor every other piece
   * of presenter text is held to — the condition legible from the mark, and
   * the thing to do about it not. It inherits the chip's own colour rather than
   * the fault's warm cue, because two lines in the alarm colour make the advice
   * look like a second fault instead of the answer to the first.
   *
   * A tight rhythm between the two rows, and a cap no taller than it needs to
   * be: on a mirrored single-window take the chip starts below the host's tab,
   * and every em of height it spends lands on the reading cue's tick beneath.
   */
  .hint {
    display: block;
    margin-top: 0.22em;
  }

  .legend {
    display: flex;
    align-items: center;
    gap: 0.22em;
    font-weight: 500;
    color: var(--stage-text);
  }

  /*
   * The key, drawn as a key — the shortcuts sheet's cap, at glass scale.
   *
   * Full text colour while the words after it are dimmed, so the eye lands on
   * the thing to press first. A rule rather than a fill: a filled light cap is
   * the brightest object on a black field, and the cue colour is the fault's.
   */
  .cap {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    min-width: 1.22em;
    height: 1.22em;
    padding: 0 0.28em;
    border: max(1px, 0.06em) solid currentColor;
    border-radius: 0.24em;
    font: inherit;
    font-weight: 650;
    line-height: 1;
  }

  .action {
    margin-left: 0.2em;
    opacity: 0.74;
  }

  .hold-status[data-reduced-motion='true'],
  .hold-status[data-reduced-motion='true'][data-visible='true'] {
    transition: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .hold-status,
    .hold-status[data-visible='true'] {
      transition: none;
    }
  }
</style>
