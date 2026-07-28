/**
 * Validated application-settings view consumed by the Settings screen
 * (spec §18) and defaults used until `get_settings` lands in Rust.
 */
import {
  OPTICAL_HARDWARE,
  defaultOpticalProfile,
  type FramingPreset,
  type ListenerPlacementMode,
  type OpticalCalibrationStep,
  type OpticalHardwareKind,
  type OpticalOverrides,
  type ReadingCueStyle,
  type StageMode,
  type OpticalProfile,
  type TextIntensity,
} from '../../shared/contracts';
import { defaultFollowingSettings, type FollowingSettings } from '../lib/follow-profiles';
import { defaultListenerSettings } from './settings-listener';

export type { FidelityMode, FollowFeel, FollowingSettings } from '../lib/follow-profiles';

export type LaunchBehavior = 'library' | 'recent';
export type SessionMode = 'voice' | 'manual' | 'fixed';
export type UpdateChannel = 'stable' | 'beta';

export interface AppSettings {
  schemaVersion: 1;
  revision: number;
  general: {
    launchBehavior: LaunchBehavior;
    defaultSessionMode: SessionMode;
    revisionRetentionDays: number;
    restoreWindows: boolean;
    confirmEndSession: boolean;
    /**
     * Track heading text as spoken words. A compile switch, not a stage one:
     * it changes what counts as a token, so it is read when the take compiles
     * the script rather than when the stage renders it.
     */
    readHeadings: boolean;
  };
  /**
   * Where the prompt window opens, and how (§14.2 A, §52.7).
   *
   * Its own section rather than a corner of `teleprompter`, because the answer
   * is about a physical panel rather than about type. Both fields are
   * per-machine — a fingerprint means nothing on another Mac — so both live in
   * the local overlay.
   */
  stage: {
    /**
     * The panel the stage opens on, by `DisplayDescriptor.fingerprint`.
     * `null` means "choose one": an external display when one is connected,
     * otherwise the only display there is.
     */
    displayFingerprint: string | null;
    fullscreen: boolean;
  };
  /**
   * Inworld speech-to-text (spec §18.2). The API key is not here and never
   * crosses into JavaScript: it lives in the OS credential store and is read
   * only by Rust, which owns the socket. What the UI holds is the choice of
   * model and locale.
   */
  inworld: {
    /** Inworld model id, e.g. `inworld/inworld-stt-1`. */
    transcriptionModel: string;
    /** BCP-47 tag the recogniser is told to expect, e.g. `en-US`. */
    language: string;
  };
  audio: {
    preferredDeviceId?: string;
    /**
     * The label `preferredDeviceId` carried when it was chosen, e.g.
     * "Blue Yeti" (§28.1).
     *
     * The id alone is not a durable name for a piece of hardware — WKWebView
     * salts device ids per origin and session, and a replug can change them —
     * so an id-only memory hands the presenter back the system default (very
     * often a headset) on some restarts, without saying so. The label is what
     * the user actually picked, so it is what makes the choice survive; see
     * `matchRememberedMicrophone`, which matches on the id first and re-pins
     * the fresh id when only the label matches.
     */
    preferredDeviceLabel?: string;
    followSystemDefault: boolean;
    noiseSuppression: boolean;
    echoCancellation: boolean;
    autoGainControl: boolean;
    /**
     * §28.4, 0-1, 0.5 = the A.6 defaults. The one Rust-owned field in this
     * section. It no longer gates what is sent — Inworld endpoints server-side
     * — but it decides where the meter says the microphone can hear you and
     * when the dead-input detector gives up, which is room tuning worth
     * outliving a cleared browser store. Everything else here is per-machine
     * capture state. See services/settings-audio.ts.
     */
    vadSensitivity: number;
    /**
     * §28.1. Microphone access has been granted on this machine before.
     *
     * Per-machine capture state, so it lives in the same local overlay as the
     * device id — a grant on this Mac says nothing about another one.
     *
     * It exists because `navigator.permissions.query({ name: 'microphone' })`
     * is not implemented in WKWebView, which is the only webview this app
     * ships in. `queryMicrophonePermission` therefore returns 'unsupported'
     * every time, the "notice a permission that is already granted" path never
     * fires, and the user was asked to click Allow before every single take —
     * the exact re-prompt that path was written to prevent, on the one platform
     * where it runs. macOS grants the microphone to the APPLICATION, so once
     * this is true, opening the mic again raises no prompt.
     */
    microphoneGranted: boolean;
  };
  teleprompter: {
    fontFamilyId: string;
    fontSizePx: number;
    lineHeight: number;
    mirrorX: boolean;
    mirrorY: boolean;
    /** Percent of the stage width the script column occupies (§14.2 E). */
    columnWidthPercent: number;
    readingBandCenterPercent: number;
    phraseHighlight: boolean;
    pastDimming: boolean;
    /**
     * Luminance of the TEXT over the stage's unchanging black field.
     *
     * This replaces the "Stage background" menu, which offered near-black and
     * high-contrast black and delivered neither: `themeId`, `background` and
     * `foreground` are written into every `StageSettings` and read by nothing,
     * because `src/styles/stage.css` hard-codes `--stage-bg`. The two options
     * rendered identically. What a presenter is actually reaching for when they
     * go looking for a background control on a prompter is how hot the type
     * burns against the glass — a bright rig washes out a soft face, a dark
     * studio makes a strong one bloom — so that is the control that exists now.
     */
    textIntensity: TextIntensity;
    fixedSpeedWpm: number;
    stageEndBehavior: 'close' | 'blank';
    hidePointer: boolean;
    /**
     * Clean Take hides the instrumentation; Diagnostic Take shows it.
     *
     * Here rather than nowhere because the stage already READS
     * `StageSettings.stageMode` — it derives the transcript bar, the waveform
     * and the alignment readout from it — and until something wrote it the
     * diagnostic take was unreachable outside the dev preview. A live read with
     * no writer is the same defect as a writer with no reader.
     */
    stageMode: StageMode;
    /** What marks the reading position: fixed side ticks, a soft wash, or nothing. */
    readingCue: ReadingCueStyle;
  };
  /**
   * Calibrated rigs, per panel (`shared/contracts/optical.ts`).
   *
   * Its own top-level section rather than a field on `teleprompter`, because a
   * profile is not a preference about type — it is a measurement of a physical
   * arrangement, and one panel routinely holds several. The Elgato on the desk
   * calibrated for a seated waist-up shot and the same Elgato on the boom arm
   * for a standing close-up are two different rigs sharing one
   * `displayFingerprint`; a single-valued field would silently let the second
   * overwrite the first, which is the one failure a calibration store cannot
   * afford (nobody re-measures a distance they believe is already saved).
   *
   * None of this has a Rust twin, so the localStorage overlay IS the document
   * for it — see `mergeSection` in services/settings.ts, and note the trap
   * documented there: a section missing from that merge does not fail loudly,
   * the setting simply reverts on every read. The durable backstop is the §52
   * `display_profiles` row a take writes, which carries `opticalProfile` inside
   * its `StageSettings` — but that row is one per panel and is rewritten by
   * every take, so what it backs up is the rig that panel LAST RAN WITH, not
   * the list. Clearing the browser store still costs a two-rig operator one of
   * their two arrangements; this map is the only place the list lives.
   */
  optical: OpticalSettings;
  /**
   * Smooth-following controls (companion §47). Values are understandable
   * choices; they resolve to a versioned `SmoothFollowProfile` through
   * `lib/follow-profiles.ts` rather than exposing control-system parameters.
   */
  following: FollowingSettings;
  /**
   * Listener defaults (§37, §46.7). Rust-owned in both directions, and an exact
   * twin of `settings::ListenerSettings` — this section and the Rust struct
   * used to be two structures for one feature, one of which nothing could set.
   * See services/settings-listener.ts.
   */
  listeners: ListenerSettings;
  /**
   * How the Listener is framed on the stage (§37.4).
   *
   * Separate from `listeners` because that section is Rust-owned in both
   * directions and these six fields have no home in the Rust document. They
   * are the percent-scale inputs `buildListenerSelection` converts into a
   * `ListenerGeometry`, kept in the shape the sliders bind to so there is one
   * place a framing is written and one place it is read.
   */
  listenerFraming: ListenerFraming;
  privacy: {
    diagnosticLogging: boolean;
    updateChannel: UpdateChannel;
    /**
     * §36.2 transcript retention. Rust-owned in both directions and 'off' by
     * default — it had no mapping in `settings.ts` at all, so the one setting
     * that decides whether spoken words are written to disk was unreachable
     * from the UI in either direction.
     */
    saveTranscript: TranscriptRetention;
  };
}

/** §36.2 retention windows, exactly the values Rust validates. */
export type TranscriptRetention = 'off' | '1d' | '7d' | '30d' | 'forever';

/* ---------------------------------------------------------------------------
 * The optical section
 * ------------------------------------------------------------------------- */

export interface OpticalSettings {
  /** Every calibrated rig, keyed by `opticalRigKey(fingerprint, rigName)`. */
  profiles: Record<string, OpticalProfile>;
  /** The rig in force on each panel: display fingerprint → rig name. */
  activeRig: Record<string, string>;
}

/**
 * The storage key for one rig on one panel.
 *
 * Both halves are percent-encoded before they are joined, so a rig somebody
 * named `Desk::boom` cannot collide with the `boom` rig of a panel whose
 * fingerprint happens to end in `Desk`. The key is opaque and nothing decodes
 * it — the rig's name is read back off the profile, which is where it is
 * authoritative.
 */
export function opticalRigKey(displayFingerprint: string, rigName: string): string {
  return `${encodeURIComponent(displayFingerprint)}::${encodeURIComponent(rigName)}`;
}

export interface OpticalRigEntry {
  key: string;
  profile: OpticalProfile;
  /** True for the one rig `activeRig` names for this panel. */
  active: boolean;
}

/**
 * Every rig calibrated for a panel, the one in force first and the rest by
 * name, so the UI can offer a picker rather than assuming one monitor means one
 * arrangement.
 *
 * By name rather than by recency because nothing records recency: a profile
 * carries what was measured, not when, and inventing an order out of the map's
 * insertion sequence would put a rig somewhere different every time the store
 * was rewritten.
 */
export function opticalRigsForDisplay(
  optical: OpticalSettings,
  displayFingerprint: string | null,
): OpticalRigEntry[] {
  if (displayFingerprint === null || displayFingerprint === '') return [];
  const prefix = `${encodeURIComponent(displayFingerprint)}::`;
  const activeName = optical.activeRig[displayFingerprint];
  const entries: OpticalRigEntry[] = [];
  for (const [key, stored] of Object.entries(optical.profiles)) {
    if (!key.startsWith(prefix)) continue;
    const profile = normalizeOpticalProfile(stored);
    if (profile === null) continue;
    entries.push({ key, profile, active: profile.rigName === activeName });
  }
  return entries.sort((a, b) =>
    a.active === b.active ? a.profile.rigName.localeCompare(b.profile.rigName) : a.active ? -1 : 1,
  );
}

/**
 * The rig a take on this panel runs with, or null when nothing is calibrated.
 *
 * Deliberately NOT "the only profile, if there is exactly one": a rig has to be
 * chosen before it is used, because adopting a stale arrangement is how the
 * stage ends up sized for a distance the presenter is no longer standing at.
 */
export function activeOpticalProfile(
  optical: OpticalSettings,
  displayFingerprint: string | null,
): OpticalProfile | null {
  if (displayFingerprint === null || displayFingerprint === '') return null;
  const rigName = optical.activeRig[displayFingerprint];
  if (typeof rigName !== 'string' || rigName === '') return null;
  return normalizeOpticalProfile(optical.profiles[opticalRigKey(displayFingerprint, rigName)]);
}

/**
 * Store a rig against a panel and make it the one that panel runs with.
 *
 * The name is trimmed here, once, because everything that reads this store
 * reads it back through `normalizeOpticalProfile`, which trims. Keying on the
 * untrimmed form leaves a rig whose stored name and whose key disagree, and the
 * disagreement is invisible until it matters: `activeOpticalProfile` still
 * finds it (it rebuilds the same untrimmed key) while `opticalRigsForDisplay`
 * marks it inactive (it compares the trimmed name), so the take runs on a rig
 * the picker says is not in force.
 */
export function withOpticalProfile(
  optical: OpticalSettings,
  displayFingerprint: string,
  profile: OpticalProfile,
): OpticalSettings {
  const rigName = profile.rigName.trim();
  return {
    profiles: {
      ...optical.profiles,
      [opticalRigKey(displayFingerprint, rigName)]: { ...profile, rigName },
    },
    activeRig: { ...optical.activeRig, [displayFingerprint]: rigName },
  };
}

/** Forget a rig, and the panel's choice of it if that is what it was. */
export function withoutOpticalProfile(
  optical: OpticalSettings,
  displayFingerprint: string,
  rigName: string,
): OpticalSettings {
  // Trimmed for the same reason it is trimmed on the way in: the caller has the
  // name off a listed entry, which is the normalized one.
  const name = rigName.trim();
  const profiles = { ...optical.profiles };
  delete profiles[opticalRigKey(displayFingerprint, name)];
  const activeRig = { ...optical.activeRig };
  if (activeRig[displayFingerprint] === name) delete activeRig[displayFingerprint];
  return { profiles, activeRig };
}

const FRAMING_PRESETS: readonly FramingPreset[] = [
  'close-up',
  'head-and-shoulders',
  'waist-up',
  'full-body',
];
const TEXT_INTENSITIES: readonly TextIntensity[] = ['soft', 'standard', 'strong'];
const READING_CUES: readonly ReadingCueStyle[] = ['ticks', 'wash', 'none'];
const SCALE_SOURCES = ['model', 'diagonal', 'ruler'] as const;
const CALIBRATION_STEPS: readonly OpticalCalibrationStep[] = [
  'hardware',
  'safe-area',
  'orientation',
  'lens',
  'distance',
  'text-size',
  'line-width',
  'brightness',
  'follow-test',
];

/**
 * Accept a stored profile only if it still has the shape the resolver walks.
 *
 * `resolveStageGeometry` reads `profile.safeArea.top` and `profile.lens.x`
 * without guarding the objects themselves, and it is right not to: it is handed
 * a typed profile. This is the boundary where that type stops being a promise.
 * `loadOverlay` checks that a settings SECTION is a plain object and
 * deliberately leaves its fields alone — the correct call for a boolean, the
 * wrong one for a document something dereferences two levels into, because a
 * `TypeError` thrown while building an envelope fails the take rather than the
 * setting.
 *
 * Missing scalars are filled from `defaultOpticalProfile()`. A document that is
 * not a v1 profile at all is refused outright rather than repaired: guessing at
 * a calibration is how an uncalibrated rig ends up claiming a viewing distance
 * nobody measured, which is the single thing the `calibrated` flag exists to
 * prevent.
 */
export function normalizeOpticalProfile(candidate: unknown): OpticalProfile | null {
  if (!isRecord(candidate)) return null;
  if (candidate['schemaVersion'] !== 1) return null;
  const rigName = candidate['rigName'];
  if (typeof rigName !== 'string' || rigName.trim() === '') return null;

  const base = defaultOpticalProfile();
  const safeArea = isRecord(candidate['safeArea']) ? candidate['safeArea'] : {};
  const lens = isRecord(candidate['lens']) ? candidate['lens'] : {};
  const flips = isRecord(candidate['flips']) ? candidate['flips'] : {};
  const scale = isRecord(candidate['scale']) ? candidate['scale'] : null;
  const mmPerCssPx = scale ? positive(scale['mmPerCssPx']) : null;
  const source = SCALE_SOURCES.find((s) => s === scale?.['source']) ?? 'diagonal';
  const diagonalMm = scale ? positive(scale['diagonalMm']) : null;
  const hardwareKind = candidate['hardwareKind'];
  const steps = candidate['completedSteps'];

  return {
    schemaVersion: 1,
    rigName: rigName.trim(),
    hardwareKind:
      typeof hardwareKind === 'string' && hardwareKind in OPTICAL_HARDWARE
        ? (hardwareKind as OpticalHardwareKind)
        : base.hardwareKind,
    scale:
      mmPerCssPx === null
        ? null
        : { mmPerCssPx, source, ...(diagonalMm === null ? {} : { diagonalMm }) },
    viewingDistanceMm: positive(candidate['viewingDistanceMm']),
    safeArea: {
      top: finite(safeArea['top'], base.safeArea.top),
      right: finite(safeArea['right'], base.safeArea.right),
      bottom: finite(safeArea['bottom'], base.safeArea.bottom),
      left: finite(safeArea['left'], base.safeArea.left),
    },
    lens: { x: finite(lens['x'], base.lens.x), y: finite(lens['y'], base.lens.y) },
    flips: { horizontal: flips['horizontal'] === true, vertical: flips['vertical'] === true },
    framing: FRAMING_PRESETS.find((f) => f === candidate['framing']) ?? base.framing,
    bias: finite(candidate['bias'], base.bias),
    overrides: normalizeOpticalOverrides(candidate['overrides']),
    intensity: TEXT_INTENSITIES.find((i) => i === candidate['intensity']) ?? base.intensity,
    readingCue: READING_CUES.find((c) => c === candidate['readingCue']) ?? base.readingCue,
    // Against the declared list, not merely "is a string": the wizard decides
    // what it still has to ask by what is missing from here, so a step name it
    // does not recognise is a step it can neither show as done nor offer.
    completedSteps: Array.isArray(steps)
      ? CALIBRATION_STEPS.filter((step) => steps.includes(step))
      : [],
  };
}

/**
 * The keys an operator can pin, enumerated rather than copied wholesale.
 *
 * `ResolvedOptics.overriddenFields` is what the UI reads to mark a control "set
 * by you" and offer a reset to automatic, so an entry that reaches the resolver
 * under a name no control owns is an override nobody can find and nobody can
 * undo — the exact trap the override block's own doc says it must not become.
 * Copying the stored object through would let a renamed or hand-typed key do
 * that; naming them here means an override can only ever be one a screen has.
 */
const OVERRIDE_KEYS: readonly (keyof OpticalOverrides)[] = [
  'fontSizePx',
  'arcminutes',
  'characters',
  'columnCh',
  'maxColumnFraction',
  'lineHeight',
  'fontWeight',
  'letterSpacingEm',
  'paragraphSpacingEm',
  'deadZoneLines',
  'topFadeLines',
  'bottomFadeLines',
  'futureReserveLines',
  'sentenceMicrogapLines',
  'pastOpacity',
  'futureOpacity',
  'secondaryMinPx',
  'lensOffsetDegrees',
];

/**
 * Every override is a number somebody typed. Anything else is dropped rather
 * than passed on: the resolver decides the RANGE each one is allowed (zero is
 * meaningful for spacing, negative for letter spacing, positive only for
 * sizes), and duplicating those rules here would give one value two sets of
 * limits that could drift apart.
 */
function normalizeOpticalOverrides(candidate: unknown): OpticalOverrides {
  if (!isRecord(candidate)) return {};
  const overrides: Record<string, number> = {};
  for (const key of OVERRIDE_KEYS) {
    const value = candidate[key];
    if (typeof value === 'number' && Number.isFinite(value)) overrides[key] = value;
  }
  return overrides;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Null rather than zero: these fields mean "not measured yet", not "none". */
function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** The percent-scale framing inputs behind a `ListenerGeometry`. */
export interface ListenerFraming {
  placement: ListenerPlacementMode;
  /** Multiplier on the placement's own box; 'background' ignores it. */
  sizePercent: number;
  /** `cropZoom = pack defaultZoom × zoomPercent/100`. */
  zoomPercent: number;
  offsetXPercent: number;
  offsetYPercent: number;
  /** Flips the video only — never the script (see shared/listener/geometry). */
  mirrorVideo: boolean;
}

/**
 * Listener defaults. Declared here rather than in settings-listener.ts so the
 * adapter can import the shape it maps to without a cycle; the adapter owns the
 * defaults, the clamps, and both directions of the mapping.
 */
export interface ListenerSettings {
  /** Pack preselected when `autoplay` is on. `null` = ask every time. */
  defaultPackId: string | null;
  autoplay: boolean;
  /** 0-80. `opacity = 1 - dimPercent/100` on the stage. */
  dimPercent: number;
  /** 0-24 CSS pixels. */
  blurPx: number;
  /** 0-1, the CSS `saturate()` factor the stage applies. */
  saturation: number;
  /**
   * §37.4. Keep the Listener on screen when the stage is blanked. Read by the
   * session when it builds the `blank` directive, where it becomes
   * `keepListener` — the directive stays the single carrier of the decision.
   */
  keepWhenBlanked: boolean;
}

export interface ClearResult {
  kind: string;
  /** Number of entries removed. */
  clearedFiles: number;
  /** Bytes actually reclaimed — a size, not a count (C6). */
  clearedBytes: number;
}

/**
 * `unsupported` is the honest v1 answer: no updater plugin is wired
 * (spec §44.10), so `check_for_update` returns NOT_IMPLEMENTED. It used to be
 * reported as `up_to_date`, which is a claim CandidCue cannot make, and which
 * would have hidden real network/auth failures once an updater shipped (C8).
 */
export interface UpdateCheckResult {
  status: 'up_to_date' | 'available' | 'error' | 'unsupported';
  currentVersion: string;
  availableVersion?: string;
  /** Present on `error`: what actually went wrong. */
  message?: string;
}

/**
 * The uncalibrated stage appearance, in one place.
 *
 * These numbers used to exist twice and disagree: `defaultAppSettings` said a
 * 78% column at 1.32 line height, `buildStageSettings` fell back to 68% at
 * 1.28. Nothing caught it because the two are never compared — the Settings
 * screen shows one and the envelope's fallback only applies to callers that
 * pass no overrides at all (previews, tests, the DOM harness), so the app
 * demonstrated itself with a layout no user could get. Every take now goes
 * through the same numbers, whichever end it enters from.
 *
 * They are a defensible desk-distance guess and a poor universal default,
 * which is exactly what an uncalibrated rig should be told it has: the moment a
 * rig HAS an `OpticalProfile`, `resolveStageGeometry` replaces all of this with
 * a size derived from a measured distance.
 */
export const DEFAULT_STAGE_APPEARANCE = {
  fontFamilyId: 'system-sans',
  fontSizePx: 64,
  lineHeight: 1.32,
  columnWidthPercent: 78,
  readingBandCenterPercent: 38,
} as const;

export function defaultAppSettings(): AppSettings {
  return {
    schemaVersion: 1,
    revision: 1,
    general: {
      launchBehavior: 'library',
      defaultSessionMode: 'voice',
      revisionRetentionDays: 30,
      restoreWindows: true,
      confirmEndSession: true,
      readHeadings: false,
    },
    stage: {
      // Automatic. Pinning a fingerprint on first run would pin whichever
      // panel happened to be attached at install time.
      displayFingerprint: null,
      fullscreen: true,
    },
    inworld: {
      transcriptionModel: 'inworld/inworld-stt-1',
      language: 'en-US',
    },
    audio: {
      followSystemDefault: true,
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
      vadSensitivity: 0.5,
      // Never assume a grant that has not happened: the first take on a
      // machine still asks, which is the one time asking is right.
      microphoneGranted: false,
    },
    teleprompter: {
      fontFamilyId: DEFAULT_STAGE_APPEARANCE.fontFamilyId,
      fontSizePx: DEFAULT_STAGE_APPEARANCE.fontSizePx,
      lineHeight: DEFAULT_STAGE_APPEARANCE.lineHeight,
      mirrorX: false,
      mirrorY: false,
      columnWidthPercent: DEFAULT_STAGE_APPEARANCE.columnWidthPercent,
      readingBandCenterPercent: DEFAULT_STAGE_APPEARANCE.readingBandCenterPercent,
      phraseHighlight: true,
      pastDimming: true,
      textIntensity: 'standard',
      fixedSpeedWpm: 150,
      stageEndBehavior: 'close',
      hidePointer: true,
      stageMode: 'clean',
      readingCue: 'ticks',
    },
    // Nothing calibrated until somebody stands at a rig and measures it.
    optical: { profiles: {}, activeRig: {} },
    following: defaultFollowingSettings(),
    listeners: defaultListenerSettings(),
    listenerFraming: {
      placement: 'background',
      sizePercent: 100,
      zoomPercent: 100,
      offsetXPercent: 0,
      offsetYPercent: 0,
      mirrorVideo: false,
    },
    privacy: {
      diagnosticLogging: false,
      updateChannel: 'stable',
      saveTranscript: 'off',
    },
  };
}
