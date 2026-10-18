/**
 * The single seam between "what the rig is" and "what the stage draws".
 *
 * `resolveStageGeometry` is the only place an `OpticalProfile` turns into
 * numbers the renderer uses. Control calls it when it builds a session
 * envelope; the calibration wizard calls it on every slider move to show a live
 * preview; tests call it directly, because it is pure.
 *
 * The rule it exists to enforce: NOTHING downstream may invent geometry. The
 * stage measures its own line pitch and multiplies the line-unit values here by
 * it, and that is the whole of the stage's licence to compute layout. Every
 * other number — column measure, band position, fade depths, secondary-text
 * floor — is decided here, once, where it can be reasoned about and tested
 * without a browser.
 */
import {
  ANGULAR_HARD_FLOOR_ARCMIN,
  ANGULAR_SOFT_FLOOR_ARCMIN,
  MAX_COLUMN_FRACTION,
  READING_MEASURE,
  arcminutesForBias,
  arcminutesForFontSizePx,
  charactersForBias,
  charactersForCh,
  charactersForWidthPx,
  chForCharacters,
  clamp,
  fontSizePxForArcminutes,
  hardwareFitCheck,
  isPlausibleViewingDistanceMm,
  MIN_RENDERABLE_FONT_SIZE_PX,
  normalizeFontMetrics,
  readingMeasureFor,
  secondaryTextFloorPx,
  type AngularContext,
  type FontMetrics,
  type ReadingContext,
} from './optics';
import type {
  FramingPreset,
  OpticalOverrides,
  OpticalProfile,
  ResolvedOptics,
} from './contracts/optical';

/* ---------------------------------------------------------------------------
 * Line-unit defaults
 *
 * Each of these replaces a `vh` constant or a magic pixel value that meant
 * something different on every panel CandidCue supports. They are multiples of
 * the MEASURED line pitch, so a display twice as tall shows twice as many lines
 * rather than the same lines at different proportions.
 * ------------------------------------------------------------------------- */

/**
 * The reading corridor, total height, in line pitches.
 *
 * Was 4% of viewport height on each side: 48px on a 600px panel against an
 * ~85px line, so barely half a line, and 86px on a 1080px panel, so a full one.
 * The same setting produced materially different behaviour on the two displays
 * the app is actually used on. Just under one line is the value that reads as
 * "hold still while the reader is on this line, correct when they leave it".
 */
export const DEFAULT_DEAD_ZONE_LINES = 0.84;

/**
 * Focus fades. The top fade is deeper than the bottom deliberately: material
 * above the band has been spoken and is receding, while material below it is
 * about to be needed and must stay readable for as long as possible.
 */
export const DEFAULT_TOP_FADE_LINES = 1.25;
export const DEFAULT_BOTTOM_FADE_LINES = 0.75;

/** Upcoming script kept below the band — roughly 2.5–3.5 seconds of speech. */
export const DEFAULT_FUTURE_RESERVE_LINES = 3;

/**
 * Extra separation after strong sentence punctuation inside a long paragraph.
 *
 * Display-only, and small on purpose. It gives the eye the same landing place a
 * paragraph break gives it, without changing one word of the spoken script or
 * introducing a break the aligner would have to reason about.
 */
export const DEFAULT_SENTENCE_MICROGAP_LINES = 0.2;

/**
 * The body size used when nothing has been calibrated.
 *
 * 64 CSS pixels is roughly 25 arcminutes at 1.2 m on a 9-inch Prompter, so it
 * is a defensible desk-distance guess and a poor universal default — which is
 * exactly how it should be labelled in the UI. It exists so an uncalibrated rig
 * still prompts.
 */
export const UNCALIBRATED_FONT_SIZE_PX = 64;

/**
 * The same guess, for a reading window.
 *
 * ---------------------------------------------------------------------------
 * WHY THE 64 ABOVE IS NOT REUSED
 * ---------------------------------------------------------------------------
 * Every reason the constant above exists is a reason it is wrong here: it is
 * "roughly 25 arcminutes at 1.2 m on a 9-inch Prompter", and reader mode is
 * neither of those distances nor that panel. 64 px in a 900 px reading window is
 * about a dozen characters a line.
 *
 * 30 px is the same arithmetic run for the reading case: on a display around 0.2
 * mm per CSS pixel (a 16" MacBook Pro at default scaling measures 0.200), 30 px
 * of body text subtends about 26 arcminutes of cap height at the desk preset's
 * 550 mm. That sits between the `standard` (24') and `comfort` (28') rungs of
 * `ANGULAR_PRESET_ARCMIN`, which is the right side of the ladder to guess on:
 * text read continuously for twenty minutes should err generous, and a guess that
 * came out under the standard rung would be betting on a display being no smaller
 * than assumed.
 *
 * So an uncalibrated reading window lands within a rung of where a calibrated one
 * would, which is the most a guess can honestly do. For the record, a CALIBRATED
 * 550 mm rig at the standard 24' resolves to 27.4 px on the same display — this
 * constant is deliberately a little above that, not equal to it.
 *
 * It matters more than the prompter default does, because it is reached more
 * often: `scaleForDisplay` can only answer for hardware it recognises by its
 * panel, and the ordinary Mac display somebody reads on is `generic`.
 */
export const UNCALIBRATED_READER_FONT_SIZE_PX = 30;

/**
 * The column measure an uncalibrated PROMPTER gets, as a fraction.
 *
 * Prompter only. An uncalibrated reading window is solved in characters instead
 * — see `uncalibratedReaderColumnCh` — because a share of the window has no
 * ceiling, and a window, unlike a panel, can be dragged to 2560 px.
 */
export const UNCALIBRATED_COLUMN_FRACTION = 0.68;

/**
 * How close to the true top/bottom edge the band sits for an off-panel lens.
 *
 * Not 0 or 1: those pin the reading line exactly on the clipping edge, which is
 * hostile regardless of what the font measures out to. 5% matches the bound
 * `bandCenterPercentFor` already clamps the legacy flattened center to (spec's
 * 5–95% floor for a settings document Rust stores opaquely), so an off-panel
 * rig's pin survives that clamp unchanged rather than landing on its edge.
 */
export const OFF_PANEL_READING_BAND_EDGE_FRACTION = 0.05;

/**
 * Where the reading line sits when there is no camera to derive it from.
 *
 * A little above centre. Dead centre wastes the asymmetry that reading actually
 * has — the line being read matters, the lines after it matter nearly as much,
 * and the lines already read matter not at all — so lifting the band leaves more
 * room below it for the text coming up. `DEFAULT_FUTURE_RESERVE_LINES` is 3
 * against `TARGET_LINES_ABOVE_BAND`'s 1, which is the same asymmetry stated in
 * line units, and 0.42 is roughly where that ratio puts the band.
 *
 * Deliberately NOT the off-panel edge pin. That number exists because a lens
 * ABOVE the glass wants the reader's eyeline as close to it as possible, and
 * pinning a reader's text to the top 5% of their window for the sake of a camera
 * that is not there would be inheriting a constraint along with its remedy.
 */
export const NO_LENS_READING_BAND_FRACTION = 0.42;

/* ---------------------------------------------------------------------------
 * Typography defaults
 *
 * These were scattered across three files that disagreed with each other:
 * `defaultAppSettings` said line height 1.32, `buildStageSettings` fell back to
 * 1.28, and the preview used a third value. A default that depends on which
 * code path built the settings is not a default.
 * ------------------------------------------------------------------------- */

/**
 * 1.38.
 *
 * Enough separation to find the next line on a return sweep without spending
 * the vertical room that upcoming context needs — which on a 600px panel is the
 * binding constraint. The reviews cluster between 1.34 and 1.45; this is the
 * middle, and the accessibility path can go to 1.5 through an override.
 */
export const DEFAULT_LINE_HEIGHT = 1.38;

/** Medium. Enough substance to survive reflection without becoming a glowing block. */
export const DEFAULT_FONT_WEIGHT = 500;

/**
 * Zero.
 *
 * Evidence for extra tracking is inconsistent, and at prompting sizes generous
 * letter spacing makes words visually disintegrate — the spaces between letters
 * start to compete with the spaces between words. Available as an override with
 * a deliberately narrow range.
 */
export const DEFAULT_LETTER_SPACING_EM = 0;

/**
 * 0.70em.
 *
 * Deliberately not the 0.80 one review proposed. A larger gap buys visual
 * separation with vertical room that upcoming context needs more, and the
 * better tool for a real beat is authored pause markup, which says what it
 * means instead of encoding it as whitespace.
 */
export const DEFAULT_PARAGRAPH_SPACING_EM = 0.7;

/**
 * 0.48, raised from 0.42.
 *
 * Warm off-white at 42% on black is about 3.7:1 — over the large-text minimum,
 * but that minimum assumes a display being read directly. A beamsplitter costs
 * contrast twice: once in the reflection and again in the ambient light the
 * glass picks up. 0.48 is about 4.6:1 before the optical path, which leaves
 * something in hand for it.
 */
export const DEFAULT_PAST_OPACITY = 0.48;

/** Just under full: upcoming text is not the focus, but it is not receding either. */
export const DEFAULT_FUTURE_OPACITY = 0.92;

/**
 * How framing changes the reading measure.
 *
 * A sideways eye movement that is invisible in a waist-up shot is obvious in a
 * tight headshot, so tighter framing wants a narrower column. These multipliers
 * are a starting position to be validated against real recordings, not a
 * finding — which is why they live here as one named table rather than being
 * spread through the resolver.
 */
const FRAMING_MEASURE_SCALE: Record<FramingPreset, number> = {
  'close-up': 0.75,
  'head-and-shoulders': 1,
  'waist-up': 1.12,
  'full-body': 1.25,
};


export interface ViewportInfo {
  widthPx: number;
  heightPx: number;
}

export interface ResolveInput {
  profile: OpticalProfile;
  /** Measured font proportions; falls back to DIN ratios when unusable. */
  metrics?: Partial<FontMetrics> | null;
  viewport: ViewportInfo;
  /**
   * Whether this geometry is for a prompter or for somebody reading off their
   * own screen. Defaults to `prompter`, which is what every existing caller
   * meant.
   *
   * On a calibrated rig it moves exactly two pieces of geometry — the character
   * band the width solver aims at, and whether the framing multiplier applies —
   * and otherwise only the wording of the advice. See `READER_READING_MEASURE`
   * for why those two and no others. On an uncalibrated rig it also picks the
   * guessed body size and the column rule: a reading window gets its target
   * measure, capped by the width, where a prompter gets 68% of the width.
   */
  readingContext?: ReadingContext;
}

export interface ResolveResult {
  optics: ResolvedOptics;
  /** Operator-facing sentences. Empty when the profile resolves cleanly. */
  warnings: string[];
}

/*
 * Three warnings by name, so a surface that already states the same fact some
 * other way can leave them out without matching on prose. Settings is the one
 * that does: it never measures the stage font (a take does), and it explains an
 * uncalibrated display's sizing in its own words above the readout.
 */
export const UNCALIBRATED_READER_WARNING =
  'This display has not been calibrated, so the text size is a reading-distance guess (about 55 cm) rather than a measurement.';
export const UNCALIBRATED_PROMPTER_WARNING =
  'This rig has not been calibrated. Text size is a desk-distance guess (about 1.2 m) rather than a measurement.';
export const UNMEASURED_FONT_WARNING =
  'The stage font could not be measured, so sizes are estimated from standard proportions.';

/**
 * Turn a rig profile into stage geometry.
 *
 * Total: every branch produces a usable `ResolvedOptics`, including the one
 * where the caller has supplied nothing at all. A teleprompter that refuses to
 * draw because it has not been calibrated is worse than one that draws a
 * defensible guess and says it is guessing.
 */
export function resolveStageGeometry(input: ResolveInput): ResolveResult {
  const { profile, viewport } = input;
  const metrics = normalizeFontMetrics(input.metrics);
  const warnings: string[] = [];

  const safeArea = normalizeSafeArea(profile.safeArea);
  const safeWidthPx = Math.max(1, viewport.widthPx * (1 - safeArea.left - safeArea.right));

  const mmPerCssPx = profile.scale?.mmPerCssPx ?? null;
  const distanceMm = profile.viewingDistanceMm;
  /*
   * Calibrated means PLAUSIBLE, not merely present.
   *
   * These come from a person typing into a box, and "positive and finite" is
   * not the same as "possible". A viewing distance of 1mm is a real number that
   * resolves to a 0.05px body size, which rounds to zero and leaves the
   * presenter looking at a blank rig — with nothing NaN anywhere to notice. A
   * value outside the plausible range is treated as no calibration at all,
   * which falls back to a stage that works.
   */
  const calibrated =
    typeof mmPerCssPx === 'number' &&
    Number.isFinite(mmPerCssPx) &&
    mmPerCssPx > 0 &&
    isPlausibleViewingDistanceMm(distanceMm);

  const readingContext = input.readingContext ?? 'prompter';
  const targetArcmin = resolveTargetArcminutes(profile);
  const targetCharacters = resolveTargetCharacters(profile, readingContext);

  /*
   * Resolved BEFORE the fit, because it is an input to it.
   *
   * It used to be read only afterwards, so the fit always solved against the
   * default: raising the limit could not widen an unpinned column (the measure
   * had already been decided against 82%), and lowering it narrowed the render
   * while the verdict and advice went on describing the wider one.
   */
  const columnFraction = usable(profile.overrides?.maxColumnFraction)
    ? clamp(profile.overrides.maxColumnFraction, 0.1, 1)
    : MAX_COLUMN_FRACTION;
  /*
   * The width a column may actually occupy — the same quantity `hardwareFitCheck`
   * solves against, restated here because the column has to be re-solved when a
   * pinned size changes what a `ch` is worth, and because an uncalibrated reading
   * window is solved against it directly. Kept in one expression so the paths
   * cannot drift: an override of the fraction is honoured in all of them.
   */
  const usableWidthPx = safeWidthPx * columnFraction;

  const fit = hardwareFitCheck({
    safeWidthPx,
    maxColumnFraction: columnFraction,
    mmPerCssPx,
    distanceMm,
    targetArcmin,
    targetCharacters,
    metrics,
    readingContext,
  });

  /*
   * Font size and column, from the fit rather than from the request.
   *
   * The fit check has already resolved the trade-off between legibility and
   * measure against this panel; re-deriving either here would let the two
   * disagree. When the rig is uncalibrated the fit check declines to answer, and
   * the legacy pixel default takes over — which is the one case where the stage
   * is knowingly guessing.
   */
  const bodyFontSizePx =
    fit.fontSizePx !== null && fit.fontSizePx >= MIN_RENDERABLE_FONT_SIZE_PX
      ? fit.fontSizePx
      : readingContext === 'reader'
        ? UNCALIBRATED_READER_FONT_SIZE_PX
        : UNCALIBRATED_FONT_SIZE_PX;

  /*
   * A reading window the fit check declined to size — no physical scale, which
   * is the ordinary case: `readerOpticalProfile` only has one when a prompter rig
   * on the same panel lends it.
   *
   * It does NOT get the prompter's 68% guess. A share of the width has no
   * ceiling, and a window can be dragged to 2560 px, where 68% at the reader's
   * 30 px is over a hundred characters a line: the eye loses its place on every
   * return sweep. It gets the reader's own target measure instead, bounded by
   * what the window can hold at the calibrated fit's column fraction — so a wide
   * window stops stretching the prose and a narrow one uses the margin the 68%
   * guess left empty. The verdict stays `uncalibrated`: the SIZE is still a guess
   * about a display nobody has measured, and only the measure is now principled.
   */
  const uncalibratedReader =
    readingContext === 'reader' && !(fit.columnCh !== null && fit.columnCh > 0);

  const columnCh =
    fit.columnCh !== null && fit.columnCh > 0
      ? fit.columnCh
      : uncalibratedReader
        ? uncalibratedReaderColumnCh(usableWidthPx, bodyFontSizePx, targetCharacters, metrics)
        : uncalibratedColumnCh(safeWidthPx, bodyFontSizePx, metrics);

  const angularContext: AngularContext | null = calibrated
    ? { distanceMm: distanceMm as number, mmPerCssPx: mmPerCssPx as number, metrics }
    : null;

  const bodyArcminutes = angularContext
    ? arcminutesForFontSizePx(bodyFontSizePx, angularContext)
    : null;

  const charactersPerLine = charactersForWidthPx(
    Math.min(usableWidthPx, columnCh * metrics.zeroAdvanceRatio * bodyFontSizePx),
    bodyFontSizePx,
    metrics,
  );

  /* ---- warnings the operator can act on ---- */
  if (!calibrated) {
    warnings.push(
      readingContext === 'reader' ? UNCALIBRATED_READER_WARNING : UNCALIBRATED_PROMPTER_WARNING,
    );
  }
  if (!metrics.measured) {
    warnings.push(UNMEASURED_FONT_WARNING);
  }
  if (fit.advice) warnings.push(fit.advice);
  if (bodyArcminutes !== null && bodyArcminutes < ANGULAR_HARD_FLOOR_ARCMIN) {
    warnings.push(
      'The resolved text is below the size at which reading stays comfortable. Move closer or use a larger prompter.',
    );
  } else if (bodyArcminutes !== null && bodyArcminutes < ANGULAR_SOFT_FLOOR_ARCMIN) {
    warnings.push('The resolved text is smaller than the recommended minimum for fluent reading.');
  }

  /*
   * Overrides, applied last.
   *
   * The whole model above has already run, including the hardware-fit check, so
   * an operator who pins a size still gets TOLD what it costs them in reading
   * measure — they are simply not prevented from choosing it. Reversing the
   * order would silence the one piece of feedback that makes a manual choice an
   * informed one.
   */
  const o = profile.overrides ?? {};
  const overriddenFields: string[] = [];

  /*
   * Three overrides act BEFORE the fit check — they change what the model is
   * asked for rather than shadowing what it produced — so they never reach the
   * `take()` helper below and went unrecorded. An override the UI cannot see is
   * one the user cannot reset, which is the whole failure this list prevents.
   */
  if (usable(o.arcminutes)) overriddenFields.push('arcminutes');
  if (usable(o.characters)) overriddenFields.push('characters');
  if (usable(o.maxColumnFraction)) overriddenFields.push('maxColumnFraction');
  const take = <T>(key: keyof OpticalOverrides, value: T, derived: T): T => {
    if (value === derived) return derived;
    overriddenFields.push(key);
    return value;
  };

  const finalFontSizePx =
    usable(o.fontSizePx) && o.fontSizePx >= MIN_RENDERABLE_FONT_SIZE_PX
      ? take('fontSizePx', o.fontSizePx, bodyFontSizePx)
      : bodyFontSizePx;

  /*
   * A pinned SIZE must not shrink the COLUMN.
   *
   * `columnCh` is a count of `ch`, and a `ch` is a fraction of the em — so a
   * column solved against the size the model wanted and then rendered at a
   * smaller pinned size comes out proportionally narrower. That is not a
   * near-miss, it is the whole defect: a 9-inch Prompter solved at 70px and
   * pinned to 48px rendered its column at 647px of a 1024px panel and left a
   * third of the glass empty, with the text in a ribbon down the middle.
   *
   * The fit check's rule is "legibility outranks measure": hold the type at
   * the size asked for and let the line narrow. Pinning the type SMALLER is
   * the same statement from the other end — the presenter has bought width
   * with size — so the honest answer is to spend it. Re-solve the column at
   * the size that will actually be rendered, still bounded by the width the
   * panel has and by the measure band's own ceiling, which is what stops a
   * pinned-tiny size from running the line out to something unreadable.
   *
   * Only when the size moved and the column was not itself pinned: an explicit
   * `columnCh` is a presenter naming a number, and it is not this code's to
   * reinterpret.
   */
  /* What the panel can hold at the size that will be RENDERED, once the cue has
     its margin. The ceiling in both cases below. */
  const widthCapCharacters = charactersForWidthPx(usableWidthPx, finalFontSizePx, metrics);
  /*
   * And what to ask for.
   *
   * With no size pinned, the fit check has already solved the trade against
   * this panel and its answer stands. With a size pinned, the presenter has
   * bought width with size and the honest thing is to spend it — up to the
   * measure this profile actually asked for.
   *
   * SMALLER, tested as such rather than as "different". Settings rounds the
   * automatic size to a whole pixel, so a presenter who pins what the model
   * already chose usually pins a number a fraction away from it — and a
   * `!==` test read that visual no-op, and a deliberately LARGER pin, as a
   * licence to widen the line. A larger pin keeps the fit's measure and simply
   * renders it bigger, which is what the `ch` unit does correctly on its own.
   *
   * `targetCharacters`, not the band's ceiling. The ceiling is a guardrail, not
   * an editorial target, and asking for it would throw away everything the
   * profile said about measure: the bias, the framing multiplier, and an
   * explicit `overrides.characters`. On the 9-inch panel this fix came from the
   * panel binds first and the two agree, but a 1920px XL pinned to 64px would
   * run to ~49 characters against a profile that asked for 37, and a pinned
   * reader window to 90 against a 67-character target.
   *
   * An uncalibrated reading window asks for its target at EVERY size, larger
   * pins included. Its column was never a fit's answer to keep — it is "the
   * target, or what the window holds" — so carrying its `ch` count to a larger
   * pin would grow the line in pixels until the width cap caught it, and a pin
   * of 20 px and one of 96 px have to land on that same rule, re-run at the size
   * actually rendered. A pinned `characters` is already inside the target.
   */
  const boughtWidthWithSize = finalFontSizePx > 0 && finalFontSizePx < bodyFontSizePx;
  const requestedCharacters =
    boughtWidthWithSize || uncalibratedReader
      ? targetCharacters
      : charactersForCh(columnCh, metrics);
  const derivedColumnCh = chForCharacters(
    Math.min(widthCapCharacters, requestedCharacters),
    metrics,
  );
  const finalColumnCh = usable(o.columnCh)
    ? take('columnCh', o.columnCh, derivedColumnCh)
    : derivedColumnCh;

  /*
   * The reported measure has to describe what will actually be RENDERED.
   *
   * When a size or column is pinned, the characters-per-line computed further
   * up describes the geometry the model wanted, not the one the presenter will
   * read. Recomputing from the final numbers is what keeps the readout honest
   * — and it is the readout the operator uses to judge whether their override
   * was a good idea.
   */
  const finalCharactersPerLine = charactersForWidthPx(
    Math.min(usableWidthPx, finalColumnCh * metrics.zeroAdvanceRatio * finalFontSizePx),
    finalFontSizePx,
    metrics,
  );

  const finalArcminutes = angularContext
    ? arcminutesForFontSizePx(finalFontSizePx, angularContext)
    : null;

  /*
   * The reading band, shifted off the lens by a chosen angle.
   *
   * Converted to a fraction of the viewport here rather than carried through as
   * degrees, because everything downstream works in the safe rectangle. The
   * conversion needs the physical scale, so an uncalibrated rig simply cannot
   * honour this control — and says nothing rather than applying a wrong number.
   *
   * All of that assumes the lens is IN the rectangle. A desk/lid webcam is not:
   * there is no fraction of the safe area that describes a camera sitting above
   * or below the glass, so `lens.y` is not read at all for those rigs — the
   * band is pinned as close to the true edge as the fold-back guard allows, and
   * `lensOffsetDegrees` (an angle measured from the lens) is skipped entirely
   * rather than shifting a position that was never derived from the lens.
   */
  const derivedBandY =
    profile.lensPlacement === 'above'
      ? OFF_PANEL_READING_BAND_EDGE_FRACTION
      : profile.lensPlacement === 'below'
        ? 1 - OFF_PANEL_READING_BAND_EDGE_FRACTION
        : profile.lensPlacement === 'none'
          ? /*
             * No camera, so `lens.y` describes nothing.
             *
             * Deliberately not read even though it is present and finite: the
             * crosshair is a MEASUREMENT of where one camera ended up in one
             * hood, and a rig with no camera has never had that measurement
             * taken. Using whatever value the field happens to be carrying would
             * be the same unearned confidence the module's header rejects
             * elsewhere. An operator who wants the band somewhere else says so
             * through `overrides.readingBandY`, which is a stated preference.
             */
            NO_LENS_READING_BAND_FRACTION
          : clamp(profile.lens.y, 0.1, 0.9);
  let finalBandY = derivedBandY;
  /*
   * A stated position wins over a derived one, and short-circuits the offset.
   *
   * `readingBandY` and `lensOffsetDegrees` both move the band, and composing them
   * would mean the number the operator typed is not the number they get. So this
   * one is checked first and the offset arm below is skipped when it applies —
   * which is also why it is `else if` rather than two independent branches.
   */
  if (usable(o.readingBandY)) {
    const stated = clamp(o.readingBandY, 0.1, 0.9);
    if (stated !== derivedBandY) {
      overriddenFields.push('readingBandY');
      finalBandY = stated;
    }
  } else if (
    profile.lensPlacement === 'in-panel' &&
    usableSigned(o.lensOffsetDegrees) &&
    o.lensOffsetDegrees !== 0 &&
    calibrated
  ) {
    const offsetMm =
      (distanceMm as number) * Math.tan((o.lensOffsetDegrees * Math.PI) / 180);
    const offsetPx = offsetMm / (mmPerCssPx as number);
    /*
     * Divided by the SAFE height, not the viewport height.
     *
     * `readingBandY` is a fraction of the safe rectangle — that is what every
     * consumer resolves it against — so converting a pixel offset with the full
     * viewport height under-shifts the band by exactly the fraction the hood
     * crops. On a 600px panel with 20% insets a 1-degree offset moved the band
     * 65px instead of 109px, and the error grows with the crop.
     */
    const safeHeightPx = Math.max(1, viewport.heightPx * (1 - safeArea.top - safeArea.bottom));
    const shifted = clamp(derivedBandY + offsetPx / safeHeightPx, 0.1, 0.9);
    if (shifted !== derivedBandY) {
      overriddenFields.push('lensOffsetDegrees');
      finalBandY = shifted;
    }
  }

  const optics: ResolvedOptics = {
    schemaVersion: 1,
    safeArea,
    opticalCenterX: clamp(profile.lens.x, 0, 1),
    readingBandY: finalBandY,
    lensPlacement: profile.lensPlacement,
    deadZoneLines: usable(o.deadZoneLines)
      ? take('deadZoneLines', clamp(o.deadZoneLines, 0.3, 2), DEFAULT_DEAD_ZONE_LINES)
      : DEFAULT_DEAD_ZONE_LINES,
    topFadeLines: usableOrZero(o.topFadeLines)
      ? take('topFadeLines', clamp(o.topFadeLines, 0, 4), DEFAULT_TOP_FADE_LINES)
      : DEFAULT_TOP_FADE_LINES,
    bottomFadeLines: usableOrZero(o.bottomFadeLines)
      ? take('bottomFadeLines', clamp(o.bottomFadeLines, 0, 4), DEFAULT_BOTTOM_FADE_LINES)
      : DEFAULT_BOTTOM_FADE_LINES,
    futureReserveLines: usableOrZero(o.futureReserveLines)
      ? take('futureReserveLines', clamp(o.futureReserveLines, 0, 10), DEFAULT_FUTURE_RESERVE_LINES)
      : DEFAULT_FUTURE_RESERVE_LINES,
    sentenceMicrogapLines: usableOrZero(o.sentenceMicrogapLines)
      ? take(
          'sentenceMicrogapLines',
          clamp(o.sentenceMicrogapLines, 0, 1),
          DEFAULT_SENTENCE_MICROGAP_LINES,
        )
      : DEFAULT_SENTENCE_MICROGAP_LINES,
    columnCh: finalColumnCh,
    secondaryMinPx: usable(o.secondaryMinPx)
      ? take(
          'secondaryMinPx',
          o.secondaryMinPx,
          secondaryTextFloorPx({ bodyFontSizePx: finalFontSizePx, context: angularContext }),
        )
      : secondaryTextFloorPx({ bodyFontSizePx: finalFontSizePx, context: angularContext }),
    bodyFontSizePx: finalFontSizePx,
    lineHeight: usable(o.lineHeight)
      ? take('lineHeight', clamp(o.lineHeight, 1.0, 2.0), DEFAULT_LINE_HEIGHT)
      : DEFAULT_LINE_HEIGHT,
    fontWeight: usable(o.fontWeight)
      ? take('fontWeight', clamp(o.fontWeight, 300, 800), DEFAULT_FONT_WEIGHT)
      : DEFAULT_FONT_WEIGHT,
    letterSpacingEm: usableSigned(o.letterSpacingEm)
      ? take('letterSpacingEm', clamp(o.letterSpacingEm, -0.02, 0.08), DEFAULT_LETTER_SPACING_EM)
      : DEFAULT_LETTER_SPACING_EM,
    paragraphSpacingEm: usableOrZero(o.paragraphSpacingEm)
      ? take('paragraphSpacingEm', clamp(o.paragraphSpacingEm, 0, 2), DEFAULT_PARAGRAPH_SPACING_EM)
      : DEFAULT_PARAGRAPH_SPACING_EM,
    pastOpacity: usableOrZero(o.pastOpacity)
      ? take('pastOpacity', clamp(o.pastOpacity, 0.15, 1), DEFAULT_PAST_OPACITY)
      : DEFAULT_PAST_OPACITY,
    futureOpacity: usableOrZero(o.futureOpacity)
      ? take('futureOpacity', clamp(o.futureOpacity, 0.3, 1), DEFAULT_FUTURE_OPACITY)
      : DEFAULT_FUTURE_OPACITY,
    calibrated,
    metricsMeasured: metrics.measured,
    mmPerCssPx,
    viewingDistanceMm: distanceMm,
    bodyArcminutes: finalArcminutes,
    charactersPerLine: Number.isFinite(finalCharactersPerLine) ? finalCharactersPerLine : null,
    fitVerdict: fit.verdict,
    /*
     * The advice has to describe the line the presenter will READ.
     *
     * `fit.advice` is written against the automatic geometry, and a pinned size
     * changes that geometry after the fact — so the rig this came from ended up
     * with an ideal-length 35-character line while Settings and the calibration
     * preview went on saying "this display fits about 23 characters per line,
     * which is narrower than ideal". The advice is about measure, so it is
     * withdrawn once the measure it complains about is no longer the one being
     * rendered. Every other verdict (uncalibrated, angle-limited, impossible)
     * is about the RIG rather than the column and still holds.
     */
    fitAdvice:
      fit.verdict === 'width_limited' &&
      finalCharactersPerLine >= readingMeasureFor(readingContext).bandMin
        ? ''
        : fit.advice,
    overriddenFields: overriddenFields.sort(),
  };

  /*
   * A pinned size still has to be told on itself.
   *
   * The fit advice above describes the DERIVED size, so when it has been
   * overridden the operator needs a sentence about the size they actually chose
   * — otherwise pinning a large number silently buys an unreadably short line
   * and nothing says so.
   */
  if (overriddenFields.includes('fontSizePx') || overriddenFields.includes('columnCh')) {
    // The same band the fit check judged against, or the two would disagree
    // about the same column: 40 characters is narrow for a reader and roomy for
    // a prompter, and only one of those sentences can be true at a time.
    const measure = readingMeasureFor(readingContext);
    if (finalCharactersPerLine < measure.hardFloor) {
      warnings.push(
        `At the size you have set, a line holds about ${Math.round(finalCharactersPerLine)} characters — too few to carry a phrase. Reduce the text size or widen the column.`,
      );
    } else if (finalCharactersPerLine < measure.bandMin) {
      warnings.push(
        `At the size you have set, a line holds about ${Math.round(finalCharactersPerLine)} characters, which is narrower than ideal.`,
      );
    }
    if (finalArcminutes !== null && finalArcminutes < ANGULAR_HARD_FLOOR_ARCMIN) {
      warnings.push(
        'The size you have set is below the point at which reading stays comfortable from this distance.',
      );
    }
  }

  return { optics, warnings };
}

/** The angular target this profile is asking for, before the panel has its say. */
export function resolveTargetArcminutes(profile: OpticalProfile): number {
  const override = profile.overrides?.arcminutes;
  if (usable(override)) return clamp(override, ANGULAR_HARD_FLOOR_ARCMIN, 60);
  return arcminutesForBias(profile.bias);
}

/**
 * The prose measure this profile is asking for, before the panel has its say.
 *
 * An explicit character override is taken at face value and NOT scaled by the
 * framing preset. Framing is a shortcut for "I have not thought about this, pick
 * something sensible for a headshot"; once somebody has named a number, silently
 * multiplying it by 0.75 would make the control lie about its own value.
 */
export function resolveTargetCharacters(
  profile: OpticalProfile,
  context: ReadingContext = 'prompter',
): number {
  const measure = readingMeasureFor(context);
  const override = profile.overrides?.characters;
  if (usable(override)) {
    return clamp(override, measure.hardFloor, measure.bandMax);
  }
  /*
   * Framing is skipped entirely in reader mode, not merely neutralised.
   *
   * The multiplier answers "how much eye travel will the camera see?", and in
   * reader mode there is no camera — so a profile that still says `close-up`
   * from some earlier life would otherwise quietly cut a reader's line by a
   * quarter for the sake of a shot nobody is taking. `head-and-shoulders`
   * happens to be 1.0, which is exactly why relying on the default here would
   * be a bug waiting for somebody to change one field.
   */
  const framing = context === 'reader' ? 1 : FRAMING_MEASURE_SCALE[profile.framing] ?? 1;
  const scaled = charactersForBias(profile.bias, context) * framing;
  return clamp(scaled, measure.hardFloor, measure.bandMax);
}

/** A supplied override is only an override if it is a usable positive number. */
function usable(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Zero is meaningful for some overrides (spacing, offsets), so allow it. */
function usableOrZero(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Any finite number, for signed values like letter spacing. */
function usableSigned(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The column an uncalibrated PROMPTER gets: the historical 68% of the safe width,
 * expressed in `ch` so that the renderer has exactly one column mechanism
 * rather than a calibrated path and a legacy path that can drift apart.
 */
function uncalibratedColumnCh(
  safeWidthPx: number,
  fontSizePx: number,
  metrics: FontMetrics,
): number {
  const widthPx = safeWidthPx * UNCALIBRATED_COLUMN_FRACTION;
  const advancePx = metrics.zeroAdvanceRatio * fontSizePx;
  if (!(advancePx > 0)) return chForCharacters(READING_MEASURE.idealMin, metrics);
  return widthPx / advancePx;
}

/**
 * The column an uncalibrated READING WINDOW gets: its target measure, or what
 * the window can hold at this size if that is less.
 *
 * In characters of prose (the average advance), converted to `ch` (the zero's
 * advance) only at the end, so the cap is a count a reader would recognise
 * rather than a count of zeros. Both bounds come from the caller — the target
 * already carries `overrides.characters`, and the usable width already carries
 * `overrides.maxColumnFraction` — so this decides nothing of its own.
 */
function uncalibratedReaderColumnCh(
  usableWidthPx: number,
  fontSizePx: number,
  targetCharacters: number,
  metrics: FontMetrics,
): number {
  const availableCharacters = charactersForWidthPx(usableWidthPx, fontSizePx, metrics);
  return chForCharacters(Math.min(targetCharacters, availableCharacters), metrics);
}

/**
 * Insets must leave a usable rectangle.
 *
 * A safe area is dragged by hand against a reflection, and a slip that makes
 * opposite edges sum past 1 would produce a negative width and take the whole
 * layout with it. Clamped rather than rejected: the presenter is mid-calibration
 * and a stage that goes blank while they drag is not debuggable.
 */
function normalizeSafeArea(insets: {
  top: number;
  right: number;
  bottom: number;
  left: number;
}): { top: number; right: number; bottom: number; left: number } {
  const top = clamp(insets.top, 0, 0.45);
  const bottom = clamp(insets.bottom, 0, 0.45);
  const left = clamp(insets.left, 0, 0.45);
  const right = clamp(insets.right, 0, 0.45);
  return { top, right, bottom, left };
}
