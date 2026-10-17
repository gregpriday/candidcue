/**
 * Where this take will actually open, said out loud before it does (CCUX-004,
 * CCUX-005, #302).
 *
 * ---------------------------------------------------------------------------
 * THREE THINGS THAT ARE NOT THE SAME THING
 * ---------------------------------------------------------------------------
 * The product had one name — "Stage display" — covering three ideas, and the
 * name it had was the one belonging to the idea it did NOT control:
 *
 *   Destination     the panel or window THIS take will use. A prompter take
 *                   fills the panel pinned in Settings › Prompter display and
 *                   rigs, and the monitor the control window is on when nothing
 *                   is pinned or the pinned panel is unplugged
 *                   (`windows/present.rs`). `resolvePrompterDisplay` is that
 *                   rule, and the one place the frontend states it.
 *   Calibrated rig  the physical panel an optical profile was measured for.
 *   Preview target  the panel identification, display tests and calibration
 *                   previews are aimed at (`chooseStageDisplay`).
 *
 * A user could correctly choose and calibrate a panel in Settings, press
 * Present from a different one, and get behaviour that follows the architecture
 * exactly while contradicting everything the interface had told them. Nothing
 * was broken; the vocabulary was.
 *
 * Then the architecture moved — Present learned to fill the pinned panel — and
 * every screen describing the destination kept describing the old rule, each
 * one getting a different case wrong (#302). Welcome, Settings, the editor and
 * the readiness sheet now all ask `resolvePrompterDisplay`, so they cannot
 * drift apart from each other again; keeping it in step with Rust is the one
 * obligation left, and the tests beside it pin the cases Rust decides.
 *
 * This module resolves the first of the three and reports honestly when it
 * disagrees with the second. It is pure — displays and settings in, sentences
 * out — so the wording is testable without a window, a monitor or a rig.
 */
import type { DisplayDescriptor } from '../services/stage-types';
import type { PresentationMode } from '../services/settings-types';

/* ---------------------------------------------------------------------------
 * WHERE PRESENT PUTS A PROMPTER TAKE
 * ------------------------------------------------------------------------- */

/**
 * Why a prompter take is going where it is going.
 *
 *   pinned       the panel pinned in Settings, which is connected;
 *   pin-missing  a panel is pinned but not connected, so Present falls back to
 *                the monitor the control window is on;
 *   unpinned     nothing is pinned, so Present fills the monitor the control
 *                window is on.
 */
export type PrompterDisplayReason = 'pinned' | 'pin-missing' | 'unpinned';

export interface PrompterDisplay {
  /**
   * The panel the take will fill, or null when it is the window's monitor and
   * nobody could name that. Never a guess: an unknown answer stays unknown.
   */
  display: DisplayDescriptor | null;
  reason: PrompterDisplayReason;
}

/**
 * The display identity a fingerprint carries, without the ordinal that tells two
 * identical panels apart. Rust's `fingerprint_identity` (`windows/mod.rs`),
 * kept character-for-character: only a trailing `-<digits>` after the fourth
 * character is an ordinal, so the `dsp-` prefix is never mistaken for one.
 */
function fingerprintIdentity(fingerprint: string): string {
  const index = fingerprint.lastIndexOf('-');
  if (index > 3 && /^\d*$/.test(fingerprint.slice(index + 1))) return fingerprint.slice(0, index);
  return fingerprint;
}

/**
 * The connected panel a pinned fingerprint refers to, the way Present finds it.
 *
 * Rust's `match_display_index`: an exact fingerprint first, then the first panel
 * with the same identity — which is what keeps a pin resolving after its twin
 * was unplugged and the ordinals shifted. Matching exactly here, as the older
 * screens did, would call that panel unplugged while Present filled it.
 */
export function findPinnedDisplay(
  displays: readonly DisplayDescriptor[],
  pinned: string | null,
): DisplayDescriptor | null {
  if (pinned === null || pinned === '') return null;
  const exact = displays.find((d) => d.fingerprint === pinned);
  if (exact !== undefined) return exact;
  const identity = fingerprintIdentity(pinned);
  return displays.find((d) => fingerprintIdentity(d.fingerprint) === identity) ?? null;
}

/**
 * The panel Present will fill with a prompter take: `apply_presentation` in
 * `windows/present.rs`, restated for the screens that have to describe it.
 *
 * The pinned panel when it is connected; otherwise the monitor the control
 * window is on. Not "an external display when one is connected" — that is
 * `chooseStageDisplay`'s preview guess, and describing Present with it told a
 * first-run user with a second monitor that the take would open there, moments
 * before the monitor in front of them became the prompter.
 *
 * Prompter takes only. A reading window ignores the pin and opens where the
 * window is, so it makes no claim about a panel at all.
 */
export function resolvePrompterDisplay(input: {
  /** Every connected panel, in the order Rust lists them. */
  displays: readonly DisplayDescriptor[];
  /** `settings.stage.displayFingerprint`. */
  pinnedFingerprint: string | null;
  /** The panel the control window is on right now, or null if unknown. */
  windowDisplay: DisplayDescriptor | null;
}): PrompterDisplay {
  const { displays, pinnedFingerprint, windowDisplay } = input;
  if (pinnedFingerprint === null || pinnedFingerprint === '') {
    return { display: windowDisplay, reason: 'unpinned' };
  }
  const pinned = findPinnedDisplay(displays, pinnedFingerprint);
  if (pinned !== null) return { display: pinned, reason: 'pinned' };
  return { display: windowDisplay, reason: 'pin-missing' };
}

/* ---------------------------------------------------------------------------
 * WHAT TO SAY ABOUT IT
 * ------------------------------------------------------------------------- */

export interface TakeDestinationInput {
  mode: PresentationMode;
  /**
   * The panel the control window is on RIGHT NOW, or null when it cannot be
   * determined. A prompter take lands here only when nothing pinned is
   * connected — see `resolvePrompterDisplay`.
   *
   * Null is a real answer and is reported as one. Substituting the calibrated
   * display here would reintroduce the exact confusion this module exists to
   * remove, and it would do it while looking more confident than before.
   */
  currentDisplay: DisplayDescriptor | null;
  /** Every connected panel, which is what a pinned fingerprint is resolved against. */
  displays: DisplayDescriptor[];
  /** The panel pinned in Settings › Prompter display and rigs, if any. */
  pinnedFingerprint: string | null;
  /**
   * Connected panels that have a rig IN FORCE, with its name.
   *
   * ---------------------------------------------------------------------------
   * NOT "WHATEVER PANEL IS PINNED"
   * ---------------------------------------------------------------------------
   * The pin decides where a prompter take opens. It says nothing about whether
   * anything was ever measured on that panel. Reading it as "the calibrated
   * rig" meant somebody who had merely SELECTED a panel, and calibrated nothing
   * anywhere, was warned that their non-existent rig was set up for a different
   * display.
   *
   * A rig exists when `optical.activeRig` names one for the panel and the
   * profile resolves — `activeOpticalProfile` is the authority, and it is
   * deliberately not "the only profile if there is exactly one", because a rig
   * has to be chosen before it is used.
   */
  calibratedRigs: CalibratedRig[];
  /**
   * The rig in force under the pinned fingerprint, read whether or not that
   * panel is connected — the one rig an unplugged pin takes out of the picture.
   * Null when nothing is pinned or no rig was chosen for it.
   */
  pinnedRigName: string | null;
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
   * Present when the take will open away from measured optics it would
   * otherwise have used: a calibrated rig's panel elsewhere, or a pinned,
   * calibrated panel that is unplugged. Informative, never blocking — the take
   * still opens, and the readiness sheet offers to start it anyway.
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
  const { mode, currentDisplay, displays, pinnedFingerprint } = input;

  if (mode === 'reader') {
    return {
      summary: 'Reading window · opens where this window is',
      confidence: 'window',
      mismatch: null,
    };
  }

  const target = resolvePrompterDisplay({ displays, pinnedFingerprint, windowDisplay: currentDisplay });
  const landing = target.display;
  const summary =
    landing === null
      ? 'Teleprompter · fills this window’s display'
      : `Teleprompter · ${displayName(landing)}`;

  return {
    summary,
    confidence: landing === null ? 'unknown' : 'known',
    mismatch: resolveMismatch(target, input),
  };
}

/** A rig's name in quotes, or a rig-neutral phrase when it has none. */
function rigLabel(rigName: string): string {
  return rigName.trim() === '' ? 'A rig' : `“${rigName.trim()}”`;
}

/**
 * Whether the take is opening away from the panel the operator set up for it.
 *
 * Two cases earn it, both KNOWN problems rather than guesses:
 *
 *  - the pinned panel is unplugged and a rig was chosen for it, so the take
 *    falls back to the monitor the window is on and goes without the optics
 *    the operator measured;
 *  - the take lands on a panel with no rig while a rig is in force on another
 *    connected one.
 *
 * And it stays silent when:
 *
 *  - the take lands on a panel with its own rig — whatever monitor the editor
 *    is on, that take is laid out from measured optics (#302: a pinned,
 *    calibrated panel used to be reported as the wrong one whenever Present was
 *    pressed from the desk monitor, which was every time);
 *  - no rig is calibrated at all — display-based defaults are the normal case
 *    and are not a degradation. That includes an unplugged pin with no rig:
 *    the line beside Present already names where the take goes, and raising
 *    the readiness sheet on every take for somebody who left the prompter at
 *    the studio would be an interruption that tells them nothing new;
 *  - the landing panel cannot be named, because "this might be the wrong panel"
 *    is a worse thing to tell somebody than nothing. A warning that fires on
 *    uncertainty rather than on a known problem is the kind users switch off.
 *
 * The title has to stand on its own: the readiness sheet shows nothing else.
 */
function resolveMismatch(
  target: PrompterDisplay,
  input: TakeDestinationInput,
): DestinationMismatch | null {
  const landing = target.display;
  const rigs = input.calibratedRigs;
  // The panel this take is opening on has its own rig. Nothing to say.
  if (landing !== null && rigs.some((r) => r.display.fingerprint === landing.fingerprint)) return null;

  /*
   * An empty list cannot prove a pin is unplugged: it is a machine that named
   * no panels at all, and "the display you chose is not connected" would be
   * a claim made on no evidence.
   */
  const pinnedRig = input.pinnedRigName;
  if (target.reason === 'pin-missing' && pinnedRig !== null && input.displays.length > 0) {
    const where =
      landing === null
        ? 'the display the CandidCue window is on'
        : `${displayName(landing)}, where the CandidCue window is`;
    return {
      title: `The prompter display you chose is not connected, so this take will open on ${where}.`,
      detail: `${rigLabel(pinnedRig)} is calibrated for the display you chose, so this take will size its text from the panel it lands on rather than from measured optics.`,
      suggestion:
        'Reconnect the display you chose and present again, choose another in Settings › Prompter display and rigs, or carry on.',
    };
  }

  if (landing === null) return null;
  if (rigs.length === 0) return null;

  const elsewhere = rigs[0]!;
  const others =
    rigs.length > 1 ? ` (and ${rigs.length - 1} other calibrated ${rigs.length === 2 ? 'display' : 'displays'})` : '';
  return {
    title: `This take will open on ${displayName(landing)}, which has no calibrated rig.`,
    detail: `${rigLabel(elsewhere.rigName)} is calibrated for ${displayName(elsewhere.display)}${others}, so this take will size its text from the panel it lands on rather than from measured optics.`,
    /*
     * Not "drag the window there": Present fills the PINNED panel, so moving
     * the editor changes nothing once one is pinned. Choosing the rig's panel
     * is the one instruction that works whether or not something is.
     */
    suggestion: `Choose ${displayName(elsewhere.display)} in Settings › Prompter display and rigs and present again, or carry on with display-based defaults.`,
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
