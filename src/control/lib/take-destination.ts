/**
 * Where this take will actually open, said out loud before it does (CCUX-004,
 * CCUX-005).
 *
 * ---------------------------------------------------------------------------
 * THREE THINGS THAT ARE NOT THE SAME THING
 * ---------------------------------------------------------------------------
 * The product had one name — "Stage display" — covering three ideas, and the
 * name it had was the one belonging to the idea it did NOT control:
 *
 *   Destination     the panel or window THIS take will use. Single-window
 *                   presentation fills whichever monitor the control window is
 *                   already on, so this is a fact about where the window is
 *                   sitting right now.
 *   Calibrated rig  the physical panel an optical profile was measured for.
 *   Preview target  the panel identification, display tests and calibration
 *                   previews are aimed at.
 *
 * A user could correctly choose and calibrate a panel in Settings, press
 * Present from a different one, and get behaviour that follows the architecture
 * exactly while contradicting everything the interface had told them. Nothing
 * was broken; the vocabulary was.
 *
 * This module resolves the first of the three and reports honestly when it
 * disagrees with the second. It is pure — displays and settings in, sentences
 * out — so the wording is testable without a window, a monitor or a rig.
 */
import type { DisplayDescriptor } from '../services/stage-types';
import type { PresentationMode } from '../services/settings-types';

export interface TakeDestinationInput {
  mode: PresentationMode;
  /**
   * The panel the control window is on RIGHT NOW, or null when it cannot be
   * determined.
   *
   * Null is a real answer and is reported as one. Substituting the calibrated
   * display here would reintroduce the exact confusion this module exists to
   * remove, and it would do it while looking more confident than before.
   */
  currentDisplay: DisplayDescriptor | null;
  /**
   * Connected panels that have a rig IN FORCE, with its name.
   *
   * ---------------------------------------------------------------------------
   * NOT `settings.stage.displayFingerprint`
   * ---------------------------------------------------------------------------
   * That fingerprint is the panel chosen for previews, display tests and
   * calibration — which is the third of the three ideas this module separates,
   * and says nothing about whether anything was ever measured on it. Reading it
   * as "the calibrated rig" meant somebody who had merely SELECTED a panel, and
   * calibrated nothing anywhere, was warned that their non-existent rig was set
   * up for a different display.
   *
   * A rig exists when `optical.activeRig` names one for the panel and the
   * profile resolves — `activeOpticalProfile` is the authority, and it is
   * deliberately not "the only profile if there is exactly one", because a rig
   * has to be chosen before it is used.
   */
  calibratedRigs: CalibratedRig[];
}

export interface CalibratedRig {
  display: DisplayDescriptor;
  /** The rig's own name, off the profile, where it is authoritative. */
  rigName: string;
}

export type DestinationConfidence =
  /** The panel is known by name. */
  | 'known'
  /** A reading window, which opens where the window already is by definition. */
  | 'window'
  /** Nobody could name the panel. Say so; do not guess. */
  | 'unknown';

export interface TakeDestination {
  /** One short line for under the Present button, e.g. "Teleprompter · Dell 24-inch". */
  summary: string;
  confidence: DestinationConfidence;
  /**
   * Present when the take will open somewhere other than the calibrated rig's
   * panel. Informative, never blocking — presenting where the window is, is a
   * supported and deliberate behaviour.
   */
  mismatch: DestinationMismatch | null;
}

export interface DestinationMismatch {
  title: string;
  detail: string;
  /** What the operator can do about it, if they want to. */
  suggestion: string;
}

/** A panel's name, or a stable stand-in when the OS gave none. */
export function displayName(display: DisplayDescriptor | null): string {
  if (display === null) return 'an unknown display';
  const named = (display.name ?? '').trim();
  if (named !== '') return named;
  return display.primary ? 'the main display' : 'a second display';
}

/**
 * Resolve the destination, and the mismatch if there is one.
 *
 * The mismatch is deliberately NOT raised for a reading window. A reader is an
 * ordinary desktop window that the user places by dragging it, and it makes no
 * claim to be on calibrated glass — warning that it is on the "wrong" panel
 * would be warning about the thing they just did on purpose.
 */
export function resolveTakeDestination(input: TakeDestinationInput): TakeDestination {
  const { mode, currentDisplay, calibratedRigs } = input;

  if (mode === 'reader') {
    return {
      summary: 'Reading window · opens where this window is',
      confidence: 'window',
      mismatch: null,
    };
  }

  const summary =
    currentDisplay === null
      ? 'Teleprompter · fills this window’s display'
      : `Teleprompter · ${displayName(currentDisplay)}`;

  return {
    summary,
    confidence: currentDisplay === null ? 'unknown' : 'known',
    mismatch: resolveMismatch(currentDisplay, calibratedRigs),
  };
}

/**
 * Whether the take is opening away from the panel a rig was measured for.
 *
 * Only raised when there is genuinely something to say. In particular it stays
 * silent when:
 *
 *  - no rig is calibrated at all — display-based defaults are the normal case
 *    and are not a degradation;
 *  - the current panel cannot be named, because "this might be the wrong panel"
 *    is a worse thing to tell somebody than nothing. A warning that fires on
 *    uncertainty rather than on a known problem is the kind users switch off.
 */
function resolveMismatch(
  current: DisplayDescriptor | null,
  rigs: CalibratedRig[],
): DestinationMismatch | null {
  if (current === null) return null;
  if (rigs.length === 0) return null;
  // The panel this take is opening on has its own rig. Nothing to say.
  if (rigs.some((r) => r.display.fingerprint === current.fingerprint)) return null;

  const elsewhere = rigs[0]!;
  const rig = elsewhere.rigName.trim() === '' ? 'A rig' : `“${elsewhere.rigName.trim()}”`;
  const others =
    rigs.length > 1 ? ` (and ${rigs.length - 1} other calibrated ${rigs.length === 2 ? 'display' : 'displays'})` : '';
  return {
    title: `This take will open on ${displayName(current)}, which has no calibrated rig.`,
    detail: `${rig} is calibrated for ${displayName(elsewhere.display)}${others}, so this take will size its text from the panel it lands on rather than from measured optics.`,
    suggestion: `Drag the CandidCue window to ${displayName(elsewhere.display)} and present again, or carry on with display-based defaults.`,
  };
}

/**
 * The same fact for a screen reader, where the "·" separators are noise.
 *
 * Kept beside the visual summary rather than derived at the call site so the
 * two cannot describe different destinations.
 */
export function destinationAnnouncement(destination: TakeDestination): string {
  const base = destination.summary.replace(/\s·\s/g, ', ');
  if (destination.mismatch === null) return base;
  /*
   * The WHOLE mismatch, not just its title.
   *
   * The visual treatment can afford to put the explanation in a tooltip because
   * the colour change invites a hover. A screen-reader user gets no such
   * invitation, and a title that only repeats the destination would tell them
   * something is different without ever saying what or what to do — which is
   * worse than silence.
   */
  const { title, detail, suggestion } = destination.mismatch;
  return `${base}. ${title} ${detail} ${suggestion}`;
}
