/**
 * Working out what the rig is, without asking.
 *
 * ---------------------------------------------------------------------------
 * WHY DISCOVERY IS SEPARATE FROM CALIBRATION
 * ---------------------------------------------------------------------------
 * Calibration is what a person does standing at their rig. Discovery is what
 * CandidCue should have already done before they got there.
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
import { inchesToMm, mmPerCssPixel } from './optics';

/** Just enough of a display to identify it. */
export interface DisplayShape {
  name?: string | undefined;
  /** Device pixels, as the window layer reports them. */
  physicalSize: { width: number; height: number };
  scaleFactor: number;
}

export interface HardwareIdentification {
  kind: OpticalHardwareKind;
  /** How the match was reached, so the UI can say how sure it is. */
  confidence: 'model' | 'resolution' | 'unknown';
  /** Physical diagonal, when the identification implies one. */
  diagonalInches: number | null;
  /** One line for the wizard's first step. */
  label: string;
}

/**
 * The 9-inch Prompter's native mode.
 *
 * 1024x600 is an unusual enough resolution that seeing it is strong evidence on
 * its own — no mainstream monitor ships it, and the panel is very unlikely to be
 * driven at anything else. That makes it a safe fallback when the display
 * reports no name at all, which happens on some capture and bridge paths.
 */
const PROMPTER_9_MODE = { width: 1024, height: 600 };

/**
 * Identify the panel behind a display.
 *
 * Name first, because it is the only signal that distinguishes a Prompter XL
 * from any other 1080p monitor. Resolution second, and only for the one mode
 * that is genuinely diagnostic. Everything else is honestly `unknown` — a guess
 * dressed as an identification would put a wrong physical size into the angular
 * model, and every size on the glass would be wrong by the same factor without
 * anything looking broken.
 */
export function identifyHardware(display: DisplayShape | null | undefined): HardwareIdentification {
  const name = (display?.name ?? '').toLowerCase();

  if (name.includes('prompter')) {
    // "XL" is the only thing separating the two Elgato panels by name.
    const xl = name.includes('xl');
    const kind: OpticalHardwareKind = xl ? 'elgato-prompter-xl' : 'elgato-prompter';
    return {
      kind,
      confidence: 'model',
      diagonalInches: OPTICAL_HARDWARE[kind].diagonalInches,
      label: OPTICAL_HARDWARE[kind].label,
    };
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
 */
export function scaleForDisplay(
  display: DisplayShape,
  identification: HardwareIdentification,
): OpticalScale | null {
  const inches = identification.diagonalInches;
  if (inches === null || !(inches > 0)) return null;
  const scaleFactor = display.scaleFactor > 0 ? display.scaleFactor : 1;
  const diagonalMm = inchesToMm(inches);
  const mmPerCssPx = mmPerCssPixel({
    diagonalMm,
    widthPx: display.physicalSize.width / scaleFactor,
    heightPx: display.physicalSize.height / scaleFactor,
  });
  if (mmPerCssPx === null) return null;
  return { mmPerCssPx, source: 'model', diagonalMm };
}

/**
 * A sensible starting distance for a panel of this kind.
 *
 * Distance is the one thing that genuinely cannot be discovered, so this is a
 * guess — but a per-hardware guess beats a universal one by a wide margin. A
 * 9-inch prompter is a desk instrument; an XL is a studio one and is usually
 * further away than people expect.
 */
export function defaultDistanceMm(kind: OpticalHardwareKind): number | null {
  switch (kind) {
    case 'elgato-prompter':
      return 1200;
    case 'elgato-prompter-xl':
      return 2500;
    case 'ipad-sidecar':
      return 1000;
    default:
      return null;
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
 * Build the best profile CandidCue can produce for a display on its own.
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

  if (identification.confidence !== 'unknown') answered.push('hardware');

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

  const distance = base.viewingDistanceMm ?? defaultDistanceMm(identification.kind);
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
