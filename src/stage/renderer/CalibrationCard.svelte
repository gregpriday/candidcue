<!--
  The calibration overlays: four cards, one component, selected by `mode`.

  ---------------------------------------------------------------------------
  WHY ONE COMPONENT
  ---------------------------------------------------------------------------
  These four are drawn at four different moments of one wizard, but they share a
  single constraint that dominates everything else about them: the person
  reading them is looking through a beamsplitter, from where they will stand,
  at a display that may be mirrored in either axis. So they share a palette
  (near-white on black, nothing subtle), a type floor (nothing small enough to
  be "a detail"), and a rule that every element must survive being flipped.
  Splitting them into four files would make it easy for one to drift off that
  shared contract, which is the only thing making any of them usable.

  ---------------------------------------------------------------------------
  THE ORIENTATION CARD IS THE HARD ONE
  ---------------------------------------------------------------------------
  Its entire job is to be WRONG in an obvious way when the flips are wrong, and
  the trap is that most things one would naturally draw — a cross, a circle, a
  centred box, the letters O, H, X, a symmetric arrow — look exactly the same
  mirrored. Every element on that card is therefore chosen for asymmetry:
  words rather than icons, an L-bent arrow rather than a straight one, a letter
  L rather than a dot, a face in which one eye is ringed and the nose leans.
  If an element on this card could be confused with its own reflection it is a
  defect, not a style choice.

  Presentational: the wizard owns the numbers and the step order. This draws.
-->
<script module lang="ts">
  /** Which card. Exported so the wizard can hold one in a typed store. */
  export type CalibrationMode = 'orientation' | 'safe-area' | 'ruler' | 'type-sample';
</script>

<script lang="ts">
  import type { SafeAreaInsets } from '../../shared/contracts';
  import { stageFontStack } from './text';

  interface Props {
    mode: CalibrationMode;

    /**
     * `safe-area`: the four edges, as fractions of the viewport, each moved
     * independently. Clamped here as well as in the resolver — this component
     * is dragged live, and a frame that inverts mid-drag is not debuggable by
     * the person doing the dragging.
     */
    insets?: SafeAreaInsets;

    /**
     * `ruler`: the bar's length in CSS pixels — the known quantity of the whole
     * measurement, so it is rendered exactly and never scaled to fit. Choose a
     * length that fits the panel; nothing here will silently shrink it, because
     * a bar that is not the length it claims produces a wrong physical scale
     * and every angular number downstream inherits the error.
     */
    barLengthPx?: number;

    /** `type-sample`: the size under consideration. */
    fontSizePx?: number;
    /** `type-sample`: the column measure under consideration, CSS `ch`. */
    columnCh?: number;
    fontWeight?: number;
    fontFamilyId?: string;
    /** Override the passage — e.g. with the presenter's own opening line. */
    sampleText?: string;

    /**
     * Floor for every label on these cards. Pass `optics.secondaryMinPx` once
     * it has been resolved; the default is a legible desk value for the steps
     * that run BEFORE there is any resolved optics to ask.
     */
    labelSizePx?: number;
  }

  let {
    mode,
    insets = { top: 0, right: 0, bottom: 0, left: 0 },
    barLengthPx = 400,
    fontSizePx = 64,
    columnCh = 34,
    fontWeight = 500,
    // The bundled default, matching `DEFAULT_STAGE_APPEARANCE`: a type sample
    // judged in one face and then prompted in another has measured nothing.
    fontFamilyId = 'high-legibility',
    sampleText,
    labelSizePx = 20,
  }: Props = $props();

  function finite(value: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  function clampFraction(value: number): number {
    return Math.min(0.45, Math.max(0, finite(value, 0)));
  }

  /** Nothing on a card read through glass from two metres may be small. */
  const labelPx = $derived(Math.max(16, finite(labelSizePx, 20)));

  const edges = $derived({
    top: clampFraction(insets.top),
    right: clampFraction(insets.right),
    bottom: clampFraction(insets.bottom),
    left: clampFraction(insets.left),
  });

  /**
   * Bounded at both ends, and the ceiling is not a layout preference.
   *
   * The tick loop below walks the bar in 50 px steps, so a caller that hands in
   * device pixels, a millimetre figure multiplied the wrong way, or a viewport
   * width read before layout would ask this component to mount tens of
   * thousands of spans and take the calibration step down with it — during the
   * one wizard the presenter cannot skip. Clamping the NUMBER rather than
   * scaling the drawn bar is what keeps the label honest: whatever survives
   * here is both the width rendered and the width printed.
   */
  const barPx = $derived(Math.min(4000, Math.max(50, Math.round(finite(barLengthPx, 400)))));

  /**
   * A weight outside 1–1000 is an invalid CSS declaration, which browsers drop
   * silently — the sample would then render at the inherited weight while the
   * control claims otherwise, on the one step whose entire purpose is judging
   * how the face reads through the glass.
   */
  function clampWeight(value: number): number {
    return Math.min(1000, Math.max(100, Math.round(finite(value, 500))));
  }

  /**
   * Minor tick every 50 px, major every 100.
   *
   * The ticks are not decoration: they are what lets somebody read a partial
   * measurement off a ruler that does not quite line up with the ends, and
   * what makes an accidentally scaled bar obvious — evenly spaced marks that
   * do not land on the ruler's own centimetres are a visible contradiction.
   * Both ends are excluded because the end caps already mark them.
   */
  const ticks = $derived.by(() => {
    const out: Array<{ x: number; major: boolean }> = [];
    for (let x = 50; x < barPx; x += 50) out.push({ x, major: x % 100 === 0 });
    return out;
  });

  /**
   * Long enough to wrap to about three lines at the ideal 32–38 character
   * measure, and chosen for what it contains rather than what it says: caps,
   * descenders, an apostrophe, an em dash and digits. A sample without digits
   * would hide the one glyph class that most often turns out to be too small
   * to read at distance.
   */
  const DEFAULT_SAMPLE =
    "Good morning. In the next 90 seconds I'll show you exactly how this works, and why it matters to you.";

  const sample = $derived(
    typeof sampleText === 'string' && sampleText.trim().length > 0 ? sampleText : DEFAULT_SAMPLE,
  );
</script>

<div class="calibration-card" data-mode={mode} style:font-size="{labelPx}px">
  {#if mode === 'orientation'}
    <!--
      Read this card and every flip is decided at once. If any label is on the
      wrong side, or any of it reads back to front, the axis that did it is
      named on the card itself.
    -->
    <div class="orient">
      <span class="orient-edge orient-top">TOP</span>
      <span class="orient-edge orient-bottom">BOTTOM</span>
      <span class="orient-edge orient-left">LEFT</span>
      <span class="orient-edge orient-right">RIGHT</span>

      <div class="orient-body">
        <!-- The bent arrow. A straight arrow is its own mirror about one axis;
             an L-bend is distinct under a horizontal flip, a vertical flip and
             a 180° rotation, which is all three cases the glass can produce. -->
        <svg class="orient-arrow" viewBox="0 0 150 100" aria-hidden="true">
          <path
            d="M14 82 H96 V38"
            fill="none"
            stroke="currentColor"
            stroke-width="9"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path d="M96 8 L78 42 L114 42 Z" fill="currentColor" />
          <!-- A solid tail block, so the arrow still has a distinguishable
               start if the head runs off a badly cropped hood. -->
          <rect x="8" y="70" width="14" height="24" rx="3" fill="currentColor" />
        </svg>

        <!-- Digits and letters together: '123' catches a vertical flip (a 1
             and a 3 are unrecognisable upside down) and 'ABC' catches a
             horizontal one. Either flip also reverses the reading order, which
             is a second, independent tell. -->
        <p class="orient-glyphs">123 / ABC</p>

        <svg class="orient-face" viewBox="0 0 200 150" aria-hidden="true">
          <!-- Shoulders, then head: an outline silhouette rather than a filled
               one, because a filled shape on black loses its features at the
               contrast a beamsplitter leaves. -->
          <path
            d="M35 150 Q48 120 78 112 L122 112 Q152 120 165 150"
            fill="none"
            stroke="currentColor"
            stroke-width="4"
            stroke-linecap="round"
          />
          <ellipse
            cx="100"
            cy="60"
            rx="42"
            ry="50"
            fill="none"
            stroke="currentColor"
            stroke-width="4"
          />
          <!-- The nose leans, so the face is not its own mirror even with the
               eye markings ignored. -->
          <path
            d="M100 56 L91 80 L104 83"
            fill="none"
            stroke="currentColor"
            stroke-width="3.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M84 96 Q100 106 116 96"
            fill="none"
            stroke="currentColor"
            stroke-width="3.5"
            stroke-linecap="round"
          />
          <!-- The marked eye: filled AND ringed AND lettered. Three
               independent markings because the one that survives a dim,
               half-silvered reflection is not always the one you expect. -->
          <circle cx="82" cy="52" r="13" fill="none" stroke="currentColor" stroke-width="3" />
          <circle cx="82" cy="52" r="6.5" fill="currentColor" />
          <!-- The other eye stays open and unmarked, so the pair is
               unambiguous rather than merely different. -->
          <circle cx="118" cy="52" r="6.5" fill="none" stroke="currentColor" stroke-width="3" />
          <path d="M46 54 H62" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
          <!-- 'L' rather than a dot or an arrow: it is strongly asymmetric in
               both axes, and a mirrored L is instantly wrong to anyone who has
               ever seen the letter. -->
          <text
            x="20"
            y="66"
            font-size="38"
            font-weight="700"
            fill="currentColor"
            font-family="inherit">L</text
          >
        </svg>

        <p class="orient-caption">
          The eye marked <strong>L</strong> must sit on the <strong>LEFT</strong> side, and every
          word on this card must read the right way round.
        </p>
      </div>
    </div>
  {:else if mode === 'safe-area'}
    <!--
      The frame the presenter fits inside what the hood actually reveals. Every
      piece of geometry downstream is computed inside this rectangle, so a frame
      set too generously silently pushes the text under the bezel.
    -->
    <div class="safe-field" aria-hidden="true">
      <div
        class="safe-rect"
        style:top="{edges.top * 100}%"
        style:right="{edges.right * 100}%"
        style:bottom="{edges.bottom * 100}%"
        style:left="{edges.left * 100}%"
      >
        <span class="safe-corner sc-tl"></span>
        <span class="safe-corner sc-tr"></span>
        <span class="safe-corner sc-bl"></span>
        <span class="safe-corner sc-br"></span>

        <span class="safe-label sl-top">TOP {Math.round(edges.top * 100)}%</span>
        <span class="safe-label sl-bottom">BOTTOM {Math.round(edges.bottom * 100)}%</span>
        <span class="safe-label sl-left">LEFT {Math.round(edges.left * 100)}%</span>
        <span class="safe-label sl-right">RIGHT {Math.round(edges.right * 100)}%</span>

        <p class="safe-hint">
          Move each edge in until the whole frame — all four corners — is inside what you can see in
          the glass.
        </p>
      </div>
    </div>
  {:else if mode === 'ruler'}
    <!--
      The physical scale, measured rather than looked up.

      The operating system reports device pixels, never millimetres, and a
      hardware table describes the panel rather than the finished optical path —
      so a magnifying beamsplitter, an overscanning panel or a misread display
      scale all vanish into this one measurement and nowhere else.
    -->
    <div class="ruler">
      <p class="ruler-lead">Hold a ruler flat against the glass and measure this bar.</p>

      <!-- Exactly `barPx` wide. The caps are 2 px and sit at the extreme ends,
           so the outer-edge-to-outer-edge span the label asks for is the length
           the label states, with nothing to interpret. -->
      <div class="ruler-bar" style:width="{barPx}px" aria-hidden="true">
        <span class="ruler-baseline"></span>
        {#each ticks as tick (tick.x)}
          <span
            class="ruler-tick"
            class:ruler-tick-major={tick.major}
            style:left="{tick.x - 1}px"
          ></span>
        {/each}
        <span class="ruler-cap ruler-cap-start"></span>
        <span class="ruler-cap ruler-cap-end"></span>
      </div>

      <p class="ruler-label">{barPx} CSS pixels — outer edge to outer edge</p>
      <p class="ruler-note">
        Type what you measured, in millimetres. That is how CandidCue works out how large the text
        really looks from where you stand.
      </p>
    </div>
  {:else}
    <!--
      The size step. The instruction is "the smallest that is effortless", not
      "the largest that fits": oversized type costs reading measure, and a line
      too short to carry a clause is its own reading problem.
    -->
    <div class="sample">
      <p
        class="sample-text"
        style:font-size="{Math.max(8, finite(fontSizePx, 64))}px"
        style:max-width="{Math.max(8, finite(columnCh, 34))}ch"
        style:font-weight={clampWeight(fontWeight)}
        style:font-family={stageFontStack(fontFamilyId)}
      >
        {sample}
      </p>
      <p class="sample-hint">
        Stand where you will present. Choose the smallest size you can read without effort.
      </p>
    </div>
  {/if}
</div>

<style>
  .calibration-card {
    position: absolute;
    inset: 0;
    /* Near-white on black and nothing else. A half-silvered mirror throws away
       most of the light, so anything mid-grey on these cards arrives at the
       presenter's eye as black. */
    color: var(--stage-text);
    background: var(--stage-bg);
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.35;
  }

  /* ---- orientation ---------------------------------------------------- */

  .orient {
    position: absolute;
    /*
     * The margin has to hold the labels that straddle the frame, not just look
     * like a margin. TOP and BOTTOM hang 0.75em outside the border, and this
     * card is sized from the resolved secondary-text floor — which on an
     * uncalibrated rig is already ~43px, so 0.75em is ~32px. A flat 3% is 18px
     * on the 9-inch prompter panel, and the two labels the ORIENTATION card
     * exists to show would be the first thing the stage clipped.
     */
    inset: max(3%, 1.5em);
    /* A visible frame, so TOP/BOTTOM/LEFT/RIGHT are anchored to something the
       eye can see rather than floating near an edge that may be cropped. */
    border: 2px solid rgb(245 243 239 / 55%);
    border-radius: 12px;
  }

  .orient-edge {
    position: absolute;
    padding: 0.2em 0.6em;
    font-weight: 700;
    letter-spacing: 0.12em;
    white-space: nowrap;
    background: var(--stage-bg);
  }
  .orient-top {
    top: -0.75em;
    left: 50%;
    transform: translateX(-50%);
  }
  .orient-bottom {
    bottom: -0.75em;
    left: 50%;
    transform: translateX(-50%);
  }
  .orient-left {
    left: 0.6em;
    top: 50%;
    transform: translateY(-50%);
  }
  .orient-right {
    right: 0.6em;
    top: 50%;
    transform: translateY(-50%);
  }

  .orient-body {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.6em;
    padding: 2.5em 6em;
    text-align: center;
  }

  .orient-arrow {
    width: min(26vw, 220px);
    height: auto;
  }

  .orient-glyphs {
    margin: 0;
    font-size: 1.9em;
    font-weight: 700;
    letter-spacing: 0.16em;
    /* Tabular figures: a proportional '1' is narrow enough that a mirrored
       '123' can pass at a glance. */
    font-variant-numeric: tabular-nums;
  }

  .orient-face {
    width: min(22vw, 200px);
    height: auto;
  }

  .orient-caption {
    margin: 0;
    max-width: 34em;
    opacity: 0.85;
  }

  /* ---- safe area ------------------------------------------------------ */

  .safe-field {
    position: absolute;
    inset: 0;
  }

  .safe-rect {
    position: absolute;
    border: 2px solid rgb(245 243 239 / 92%);
    /* Everything OUTSIDE the frame is washed, so the safe rectangle reads as a
       clean hole in a lit field. Against a black stage a bare outline gives no
       sense of which side is "in", and people set the frame inside out. */
    box-shadow: 0 0 0 100vmax rgb(245 243 239 / 5%);
  }

  .safe-corner {
    position: absolute;
    width: 42px;
    height: 42px;
    border: 5px solid var(--stage-text);
  }
  .sc-tl {
    top: -2px;
    left: -2px;
    border-right: none;
    border-bottom: none;
  }
  .sc-tr {
    top: -2px;
    right: -2px;
    border-left: none;
    border-bottom: none;
  }
  .sc-bl {
    bottom: -2px;
    left: -2px;
    border-right: none;
    border-top: none;
  }
  .sc-br {
    bottom: -2px;
    right: -2px;
    border-left: none;
    border-top: none;
  }

  .safe-label {
    position: absolute;
    padding: 0.2em 0.6em;
    font-weight: 650;
    letter-spacing: 0.08em;
    white-space: nowrap;
    background: var(--stage-bg);
  }
  .sl-top {
    top: 0.6em;
    left: 50%;
    transform: translateX(-50%);
  }
  .sl-bottom {
    bottom: 0.6em;
    left: 50%;
    transform: translateX(-50%);
  }
  .sl-left {
    left: 0.6em;
    top: 50%;
    transform: translateY(-50%);
  }
  .sl-right {
    right: 0.6em;
    top: 50%;
    transform: translateY(-50%);
  }

  .safe-hint {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    margin: 0;
    max-width: 26em;
    text-align: center;
    opacity: 0.85;
  }

  /* ---- ruler ---------------------------------------------------------- */

  .ruler,
  .sample {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.4em;
    padding: 2em;
    text-align: center;
  }

  .ruler-lead,
  .ruler-label,
  .ruler-note,
  .sample-hint {
    margin: 0;
    max-width: 32em;
  }

  .ruler-label {
    font-weight: 700;
    letter-spacing: 0.04em;
    font-variant-numeric: tabular-nums;
  }

  .ruler-note {
    opacity: 0.8;
  }

  .ruler-bar {
    position: relative;
    height: 56px;
    /* No padding, no border, no box-sizing surprises: this element's width IS
       the measurement, and anything that could add to it is a wrong answer. */
    flex: none;
  }

  .ruler-baseline {
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 3px;
    transform: translateY(-50%);
    background: var(--stage-text);
  }

  .ruler-cap {
    position: absolute;
    top: 0;
    width: 2px;
    height: 100%;
    background: var(--stage-text);
  }
  .ruler-cap-start {
    left: 0;
  }
  .ruler-cap-end {
    right: 0;
  }

  .ruler-tick {
    position: absolute;
    top: 50%;
    width: 2px;
    height: 18px;
    transform: translateY(-50%);
    background: rgb(245 243 239 / 70%);
  }
  .ruler-tick-major {
    height: 34px;
    background: var(--stage-text);
  }

  /* ---- type sample ---------------------------------------------------- */

  .sample-text {
    margin: 0;
    /* The measure is set in `ch` of the sample's OWN size, which is what makes
       the two controls independent: changing the size does not change how many
       characters the line holds. */
    text-align: left;
    text-wrap: pretty;
  }

  .sample-hint {
    opacity: 0.85;
  }
</style>
