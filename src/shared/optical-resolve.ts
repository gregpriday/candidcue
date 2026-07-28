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
  READING_MEASURE,
  arcminutesForBias,
  arcminutesForFontSizePx,
  charactersForBias,
  charactersForWidthPx,
  chForCharacters,
  clamp,
  fontSizePxForArcminutes,
  hardwareFitCheck,
  isPlausibleViewingDistanceMm,
  MIN_RENDERABLE_FONT_SIZE_PX,
  normalizeFontMetrics,
  secondaryTextFloorPx,
  type AngularContext,
  type FontMetrics,
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

/** The column measure used when nothing has been calibrated, as a fraction. */
export const UNCALIBRATED_COLUMN_FRACTION = 0.68;

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

/** Fraction of the safe width the column may occupy before it looks crammed. */
const MAX_COLUMN_FRACTION = 0.92;

export interface ViewportInfo {
  widthPx: number;
  heightPx: number;
}

export interface ResolveInput {
  profile: OpticalProfile;
  /** Measured font proportions; falls back to DIN ratios when unusable. */
  metrics?: Partial<FontMetrics> | null;
  viewport: ViewportInfo;
}

export interface ResolveResult {
  optics: ResolvedOptics;
  /** Operator-facing sentences. Empty when the profile resolves cleanly. */
  warnings: string[];
}

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

  const targetArcmin = resolveTargetArcminutes(profile);
  const targetCharacters = resolveTargetCharacters(profile);

  const fit = hardwareFitCheck({
    safeWidthPx,
    maxColumnFraction: MAX_COLUMN_FRACTION,
    mmPerCssPx,
    distanceMm,
    targetArcmin,
    targetCharacters,
    metrics,
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
      : UNCALIBRATED_FONT_SIZE_PX;

  const columnCh =
    fit.columnCh !== null && fit.columnCh > 0
      ? fit.columnCh
      : uncalibratedColumnCh(safeWidthPx, bodyFontSizePx, metrics);

  const angularContext: AngularContext | null = calibrated
    ? { distanceMm: distanceMm as number, mmPerCssPx: mmPerCssPx as number, metrics }
    : null;

  const bodyArcminutes = angularContext
    ? arcminutesForFontSizePx(bodyFontSizePx, angularContext)
    : null;

  const charactersPerLine = charactersForWidthPx(
    Math.min(safeWidthPx * MAX_COLUMN_FRACTION, columnCh * metrics.zeroAdvanceRatio * bodyFontSizePx),
    bodyFontSizePx,
    metrics,
  );

  /* ---- warnings the operator can act on ---- */
  if (!calibrated) {
    warnings.push(
      'This rig has not been calibrated. Text size is a desk-distance guess (about 1.2 m) rather than a measurement.',
    );
  }
  if (!metrics.measured) {
    warnings.push(
      'The stage font could not be measured, so sizes are estimated from standard proportions.',
    );
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

  const derivedColumnCh = columnCh;
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
    Math.min(
      safeWidthPx * (usable(o.maxColumnFraction) ? clamp(o.maxColumnFraction, 0.1, 1) : MAX_COLUMN_FRACTION),
      finalColumnCh * metrics.zeroAdvanceRatio * finalFontSizePx,
    ),
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
   */
  const derivedBandY = clamp(profile.lens.y, 0.1, 0.9);
  let finalBandY = derivedBandY;
  if (usableSigned(o.lensOffsetDegrees) && o.lensOffsetDegrees !== 0 && calibrated) {
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
    fitAdvice: fit.advice,
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
    if (finalCharactersPerLine < READING_MEASURE.hardFloor) {
      warnings.push(
        `At the size you have set, a line holds about ${Math.round(finalCharactersPerLine)} characters — too few to carry a phrase. Reduce the text size or widen the column.`,
      );
    } else if (finalCharactersPerLine < READING_MEASURE.bandMin) {
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
export function resolveTargetCharacters(profile: OpticalProfile): number {
  const override = profile.overrides?.characters;
  if (usable(override)) {
    return clamp(override, READING_MEASURE.hardFloor, READING_MEASURE.bandMax);
  }
  const scaled = charactersForBias(profile.bias) * (FRAMING_MEASURE_SCALE[profile.framing] ?? 1);
  return clamp(scaled, READING_MEASURE.hardFloor, READING_MEASURE.bandMax);
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
 * The column an uncalibrated rig gets: the historical 68% of the safe width,
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
