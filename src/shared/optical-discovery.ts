/**
 * Working out what the rig is, without asking.
 *
 * ---------------------------------------------------------------------------
 * WHY DISCOVERY IS SEPARATE FROM CALIBRATION
 * ---------------------------------------------------------------------------
 * Calibration is what a person does standing at their rig. Discovery is what
 * Speaking Glass should have already done before they got there.
 *
 * Almost everything the optical model needs is knowable from the display the
 * stage is about to open on: which panel it is, how physically large that panel
 * is, and therefore how many millimetres a CSS pixel is worth. Only two facts
 * genuinely require a human — how far away they will stand, and how much of the
 * panel their hood actually reveals — and one of those has a defensible default
 * per hardware kind.
 *
 * So the wizard should open with most of its questions already answered and the
 * stage already looking approximately right. Every answer here is a starting
 * point that the profile can overwrite; nothing in this module is a verdict.
 *
 * ---------------------------------------------------------------------------
 * AND WHY A TAKE NOW RUNS ON IT DIRECTLY
 * ---------------------------------------------------------------------------
 * For a long time discovery was only a proposal behind a button in Settings: a
 * prompter take on a panel with no chosen rig ran at a flat 64px, however large
 * the glass. That is the layout that looked wrong on a 9-inch Prompter, and it
 * looked wrong for a knowable reason — the app could identify the panel and
 * size for it, and chose not to until somebody finished a wizard.
 *
 * `automaticProfile` is the take-time answer: the best profile discovery can
 * build for the panel the window actually landed on, or null when it genuinely
 * cannot size the glass. `stageSettingsFromSettings` reaches for it whenever no
 * rig has been chosen, so pressing Present on any recognisable display — or any
 * display that reports its own millimetres — gets type sized by visual angle
 * rather than by pixel count. A calibrated rig still wins outright, because a
 * ruler and a measured distance beat a table and a guess.
 *
 * Pure logic. Takes a structural description of a display rather than importing
 * the control layer's `DisplayDescriptor`, because `shared/` must not depend on
 * `control/` and because the stage may one day want to identify its own panel.
 */
import {
  OPTICAL_HARDWARE,
  defaultOpticalProfile,
  type OpticalHardwareKind,
  type OpticalProfile,
  type OpticalScale,
} from './contracts/optical';
import { inchesToMm, isPlausibleDiagonalMm, mmPerCssPixel } from './optics';

/** Just enough of a display to identify it. */
export interface DisplayShape {
  name?: string | undefined;
  /** Device pixels, as the window layer reports them. */
  physicalSize: { width: number; height: number };
  scaleFactor: number;
  /**
   * The panel's active area in millimetres, when the window layer could read
   * it off the monitor's EDID and believed the answer. Absent on platforms
   * that do not read it and on panels that lie (`windows/panel_size.rs` says
   * which lies it checks for). Structurally the same field as
   * `DisplayDescriptor.physicalSizeMm`, so a descriptor can be passed here as
   * it is.
   */
  physicalSizeMm?: { width: number; height: number } | null | undefined;
}

export interface HardwareIdentification {
  kind: OpticalHardwareKind;
  /**
   * How the match was reached, so the UI can say how sure it is.
   *
   * `'panel'` is the honest middle: the MODEL is unknown, but the panel
   * reported its own size, so the physical scale — the only thing the angular
   * model actually needs from an identification — is known anyway.
   */
  confidence: 'model' | 'resolution' | 'panel' | 'unknown';
  /** Physical diagonal, when the identification implies one. */
  diagonalInches: number | null;
  /** One line for the wizard's first step. */
  label: string;
}

/**
 * The two Elgato panels' native modes.
 *
 * 1024x600 is an unusual enough resolution that seeing it is strong evidence on
 * its own — no mainstream monitor ships it, and the panel is very unlikely to be
 * driven at anything else. That makes it a safe fallback when the display
 * reports no name at all, which is in fact what happens on macOS: tao names
 * every monitor `Monitor #<model number>`, so the name check below has never
 * matched a real Elgato there and the grid is what identifies the 9-inch.
 *
 * The XL's 1920x1080 identifies nothing on its own, but it is still what an
 * XL must be running at. A name that says "Prompter" over a different grid is
 * a name to distrust — a mock, a capture device, somebody's monitor label —
 * and now that identification sizes a take directly, a wrong model is a wrong
 * physical scale on the glass. So the name only counts when the grid agrees.
 */
const PROMPTER_9_MODE = { width: 1024, height: 600 };
const PROMPTER_XL_MODE = { width: 1920, height: 1080 };

function runsAtNativeMode(
  display: DisplayShape,
  mode: { width: number; height: number },
): boolean {
  const { width, height } = display.physicalSize;
  if (width === mode.width && height === mode.height) return true;
  // A panel driven at a HiDPI multiple of its native grid still IS that panel.
  const scale = display.scaleFactor;
  return (
    Number.isFinite(scale) &&
    scale > 0 &&
    Math.round(width / scale) === mode.width &&
    Math.round(height / scale) === mode.height
  );
}

/** The panel's reported size as a diagonal in millimetres, or null. */
function reportedDiagonalMm(display: DisplayShape | null | undefined): number | null {
  const mm = display?.physicalSizeMm;
  if (!mm) return null;
  if (!(mm.width > 0) || !(mm.height > 0)) return null;
  const diagonal = Math.hypot(mm.width, mm.height);
  return isPlausibleDiagonalMm(diagonal) ? diagonal : null;
}

/**
 * Identify the panel behind a display.
 *
 * Name first, because it is the only signal that distinguishes a Prompter XL
 * from any other 1080p monitor. Resolution second, and only for the one mode
 * that is genuinely diagnostic. Then the panel's own millimetres, which name
 * no model but do size the glass. Everything else is honestly `unknown` — a
 * guess dressed as an identification would put a wrong physical size into the
 * angular model, and every size on the glass would be wrong by the same factor
 * without anything looking broken.
 */
export function identifyHardware(display: DisplayShape | null | undefined): HardwareIdentification {
  const name = (display?.name ?? '').toLowerCase();

  if (display && name.includes('prompter')) {
    // "XL" is the only thing separating the two Elgato panels by name.
    const xl = name.includes('xl');
    const kind: OpticalHardwareKind = xl ? 'elgato-prompter-xl' : 'elgato-prompter';
    if (runsAtNativeMode(display, xl ? PROMPTER_XL_MODE : PROMPTER_9_MODE)) {
      return {
        kind,
        confidence: 'model',
        diagonalInches: OPTICAL_HARDWARE[kind].diagonalInches,
        label: OPTICAL_HARDWARE[kind].label,
      };
    }
    // The name says Prompter and the pixels say otherwise. Fall through: the
    // grid or the panel's own millimetres may still identify it honestly.
  }

  if (name.includes('ipad')) {
    return {
      kind: 'ipad-sidecar',
      confidence: 'model',
      // iPads vary too much to assume, and Sidecar reports a virtual geometry
      // anyway. The wizard asks.
      diagonalInches: null,
      label: OPTICAL_HARDWARE['ipad-sidecar'].label,
    };
  }

  if (
    display &&
    display.physicalSize.width === PROMPTER_9_MODE.width &&
    display.physicalSize.height === PROMPTER_9_MODE.height
  ) {
    return {
      kind: 'elgato-prompter',
      confidence: 'resolution',
      diagonalInches: OPTICAL_HARDWARE['elgato-prompter'].diagonalInches,
      label: `${OPTICAL_HARDWARE['elgato-prompter'].label} (identified by its 1024 x 600 panel)`,
    };
  }

  const reportedMm = reportedDiagonalMm(display);
  if (reportedMm !== null) {
    const inches = reportedMm / inchesToMm(1);
    return {
      kind: 'generic',
      confidence: 'panel',
      diagonalInches: inches,
      label: `${OPTICAL_HARDWARE.generic.label} (${inches.toFixed(1).replace(/\.0$/, '')}-inch, by its own report)`,
    };
  }

  return {
    kind: 'generic',
    confidence: 'unknown',
    diagonalInches: null,
    label: OPTICAL_HARDWARE.generic.label,
  };
}

/**
 * The physical scale implied by an identification, in millimetres per CSS pixel.
 *
 * Returns null when the hardware is unknown, which is the honest answer and the
 * trigger for the wizard's ruler step. Note the division by `scaleFactor`: the
 * stage lays out in CSS pixels, so the diagonal has to be divided across the
 * LOGICAL resolution, and a display running at 2x would otherwise resolve to
 * half the true millimetres per pixel and every size on the glass would come out
 * at half its intended angle.
 *
 * The source records where the diagonal came from: a hardware table for a
 * recognised model, the panel itself when only its EDID vouched for it.
 */
export function scaleForDisplay(
  display: DisplayShape,
  identification: HardwareIdentification,
): OpticalScale | null {
  const inches = identification.diagonalInches;
  if (inches === null || !(inches > 0)) return null;
  // A scale factor that is not a positive number is a display the window
  // layer has not finished describing. Treating it as 1x would halve the
  // millimetres per pixel on a Retina panel — complete-or-null applies here too.
  const scaleFactor = display.scaleFactor;
  if (!Number.isFinite(scaleFactor) || !(scaleFactor > 0)) return null;
  const diagonalMm = inchesToMm(inches);
  const mmPerCssPx = mmPerCssPixel({
    diagonalMm,
    widthPx: display.physicalSize.width / scaleFactor,
    heightPx: display.physicalSize.height / scaleFactor,
  });
  if (mmPerCssPx === null) return null;
  return {
    mmPerCssPx,
    source: identification.confidence === 'panel' ? 'display' : 'model',
    diagonalMm,
  };
}

/**
 * How far from an unrecognised panel a presenter is assumed to stand, as a
 * multiple of its diagonal — and the range that multiple is held to.
 *
 * ---------------------------------------------------------------------------
 * A GUESS, SCALED BY THE GLASS
 * ---------------------------------------------------------------------------
 * Distance cannot be discovered, but it is not unrelated to the panel: nobody
 * mounts a 32-inch monitor beside a lens to read it from arm's length, and
 * nobody stands three metres back from a 9-inch one. The two known Elgato
 * defaults sit at roughly five and six diagonals; a webcam desk rig with a
 * laptop screen sits nearer three. Four and a half is the middle of that
 * evidence, so a 24-inch monitor resolves to about 2.7 m and a 13-inch laptop
 * to about 1.5 m. The clamp keeps a phone-sized or wall-sized panel from
 * producing a distance nobody would stand at.
 *
 * It is a starting point, and `resolveStageGeometry` labels it as one in its
 * warnings. The calibration wizard's distance step is where it becomes a
 * measurement.
 */
export const GENERIC_DISTANCE_DIAGONALS = 4.5;
export const GENERIC_DISTANCE_RANGE_MM = { min: 600, max: 4000 } as const;

/**
 * A sensible starting distance for a panel of this kind.
 *
 * Distance is the one thing that genuinely cannot be discovered, so this is a
 * guess — but a per-hardware guess beats a universal one by a wide margin. A
 * 9-inch prompter is a desk instrument; an XL is a studio one and is usually
 * further away than people expect. An unrecognised panel with a known diagonal
 * gets the scaled guess above; one with no diagonal at all gets nothing, which
 * is what sends the wizard to its distance step.
 */
export function defaultDistanceMm(
  kind: OpticalHardwareKind,
  diagonalMm: number | null = null,
): number | null {
  switch (kind) {
    case 'elgato-prompter':
      return 1200;
    case 'elgato-prompter-xl':
      return 2500;
    case 'ipad-sidecar':
      return 1000;
    default: {
      if (diagonalMm === null || !isPlausibleDiagonalMm(diagonalMm)) return null;
      const scaled = diagonalMm * GENERIC_DISTANCE_DIAGONALS;
      return Math.round(
        Math.min(GENERIC_DISTANCE_RANGE_MM.max, Math.max(GENERIC_DISTANCE_RANGE_MM.min, scaled)),
      );
    }
  }
}

export interface DiscoveredProfile {
  profile: OpticalProfile;
  identification: HardwareIdentification;
  /** Which steps discovery has already satisfied, for the wizard to skip. */
  answered: Array<'hardware' | 'scale' | 'distance'>;
  /** What still genuinely needs a person. */
  outstanding: Array<'scale' | 'distance' | 'safe-area' | 'orientation' | 'lens'>;
}

/**
 * Build the best profile Speaking Glass can produce for a display on its own.
 *
 * The result is immediately usable — a take started right now would be sized
 * from a real physical scale and a plausible distance rather than from a 64px
 * guess. `outstanding` is what the wizard should still walk through, and it is
 * deliberately short: the aperture and the lens are the two things only a person
 * looking through the glass can supply, and orientation is the one that must be
 * confirmed rather than assumed because getting it wrong is invisible in code
 * and obvious on a rig.
 */
export function discoverProfile(
  display: DisplayShape | null | undefined,
  existing?: OpticalProfile | null,
): DiscoveredProfile {
  const identification = identifyHardware(display);
  const base = existing ?? defaultOpticalProfile();
  const answered: DiscoveredProfile['answered'] = [];
  const outstanding: DiscoveredProfile['outstanding'] = [];

  // A panel that only reported its size has answered "how big", not "what is
  // it" — the wizard's hardware step is still worth a look.
  if (identification.confidence === 'model' || identification.confidence === 'resolution') {
    answered.push('hardware');
  }

  const scale = display ? scaleForDisplay(display, identification) : null;
  /*
   * A scale already on the profile WINS over a freshly derived one.
   *
   * The stored value may have come from a ruler held against the glass, which
   * measures the finished optical path — including a beamsplitter that
   * magnifies — while a model lookup only ever describes the panel. Recomputing
   * over the top of it would silently discard the better measurement every time
   * the app relaunched.
   */
  const resolvedScale = base.scale ?? scale;
  if (resolvedScale) answered.push('scale');
  else outstanding.push('scale');

  const distance =
    base.viewingDistanceMm ??
    defaultDistanceMm(identification.kind, resolvedScale?.diagonalMm ?? null);
  if (base.viewingDistanceMm !== null) answered.push('distance');
  else if (distance !== null) outstanding.push('distance');
  else outstanding.push('distance');

  // These three cannot be discovered at all: they are facts about a hood and a
  // camera, visible only to somebody looking through the glass.
  outstanding.push('safe-area', 'orientation', 'lens');

  return {
    identification,
    answered,
    outstanding,
    profile: {
      ...base,
      hardwareKind: identification.kind,
      scale: resolvedScale,
      viewingDistanceMm: distance,
      rigName: base.rigName === 'Default rig' ? identification.label : base.rigName,
    },
  };
}

/**
 * The name every automatic profile carries.
 *
 * Never stored — an automatic profile is rebuilt from the panel every time a
 * take opens, which is the point of it — so the name is a label, not a key. It
 * is what the in-take appearance sheet and the take summary show, and it is
 * how `isAutomaticProfile` tells one from a rig somebody calibrated.
 */
export const AUTOMATIC_RIG_NAME = 'Automatic';

/** True for a profile `automaticProfile` built, as opposed to one somebody saved. */
export function isAutomaticProfile(profile: OpticalProfile | null | undefined): boolean {
  return profile?.rigName === AUTOMATIC_RIG_NAME;
}

/**
 * The presenter's own choices that an automatic profile must carry, because
 * `buildStageSettings` reads them off whichever profile is in force.
 *
 * A profile decides more than geometry: text intensity, the reading cue and
 * the size/measure bias live on it too, since a calibrated rig chose them at
 * the glass. The automatic profile has no glass to have chosen them at, so it
 * takes the loose Settings values — otherwise merely upgrading would have
 * quietly reset a Soft, Wash presenter to Standard, Ticks.
 *
 * `bias` is the same argument one step further, and it is the one a presenter
 * notices: it decides the trade between type size and how much of a sentence
 * a line holds, which on a small panel is the difference between 26 and 36
 * characters. The slider for it existed only on a stored rig, so asking for a
 * wider line on an automatic panel meant saving discovery's ESTIMATED
 * distance as a calibration — trading automatic sizing for a question about
 * type. It is a preference, so it belongs with the preferences.
 */
export interface AutomaticProfileSeed {
  intensity: OpticalProfile['intensity'];
  readingCue: OpticalProfile['readingCue'];
  /** 0 is "more text on screen", 1 is "larger, easier text". */
  bias?: number;
}

/**
 * The profile a take runs with on a panel nobody has calibrated, or null when
 * the panel cannot be sized at all.
 *
 * ---------------------------------------------------------------------------
 * COMPLETE OR NOTHING
 * ---------------------------------------------------------------------------
 * The angular model needs both a scale and a distance to say anything; with
 * one missing `resolveStageGeometry` falls through to its 64px guess anyway,
 * only now inside an envelope that carries an optics block and reports itself
 * as a rig. That is the worst of both — a guess that the appearance sheet
 * would lock as "calibrated" — so a profile that cannot complete is not
 * returned at all, and the take takes the plain uncalibrated layout that says
 * it is one.
 *
 * Everything discovery cannot know is left at the defaults a fresh rig gets:
 * the whole panel visible, no flips (the mirror is the panel's own, from
 * Settings, as it is for every rig), the lens behind the glass a little above
 * centre. Those are
 * the same defaults the calibration wizard opens with, so a presenter who
 * later walks the wizard starts from exactly what they have been reading off.
 *
 * What it does NOT decide is the distance's provenance: `resolveStageGeometry`
 * calls a profile calibrated whenever it has a scale and a plausible
 * distance, and this one's distance is a per-hardware guess. The fit verdict
 * it reports is therefore "at the assumed distance", and the sheet and
 * Settings say so in words rather than the resolver saying so in a flag.
 */
export function automaticProfile(
  display: DisplayShape | null | undefined,
  seed?: AutomaticProfileSeed,
): OpticalProfile | null {
  if (!display) return null;
  const discovered = discoverProfile(display, null);
  const { profile } = discovered;
  if (profile.scale === null || profile.viewingDistanceMm === null) return null;
  const seeded = { ...profile, ...(seed ?? {}), rigName: AUTOMATIC_RIG_NAME };
  /*
   * The bias arrives from a localStorage overlay that is merged field-wise and
   * validated section-wise, so "a number" is not a safe assumption here — and a
   * NaN would travel all the way to a font size before anything noticed. Not a
   * number at all means the presenter has expressed nothing, so discovery's own
   * value stands; a number outside the range is still an expressed preference
   * and is clamped rather than discarded.
   */
  seeded.bias =
    typeof seeded.bias === 'number' && Number.isFinite(seeded.bias)
      ? Math.min(1, Math.max(0, seeded.bias))
      : profile.bias;
  return seeded;
}
