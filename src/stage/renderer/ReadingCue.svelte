<!--
  What marks the reading position.

  ---------------------------------------------------------------------------
  WHY THIS REPLACES THE PHRASE UNDERLAY
  ---------------------------------------------------------------------------
  The underlay was a rounded rectangle drawn around the sentence the aligner
  believed was current. It failed in two ways at once, and both are structural
  rather than a matter of tuning.

  It ASSERTED A PHRASE. While recognition is uncertain — which is most of a
  hold — the assertion is a claim the engine has explicitly declined to make,
  and the presenter reads the box rather than the state. Worse, when the belief
  moved by one sentence the box jumped, resized and re-wrapped, so the single
  most eye-catching element on the glass moved every time the engine changed its
  mind. A teleprompter's whole job is to be still.

  And it was invisible. `currentUnderlayOpacity` shipped around 0.02 over a
  black field, which is below the threshold at which anything orients by it. So
  it was simultaneously too faint to use and too unstable to trust.

  The replacement is FIXED ON SCREEN. It marks the LINE the reader should be
  on — the reading band, which is a property of the rig, not of the aligner —
  and it never moves, never resizes and never claims a word. It cannot be wrong
  about the script because it says nothing about the script.

  ---------------------------------------------------------------------------
  SHAPE, NOT OPACITY
  ---------------------------------------------------------------------------
  The ticks are triangles with a real silhouette, not soft glows. A shape at the
  edge of vision reads as an instrument mark and is found instantly by peripheral
  vision; a gradient of the same average luminance reads as a smudge on the glass
  and gets cleaned rather than used. This is also what makes the hold ladder
  possible: a shape has a solid state and an outline state that differ in KIND,
  where a wash has only more or less of itself.

  Presentational only. Every position arrives as a prop; nothing here measures,
  subscribes or decides.
-->
<script lang="ts">
  import type { ReadingCueStyle } from '../../shared/contracts';

  interface Props {
    style: ReadingCueStyle;
    /** Reading band centre, CSS px from the top of the stage. */
    bandCenterPx: number;
    /** Left edge of the text column, CSS px. */
    columnLeftPx: number;
    columnWidthPx: number;
    /**
     * The first rung of the hold ladder: solid becomes outline.
     *
     * Deliberately the whole of the change. No pulse, no motion, no colour —
     * the presenter is mid-sentence and the cue's job at this moment is to
     * report without being looked at.
     */
    hollow?: boolean;
    /**
     * Height of one tick, CSS px.
     *
     * Pass the body CAP HEIGHT (`bodyFontSizePx * capHeightRatio`) so the mark
     * stays the size of a letter at every distance and on every panel. The
     * default is a desk-distance guess for a caller that has not resolved
     * optics yet, and is the one number here that is not derived from the rig.
     */
    sizePx?: number;
  }

  let {
    style,
    bandCenterPx,
    columnLeftPx,
    columnWidthPx,
    hollow = false,
    sizePx = 24,
  }: Props = $props();

  /** Props cross a process boundary; a NaN here would take the layout out. */
  function finite(value: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  const unitPx = $derived(Math.max(8, finite(sizePx, 24)));
  const centerPx = $derived(Math.max(0, finite(bandCenterPx, 0)));
  const leftPx = $derived(Math.max(0, finite(columnLeftPx, 0)));
  const widthPx = $derived(Math.max(0, finite(columnWidthPx, 0)));

  /* The triangle is drawn in a 16x18 box, so its width tracks its height. */
  const tickWidthPx = $derived((unitPx * 16) / 18);

  /**
   * How far outside the column the ticks sit.
   *
   * Half a unit: close enough that the eye takes the tick and the line as one
   * object, far enough that a descender never touches it. The column already
   * leaves ~4% of the safe width on each side, which on the narrowest panel
   * CandidCue supports is just enough for a tick and this gap — hence the
   * clamps below, which pull a tick back on screen rather than letting it slide
   * off the edge of a display nobody anticipated.
   */
  const gapPx = $derived(unitPx * 0.5);

  const leftTickPx = $derived(leftPx - gapPx - tickWidthPx);
  const rightTickPx = $derived(leftPx + widthPx + gapPx);

  /**
   * Total height of the wash, in units of the cap height it is handed.
   *
   * A cap height is roughly half a line pitch, so 3.2 of them is about one and
   * two-thirds lines — and only the middle 36% of that is lit (see the gradient
   * stops below), which lands the plateau at roughly half a line. That is the
   * size that reads as "this line", with the fade skirts falling away before
   * they reach the lines above and below. Sized in caps rather than in pixels
   * so a 9-inch panel and a 15.6-inch one get the same mark relative to type.
   */
  const WASH_HEIGHT_UNITS = 3.2;
</script>

{#if style === 'ticks'}
  <!-- aria-hidden: this is a position mark for the eye. A screen reader user
       is not reading off the glass, and announcing it would interrupt the
       transcript status that is actually useful to them. -->
  <div class="cue ticks" data-hollow={hollow} aria-hidden="true">
    <span
      class="tick"
      style:left="max(0px, {leftTickPx}px)"
      style:top="{centerPx}px"
      style:width="{tickWidthPx}px"
      style:height="{unitPx}px"
    >
      <svg viewBox="0 0 16 18">
        <!-- Stroked in BOTH states and filled in only one, so the silhouette
             is identical either way. A fill that also changed the outline would
             make the mark grow and shrink, which is movement. -->
        <path
          d="M3 2 L14 9 L3 16 Z"
          fill="currentColor"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linejoin="round"
        />
      </svg>
    </span>
    <span
      class="tick"
      style:left="min({rightTickPx}px, calc(100% - {tickWidthPx}px))"
      style:top="{centerPx}px"
      style:width="{tickWidthPx}px"
      style:height="{unitPx}px"
    >
      <svg viewBox="0 0 16 18">
        <path
          d="M13 2 L2 9 L13 16 Z"
          fill="currentColor"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linejoin="round"
        />
      </svg>
    </span>
  </div>
{:else if style === 'wash'}
  <!--
    The louder option, for presenters who cannot find the line from the ticks.

    Full width and centred on the band, at 6% over black. The underlay it
    descends from ran at about 2%, which is under the threshold at which a
    surface reads as lit at all; 6% is visible in peripheral vision and still
    quiet enough that the script stays the brightest thing on the glass.
  -->
  <div class="cue wash" data-hollow={hollow} aria-hidden="true">
    <div
      class="wash-band"
      style:top="{centerPx}px"
      style:height="{unitPx * WASH_HEIGHT_UNITS}px"
    >
      {#if hollow}
        <!-- Same solid-to-outline move as the ticks, applied to a band: the
             fill drops away and the plateau's two edges are drawn instead. -->
        <span class="wash-rule wash-rule-top"></span>
        <span class="wash-rule wash-rule-bottom"></span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .cue {
    position: absolute;
    inset: 0;
    /* The stage has no pointer affordances and this one least of all. */
    pointer-events: none;
    color: var(--stage-text);
  }

  .tick {
    position: absolute;
    display: block;
    /* Centred ON the band rather than hanging below it: the band centre is
       where the reader's eyeline rests, and the mark has to agree with it to
       the pixel or it teaches the wrong line. */
    transform: translateY(-50%);
  }

  .tick svg {
    display: block;
    width: 100%;
    height: 100%;
    /* Quiet enough to sit under the script's brightness, solid enough to be
       found without being looked for. */
    opacity: 0.5;
  }

  .tick svg path {
    /* The one tween here, and it is not motion: nothing changes position or
       size, only how much of the triangle is inked. An instant ink change at
       the edge of peripheral vision registers as a flicker and pulls the eye
       off the line — the exact cost the ladder exists to avoid paying. Rides
       the same variable every other stage tween does, so frame pressure
       (§61 step 1) removes it along with the rest. */
    transition: fill-opacity var(--stage-fx-ms, 200ms) linear;
  }

  .ticks[data-hollow='true'] .tick svg path {
    fill-opacity: 0;
  }

  .wash-band {
    position: absolute;
    left: 0;
    right: 0;
    transform: translateY(-50%);
    /* The plateau runs 32%–68% of the band's height; the rules below are
       pinned to those same two edges. */
    background: linear-gradient(
      180deg,
      rgb(245 243 239 / 0%) 0%,
      rgb(245 243 239 / 6%) 32%,
      rgb(245 243 239 / 6%) 68%,
      rgb(245 243 239 / 0%) 100%
    );
    transition: background var(--stage-fx-ms, 200ms) linear;
  }

  .wash[data-hollow='true'] .wash-band {
    background: linear-gradient(
      180deg,
      rgb(245 243 239 / 0%) 0%,
      rgb(245 243 239 / 2%) 32%,
      rgb(245 243 239 / 2%) 68%,
      rgb(245 243 239 / 0%) 100%
    );
  }

  .wash-rule {
    position: absolute;
    left: 0;
    right: 0;
    height: 1px;
    background: rgb(245 243 239 / 16%);
  }
  .wash-rule-top {
    top: 32%;
  }
  .wash-rule-bottom {
    top: calc(68% - 1px);
  }

  @media (prefers-reduced-motion: reduce) {
    .tick svg path,
    .wash-band {
      transition: none;
    }
  }
</style>
