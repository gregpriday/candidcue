/**
 * The stage appearance controls, and the ranges they run over.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE
 * ---------------------------------------------------------------------------
 * These five values are now set from two places: the Settings screen, before a
 * take, and the in-session sheet, during one. Two copies of "line height goes
 * from 1.05 to 1.8" is the kind of duplication that does not fail — it drifts,
 * and the symptom is a slider that will not reach a value the other screen
 * saved, with nothing on either screen to explain why. So the ranges live here
 * and both screens read them.
 *
 * Only the five are here. The rest of `teleprompter` — the font family, the
 * mirror flips, the end-of-take behaviour — are decisions made once at a desk,
 * not judgements made at the glass with the prompter running, and putting them
 * on the in-session sheet would bury the four that have to be there.
 */
import { READER_PREFERENCE_LIMITS, type AppSettings } from '../services/settings-types';
import type { ReadingCueStyle, TextIntensity } from '../../shared/contracts';
import { READER_READING_MEASURE } from '../../shared/optics';

/** The whole saved teleprompter section, named for readability. */
export type TeleprompterSettings = AppSettings['teleprompter'];

/**
 * What a presenter can judge by looking at the glass.
 *
 * Deliberately a subset of `TeleprompterSettings` with the same field names
 * rather than a parallel shape: it is patched straight back into the saved
 * section, and a rename between the two would be a silent no-op rather than a
 * type error.
 */
export interface StageAppearance {
  textIntensity: TextIntensity;
  fontSizePx: number;
  lineHeight: number;
  columnWidthPercent: number;
  readingBandCenterPercent: number;
}

/**
 * The per-rig override ceiling, and the hard limit on what the size slider will
 * grow to fit. See `typeCeilingPx`.
 */
/** Anything an appearance can be read off: the saved section, or a rendered stage. */
export type StageAppearanceSource = Omit<StageAppearance, 'textIntensity'> & {
  textIntensity?: TextIntensity;
};

const INTENSITIES: readonly TextIntensity[] = ['soft', 'standard', 'strong'];

/** What a field falls back to when the saved one is not a usable number. */
const DEFAULTS = {
  fontSizePx: 64,
  lineHeight: 1.32,
  columnWidthPercent: 78,
  readingBandCenterPercent: 38,
} as const;

export const ADVANCED_FONT_SIZE_CEILING_PX = 512;

/** The smallest size either screen offers. */
export const MIN_FONT_SIZE_PX = 24;

/**
 * The ceiling on the size slider, given the size it is currently showing.
 *
 * 320px covers every panel CandidCue knows about at its rated distance — a
 * Prompter XL at 4.6m wants about 234 — and the advanced per-rig override goes
 * to 512 for the rigs that are stranger than that. The ceiling FOLLOWS a larger
 * stored value up to that same 512 rather than clamping it, because a slider
 * whose maximum is below its own value silently rewrites that value the first
 * time it is touched, and the operator has no way to see that it did. Past 512
 * the value did not come from this control and is treated as damage: the slider
 * offers to repair it rather than growing to fit it.
 */
export function typeCeilingPx(currentPx: number): number {
  // Total for a value that is not a number at all. The settings overlay does
  // not validate scalar types on the way in, so a corrupted `fontSizePx`
  // reaches here as a string or a NaN — and a NaN ceiling makes every clamp
  // below it return NaN, which lands in `StageSettings.fontSizePx` and renders
  // as no type at all. The ordinary ceiling is the safe answer for damage.
  if (!Number.isFinite(currentPx)) return 320;
  return Math.max(320, Math.min(ADVANCED_FONT_SIZE_CEILING_PX, currentPx));
}

/** The bounds every appearance control is drawn and clamped against. */
export const APPEARANCE_LIMITS = {
  fontSizePx: { min: MIN_FONT_SIZE_PX, step: 1 },
  lineHeight: { min: 1.05, max: 1.8, step: 0.01 },
  columnWidthPercent: { min: 40, max: 100, step: 1 },
  readingBandCenterPercent: { min: 20, max: 70, step: 1 },
} as const;

/**
 * The five fields, off anything that carries them.
 *
 * Both `AppSettings['teleprompter']` and the rendered `StageSettings` do, under
 * the same names — which is not a coincidence to be tidied away but the thing
 * that makes "what is saved" and "what is on the glass" comparable at all.
 *
 * `textIntensity` is optional on `StageSettings` (the field postdates the
 * document), and 'standard' is the same answer the stage itself gives for a
 * missing one — see `data-text-intensity` on `.stage-root`. Anything else here
 * would make the sheet's segmented control disagree with the glass on a
 * document old enough to lack the field.
 */
export function readStageAppearance(t: StageAppearanceSource): StageAppearance {
  return {
    textIntensity: INTENSITIES.includes(t.textIntensity as TextIntensity)
      ? (t.textIntensity as TextIntensity)
      : 'standard',
    fontSizePx: numberOr(t.fontSizePx, DEFAULTS.fontSizePx),
    lineHeight: numberOr(t.lineHeight, DEFAULTS.lineHeight),
    columnWidthPercent: numberOr(t.columnWidthPercent, DEFAULTS.columnWidthPercent),
    readingBandCenterPercent: numberOr(
      t.readingBandCenterPercent,
      DEFAULTS.readingBandCenterPercent,
    ),
  };
}

/**
 * TYPE repair, not range repair.
 *
 * The settings overlay does not validate the types of its scalars on the way
 * in (see `mergeSection`), so a hand-edited or half-written store can hand back
 * a string where a number belongs. Read straight through, that reaches a sheet
 * which calls `.toFixed()` on it — a render error, thrown over a running take,
 * on the panel the presenter is reading from.
 *
 * Ranges are deliberately NOT touched here: a rig legitimately resolves values
 * outside what the sliders offer, and this function's whole job on that path is
 * to report what is on the glass.
 */
function numberOr(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Hold every value inside the range its control offers.
 *
 * `ceilingPx` defaults to `typeCeilingPx` of the value itself, which is the
 * READING rule: a rig-sized 400px survives being passed through here, because
 * this clamps damage rather than deliberate choices made somewhere with a wider
 * range.
 *
 * A caller applying a CHANGE passes the ceiling of the value it is changing
 * FROM. Without that, a self-derived ceiling reads the requested size as
 * evidence for its own legitimacy — `+` held down past the top of the slider
 * lands on 512px rather than the 320 the slider offers, and the control that
 * was meant to be bounded bounds itself by the request.
 */
export function clampStageAppearance(
  appearance: StageAppearance,
  ceilingPx: number = typeCeilingPx(appearance.fontSizePx),
): StageAppearance {
  const l = APPEARANCE_LIMITS;
  return {
    textIntensity: appearance.textIntensity,
    fontSizePx: clamp(Math.round(appearance.fontSizePx), l.fontSizePx.min, ceilingPx),
    lineHeight: clamp(appearance.lineHeight, l.lineHeight.min, l.lineHeight.max),
    columnWidthPercent: clamp(
      Math.round(appearance.columnWidthPercent),
      l.columnWidthPercent.min,
      l.columnWidthPercent.max,
    ),
    readingBandCenterPercent: clamp(
      Math.round(appearance.readingBandCenterPercent),
      l.readingBandCenterPercent.min,
      l.readingBandCenterPercent.max,
    ),
  };
}

/**
 * Do these two describe the same stage?
 *
 * The sheet asks before it writes: an operator who opens it, looks, and presses
 * OK has changed nothing, and a settings write for that would bump the saved
 * document (and every subscriber of it) for no reason.
 */
export function stageAppearanceEquals(a: StageAppearance, b: StageAppearance): boolean {
  return (
    a.textIntensity === b.textIntensity &&
    a.fontSizePx === b.fontSizePx &&
    // Line height is the one non-integer, and it arrives off a range input as
    // a float. Compared inside half a step so 1.3300000000000003 and 1.33 are
    // the same stage, which they are.
    Math.abs(a.lineHeight - b.lineHeight) < APPEARANCE_LIMITS.lineHeight.step / 2 &&
    a.columnWidthPercent === b.columnWidthPercent &&
    a.readingBandCenterPercent === b.readingBandCenterPercent
  );
}

/* ---------------------------------------------------------------------------
 * A reading window's appearance
 * ------------------------------------------------------------------------- */

/**
 * What a reading window's sheet shows and sets.
 *
 * NOT a `StageAppearance`, and the difference is the reason this exists. Those
 * five fields are patched straight back into `teleprompter` — the prompter's
 * fallback — and a reading window never reads them: its text comes from the
 * reading rig with the reader preference laid over it. A sheet that wrote a
 * reading window's numbers into `teleprompter` would put reader sizes on the
 * next uncalibrated prompter take and change nothing in the window.
 *
 * Size, spacing, intensity and cue are what is on the glass; `characters` is
 * what the reader ASKED for, because the measured answer only the stage can
 * give — it arrives at the sheet separately, as `charactersPerLine`.
 */
export interface ReaderAppearance {
  fontSizePx: number;
  lineHeight: number;
  /** The measure the reader chose, or null for the standard one. */
  characters: number | null;
  textIntensity: TextIntensity;
  readingCue: ReadingCueStyle;
}

/** The bounds the reading window's controls draw against — the preference's own. */
export const READER_APPEARANCE_LIMITS = {
  fontSizePx: { ...READER_PREFERENCE_LIMITS.fontSizePx, step: 1 },
  lineHeight: { ...READER_PREFERENCE_LIMITS.lineHeight, step: 0.01 },
} as const;

/** The three line widths the sheet offers. */
export type ReaderLineWidth = 'narrower' | 'standard' | 'wider';

/**
 * The measures behind Narrower and Wider: the two ends of the reader measure's
 * ideal band, so neither is a line anybody would call cramped or a long one.
 * Standard asks for nothing and leaves the measure to the profile.
 */
export const READER_LINE_WIDTH_CHARACTERS = {
  narrower: READER_READING_MEASURE.idealMin,
  wider: READER_READING_MEASURE.idealMax,
} as const;

export function readerCharactersFor(width: ReaderLineWidth): number | null {
  return width === 'standard' ? null : READER_LINE_WIDTH_CHARACTERS[width];
}

/**
 * Which segment a stored measure belongs to. Only the sheet writes one, so it
 * is one of the two exact values — but a value from anywhere else still lands
 * on the nearer side rather than on no segment at all.
 */
export function readerLineWidthFor(characters: number | null): ReaderLineWidth {
  if (characters === null) return 'standard';
  const { narrower, wider } = READER_LINE_WIDTH_CHARACTERS;
  return characters <= (narrower + wider) / 2 ? 'narrower' : 'wider';
}

/**
 * One step of a reading window's size, from where it is now.
 *
 * Held to the reader preference's range rather than the prompter's: a reading
 * window at 320 px is a dozen words a screen, and the prompter's 24 px floor is
 * larger than somebody at a desk may want.
 */
export function stepReaderFontSize(currentPx: number, deltaPx: number): number {
  const { min, max } = READER_APPEARANCE_LIMITS.fontSizePx;
  return clamp(Math.round(currentPx + deltaPx), min, max);
}

/**
 * The BOUNDS are validated too, not just the candidate.
 *
 * `Math.min(NaN, x)` is NaN, so a non-finite ceiling turns a perfectly good
 * request into one — the failure arrives at the far end, in a stage rendered at
 * no size, with nothing pointing back at the corrupt saved value that caused it.
 */
function clamp(value: number, min: number, max: number): number {
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) ? max : lo;
  if (!Number.isFinite(value)) return lo;
  return Math.min(Math.max(lo, hi), Math.max(lo, value));
}
