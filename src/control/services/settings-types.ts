/**
 * Validated application-settings view consumed by the Settings screen
 * (spec §18) and defaults used until `get_settings` lands in Rust.
 */
import {
  BUNDLED_MODEL_NAME,
  OPTICAL_HARDWARE,
  defaultOpticalProfile,
  type FramingPreset,
  type LensPlacement,
  type OpticalCalibrationStep,
  type OpticalHardwareKind,
  type OpticalOverrides,
  type PresentationMode,
  type ReaderFrame,
  type ReadingCueStyle,
  type OpticalProfile,
  type TextIntensity,
} from '../../shared/contracts';
import {
  RIG_PRESETS,
  opticalProfileFieldsForPreset,
} from '../../shared/optical-rig-presets';
import { defaultFollowingSettings, type FollowingSettings } from '../lib/follow-profiles';

export type { FollowFeel, FollowingSettings } from '../lib/follow-profiles';

export type LaunchBehavior = 'library' | 'recent';
export type SessionMode = 'voice' | 'manual' | 'fixed';

/**
 * Re-exported from the contracts, where it lives because `StageSettings` and the
 * stage's own dock both need it and neither may import from control services.
 */
export type { PresentationMode, ReaderFrame };

/**
 * Read a stored `stage` section that may predate `presentationMode`.
 *
 * The retired `fullscreen` boolean never affected a take, so nobody's habits
 * were built on it — but somebody who deliberately turned it OFF was expressing
 * the preference reader mode now actually delivers, and honouring that is
 * cheaper than explaining why it was ignored. An absent or unrecognised value
 * takes `prompter`, which is what every take has always done.
 *
 * Exported and pure so the migration is testable without a settings store.
 */
export function migrateStageMode(stored: unknown): PresentationMode {
  if (typeof stored !== 'object' || stored === null) return 'prompter';
  const section = stored as { presentationMode?: unknown; fullscreen?: unknown };
  if (section.presentationMode === 'reader' || section.presentationMode === 'prompter') {
    return section.presentationMode;
  }
  if (section.fullscreen === false) return 'reader';
  return 'prompter';
}

export interface AppSettings {
  schemaVersion: 1;
  revision: number;
  general: {
    launchBehavior: LaunchBehavior;
    defaultSessionMode: SessionMode;
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
   * Which panel a take belongs to, and how it presents (§14.2 A, §52.7).
   *
   * Its own section rather than a corner of `teleprompter`, because the answer
   * is about a physical panel rather than about type.
   *
   * `displayFingerprint` is where a prompter take opens — Present moves this
   * window onto that panel — as well as which panel the preview, the display
   * test and the optical rigs belong to.
   *
   * ---------------------------------------------------------------------------
   * THE SECTION IS SPLIT DOWN THE MIDDLE, AND THAT IS THE POINT
   * ---------------------------------------------------------------------------
   * This section used to be wholly overlay-backed on the grounds that all of it
   * was per-machine. `displayFingerprint` genuinely is — a fingerprint means
   * nothing on another Mac — and it stays local.
   *
   * `presentationMode` is not. It is a statement about how somebody works, it is
   * the same answer on every machine they own, and losing it to a cleared
   * browser store is exactly the failure this codebase has already documented
   * for the optical rigs. It is Rust-backed now; see `RustSettings` in
   * settings.ts for the mapping and for how an existing overlay value is
   * adopted rather than overwritten on the first read after the move.
   *
   * `readerFrame` is Rust-backed too, for a plainer reason: it has to survive a
   * quit to be worth anything at all.
   */
  stage: {
    /**
     * The panel Settings works against, by `DisplayDescriptor.fingerprint`.
     * `null` means "choose one": an external display when one is connected,
     * otherwise the only display there is.
     *
     * Where a prompter take opens: Present hands it to `set_control_presenting`
     * and Rust moves this window onto that panel before filling it. When it is
     * null, or names a panel that is no longer connected, the take fills the
     * monitor the window is already on instead — and either way the take is
     * calibrated against the panel Rust reports it actually landed on, never
     * against this value. It also selects which panel the preview, the display
     * test and the optical rigs belong to, which is why it is per-machine: a
     * fingerprint means nothing on another Mac.
     *
     * Read directly on ONE other take path, as a last resort: when Rust can
     * name no panel at all, `chooseStageDisplay` falls back to this. That is a
     * guess, and it can be the wrong panel — but it is the guess takes were
     * composed from before any of them were told where they landed.
     */
    displayFingerprint: string | null;
    /**
     * The shape a take presents in (§ reader-mode spec).
     *
     * ----------------------------------------------------------------------
     * THIS REPLACED A BOOLEAN THAT DID NOTHING
     * ----------------------------------------------------------------------
     * There used to be `fullscreen: boolean` here, with a switch in Settings
     * labelled "Full screen". It was read in exactly three places — the stage
     * preview, the display test, and its own toggle — and `lib/start-take.ts`
     * never looked at it once. A real take called `enterPresentation()`
     * unconditionally, so the switch had no effect on any take anybody has ever
     * run.
     *
     * `prompter` is what every take did regardless: borderless, filling the
     * monitor, above the menu bar. `reader` is the mode that boolean looked like
     * it offered — an ordinary window, at desk distance, no mirror and no hood.
     * See `migrateStageMode` for how the old field is read on the way in.
     */
    presentationMode: PresentationMode;
    /**
     * Where a reader-mode take last left its window, or `null` if one never has.
     *
     * Read only when `general.restoreWindows` is on — that toggle shipped with
     * no reader anywhere in the tree, which is the same defect the retired
     * `fullscreen` boolean was culled for, and this is what gives it something
     * to actually govern.
     *
     * Prompter mode has no frame and never writes one: it fills whichever
     * monitor the window is already on, so there is nothing about its geometry
     * that a next launch could restore.
     */
    readerFrame: ReaderFrame | null;
  };
  /**
   * On-device speech-to-text (spec §18.2). There is no API key and no
   * credential store — the recogniser is bundled with the app. What the UI
   * holds is a record of WHICH recogniser heard a take, which is a question a
   * diagnostics bundle has to answer about a session recorded months ago.
   */
  speech: {
    /** The bundled recogniser's name, e.g. `x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05`. */
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
     * section. It no longer gates what is sent — the recogniser endpoints itself
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
    /*
     * No `mirrorX`/`mirrorY`. Mirroring was a global pair here, applied to every
     * panel, and it belongs to the panel with the glass in front of it — it is
     * `optical.panelMirror` now (#206).
     */
    /** Percent of the stage width the script column occupies (§14.2 E). */
    columnWidthPercent: number;
    readingBandCenterPercent: number;
    phraseHighlight: boolean;
    pastDimming: boolean;
    /**
     * Choose where lines break instead of letting the browser fill each line.
     *
     * On by default and expected to stay on. A browser breaks at the last word
     * that fits, which is right for prose somebody reads silently and wrong for
     * a prompter: a line that ends on "the", on "will", or halfway through
     * "South Africa" costs the presenter a recovery at the return sweep that
     * the viewer can hear.
     *
     * The control exists because a presenter who dislikes what it does should
     * not have to live with it, not because it is expected to be turned off.
     * Off is exactly the old behaviour — the planner is skipped and the browser
     * wraps — so it is also the fastest way to tell whether a layout complaint
     * is about the breaker at all.
     */
    semanticLineBreaks: boolean;
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
    /**
     * Diagnostic Take when true, Clean Take when false (#300).
     *
     * `stageSettingsFromSettings` turns it into `StageSettings.stageMode`, which
     * draws the alignment readout and the raw transcript on the glass and
     * renders reference blocks in full rather than as take cues. Settings ›
     * Teleprompter is its writer.
     *
     * A boolean under a new name rather than the `stageMode` this replaced. The
     * store saves a whole section at a time, so every profile that ever changed
     * a teleprompter setting stored the old `'diagnostic'` default alongside it
     * — a value nobody chose, indistinguishable from one somebody did. Ignoring
     * that key and starting a fresh one is the only way the new default reaches
     * those profiles; see `withoutRetiredTeleprompterKeys`.
     */
    diagnosticTake: boolean;
    /** What marks the reading position: fixed side ticks, a soft wash, or nothing. */
    readingCue: ReadingCueStyle;
    /**
     * Larger type, or more of the sentence — on a panel that cannot have both.
     *
     * The same single control a calibrated rig carries as `bias` (0 is "more
     * text on screen", 1 is "larger, easier text"), for the panels running on
     * the AUTOMATIC profile, which is most of them: automatic sizing is
     * derived fresh from the landed panel on every take and so has nowhere of
     * its own to keep a preference.
     *
     * It is here beside `textIntensity` and `readingCue` because it is the
     * same kind of thing they are — something the presenter prefers, not
     * something anybody measured — and those two already travel to the
     * automatic profile through `AutomaticProfileSeed` for exactly this
     * reason. Without it the slider existed but could only be reached by
     * storing a rig, so a presenter who simply wanted a wider line had to
     * freeze discovery's ESTIMATED viewing distance into a saved calibration
     * to get one, and lost automatic sizing to ask a question about type.
     *
     * A stored rig still ignores this: it carries its own `bias`, chosen at
     * the glass, and a loose preference must not reach around a measurement.
     */
    sizeBias: number;
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
   * Rust owns it once adopted: the `optical` section of the settings
   * document (`settings::OpticalSettings`), revisioned and included in an
   * export. Until that adoption succeeds the legacy localStorage overlay still
   * supplies the values — see `opticalAwaitingAdoption` and, for mirroring,
   * `panelMirrorAwaitingAdoption` in services/settings.ts. There is no third
   * store: the `display_profiles` rows that once claimed to back this up had
   * no writer and were dropped (#232).
   */
  optical: OpticalSettings;
  /**
   * Smooth-following controls (companion §47). Values are understandable
   * choices; they resolve to a versioned `SmoothFollowProfile` through
   * `lib/follow-profiles.ts` rather than exposing control-system parameters.
   */
  following: FollowingSettings;
  /*
   * No `privacy` section. #180 took `diagnosticLogging` and `updateChannel` out
   * of it — neither was ever read, so both were a stored preference that
   * decided nothing behind a control that implied otherwise. #215 took the last
   * field, `saveTranscript`: takes stopped writing transcripts (#214), so the
   * retention window had nothing left to keep, and Rust dropped
   * `general.saveTranscript` with that storage (#217). A `privacy` section
   * still sitting in the localStorage overlay is ignored.
   *
   * If a privacy setting genuinely ships, it comes back Rust-owned, and must
   * NOT adopt whatever stale value that overlay still holds.
   */
}

/* ---------------------------------------------------------------------------
 * The optical section
 * ------------------------------------------------------------------------- */

export interface OpticalSettings {
  /** Every calibrated rig, keyed by `opticalRigKey(fingerprint, rigName)`. */
  profiles: Record<string, OpticalProfile>;
  /** The rig in force on each panel: display fingerprint → rig name. */
  activeRig: Record<string, string>;
  /**
   * How a prompter take on each panel is mirrored: display fingerprint → axes.
   *
   * Per PANEL, because the glass is in front of one panel and not the others.
   * This used to be a single `teleprompter.mirrorX/mirrorY` pair for every
   * display, so a take that fell back to the laptop with the Elgato unplugged
   * read backwards, and calibrating a desk rig switched the glass rig's mirror
   * off (#206). A panel with no entry is not mirrored — see `panelMirrorFor`.
   *
   * Beside the rigs rather than inside one, because an automatic panel has no
   * stored rig to carry it, and the mirror is in force whichever rig is.
   */
  panelMirror: Record<string, PanelMirror>;
}

/** The two mirror axes of one panel. */
export interface PanelMirror {
  horizontal: boolean;
  vertical: boolean;
}

/**
 * How a prompter take on this panel is mirrored.
 *
 * Unmirrored for a panel nobody has said anything about, and for one that
 * cannot be named. That is the whole fix for the fallback case: a take that
 * lands on the laptop because the pinned glass is unplugged finds the
 * laptop's own answer — or none — rather than inheriting the glass's.
 *
 * Read defensively because the section is rebuilt from stored JSON, and a
 * mirror that turns on because an entry was malformed is backwards text.
 */
export function panelMirrorFor(
  optical: OpticalSettings,
  displayFingerprint: string | null | undefined,
): PanelMirror {
  if (displayFingerprint === null || displayFingerprint === undefined || displayFingerprint === '') {
    return { horizontal: false, vertical: false };
  }
  const entry = (optical.panelMirror as Record<string, Partial<PanelMirror>> | undefined)?.[
    displayFingerprint
  ];
  return { horizontal: entry?.horizontal === true, vertical: entry?.vertical === true };
}

/**
 * Set one panel's mirroring and leave every other panel's alone.
 *
 * Returns the WHOLE section, rigs included, and callers write it whole: an
 * optical write takes ownership of the section in Rust (`toRustPatch` stamps
 * `migrated`), so a patch carrying only this map could strand rigs that are
 * still waiting in the legacy overlay.
 */
export function withPanelMirror(
  optical: OpticalSettings,
  displayFingerprint: string,
  mirror: PanelMirror,
): OpticalSettings {
  return {
    ...optical,
    panelMirror: {
      ...optical.panelMirror,
      [displayFingerprint]: { horizontal: mirror.horizontal, vertical: mirror.vertical },
    },
  };
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
 * The rig name a reading window uses on every panel.
 *
 * A reserved name rather than a separate map, so a reader profile is stored,
 * listed, normalized, edited and deleted by exactly the machinery every other
 * rig already goes through — `opticalRigKey` keys it, `normalizeOpticalProfile`
 * validates it, the rig picker can show it. The alternative was a second
 * `Record<string, OpticalProfile>` beside `profiles` with its own copy of all of
 * that, which is how the two would eventually disagree about what a valid
 * profile is.
 *
 * It is only reserved by convention: somebody could name a prompter rig this and
 * have it adopted as their reading profile. That is a strange thing to do and a
 * harmless outcome — the profile they get is the one they calibrated.
 */
export const READER_RIG_NAME = 'Reading window';

/**
 * The reading rig for a panel: the stored one if it has been calibrated,
 * otherwise one derived on the spot.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SYNTHESISES AND `activeOpticalProfile` REFUSES TO
 * ---------------------------------------------------------------------------
 * Its prompter sibling returns null rather than adopting the only profile it can
 * find, and the reason is stated there: "a rig has to be chosen before it is
 * used, because adopting a stale arrangement is how the stage ends up sized for a
 * distance the presenter is no longer standing at." Every word of that is about
 * a physical arrangement that CandidCue cannot see — a hood, a mirror, where the
 * camera ended up, how far back the presenter stands.
 *
 * A reading window has none of those. It is a person at their own screen, and the
 * one number that matters — millimetres per CSS pixel — is a property of the
 * display rather than of anything somebody set up. So there is no stale
 * arrangement to inherit and nothing to confirm, and refusing to answer would
 * mean reader mode could not size text until somebody had walked a calibration
 * wizard for a rig that does not exist.
 *
 * The physical scale is borrowed from the panel's PROMPTER profile when there is
 * one, because a ruler held against the glass measured this display and that
 * measurement is better than any model lookup. Everything else comes from the
 * `desk-reading` preset.
 */
/**
 * The physical scale a reading window may borrow from a prompter rig, or null.
 *
 * Exported so the rule is testable on its own: it is a one-line policy about
 * provenance, and provenance is exactly the kind of thing that is easy to get
 * right once and lose in a later refactor. See the call site for why `'ruler'`
 * is excluded.
 */
export function inheritableReaderScale(
  profile: OpticalProfile | null,
): OpticalProfile['scale'] {
  const scale = profile?.scale ?? null;
  if (scale === null) return null;
  return scale.source === 'ruler' ? null : scale;
}

export function readerOpticalProfile(
  optical: OpticalSettings,
  displayFingerprint: string | null,
): OpticalProfile {
  const stored =
    displayFingerprint === null || displayFingerprint === ''
      ? null
      : normalizeOpticalProfile(
          optical.profiles[opticalRigKey(displayFingerprint, READER_RIG_NAME)],
        );
  /*
   * A stored profile is adopted only if it is actually a READING rig.
   *
   * `READER_RIG_NAME` is reserved by convention, and the convention is not
   * enforceable: somebody can name a prompter rig "Reading window" in the
   * calibration wizard and land it on this key. The earlier note here called that
   * "a strange thing to do and a harmless outcome", which was wrong — the profile
   * would arrive with its hood crop, its mirror and its 2.5 m distance, and every
   * one of those is wrong for a window on a desk.
   *
   * `lensPlacement === 'none'` is the discriminator because it is the one field
   * only a reading rig has, and nothing but this function writes it. A collision
   * now falls through to the derived profile, which is the right answer for a
   * reading window whether or not the collision was deliberate.
   */
  if (stored !== null && stored.lensPlacement === 'none') return stored;

  const preset = RIG_PRESETS.find((candidate) => candidate.id === 'desk-reading');
  const base = defaultOpticalProfile();
  return {
    ...base,
    rigName: READER_RIG_NAME,
    ...(preset ? opticalProfileFieldsForPreset(preset) : {}),
    /*
     * The panel's scale, from whatever rig this display has — but only when that
     * scale describes the PANEL rather than an optical path.
     *
     * Only the scale to begin with: `viewingDistanceMm`, `safeArea`, `flips` and
     * the lens are all facts about a hood and a camera, and inheriting any of them
     * would put a beamsplitter's mirror and a hood's crop on a reading window.
     *
     * And not every scale, either. `OpticalScale.source` distinguishes where the
     * number came from, and `'ruler'` is the one that cannot be carried across:
     * its own contract says a ruler measurement describes "the finished optical
     * path" and "silently corrects for anything the hardware table cannot know — a
     * magnifying beamsplitter, an overscanning panel". A reading window has no
     * beamsplitter, so a scale that includes one is wrong by exactly the
     * magnification — a rig measured at 0.25 mm/px through glass whose bare panel
     * is 0.20 would render a reading window about 20% small, confidently, with the
     * profile reporting itself calibrated.
     *
     * `'model'` and `'diagonal'` are both panel-derived (a hardware table and a
     * typed-in diagonal), so both describe the glass a reader is actually looking
     * at and both are safe. A ruler-only rig falls through to the uncalibrated
     * reader default, which is a guess that says it is one.
     */
    scale: inheritableReaderScale(activeOpticalProfile(optical, displayFingerprint)) ?? base.scale,
    /*
     * No `completedSteps`, deliberately.
     *
     * The list records what a person actually confirmed, and nobody has
     * confirmed anything about this profile — it was derived. Claiming otherwise
     * would make the calibration screen show a reading rig as further along than
     * it is, and the whole point of that list is that it does not lie.
     */
  };
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
    // Every other panel's mirroring rides along untouched — see `withPanelMirror`.
    ...optical,
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
  // The panel keeps its mirroring: the glass is still in front of it whether or
  // not a rig is calibrated for it.
  return { ...optical, profiles, activeRig };
}

const FRAMING_PRESETS: readonly FramingPreset[] = [
  'close-up',
  'head-and-shoulders',
  'waist-up',
  'full-body',
];
const TEXT_INTENSITIES: readonly TextIntensity[] = ['soft', 'standard', 'strong'];
const LENS_PLACEMENTS: readonly LensPlacement[] = ['in-panel', 'above', 'below', 'none'];
const READING_CUES: readonly ReadingCueStyle[] = ['ticks', 'wash', 'none'];
const SCALE_SOURCES = ['model', 'diagonal', 'ruler', 'display'] as const;
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
    lensPlacement:
      LENS_PLACEMENTS.find((p) => p === candidate['lensPlacement']) ?? base.lensPlacement,
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
  'readingBandY',
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

export interface ClearResult {
  kind: string;
  /** Number of entries removed. */
  clearedFiles: number;
  /** Bytes actually reclaimed — a size, not a count (C6). */
  clearedBytes: number;
}

/**
 * The result of "Export all data", with the field the old shape lacked.
 *
 * `complete` is not decoration. The previous adapter returned `{ path,
 * cancelled }` and dropped the warnings, so a failed database snapshot was
 * invisible and Settings announced "Export ready" over a folder that could
 * contain no database at all. Rust decides completeness — it is the only place
 * that knows whether every section was written and checksummed — and every
 * caller has to read it to say anything.
 */
export interface DataExportResult {
  cancelled: boolean;
  path?: string;
  /** False when any section failed. The folder is then named `-INCOMPLETE`. */
  complete?: boolean;
  scriptsCopied?: number;
  fileCount?: number;
  totalBytes?: number;
  warnings?: string[];
  /** What the export deliberately leaves out — model files, logs. */
  excluded?: string[];
}

/**
 * The result of SCHEDULING a restore. Nothing has been restored yet.
 *
 * Restoring is two-phase on purpose. The database pool is open on the file a
 * restore replaces, and swapping it underneath does not do what it looks like:
 * on Unix the existing connections keep writing to the renamed inode, and
 * SQLite recreates its journal beside the file that replaced it. So Rust
 * validates the export here — manifest, every checksum, no path escaping the
 * folder, no symlinks — and applies it at the next launch, before any pool
 * exists.
 *
 * `restartRequired` is therefore always true, and the UI has to say so:
 * without it, a successful schedule looks exactly like nothing happening.
 */
export interface RestoreResult {
  cancelled: boolean;
  /** How many scripts the export contains — what WILL be restored. */
  scriptsInExport?: number;
  /** When the export being restored was taken. */
  createdAt?: string;
  /** The CandidCue version that wrote it. */
  appVersion?: string;
  restartRequired?: boolean;
}

/*
 * `UpdateCheckResult` used to be declared here.
 *
 * CandidCue 1.0 updates manually (docs/updates.md), so there is no check to
 * have a result. The type is not "reserved for later": an updater is a feature
 * with signing, endpoint, rollback and privacy work attached, and it should
 * arrive with its own contract rather than find one already waiting.
 */

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
  /*
   * The bundled face, not the system one.
   *
   * `system-sans` was the default for as long as the high-legibility stack was
   * unreachable from the Settings menu, which made it a default by omission
   * rather than by choice. Atkinson Hyperlegible Next ships in the bundle
   * (`src/styles/fonts.css`), renders identically on every machine, needs no
   * network, and disambiguates exactly the characters a prompter loses at
   * distance — I/l/1 and 0/O. On a beamsplitter that is the whole job.
   *
   * WHO THIS ACTUALLY MOVES — and it is more than new profiles.
   *
   * A stored `fontFamilyId` wins: `loadSettings` merges the overlay OVER these
   * defaults, so anyone who has ever chosen a family keeps it. But the overlay
   * only holds fields that were written, so an existing installation that never
   * touched the teleprompter font has nothing stored and DOES move to the
   * bundled face on upgrade. That is deliberate rather than overlooked: the
   * high-legibility stack was unreachable from the picker until now, so nobody
   * on `system-sans` chose it — they were handed it. The change gives them the
   * face the product ships for the job, and the picker (where it now appears
   * first) takes it back in one click.
   *
   * `DEFAULT_STAGE_APPEARANCE` is also the fallback for any caller that omits
   * `fontFamilyId` — previews, tests, `buildStageSettings` with no overrides —
   * so this is the single answer to "what face, when nobody said".
   */
  fontFamilyId: 'high-legibility',
  fontSizePx: 64,
  lineHeight: 1.32,
  columnWidthPercent: 78,
  readingBandCenterPercent: 38,
} as const;

/**
 * The auto-scroll pace a take falls back to when nobody has set one.
 *
 * 130, because that is what RUST hands out, and Rust is what a real install
 * actually loads: `fixed_speed_wpm: 130` in `src-tauri/src/settings/mod.rs`, and
 * `fromRustDocument` maps `stageBehavior.fixedSpeedWpm` straight over whatever
 * this file said. The literal here used to be 150 — a number no packaged build
 * has ever started at, because Rust's value always overwrote it before anybody
 * saw it.
 *
 * That was harmless while nothing read it, and stops being harmless the moment
 * Settings offers to restore it: a fresh install would open on Rust's 130,
 * label it "Set by you", and offer to "reset" it to a 150 the user never chose.
 * That is precisely the defect #124 exists to remove — a control describing a
 * state the app is not in — so the two sides are made to agree rather than the
 * disagreement being papered over in the UI.
 *
 * Still deliberately NOT the two similarly-named constants elsewhere:
 *
 *   - `shared/speaking-rate.ts`'s `DEFAULT_WORDS_PER_MINUTE` is a SPEAKING
 *     rate, for estimating how long a script takes to read aloud. Different
 *     question entirely, though it is also 130 today.
 *   - `stage/renderer/autoscroll.ts`'s `AUTO_SCROLL_DEFAULT_WPM` is the
 *     renderer's repair for a value that arrived missing or invalid, not a
 *     preference. It agrees at 130 today, and does not have to.
 *
 * If Rust's default moves, this must move with it — `stage-appearance.test.ts`
 * pins them together so the disagreement cannot come back silently.
 */
export const DEFAULT_TELEPROMPTER_FIXED_SPEED_WPM = 130;

export function defaultAppSettings(): AppSettings {
  return {
    schemaVersion: 1,
    revision: 1,
    general: {
      launchBehavior: 'library',
      defaultSessionMode: 'voice',
      restoreWindows: true,
      confirmEndSession: true,
      readHeadings: false,
    },
    stage: {
      // Automatic. Pinning a fingerprint on first run would pin whichever
      // panel happened to be attached at install time.
      displayFingerprint: null,
      // What every take has always done. Reader mode is a deliberate choice, not
      // something a first run should discover by surprise on a laptop with one
      // display — and the calibration a good prompter take needs is the same
      // calibration the Welcome flow already walks somebody through.
      presentationMode: 'prompter',
      // Nothing to restore until a reading window has actually been left
      // somewhere.
      readerFrame: null,
    },
    speech: {
      // One literal, in `shared/contracts/audio.ts`, asserted by a Rust test to
      // equal the id of `cc_stt::models::default_model()` — re-exported as
      // `crate::speech::default_model` — which is in turn asserted equal to the
      // fetch catalogue's default. Rust re-derives this on every settings read,
      // so a stale value is corrected before a take, but it is also what the
      // browser mock and the offline fallback show, and a default that names the
      // wrong recogniser is a lie in the one place nothing corrects it.
      transcriptionModel: BUNDLED_MODEL_NAME,
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
      columnWidthPercent: DEFAULT_STAGE_APPEARANCE.columnWidthPercent,
      readingBandCenterPercent: DEFAULT_STAGE_APPEARANCE.readingBandCenterPercent,
      phraseHighlight: true,
      pastDimming: true,
      semanticLineBreaks: true,
      textIntensity: 'standard',
      fixedSpeedWpm: DEFAULT_TELEPROMPTER_FIXED_SPEED_WPM,
      /*
       * Clean, not Diagnostic (#300).
       *
       * Diagnostic used to be the default, so that the transcript bar and the
       * `feed:` line could tell a microphone that was never captured from a
       * recogniser that heard nothing, an aligner that would not match, and a
       * stage discarding what it is sent. The presenter no longer needs them for
       * that: a named fault, "Not hearing you", "Holding here" and "Following
       * off" reach the mirrored hold chip in either mode. What was left was a
       * first take that looked like a debug build, with moving text beside the
       * script. The instruments are one switch away for whoever is validating a
       * rig or chasing a script that will not follow.
       */
      diagnosticTake: false,
      readingCue: 'ticks',
      // The same value a fresh rig starts at, so turning the automatic profile
      // into a calibrated one changes nothing about the type by itself.
      sizeBias: defaultOpticalProfile().bias,
    },
    // Nothing calibrated until somebody stands at a rig and measures it.
    optical: { profiles: {}, activeRig: {}, panelMirror: {} },
    following: defaultFollowingSettings(),
  };
}
