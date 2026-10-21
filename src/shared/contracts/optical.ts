/**
 * The optical profile: what a rig physically IS, and what the stage should
 * therefore draw.
 *
 * ---------------------------------------------------------------------------
 * TWO SHAPES, ON PURPOSE
 * ---------------------------------------------------------------------------
 * `OpticalProfile` holds the INPUTS a person supplies once, standing at their
 * rig: which panel, how far away, where the lens is, which way the glass flips
 * the image, how much of the display the hood actually reveals. These are facts
 * about hardware and they change only when the hardware changes.
 *
 * `ResolvedOptics` holds the OUTPUTS the stage renders from: a column measure,
 * a reading band, dead-zone and fade depths in line pitches, a secondary-text
 * floor in pixels. These are derived, never authored, and they are recomputed
 * whenever the profile, the font metrics or the viewport change.
 *
 * Keeping them apart is what makes the system honest. A saved profile records
 * what somebody measured; a resolved block records what Speaking Glass concluded
 * from it, together with whether it had enough information to conclude anything
 * at all (`calibrated`, `metricsMeasured`, `fit`). Collapsing the two would
 * lose the distinction between "the presenter told us they stand 1.5 m away"
 * and "we guessed 64 px because nobody has told us anything".
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS IS STORED
 * ---------------------------------------------------------------------------
 * `OpticalProfile` — the measurement — is stored by Rust as opaque JSON in the
 * `optical` section of the settings document (`settings::OpticalSettings`),
 * keyed by panel fingerprint and rig name (`opticalRigKey`), so re-opening the
 * wizard starts from the calibration rather than from scratch. Rust does not
 * interpret it; `normalizeOpticalProfile` is the validator. `ResolvedOptics` is
 * a result rather than a record: a take re-derives it and carries it to the
 * stage inside `StageSettings`. (A script's `stageOverrides` is opaque JSON too
 * and could hold a copy, but no take reads its optics from there.)
 */

/** Hardware Speaking Glass knows the physical dimensions of without being told. */
export type OpticalHardwareKind =
  | 'elgato-prompter'
  | 'elgato-prompter-xl'
  | 'ipad-sidecar'
  | 'generic';

/**
 * The physical scale, and where it came from.
 *
 * Provenance is carried because the sources are not equally trustworthy and
 * the operator deserves to know which one is in force. A ruler measurement
 * describes the finished optical path — including a beamsplitter that magnifies
 * — while a model lookup describes only the panel.
 *
 * `'display'` is the panel's own answer: the EDID image size the window layer
 * reads off the monitor (`DisplayDescriptor.physicalSizeMm`). Like `'model'`
 * and `'diagonal'` it describes bare glass, not an optical path, so it ranks
 * with them — below a ruler, above a guess — and is what lets a monitor
 * Speaking Glass has never heard of be sized without anybody measuring it.
 */
export interface OpticalScale {
  mmPerCssPx: number;
  source: 'model' | 'diagonal' | 'ruler' | 'display';
  /** Physical diagonal used, when the source was a model, the panel, or a typed diagonal. */
  diagonalMm?: number;
}

/**
 * The part of the display the presenter can actually see in the glass.
 *
 * Fractions of the raw viewport, one per edge. A generic teleprompter hood, and
 * most iPad housings, reveal less than the whole panel — so every piece of
 * geometry downstream is computed inside this rectangle rather than against the
 * window. All zero means "the whole display is visible", which is the correct
 * assumption for a bare monitor and the default until somebody says otherwise.
 */
export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Which way this rig's glass flips the image. */
export interface OpticalFlips {
  horizontal: boolean;
  vertical: boolean;
}

/**
 * Where the camera lens sits within the safe rectangle, as fractions of it.
 *
 * The text column is centred on the LENS, not on the display: a prompter whose
 * camera sits off-centre in the hood otherwise pulls the presenter's gaze
 * sideways by exactly the offset nobody compensated for. `y` is the reading
 * band — the height the presenter's eyeline rests at for the whole take.
 *
 * Meaningful only when `OpticalProfile.lensPlacement` is `'in-panel'` — a lens
 * that sits above or below the glass entirely is not a fraction of it, and
 * `resolveStageGeometry` ignores `y` rather than clamping a coordinate that
 * was never inside the rectangle to begin with.
 */
export interface LensPosition {
  x: number;
  y: number;
}

/**
 * Where the lens sits relative to the visible glass, not within it.
 *
 * A beamsplitter/hood rig puts the lens behind the panel, so `LensPosition`'s
 * fractions describe it correctly. A desk webcam — built into a laptop lid, or
 * clipped above or below an external monitor — sits outside the safe rectangle
 * altogether, and no fraction of that rectangle can say where it is. This is
 * the discriminator that tells `resolveStageGeometry` which of those two
 * situations it is looking at, so it can stop asking `lens.y` a question that
 * only makes sense for the first.
 *
 * `'none'` is the fourth answer and it is a different KIND of answer: there is
 * no camera at all. It is what a reader-mode rig has — somebody reading a script
 * in a window on their own screen, not being filmed — and it is not the same as
 * `'in-panel'` with the crosshair left in the middle. `'in-panel'` means "the
 * lens is behind the glass and here is where", so the reading band is derived
 * from it and `lensOffsetDegrees` is an angle measured from it. `'none'` means
 * there is nothing to derive from and nothing to measure from: the band is the
 * reader's own preference and the offset control does not apply.
 */
export type LensPlacement = 'in-panel' | 'above' | 'below' | 'none';

/** How the presenter is framed, which changes how much eye travel is visible. */
export type FramingPreset = 'close-up' | 'head-and-shoulders' | 'waist-up' | 'full-body';

/** Text luminance over the unchanging black field. */
export type TextIntensity = 'soft' | 'standard' | 'strong';

/** What marks the reading position. */
export type ReadingCueStyle = 'ticks' | 'wash' | 'none';

/** How much instrumentation the presenter's glass carries. */
export type StageMode = 'clean' | 'diagnostic';

/**
 * Whether geometry is being resolved for a prompter or for a reading window.
 *
 * It selects which character band the width solver aims at, and whether the
 * framing multiplier applies — and nothing else. The angular ladder, the
 * legibility floors and the resolution order are identical in both. See
 * `READER_READING_MEASURE` in `shared/optics.ts` for the reasoning, and the
 * reader-mode spec for why the measure is the only thing a camera was dictating.
 *
 * A contract type rather than a private one because `StageSettings` carries it:
 * the stage re-resolves against its own viewport, so it has to be told which
 * band control was aiming at.
 */
export type ReadingContext = 'prompter' | 'reader';

/**
 * Every derived value, made explicit.
 *
 * ---------------------------------------------------------------------------
 * THE RULE: DISCOVER EVERYTHING, DECIDE NOTHING IRREVERSIBLY
 * ---------------------------------------------------------------------------
 * Speaking Glass should work out the right answer without being asked — panel model
 * from the display, physical scale from the model, type size from the distance,
 * measure from the panel, line pitch from the font it actually rendered. That
 * is the whole point of the optical layer, and a presenter who never opens this
 * screen should still get a well-sized stage.
 *
 * But every one of those answers is a DEFAULT, not a verdict. Somebody who
 * wants 84 pixels because 84 pixels is what they like is not wrong, and a
 * system that computes a beautiful 62 and refuses to be told otherwise is worse
 * than one that never computed anything. Rigs are strange, eyes differ, and the
 * person standing at the glass can see something the maths cannot.
 *
 * So: every field here is optional, every one shadows exactly one derived
 * value, and `ResolvedOptics.overriddenFields` records which ones were used so
 * the UI can mark them "set by you" and offer a reset to automatic. An override
 * that cannot be found or undone is a trap, not a feature.
 *
 * Overrides are applied LAST, after the hardware-fit check. That ordering is
 * deliberate: the fit check still runs, so the operator is still TOLD when
 * their chosen size costs them the reading measure — they are simply not
 * prevented from choosing it.
 */
export interface OpticalOverrides {
  /* ---- size and measure ---- */
  /** Body size in CSS pixels. Wins over every angular calculation. */
  fontSizePx?: number;
  /** Target cap height in arcminutes. Ignored when `fontSizePx` is set. */
  arcminutes?: number;
  /** Target prose measure in characters. */
  characters?: number;
  /** Column width in CSS `ch`. Wins over `characters`. */
  columnCh?: number;
  /** Fraction of the safe width the column may occupy at most. */
  maxColumnFraction?: number;

  /* ---- typography ---- */
  lineHeight?: number;
  fontWeight?: number;
  letterSpacingEm?: number;
  paragraphSpacingEm?: number;

  /* ---- vertical geometry, in line pitches ---- */
  deadZoneLines?: number;
  topFadeLines?: number;
  bottomFadeLines?: number;
  futureReserveLines?: number;
  sentenceMicrogapLines?: number;

  /* ---- treatment ---- */
  pastOpacity?: number;
  futureOpacity?: number;
  /** Floor for presenter-readable secondary text, CSS px. */
  secondaryMinPx?: number;

  /**
   * The reading band's position outright, as a fraction of the safe rectangle.
   *
   * The sibling `lensOffsetDegrees` below is an angle measured FROM the lens, so
   * it can only exist on a rig that has one. This is the direct statement, and it
   * is what a reader-mode rig (`lensPlacement: 'none'`) has instead: there is no
   * camera to offset from, so where the line sits is simply a preference.
   *
   * It wins over `lensOffsetDegrees` when both are set, because one is a stated
   * position and the other is a correction to a derivation — composing them would
   * mean the operator's own number is not the number they get.
   */
  readingBandY?: number;

  /**
   * Vertical shift of the reading band away from the lens, in DEGREES below it.
   *
   * Degrees rather than pixels or fractions because this is a claim about how
   * the camera perceives the presenter, and that is angular: the same pixel
   * offset is a different amount of apparent gaze deviation at 1 m and at 2 m.
   *
   * Gaze-detection research finds horizontal deviation far easier to notice
   * than vertical — thresholds around 2.7 degrees horizontally against roughly
   * 5.4 vertically — and some work suggests a small downward offset can read as
   * more direct than looking at the exact centre of the lens. That justifies
   * offering the adjustment and testing it on camera. It does not justify
   * hard-coding a value, so the default is zero and the range is small.
   */
  lensOffsetDegrees?: number;
}

export interface OpticalProfile {
  schemaVersion: 1;
  /** Human name for this rig — panel plus mounting, e.g. "Studio hood". */
  rigName: string;
  hardwareKind: OpticalHardwareKind;
  /** Null until the physical scale has been established. */
  scale: OpticalScale | null;
  /** Eye-to-glass distance, millimetres. Null until asked. */
  viewingDistanceMm: number | null;
  safeArea: SafeAreaInsets;
  lens: LensPosition;
  /** Where the lens sits relative to the glass. Defaults to `'in-panel'`. */
  lensPlacement: LensPlacement;
  flips: OpticalFlips;
  framing: FramingPreset;
  /** Explicit values that shadow what the optical model would derive. */
  overrides: OpticalOverrides;
  /**
   * The single sizing control: 0 favours more text on screen, 1 favours larger
   * text. Presets write a value here rather than living beside it, so there is
   * one number that decides size and measure together.
   */
  bias: number;
  intensity: TextIntensity;
  readingCue: ReadingCueStyle;
  /** Which calibration steps have actually been completed. */
  completedSteps: OpticalCalibrationStep[];
}

export type OpticalCalibrationStep =
  | 'hardware'
  | 'safe-area'
  | 'orientation'
  | 'lens'
  | 'distance'
  | 'text-size'
  | 'line-width'
  | 'brightness'
  | 'follow-test';

/**
 * What the stage actually renders from.
 *
 * Everything here is derived. Nothing in this block is authored by a user, and
 * nothing in it should ever be edited by hand — it is the output of
 * `resolveStageGeometry` and exists in the settings document only so the stage
 * does not have to redo the resolution itself.
 */
export interface ResolvedOptics {
  schemaVersion: 1;
  safeArea: SafeAreaInsets;
  /** Lens position, as fractions of the SAFE rectangle. */
  opticalCenterX: number;
  readingBandY: number;
  /**
   * Carried through so the stage can pick the corridor's clamp range without
   * re-deriving it. Optional because older cached resolutions predate this
   * field; absence means the same thing an explicit `'in-panel'` would.
   */
  lensPlacement?: LensPlacement;

  /* ---- geometry in line pitches ----
   * Expressed as multiples of the MEASURED line pitch rather than in `vh` or
   * pixels, so the stage behaves identically on a 600px panel and a 1080px one.
   * The stage multiplies each by the pitch its own measurement pass found. */
  /** Total dead-zone height; the reading corridor the token may drift within. */
  deadZoneLines: number;
  topFadeLines: number;
  bottomFadeLines: number;
  /** How much upcoming script to keep below the band. */
  futureReserveLines: number;
  /** Extra separation after strong sentence punctuation inside long paragraphs. */
  sentenceMicrogapLines: number;

  /* ---- typography ---- */
  /** Column measure in CSS `ch`. The stage sets `max-width` from this. */
  columnCh: number;
  /** Floor for every presenter-readable element that is not body copy. */
  secondaryMinPx: number;
  bodyFontSizePx: number;

  /* ---- honesty ----
   * A resolved block always says how much of itself is real. The stage and the
   * diagnostics both read these rather than inferring confidence from whether a
   * number happens to be present. */
  /** A physical scale and a distance were both known. */
  calibrated: boolean;
  /** The font was measured rather than assumed from DIN ratios. */
  metricsMeasured: boolean;
  mmPerCssPx: number | null;
  viewingDistanceMm: number | null;
  /** Cap height the body size subtends, arcminutes. Null when uncalibrated. */
  bodyArcminutes: number | null;
  /** Prose characters per line the resolved column yields. */
  charactersPerLine: number | null;
  fitVerdict: string;
  fitAdvice: string;

  /* ---- typography, resolved ---- */
  lineHeight: number;
  fontWeight: number;
  letterSpacingEm: number;
  paragraphSpacingEm: number;
  pastOpacity: number;
  futureOpacity: number;

  /**
   * Which `OpticalOverrides` keys were actually applied.
   *
   * The UI reads this to mark a control "set by you" and offer a reset — an
   * override you cannot find is indistinguishable from a bug, and this is the
   * only record that a number came from a person rather than from the model.
   * Sorted, so two resolutions of the same profile compare equal.
   */
  overriddenFields: string[];
}

/** A rig that has told us nothing — the pre-calibration default. */
export function defaultOpticalProfile(): OpticalProfile {
  return {
    schemaVersion: 1,
    rigName: 'Default rig',
    hardwareKind: 'generic',
    scale: null,
    viewingDistanceMm: null,
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    lens: { x: 0.5, y: 0.38 },
    lensPlacement: 'in-panel',
    flips: { horizontal: false, vertical: false },
    framing: 'head-and-shoulders',
    /*
     * Mid-ladder, which resolves to about 23 arcminutes of cap height.
     *
     * Four independent reviews put the preferred size somewhere between 20 and
     * 28: human-factors guidance clusters at 20-22, one display review argued
     * 24, and two arrived at roughly 27 by way of x-height degrees. The ladder
     * already spans exactly that range, so the default sits at its centre of
     * mass rather than adopting whichever source was read most recently.
     */
    bias: 0.4,
    overrides: {},
    intensity: 'standard',
    readingCue: 'ticks',
    completedSteps: [],
  };
}

/**
 * Physical dimensions for the hardware Speaking Glass ships knowledge of.
 *
 * Diagonals only — resolution comes from the display descriptor at runtime, so
 * a panel driven at a non-native resolution still resolves correctly. Elgato's
 * published comfortable-reading ranges are carried alongside so the wizard can
 * warn when a chosen distance is outside what the manufacturer supports.
 */
export const OPTICAL_HARDWARE: Record<
  OpticalHardwareKind,
  { label: string; diagonalInches: number | null; maxComfortableDistanceMm: number | null }
> = {
  'elgato-prompter': {
    label: 'Elgato Prompter (9-inch)',
    diagonalInches: 9,
    maxComfortableDistanceMm: 1800,
  },
  'elgato-prompter-xl': {
    label: 'Elgato Prompter XL (15.6-inch)',
    diagonalInches: 15.6,
    maxComfortableDistanceMm: 4600,
  },
  'ipad-sidecar': {
    // iPads vary too much to assume; the wizard asks for the diagonal.
    label: 'iPad via Sidecar',
    diagonalInches: null,
    maxComfortableDistanceMm: null,
  },
  generic: {
    label: 'Other display',
    diagonalInches: null,
    maxComfortableDistanceMm: null,
  },
};
