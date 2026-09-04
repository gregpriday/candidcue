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
  A POINT CANNOT MARK A LINE, SO IT MARKS THE START OF ONE
  ---------------------------------------------------------------------------
  The document advances one line pitch per line and the mark is fixed, so the
  mark's position relative to the line being read travels a full pitch over that
  line — and only the PHASE of that travel can be tuned. The phase
  (`lineEntryOffsetPx`) puts the tick on the middle of the capitals at the instant
  a line begins. By the last word of that line the same tick is a pitch lower,
  which is to say it is on the line below: correct as handoff, and it reads as the
  mark pointing under the words.

  No phase fixes both ends. A quarter pitch was tried and moved the error to line
  entry, where the eye is closest to the tick and notices most.

  A HAIRLINE MARKING THAT PITCH WAS TRIED HERE AND REMOVED. The geometry was
  sound — the reading position rises from the tick, so the pitch above it is where
  the line lives — but it did not work on glass at any weight. At the tick's own
  stroke it was the loudest thing on the display; cut to a quarter of that at 0.10
  it was a 4%-grey sliver that read as an artefact rather than an instrument.
  Between "competing with the mark" and "looks broken" there was no useful middle,
  which is the answer: a rule in the gutter is the wrong object for this. The
  `wash` style still marks the same one-pitch band, as a plateau over the text,
  and that is the place to reach for if the drift needs answering again.

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
    /**
     * One line pitch, CSS px — the distance the reading position travels while a
     * single line is being read, and therefore the height of the `wash` plateau.
     *
     * Used by `wash` only; `ticks` draws nothing that depends on it. Pass the
     * TYPOGRAPHIC pitch (`fontSizePx * lineHeight`), not the measured median: the
     * plateau is a statement about where the mark's phase puts the line, so it
     * has to be the number that phase was computed with, and inside a paragraph
     * the CSS line box IS the baseline-to-baseline distance exactly. Zero or
     * missing falls back to {@link TRAVEL_FALLBACK_CAPS}.
     */
    linePitchPx?: number;
  }

  let {
    style,
    bandCenterPx,
    columnLeftPx,
    columnWidthPx,
    hollow = false,
    sizePx = 24,
    linePitchPx = 0,
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
   * object, far enough that a descender never touches it. The column leaves
   * about 9% of the safe width on each side (`MAX_COLUMN_FRACTION`), which is a
   * designed margin rather than a clearance — comfortably more than a tick and
   * this gap at the sizes a prompter runs. The clamps below stay as the
   * backstop for the case the fraction cannot cover: type that is a large
   * fraction of its own panel, where the mark would otherwise slide off the
   * edge of a display nobody anticipated.
   */
  const gapPx = $derived(unitPx * 0.5);

  const leftTickPx = $derived(leftPx - gapPx - tickWidthPx);
  const rightTickPx = $derived(leftPx + widthPx + gapPx);

  /**
   * The travel, in cap heights, when no pitch has been handed over.
   *
   * At the proportions the stage actually ships — a 0.70 cap ratio against a
   * 1.32 line height — a pitch is 1.89 caps, so this is that same band expressed
   * in the one unit this component can always resolve. It is a fallback and not
   * a second opinion: `linePitchPx` is right whenever it is present.
   */
  const TRAVEL_FALLBACK_CAPS = 1.9;

  /**
   * The largest travel this will draw, in cap heights.
   *
   * Not a taste limit — a ceiling on damage, and the counterpart of the floor
   * `unitPx` puts under `sizePx`. Settings reach the stage as an opaque document
   * that Rust validates only for `schemaVersion`, so `fontSizePx * lineHeight`
   * can arrive as any finite number at all; `Number.isFinite` lets 1e6 through,
   * and a 1.9-million-pixel wash plateau lights the entire glass while its skirt
   * decays too slowly to fade anywhere on it. Real typography lands near 1.9
   * caps and cannot plausibly exceed a lineHeight of 1.8 over a 0.5 cap ratio,
   * which is 3.6, so this is well clear of anything a rig can mean.
   */
  const TRAVEL_MAX_CAPS = 6;

  /**
   * The band above the mark: one line pitch, which is exactly how far the
   * reading position rises while a line is being read.
   */
  const travelPx = $derived(
    Number.isFinite(linePitchPx) && linePitchPx > 0
      ? Math.min(linePitchPx, unitPx * TRAVEL_MAX_CAPS)
      : unitPx * TRAVEL_FALLBACK_CAPS,
  );

  /**
   * How far past the plateau the wash fades, as a fraction of the travel.
   *
   * The plateau is the claim — "the line is in here" — and the skirts only keep
   * its edges off the lines above and below, which a hard edge at exactly one
   * pitch would sit on. Total height is therefore 1.9 travels, near enough the
   * 3.2 cap heights this shipped with; what changed is that the LIT part grew
   * from about half a pitch to exactly one, and moved up by half a pitch to sit
   * where the line actually is.
   */
  const WASH_SKIRT_FRACTION = 0.45;
  const washHeightPx = $derived(travelPx * (1 + 2 * WASH_SKIRT_FRACTION));
  /** Plateau edges as percentages of the wash's own height, for the gradient. */
  const plateauTopPercent = (WASH_SKIRT_FRACTION / (1 + 2 * WASH_SKIRT_FRACTION)) * 100;
  const plateauBottomPercent = 100 - plateauTopPercent;

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

    Full width, at 6% over black. The underlay it descends from ran at about 2%,
    which is under the threshold at which a surface reads as lit at all; 6% is
    visible in peripheral vision and still quiet enough that the script stays the
    brightest thing on the glass.

    Its plateau is the same one-sided band the ticks draw: exactly one pitch,
    reaching UP from the mark rather than centred on it, because that is the
    glass the line being read actually occupies. Centred is the version that is
    lit half a pitch below every line for the whole take.
  -->
  <div class="cue wash" data-hollow={hollow} aria-hidden="true">
    <div
      class="wash-band"
      style:top="{centerPx - travelPx / 2}px"
      style:height="{washHeightPx}px"
      style:--plateau-top="{plateauTopPercent}%"
      style:--plateau-bottom="{plateauBottomPercent}%"
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
    /* The plateau is exactly one line pitch — the band above the mark — and the
       skirts are 0.45 of one on each side. The percentages come in as custom
       properties because they follow from that ratio rather than from a pair of
       chosen stops, and the rules below are pinned to the same two edges. */
    background: linear-gradient(
      180deg,
      rgb(245 243 239 / 0%) 0%,
      rgb(245 243 239 / 6%) var(--plateau-top, 24%),
      rgb(245 243 239 / 6%) var(--plateau-bottom, 76%),
      rgb(245 243 239 / 0%) 100%
    );
    transition: background var(--stage-fx-ms, 200ms) linear;
  }

  .wash[data-hollow='true'] .wash-band {
    background: linear-gradient(
      180deg,
      rgb(245 243 239 / 0%) 0%,
      rgb(245 243 239 / 2%) var(--plateau-top, 24%),
      rgb(245 243 239 / 2%) var(--plateau-bottom, 76%),
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
    top: var(--plateau-top, 24%);
  }
  .wash-rule-bottom {
    top: calc(var(--plateau-bottom, 76%) - 1px);
  }

  @media (prefers-reduced-motion: reduce) {
    .tick svg path,
    .wash-band {
      transition: none;
    }
  }
</style>
