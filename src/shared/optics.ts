/**
 * The optical model: visual angle, physical size, and reading measure.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 * The stage used to be parameterised like a responsive web page — font size in
 * CSS pixels, column width as a viewport percentage, reading band and fades in
 * `vh`, motion limits in absolute pixels, one default expected to work from one
 * to two and a half metres. Every one of those numbers means something
 * different on a 9-inch 1024x600 panel than on a 15.6-inch 1920x1080 one, which
 * is why a default that felt right on the desk felt wrong on the rig.
 *
 * A teleprompter is an optical instrument. What matters to the eye is not how
 * many pixels a letter occupies but the ANGLE it subtends, and not what
 * percentage of the display the column fills but how many CHARACTERS the reader
 * has to sweep across. Those are the units here, and everything else in the
 * stage is derived from them.
 *
 * Pure logic: no DOM, no browser APIs, no settings. Every function is total and
 * defensive about zero/negative/non-finite inputs, because the inputs come from
 * a user typing a distance into a box and from a font that may not have loaded.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

const ARCMIN_PER_DEGREE = 60;
const RAD_PER_ARCMIN = Math.PI / (180 * ARCMIN_PER_DEGREE);
const MM_PER_INCH = 25.4;

/**
 * Cap height and x-height as a fraction of the em, when the real font cannot be
 * measured.
 *
 * These are the DIN 1450 working assumptions, and they are the ONLY two magic
 * typographic ratios in the system. A font whose metrics we have actually
 * measured always wins; these exist so that a font which never loads, a
 * headless render, or a script with no Latin cap height still produces a
 * defensible size instead of nothing.
 *
 * `FontMetrics.measured` records which case a given profile is in, and the
 * diagnostics surface says so — an estimate presented as a measurement is the
 * failure mode this whole module is trying to avoid.
 */
export const FALLBACK_CAP_HEIGHT_RATIO = 0.7;
export const FALLBACK_X_HEIGHT_RATIO = 0.47;

/**
 * Average character advance as a fraction of the em, for a proportional sans.
 *
 * Used to convert a column width into "characters per line" when the real font
 * has not been measured. Lowercase Latin prose runs a little under half an em;
 * 0.5 is the conventional estimate and is close enough for a starting value
 * that the measured median from the rendered line map immediately corrects.
 */
export const FALLBACK_AVG_CHAR_WIDTH_RATIO = 0.5;

/**
 * The advance of "0" as a fraction of the em — i.e. what one CSS `ch` is worth.
 *
 * Digits are typically wider than average lowercase, which is exactly why `ch`
 * over-states the reading measure by roughly ten percent. That bias is real and
 * is corrected by `charactersPerCh`, not ignored.
 */
export const FALLBACK_ZERO_ADVANCE_RATIO = 0.55;

/**
 * The angular ladder, in arcminutes of CAP HEIGHT.
 *
 * Cap height is the internal unit throughout. The alternative convention —
 * x-height in degrees — describes the same physical quantity and the two
 * ladders agree within about one preset step, but implementing both would give
 * one physical size two different names and two slightly different sets of
 * rounding. `xHeightDegreesForCapArcminutes` exists so the other convention can
 * still be READ, in diagnostics, as a cross-check.
 */
export const ANGULAR_PRESET_ARCMIN = {
  compact: 20,
  standard: 24,
  comfort: 28,
} as const;

export type AngularPreset = keyof typeof ANGULAR_PRESET_ARCMIN;

/**
 * Below this, reading speed is known to fall away.
 *
 * 18 arcminutes of cap height is ~0.2 degrees of x-height at the fallback
 * ratios, which is the critical print size the vision-science literature
 * reports for normally sighted readers. The teleprompter review proposed 16'
 * as the floor; that works out at ~0.18 degrees of x-height, marginally UNDER
 * the level at which fluent reading starts to degrade, so the soft floor is set
 * where the evidence puts it rather than where the review put it.
 */
export const ANGULAR_SOFT_FLOOR_ARCMIN = 18;

/**
 * The absolute refusal point. Between the soft floor and here, CandidCue warns;
 * below here it declines to call the profile usable at all.
 */
export const ANGULAR_HARD_FLOOR_ARCMIN = 16;

/**
 * The reading measure, in characters per rendered line.
 *
 * The band is what the evidence supports for on-camera delivery once the
 * panel allows it. It is deliberately NOT the "24 characters" figure from the
 * display review: that number is what a 9-inch Prompter can produce at a
 * comfortable angular size, and it was generalised into a universal preference
 * by mistake. On hardware with room, the mid-30s is both more readable and
 * closer to established teleprompter practice; on hardware without room, the
 * fit check says so instead of pretending.
 */
export const READING_MEASURE = {
  /** The target the width solver aims at when the panel allows it. */
  idealMin: 32,
  idealMax: 38,
  /** Acceptable without complaint. */
  bandMin: 24,
  bandMax: 50,
  /** Below this, lines are too short to carry context; refuse. */
  hardFloor: 13,
} as const;

/* ---------------------------------------------------------------------------
 * Font metrics
 * ------------------------------------------------------------------------- */

/**
 * The measured (or assumed) proportions of the stage font, all as a fraction of
 * the em, so they are independent of the size the font is rendered at.
 */
export interface FontMetrics {
  /** Cap height / em. Drives every angular calculation. */
  capHeightRatio: number;
  /** x-height / em. Diagnostics and the alternate angular convention. */
  xHeightRatio: number;
  /** Mean advance of representative lowercase prose / em. */
  avgCharWidthRatio: number;
  /** Advance of "0" / em — the value of one CSS `ch`. */
  zeroAdvanceRatio: number;
  /** False when any ratio above is a fallback rather than a measurement. */
  measured: boolean;
}

/** The DIN-1450-derived metrics used until the real font can be measured. */
export function fallbackFontMetrics(): FontMetrics {
  return {
    capHeightRatio: FALLBACK_CAP_HEIGHT_RATIO,
    xHeightRatio: FALLBACK_X_HEIGHT_RATIO,
    avgCharWidthRatio: FALLBACK_AVG_CHAR_WIDTH_RATIO,
    zeroAdvanceRatio: FALLBACK_ZERO_ADVANCE_RATIO,
    measured: false,
  };
}

/**
 * Accept a measurement only if every ratio is plausible.
 *
 * A canvas that has not painted, a font that failed to load, or a headless
 * context can all return zeroes, and a zero cap-height ratio propagates to an
 * infinite font size. Rather than defend against that at every call site, bad
 * measurements are rejected once, here, and replaced wholesale by the fallback
 * — the same all-or-nothing rule the motion profile uses for the same reason:
 * a half-applied measurement is a third thing that nobody tuned against.
 */
export function normalizeFontMetrics(candidate: Partial<FontMetrics> | null | undefined): FontMetrics {
  const fallback = fallbackFontMetrics();
  if (!candidate) return fallback;
  const inRange = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

  if (
    !inRange(candidate.capHeightRatio, 0.4, 1.0) ||
    !inRange(candidate.xHeightRatio, 0.25, 0.9) ||
    !inRange(candidate.avgCharWidthRatio, 0.2, 1.2) ||
    !inRange(candidate.zeroAdvanceRatio, 0.2, 1.5)
  ) {
    return fallback;
  }
  // x-height above cap height is not a font, it is a bad measurement.
  if (candidate.xHeightRatio > candidate.capHeightRatio) return fallback;

  return {
    capHeightRatio: candidate.capHeightRatio,
    xHeightRatio: candidate.xHeightRatio,
    avgCharWidthRatio: candidate.avgCharWidthRatio,
    zeroAdvanceRatio: candidate.zeroAdvanceRatio,
    measured: candidate.measured !== false,
  };
}

/* ---------------------------------------------------------------------------
 * Physical scale
 * ------------------------------------------------------------------------- */

export function inchesToMm(inches: number): number {
  return inches * MM_PER_INCH;
}

/**
 * Millimetres per CSS pixel for a panel of a known physical diagonal.
 *
 * This is the number the operating system will not tell us. `PhysicalSize` from
 * the window layer is device PIXELS, not millimetres, so the physical scale has
 * to come from a hardware table, a diagonal the user typed, or a ruler held
 * against the glass. Everything angular in CandidCue rests on it.
 *
 * The width and height passed here must be in the same coordinate space the
 * stage lays out in — CSS pixels — so that a scaled display resolves correctly.
 */
export function mmPerCssPixel(options: {
  diagonalMm: number;
  widthPx: number;
  heightPx: number;
}): number | null {
  const { diagonalMm, widthPx, heightPx } = options;
  if (!isPositive(diagonalMm) || !isPositive(widthPx) || !isPositive(heightPx)) return null;
  const diagonalPx = Math.hypot(widthPx, heightPx);
  if (!isPositive(diagonalPx)) return null;
  return diagonalMm / diagonalPx;
}

/**
 * Millimetres per CSS pixel from a ruler measurement.
 *
 * The honest fallback, and the only method that survives an unusual rig: draw a
 * bar of a known length in CSS pixels, ask what it actually measures against
 * the glass, and divide. It silently corrects for anything the hardware table
 * cannot know — a magnifying beamsplitter, an overscanning panel, a display
 * scale we mis-read — because it measures the finished optical path rather than
 * the panel in isolation.
 */
export function mmPerCssPixelFromRuler(options: {
  barLengthPx: number;
  measuredMm: number;
}): number | null {
  const { barLengthPx, measuredMm } = options;
  if (!isPositive(barLengthPx) || !isPositive(measuredMm)) return null;
  return measuredMm / barLengthPx;
}

/* ---------------------------------------------------------------------------
 * Angular size
 * ------------------------------------------------------------------------- */

/**
 * The physical height a feature must have to subtend `arcmin` at `distanceMm`.
 *
 * `H = 2 * D * tan(theta / 2)`, the exact relation rather than the small-angle
 * approximation. At these angles the difference is far below a pixel, but the
 * exact form costs nothing and does not quietly stop being true if someone
 * later reuses this for something wider.
 */
export function featureHeightMm(distanceMm: number, arcmin: number): number {
  if (!isPositive(distanceMm) || !isPositive(arcmin)) return 0;
  return 2 * distanceMm * Math.tan((arcmin * RAD_PER_ARCMIN) / 2);
}

/** Inverse of `featureHeightMm`: what angle a physical height subtends. */
export function arcminutesForHeightMm(heightMm: number, distanceMm: number): number {
  if (!isPositive(heightMm) || !isPositive(distanceMm)) return 0;
  return (2 * Math.atan(heightMm / (2 * distanceMm))) / RAD_PER_ARCMIN;
}

export interface AngularContext {
  distanceMm: number;
  mmPerCssPx: number;
  metrics: FontMetrics;
}

/** The body size, in CSS pixels, whose cap height subtends `arcmin`. */
export function fontSizePxForArcminutes(arcmin: number, context: AngularContext): number | null {
  const { distanceMm, mmPerCssPx, metrics } = context;
  if (!isPositive(distanceMm) || !isPositive(mmPerCssPx) || !isPositive(arcmin)) return null;
  if (!isPositive(metrics.capHeightRatio)) return null;
  const capMm = featureHeightMm(distanceMm, arcmin);
  const capPx = capMm / mmPerCssPx;
  return capPx / metrics.capHeightRatio;
}

/** What a given body size actually subtends, in arcminutes of cap height. */
export function arcminutesForFontSizePx(fontSizePx: number, context: AngularContext): number | null {
  const { distanceMm, mmPerCssPx, metrics } = context;
  if (!isPositive(fontSizePx) || !isPositive(distanceMm) || !isPositive(mmPerCssPx)) return null;
  const capMm = fontSizePx * metrics.capHeightRatio * mmPerCssPx;
  return arcminutesForHeightMm(capMm, distanceMm);
}

/**
 * The same size expressed in the other convention: degrees of x-height.
 *
 * Read-only. Offered so a reader who thinks in DIN 1450 / critical-print-size
 * terms can check our ladder against theirs without CandidCue having to hold
 * two sources of truth for one physical quantity.
 */
export function xHeightDegreesForCapArcminutes(arcmin: number, metrics: FontMetrics): number | null {
  if (!isPositive(arcmin) || !isPositive(metrics.capHeightRatio)) return null;
  const ratio = metrics.xHeightRatio / metrics.capHeightRatio;
  return (arcmin * ratio) / ARCMIN_PER_DEGREE;
}

/** Horizontal visual angle, in degrees, subtended by a width on the glass. */
export function horizontalAngleDegrees(options: {
  widthPx: number;
  mmPerCssPx: number;
  distanceMm: number;
}): number | null {
  const { widthPx, mmPerCssPx, distanceMm } = options;
  if (!isPositive(widthPx) || !isPositive(mmPerCssPx) || !isPositive(distanceMm)) return null;
  const widthMm = widthPx * mmPerCssPx;
  return (2 * Math.atan(widthMm / (2 * distanceMm)) * 180) / Math.PI;
}

/* ---------------------------------------------------------------------------
 * Reading measure
 * ------------------------------------------------------------------------- */

/**
 * How many characters of prose fit in one CSS `ch`.
 *
 * `ch` is the advance of "0", which for a proportional sans runs wider than the
 * mean lowercase advance — so a 34ch column holds rather more than 34 characters
 * of prose. Everywhere the UI or a target speaks in CHARACTERS, and everywhere
 * CSS speaks in `ch`, this is the conversion between them.
 */
export function charactersPerCh(metrics: FontMetrics): number {
  if (!isPositive(metrics.avgCharWidthRatio)) return 1;
  return metrics.zeroAdvanceRatio / metrics.avgCharWidthRatio;
}

/** The `ch` column width that yields approximately `characters` of prose. */
export function chForCharacters(characters: number, metrics: FontMetrics): number {
  if (!isPositive(characters)) return 0;
  const perCh = charactersPerCh(metrics);
  if (!isPositive(perCh)) return characters;
  return characters / perCh;
}

/** Inverse: the prose measure of a column expressed in `ch`. */
export function charactersForCh(ch: number, metrics: FontMetrics): number {
  if (!isPositive(ch)) return 0;
  return ch * charactersPerCh(metrics);
}

/** Rendered width, in CSS pixels, of a column specified in `ch`. */
export function columnWidthPxForCh(ch: number, fontSizePx: number, metrics: FontMetrics): number {
  if (!isPositive(ch) || !isPositive(fontSizePx)) return 0;
  return ch * metrics.zeroAdvanceRatio * fontSizePx;
}

/** How many characters of prose a pixel width holds at a given body size. */
export function charactersForWidthPx(
  widthPx: number,
  fontSizePx: number,
  metrics: FontMetrics,
): number {
  if (!isPositive(widthPx) || !isPositive(fontSizePx)) return 0;
  const advancePx = metrics.avgCharWidthRatio * fontSizePx;
  if (!isPositive(advancePx)) return 0;
  return widthPx / advancePx;
}

/* ---------------------------------------------------------------------------
 * The bias control
 * ------------------------------------------------------------------------- */

/**
 * One control instead of two.
 *
 * Angular size and reading measure are not independent on a fixed panel: bigger
 * type means fewer characters per line, and the presenter is really choosing a
 * point on that trade-off rather than two unrelated numbers. Asking them to
 * reason about arcminutes AND characters is asking them to solve the
 * constrained optimisation themselves.
 *
 * So the primary control is a single bias — "more text on screen" at 0, "larger,
 * easier text" at 1 — and this maps it onto the ladder. The individual presets
 * stay available underneath for anyone who wants them.
 */
export function arcminutesForBias(bias: number): number {
  const t = clamp01(bias);
  const min = ANGULAR_PRESET_ARCMIN.compact;
  const max = ANGULAR_PRESET_ARCMIN.comfort;
  return min + (max - min) * t;
}

/** The reading measure the same bias asks for, before the panel has its say. */
export function charactersForBias(bias: number): number {
  const t = clamp01(bias);
  // Inverted: more text on screen means MORE characters per line, and larger
  // text means fewer. The panel may refuse both; that is the fit check's job.
  return READING_MEASURE.idealMax - (READING_MEASURE.idealMax - READING_MEASURE.idealMin) * t;
}

/* ---------------------------------------------------------------------------
 * Hardware fit
 * ------------------------------------------------------------------------- */

export type HardwareFitVerdict =
  /** Both the angular target and the reading measure are satisfied. */
  | 'ok'
  /** Type is the requested size; the line is narrower than ideal but usable. */
  | 'width_limited'
  /** The line is usable only by dropping type below the soft angular floor. */
  | 'angle_limited'
  /** Neither can be satisfied: the panel is too small for this distance. */
  | 'impossible'
  /** No physical scale, so no angular claim can be made at all. */
  | 'uncalibrated';

export interface HardwareFit {
  verdict: HardwareFitVerdict;
  /** The body size this panel can actually run at, CSS px. */
  fontSizePx: number | null;
  /** Cap height that size subtends, arcminutes. */
  arcminutes: number | null;
  /** Prose characters the widest usable column yields at that size. */
  achievableCharacters: number | null;
  /** The column, in `ch`, that the resolver should actually use. */
  columnCh: number | null;
  /** One sentence, addressed to the operator. Empty when the verdict is ok. */
  advice: string;
}

export interface HardwareFitInput {
  /** Usable width inside the calibrated safe rectangle, CSS px. */
  safeWidthPx: number;
  /** Fraction of the safe width the column may occupy at most (margins). */
  maxColumnFraction?: number;
  mmPerCssPx: number | null;
  distanceMm: number | null;
  /** Requested cap height, arcminutes. */
  targetArcmin: number;
  /** Requested prose measure, characters. */
  targetCharacters: number;
  metrics: FontMetrics;
}

/**
 * Can this panel, at this distance, deliver both the requested type size and a
 * usable line? And if not, which one gives way?
 *
 * This is the primary mechanism of the width system, not an edge-case warning.
 * On a 9-inch Prompter at 24 arcminutes and 1.2 m the honest answer is "about 26
 * characters, and that is all there is" — so the UI must not offer three widths
 * that do not exist. On a Prompter XL the same request leaves room to spare and
 * the whole band is real.
 *
 * The resolution order is deliberate: LEGIBILITY OUTRANKS MEASURE. Type is held
 * at the requested angular size and the line is allowed to narrow, down to the
 * hard character floor. Only when even that fails does type give way, and only
 * down to the soft angular floor. Text too small to read comfortably is a worse
 * failure than a narrow column, because a narrow column is merely inelegant
 * while small type is unreadable at the exact moment somebody is performing.
 */
export function hardwareFitCheck(input: HardwareFitInput): HardwareFit {
  const {
    safeWidthPx,
    mmPerCssPx,
    distanceMm,
    targetArcmin,
    targetCharacters,
    metrics,
  } = input;
  const maxColumnFraction = clamp(input.maxColumnFraction ?? 0.92, 0.1, 1);
  const usableWidthPx = safeWidthPx * maxColumnFraction;

  if (mmPerCssPx === null || distanceMm === null || !isPositive(mmPerCssPx) || !isPositive(distanceMm)) {
    return {
      verdict: 'uncalibrated',
      fontSizePx: null,
      arcminutes: null,
      achievableCharacters: isPositive(usableWidthPx) ? null : null,
      columnCh: null,
      advice:
        'This rig has not been calibrated, so CandidCue cannot say how large the text will look. Run the display calibration to size it by distance.',
    };
  }

  const context: AngularContext = { distanceMm, mmPerCssPx, metrics };
  const idealFontPx = fontSizePxForArcminutes(targetArcmin, context);
  if (idealFontPx === null || !isPositive(idealFontPx) || !isPositive(usableWidthPx)) {
    return {
      verdict: 'uncalibrated',
      fontSizePx: null,
      arcminutes: null,
      achievableCharacters: null,
      columnCh: null,
      advice: 'CandidCue could not resolve a text size for this display.',
    };
  }

  const charsAtIdeal = charactersForWidthPx(usableWidthPx, idealFontPx, metrics);

  // Case 1: everything the caller asked for fits.
  if (charsAtIdeal >= targetCharacters) {
    return {
      verdict: 'ok',
      fontSizePx: idealFontPx,
      arcminutes: targetArcmin,
      achievableCharacters: targetCharacters,
      columnCh: chForCharacters(targetCharacters, metrics),
      advice: '',
    };
  }

  // Case 2: hold the type size, let the line narrow — as far as the floor.
  if (charsAtIdeal >= READING_MEASURE.hardFloor) {
    const narrow = charsAtIdeal < READING_MEASURE.bandMin;
    return {
      verdict: 'width_limited',
      fontSizePx: idealFontPx,
      arcminutes: targetArcmin,
      achievableCharacters: charsAtIdeal,
      columnCh: chForCharacters(charsAtIdeal, metrics),
      advice: narrow
        ? `At this distance this display fits about ${Math.round(charsAtIdeal)} characters per line, which is narrower than ideal. Moving closer, or a larger prompter, would give you more of each sentence at a time.`
        : '',
    };
  }

  // Case 3: the line cannot reach the floor at the requested size. Shrink type
  // toward the soft angular floor and see whether that rescues it.
  const fontForFloorPx = usableWidthPx / (READING_MEASURE.hardFloor * metrics.avgCharWidthRatio);
  const arcminAtFloor = arcminutesForFontSizePx(fontForFloorPx, context) ?? 0;

  if (arcminAtFloor >= ANGULAR_SOFT_FLOOR_ARCMIN) {
    return {
      verdict: 'angle_limited',
      fontSizePx: fontForFloorPx,
      arcminutes: arcminAtFloor,
      achievableCharacters: READING_MEASURE.hardFloor,
      columnCh: chForCharacters(READING_MEASURE.hardFloor, metrics),
      advice: `To fit a readable line, the text is smaller than your chosen size — about ${arcminAtFloor.toFixed(0)}' rather than ${targetArcmin.toFixed(0)}'. Moving closer to the glass would let it be larger.`,
    };
  }

  return {
    verdict: 'impossible',
    fontSizePx: fontForFloorPx,
    arcminutes: arcminAtFloor,
    achievableCharacters: READING_MEASURE.hardFloor,
    columnCh: chForCharacters(READING_MEASURE.hardFloor, metrics),
    advice:
      'This display is too small for the distance you are standing at. Move closer, or use a larger prompter — CandidCue cannot make this comfortable to read.',
  };
}

/* ---------------------------------------------------------------------------
 * Secondary text
 * ------------------------------------------------------------------------- */

/**
 * The floor for any presenter-readable text that is not body copy.
 *
 * Cue chips, take markers, hold messages, acknowledgements and fault labels are
 * all words somebody has to read from where they are standing. They were set in
 * fractions of an em as small as 0.42, and in fixed 12 and 13 pixel sizes, which
 * at prompting distance is decoration rather than communication.
 *
 * Two bounds, whichever is larger: two thirds of body — the proportion below
 * which secondary text stops reading as the same voice as the script — and the
 * absolute angular floor, so that a small body size cannot drag its own
 * secondary text under the readability limit with it.
 */
export function secondaryTextFloorPx(options: {
  bodyFontSizePx: number;
  context?: AngularContext | null;
}): number {
  const { bodyFontSizePx } = options;
  const proportional = bodyFontSizePx * 0.67;
  const context = options.context ?? null;
  if (!context) return proportional;
  const angularFloor = fontSizePxForArcminutes(ANGULAR_HARD_FLOOR_ARCMIN, context);
  if (angularFloor === null || !isPositive(angularFloor)) return proportional;
  return Math.max(proportional, angularFloor);
}

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------- */

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
