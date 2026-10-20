/**
 * Application settings + maintenance service (spec §46.8).
 *
 * Rust owns the persisted settings document as `Revisioned<AppSettings>`
 * ({ revision, value }) with the §47.9 schema (general / stageBehavior /
 * audio / following / optical). The control UI consumes the
 * flatter view in `settings-types.ts`, so this service is an explicit
 * adapter:
 *
 *  - fields with a Rust home are mapped bidirectionally (wake phrase, prompt
 *    mode, models, mirror, fixed speed, …);
 *  - UI-only presentation fields (per-display appearance, audio processing
 *    toggles, …) persist in a local overlay (localStorage) — they are
 *    frontend state, not the Rust document.
 */
import { ipcInvoke, isTauriRuntime, BackendUnavailableError } from './ipc';
import { mockSettings } from './mock-backend';
import {
  audioToRustPatch,
  vadSensitivityFromRust,
  RUST_OWNED_AUDIO_KEYS,
  type RustAudioSettings,
} from './settings-audio';
import {
  followingFromRust,
  followingToRustPatch,
  type RustFollowingSettings,
} from './settings-following';
import {
  activeOpticalProfile,
  defaultAppSettings,
  migrateStageMode,
  normalizeOpticalProfile,
  opticalRigKey,
  type AppSettings,
  type ClearResult,
  type OpticalSettings,
  type PanelMirror,
  type PresentationMode,
  type ReaderFrame,
  type SessionMode,
  type DataExportResult,
  type RestoreResult,
} from './settings-types';
import { DEV_APP_VERSION } from '../../shared/version';

/* ---------------------------------------------------------------------------
 * Rust settings twins (src-tauri/src/settings/mod.rs, camelCase over IPC)
 * ------------------------------------------------------------------------- */

interface RustSettings {
  schemaVersion: number;
  general: {
    openTo: string;
    /**
     * "Check for updates automatically". Absent in every document written
     * before the switch existed, which Rust reads as on — and so does this.
     */
    checkForUpdates?: boolean;
    /*
     * No `updateCheck`, the retired string. serde ignores it on documents
     * already on disk; `checkForUpdates` is a different key on purpose.
     */
    /*
     * No `saveTranscript` either. Takes stopped writing transcripts (#214) and
     * Rust dropped the field with the storage it governed (#217). Documents
     * written before that still carry it; serde ignores it there too.
     */
    /*
     * Nor `autosaveDebounceMs`, `revisionIntervalMinutes`,
     * `wordsPerMinuteEstimate` or `analyticsEnabled` (#219): nothing on either
     * side read them. The editor debounces on its own constant, revisions are
     * spaced by Rust's, and a script's length is estimated at its OWN rate
     * (`ScriptSettings.wordsPerMinuteEstimate`, which stays).
     */
  };
  /*
   * No `editor` section (#219). It was typed `Record<string, unknown>` here
   * because nothing ever looked inside it.
   */
  stageBehavior: {
    promptMode: string;
    fixedSpeedWpm: number;
    /*
     * No `manualWheelMultiplier`, `pointerHideDelaySeconds`,
     * `manualMoveTrackingGraceSeconds`, `stageAcknowledgement`,
     * `keepScreenAwake` or `blankColor` (#219), none of which anything read.
     * The stage hides the pointer after a fixed 1.5 s and keeps the display
     * awake for every take, whatever the document said.
     */
    /**
     * The retired global mirror (#206), read once and never written again.
     *
     * Mirroring is per panel now (`optical.panelMirror`). This field is only the
     * SOURCE of the one-time move onto the glass — see `carriedPanelMirror`.
     */
    horizontalMirror: boolean;
    /**
     * The shape a take opens in — `null`/absent when it has never been chosen.
     *
     * The nullability is the whole migration. This setting used to live only in
     * the localStorage overlay, so every document written before the move has no
     * value here, and a plain default of `'prompter'` would read as a positive
     * claim and overwrite the preference somebody already expressed. Absent
     * instead means "ask the overlay" — see `presentationModeFromRust`.
     */
    presentationMode?: string | null;
    /** Where a reading window was last left; absent until one has been. */
    readerFrame?: unknown;
    /**
     * The pinned prompter panel (#272) — absent when nothing is pinned, AND in
     * every document written before the pin moved out of the overlay. The flag
     * below is what tells those two apart; see `displayPinAwaitingAdoption`.
     */
    displayFingerprint?: string | null;
    /** Has this document taken ownership of the pin? Absent reads as no. */
    displayPinMigrated?: boolean;
  };
  /**
   * §28.3/§28.4. `vadSensitivity` is the only field here the UI owns a slider
   * for; the model and locale are what the Rust session's config frame is
   * built from. See settings-audio.ts.
   */
  audio: Partial<RustAudioSettings> & { transcriptionModel: string; language: string };
  /** Companion §47 — absent in documents written before the section existed. */
  following?: Partial<RustFollowingSettings>;
  /**
   * §52 calibrated rigs. Absent in documents written before the section
   * existed, which is exactly the state the one-time overlay migration below
   * looks for — see `opticalAwaitingAdoption`.
   */
  optical?: {
    /** Has this document taken ownership of the calibrations? */
    migrated?: boolean;
    profiles?: Record<string, unknown>;
    activeRig?: Record<string, unknown>;
    /**
     * Per-panel mirroring (#206). `null`/absent means NEVER WRITTEN, which is
     * what the one-time move of the old global switch looks for — an empty map
     * is an operator who switched every mirror off.
     */
    panelMirror?: Record<string, unknown> | null;
  };
}

interface RustRevisioned {
  revision: number;
  value: RustSettings;
}

/** Mirror of `backup::DataExportResult`. */
interface RustExportResult {
  path: string;
  complete: boolean;
  scriptsCopied: number;
  fileCount: number;
  totalBytes: number;
  warnings: string[];
  excluded: string[];
}

/** Mirror of `backup::RestoreResult`. */
interface RustRestoreResult {
  path: string;
  appVersion: string;
  createdAt: string;
  scriptsInExport: number;
  restartRequired: boolean;
}

/**
 * Exported so another WINDOW can watch it.
 *
 * The overlaid fields — stage font and stage type size — never reach Rust, so
 * `settings://changed` says nothing about them and a second window would go on
 * showing the value it read at launch.
 *
 * The presentation mode is NOT one of them any more, and this comment used to
 * say it was: `toRustPatch` maps it and `adoptStageModeFromOverlay` writes an
 * old overlay value through to the document precisely so it stops being local.
 * What remains in the overlay for that field is a fallback for an upgrading
 * reader, not the source of truth.
 * `localStorage` raises a `storage` event in the OTHER documents of the origin
 * when this key moves, and that is the only signal there is. See
 * `installOverlaySync` in `services/settings-sync.ts`.
 */
export const SETTINGS_OVERLAY_KEY = 'candidcue.settings-overlay.v1';
const OVERLAY_KEY = SETTINGS_OVERLAY_KEY;

type Overlay = Partial<{
  [K in keyof AppSettings]: Partial<AppSettings[K]>;
}>;

/**
 * Read the local overlay, treating anything that is not a plain object of plain
 * objects as absent.
 *
 * `JSON.parse` succeeds on `null`, on `[]` and on `"nonsense"`, and the old
 * cast believed all three. A stored literal `null` then reached
 * `overlay.general` in `fromRust` and threw on a property read — during
 * `loadSettings`, which runs before the first route is chosen, so a single
 * corrupt localStorage value took the whole window down at launch with no way
 * to reach the screen that could clear it.
 *
 * Sections are checked but their FIELDS are not: a wrong-typed field is a
 * narrower problem, and it is worth handling where the value is used rather
 * than by inventing a schema for a store the app writes itself.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadOverlay(): Overlay {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(OVERLAY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return {};
    const overlay: Record<string, unknown> = {};
    for (const [key, section] of Object.entries(parsed)) {
      if (isPlainObject(section)) overlay[key] = section;
    }
    return overlay as Overlay;
  } catch {
    return {};
  }
}

/**
 * Did the last overlay write fail, and why?
 *
 * The write used to be wrapped in a bare `catch {}` with a comment saying the
 * fields "fall back to defaults next launch" — which is true, and is not
 * something the user was ever told. A quota-exceeded or disabled-storage error
 * meant every per-machine preference silently reverted at the next launch, over
 * and over, with the settings screen reporting success each time.
 *
 * What is left in the overlay after the §52 move is presentation and
 * per-machine capture state, not measured data: the calibrated rigs, the
 * following profile and the speech selection are all Rust-owned now. So a
 * failure here is worth SAYING and not worth refusing a settings change over —
 * the authoritative half already committed by the time this runs.
 */
let lastOverlayFailure: string | null = null;

export function overlayStorageFailure(): string | null {
  return lastOverlayFailure;
}

function saveOverlay(overlay: Overlay): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
    lastOverlayFailure = null;
  } catch (err) {
    lastOverlayFailure = err instanceof Error ? err.message : String(err);
  }
}

function mergeSection<T extends object>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return base;
  return { ...base, ...patch };
}

/**
 * The optical section, with every stored rig re-validated on the way in.
 *
 * `mergeSection` is enough for a section of scalars, and is not enough for this
 * one: `profiles` is a map of documents that `resolveStageGeometry` walks two
 * levels into, and `loadOverlay` deliberately validates sections rather than
 * fields. A rig that no longer normalizes is DROPPED rather than repaired —
 * see `normalizeOpticalProfile` — and the panel's choice of it goes with it, so
 * the two maps can never disagree about which arrangements exist. A rig picker
 * that lists a calibration the resolver would refuse is worse than an empty
 * one: the presenter believes a distance is saved and stops re-measuring it.
 */
function opticalFromStored(
  base: OpticalSettings,
  patch: Partial<OpticalSettings> | undefined,
): OpticalSettings {
  const merged = mergeSection(base, patch);
  const profiles: OpticalSettings['profiles'] = {};
  for (const [key, stored] of Object.entries(merged.profiles ?? {})) {
    const profile = normalizeOpticalProfile(stored);
    if (profile !== null) profiles[key] = profile;
  }
  const activeRig: OpticalSettings['activeRig'] = {};
  for (const [fingerprint, rigName] of Object.entries(merged.activeRig ?? {})) {
    if (typeof rigName !== 'string') continue;
    if (profiles[opticalRigKey(fingerprint, rigName)]) activeRig[fingerprint] = rigName;
  }
  return { profiles, activeRig, panelMirror: panelMirrorFromStored(merged.panelMirror) };
}

/**
 * Per-panel mirroring, rebuilt from stored JSON one entry at a time.
 *
 * An axis is on only when it is literally `true`. Anything else — a missing
 * axis, a string, an entry that is not an object — reads as unmirrored, because
 * a mirror switched on by a malformed value is backwards text on the glass.
 */
function panelMirrorFromStored(stored: unknown): OpticalSettings['panelMirror'] {
  const panelMirror: OpticalSettings['panelMirror'] = {};
  if (!isPlainObject(stored)) return panelMirror;
  for (const [fingerprint, entry] of Object.entries(stored)) {
    if (fingerprint === '' || !isPlainObject(entry)) continue;
    panelMirror[fingerprint] = {
      horizontal: entry['horizontal'] === true,
      vertical: entry['vertical'] === true,
    };
  }
  return panelMirror;
}

/**
 * Overlay keys behind Settings rows that changed nothing (#218).
 *
 * Revision retention pruned nothing — revisions are kept however long the
 * slider said. Nothing read the end-of-session choice. And the stage hides the
 * pointer after a fixed 1.5 s whether the switch was on or off. The rows are
 * gone, but every overlay that ever saved one of these sections still holds
 * them, and `mergeSection` would spread them back onto a section whose type no
 * longer has them. They are dropped on read, and from the stored section the
 * next time that section is written.
 */
const RETIRED_GENERAL_ROWS = ['revisionRetentionDays'] as const;
const RETIRED_TELEPROMPTER_ROWS = ['stageEndBehavior', 'hidePointer'] as const;

/** The general section without the retired retention window (#218). */
function withoutRetiredGeneralKeys<T extends object>(section: T): T {
  const copy = { ...section } as Record<string, unknown>;
  for (const key of RETIRED_GENERAL_ROWS) delete copy[key];
  return copy as T;
}

/**
 * The teleprompter section without the retired global mirror (#206), the
 * retired `stageMode` (#300), or the rows that changed nothing (#218).
 *
 * Every overlay that ever held the old switches still carries `mirrorX` and
 * `mirrorY`, and `mergeSection` would spread them straight back onto a section
 * whose type no longer has them — a value nothing should read, sitting where
 * anything that spreads the section would pass it on.
 *
 * `stageMode` is the same, and it matters more: it was never anybody's choice.
 * No control ever wrote it, and the store saves whole sections, so the
 * `'diagnostic'` default rode into the overlay on any teleprompter change at
 * all. Honouring it would keep those profiles in Diagnostic Take after the
 * default moved. `diagnosticTake` is the field a choice is recorded in.
 */
function withoutRetiredTeleprompterKeys<T extends object>(section: T): T {
  const copy = { ...section } as Record<string, unknown>;
  delete copy['mirrorX'];
  delete copy['mirrorY'];
  delete copy['stageMode'];
  for (const key of RETIRED_TELEPROMPTER_ROWS) delete copy[key];
  return copy as T;
}

/**
 * Per-panel mirroring worked out from what an install held before it existed
 * (#206).
 *
 * The old switch applied to every panel, and only some of them have glass in
 * front of them. Carrying it onto all of them would keep the bug; carrying it
 * onto none would turn an upgrading operator's glass takes round. So each
 * panel gets an answer only where there is positive evidence about it:
 *
 *   - every panel whose rig in force RECORDS a flip gets that rig's own flips.
 *     Somebody stood at that glass and told the wizard how it reverses, and
 *     the record survives even where the global does not — calibrating a desk
 *     rig afterwards switched the global off and left the glass rig's record
 *     alone, which is the second half of the issue, undone here for every
 *     panel the pin does not speak for;
 *   - the PINNED panel gets the old switch, on or off. Present sends a
 *     prompter take there, so the switch is what that panel's takes actually
 *     rendered, and that wins over an older rig record: an operator who
 *     switched the mirror off for their pinned rig is not overruled by a
 *     calibration they made before.
 *
 * NOT the primary display, and not "every connected panel": the primary is the
 * desk or laptop screen on the rig this is about, which is exactly the panel
 * the issue found reading backwards. A glass panel that is neither pinned nor
 * calibrated cannot be told from a desk monitor here, and it is left alone
 * rather than guessed — see `panelMirrorAwaitingAdoption` for why that does
 * not lose the old switch for good.
 */
function carriedPanelMirror(
  optical: OpticalSettings,
  pinned: unknown,
  legacy: PanelMirror,
): OpticalSettings['panelMirror'] {
  const carried: OpticalSettings['panelMirror'] = {};
  for (const fingerprint of Object.keys(optical.activeRig)) {
    const flips = activeOpticalProfile(optical, fingerprint)?.flips;
    if (flips && (flips.horizontal || flips.vertical)) {
      carried[fingerprint] = { horizontal: flips.horizontal, vertical: flips.vertical };
    }
  }
  if (typeof pinned === 'string' && pinned !== '') {
    if (legacy.horizontal || legacy.vertical) carried[pinned] = { ...legacy };
    // An unmirrored panel needs no entry — absent already reads that way.
    else delete carried[pinned];
  }
  return carried;
}

/**
 * The mode the persisted document holds, or the overlay's answer while it has
 * never held one.
 *
 * This is the whole of the move out of localStorage. Rust is the authority the
 * moment it has anything to say; until then the local overlay is read exactly as
 * it was before — including its own migration off the retired `fullscreen`
 * boolean — so somebody who chose reader mode last week still opens in reader
 * mode after the upgrade, and the first explicit choice pins it in Rust for
 * good.
 *
 * A value Rust holds but this build does not recognise falls through to the
 * overlay rather than to a hard-coded default: it means the document was written
 * by a newer build, and the local answer is a better guess than 'prompter'.
 */
function presentationModeFromRust(
  stageBehavior: RustSettings['stageBehavior'],
  storedStage: unknown,
): PresentationMode {
  const persisted = stageBehavior.presentationMode;
  if (persisted === 'prompter' || persisted === 'reader') return persisted;
  return migrateStageMode(storedStage);
}

/**
 * Did the local overlay actually express a preference, as opposed to simply
 * having nothing to say?
 *
 * `migrateStageMode` answers `prompter` for both, because it has to return a
 * mode. This is the question the migration needs instead: there is only
 * something to carry into Rust if somebody once chose something.
 */
function overlayStatedAMode(stored: unknown): boolean {
  if (!isPlainObject(stored)) return false;
  const mode = stored['presentationMode'];
  return mode === 'reader' || mode === 'prompter' || typeof stored['fullscreen'] === 'boolean';
}

/**
 * Does the legacy overlay actually hold a calibration to move?
 *
 * The same question `overlayStatedAMode` asks for the presentation mode, and it
 * was missing here — so a fresh install with nothing to migrate still flagged an
 * adoption, wrote an empty `optical` section on its first launch purely to plant
 * the marker, and could raise "CandidCue could not move your saved teleprompter
 * calibrations into permanent storage" at somebody who has never calibrated
 * anything.
 *
 * Nothing is lost by not writing: `updateSettings` stamps `migrated: true` on
 * every optical write, so the first REAL calibration plants the marker itself.
 */
function overlayHoldsRigs(stored: unknown): boolean {
  if (!isPlainObject(stored)) return false;
  const profiles = stored['profiles'];
  return isPlainObject(profiles) && Object.keys(profiles).length > 0;
}

/**
 * The mode that is still only in localStorage, waiting to be written to Rust.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * Reading the overlay as a fallback is only half a migration, and the missing
 * half is the half the move was FOR. A reader who upgrades, presents happily
 * for a month and never opens the split menu leaves Rust holding `None` the
 * whole time — so the day their browser store is cleared they are silently back
 * to prompter, which is the exact failure this change set out to end.
 *
 * So the read records what it found, and `loadSettings` writes it through once.
 * Module state rather than a field on `AppSettings`, because it is a fact about
 * the DOCUMENT that was just read and not a setting anybody can set: putting it
 * in the settings view would invite a screen to render it.
 */
let stageModeAwaitingAdoption: PresentationMode | null = null;

export function pendingStageModeAdoption(): PresentationMode | null {
  return stageModeAwaitingAdoption;
}

/**
 * Calibrated rigs still living only in the overlay, waiting to reach Rust.
 *
 * Exactly the same mechanism as `stageModeAwaitingAdoption`, and it matters
 * more: a presentation mode somebody loses is one menu click to set again, and
 * a viewing distance somebody loses is a tape measure and a room.
 */
let opticalAwaitingAdoption: OpticalSettings | null = null;

export function pendingOpticalAdoption(): OpticalSettings | null {
  return opticalAwaitingAdoption;
}

/**
 * Per-panel mirroring carried over from before it existed, waiting to be
 * written to Rust (#206).
 *
 * The same mechanism again, for the same reason: reading the old switch and
 * the rigs' records as a fallback keeps an upgrading operator's glass takes
 * mirrored, and only a write makes that outlive the fallback. Null when there
 * is nothing to carry. See `carriedPanelMirror` for which panels get what.
 *
 * An install with the old switch on and NO evidence about which panel is the
 * glass — nothing pinned, nothing calibrated with a flip — carries nothing and
 * writes nothing. That leaves the document unowned, so the old switch is still
 * there to be carried the moment a pin or a calibration names the glass. Any
 * optical write takes ownership, including turning a panel's mirror on in
 * Settings, which is the one-click answer for that operator in the meantime.
 */
let panelMirrorAwaitingAdoption: OpticalSettings['panelMirror'] | null = null;

export function pendingPanelMirrorAdoption(): OpticalSettings['panelMirror'] | null {
  return panelMirrorAwaitingAdoption;
}

/**
 * The pinned prompter panel still living only in the overlay, waiting to be
 * written to Rust (#272).
 *
 * The same mechanism as the mode, and since Present started moving the window
 * onto the pin it matters about as much: a lost pin does not show up as a wrong
 * setting, it shows up as the next take filling the desk monitor the operator
 * is working on, borderless and above everything.
 *
 * Unlike the mode, "nothing" is a real answer here — unpinned — and Rust cannot
 * keep it as a value: `merge_json` removes a key whose patch value is null. So
 * the document carries `displayPinMigrated` beside the pin, stamped by
 * `toRustPatch` on every write of it, and that flag rather than the pin's
 * presence is the authority marker. Without it, an operator who unpinned would
 * look exactly like a document from before the move, and the stale overlay pin
 * would be adopted straight back.
 */
let displayPinAwaitingAdoption: string | null = null;

export function pendingDisplayPinAdoption(): string | null {
  return displayPinAwaitingAdoption;
}

/** Mirrors `MAX_DISPLAY_FINGERPRINT_BYTES` in settings/mod.rs. */
const MAX_DISPLAY_FINGERPRINT_BYTES = 256;

/**
 * A stored pin, or null if it is not one Rust would accept.
 *
 * Checked to Rust's rule rather than merely for being a string, because every
 * stage save carries the pin: a value Rust refuses would not fail one write, it
 * would fail every save of the section from then on.
 */
function displayPinFromStored(stored: unknown): string | null {
  if (typeof stored !== 'string' || stored.trim() === '') return null;
  if (new TextEncoder().encode(stored).length > MAX_DISPLAY_FINGERPRINT_BYTES) return null;
  return stored;
}

/**
 * Drop the legacy `optical` section from the overlay.
 *
 * Called by the store once the durable write has SUCCEEDED, and not before.
 * Leaving the legacy copy behind was a real defect rather than untidiness:
 * `applyOverlayPatch` skips `optical`, so nothing else would ever remove it,
 * and it sat there as a second answer waiting for the first to look absent.
 */
export function forgetOverlayOptical(): void {
  const overlay = loadOverlay() as Record<string, unknown>;
  if (!('optical' in overlay)) return;
  delete overlay['optical'];
  saveOverlay(overlay as Overlay);
}

/**
 * A stored reading-window frame, or null if it is not one.
 *
 * Validated field-by-field rather than cast, which `loadOverlay`'s note argues
 * for in general and which matters more here than anywhere else in this file:
 * these four numbers are handed to `set_position`/`set_size`, so a corrupt or
 * half-written frame is not a wrong-looking setting, it is a window somebody
 * cannot see or click. A zero or negative extent is rejected for the same
 * reason. Everything else — a frame on a display that is no longer attached —
 * is Rust's off-screen clamp to deal with, which it already does for every
 * restore.
 */
function readerFrameFromRust(stored: unknown): ReaderFrame | null {
  if (!isPlainObject(stored)) return null;
  const { x, y, width, height } = stored;
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** Rust document + overlay → the UI settings view. */
/**
 * Adapt a revisioned document Rust pushed, rather than one this window read.
 *
 * The `settings://changed` broadcast (§14.1) carries exactly what `get_settings`
 * returns, so the same adapter applies — exported so `stores/settings.ts` can
 * adopt a payload without a second round trip to fetch what it was just handed.
 *
 * Defensive about the SHAPE because this one arrives as an event payload rather
 * than as a typed command result: an event is delivered by evaluating JSON in
 * the webview, and a malformed one must leave the store alone rather than
 * replace a working document with `undefined`s.
 */
/**
 * Rust has been seen holding the migrated value at least once this session.
 *
 * Separate from `stageModeAwaitingAdoption` / `opticalAwaitingAdoption`, which
 * describe the LAST document parsed and are therefore as out of order as the
 * reads that produce them. These only ever move one way. See the note where
 * they are set.
 */
let stageModeMigrated = false;
let opticalMigrated = false;
let panelMirrorMigrated = false;
let displayPinMigrated = false;

/** Test seam: forget that a migrated document was ever seen. */
export function resetMigrationStateForTesting(): void {
  stageModeMigrated = false;
  opticalMigrated = false;
  panelMirrorMigrated = false;
  displayPinMigrated = false;
  stageModeAwaitingAdoption = null;
  opticalAwaitingAdoption = null;
  panelMirrorAwaitingAdoption = null;
  displayPinAwaitingAdoption = null;
}

export function adaptRevisionedSettings(payload: unknown): AppSettings | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as Partial<RustRevisioned>;
  if (typeof candidate.revision !== 'number' || typeof candidate.value !== 'object') return null;
  try {
    return fromRust(candidate as RustRevisioned);
  } catch {
    return null;
  }
}

function fromRust(revisioned: RustRevisioned): AppSettings {
  const rust = revisioned.value;
  const overlay = loadOverlay();
  const defaults = defaultAppSettings();

  const mapped: AppSettings = {
    ...defaults,
    schemaVersion: 1,
    revision: revisioned.revision,
    general: {
      ...defaults.general,
      launchBehavior: rust.general.openTo === 'last_script' ? 'recent' : 'library',
      defaultSessionMode: toSessionMode(rust.stageBehavior.promptMode),
      checkForUpdates: rust.general.checkForUpdates !== false,
    },
    speech: {
      transcriptionModel: rust.audio.transcriptionModel,
      language: rust.audio.language,
    },
    // §28.4. Rust-owned like `following`: it is room tuning that must outlive
    // a cleared browser store, so a stale overlay must not be able to
    // contradict the persisted document.
    audio: {
      ...defaults.audio,
      vadSensitivity: vadSensitivityFromRust(rust.audio),
    },
    teleprompter: {
      ...defaults.teleprompter,
      fixedSpeedWpm: rust.stageBehavior.fixedSpeedWpm,
    },
    // Following settings are Rust-owned end to end (§47) — no overlay merge,
    // so a stale local overlay can never resurrect an old assist mode.
    following: followingFromRust(rust.following),
  };

  /*
   * Resolved once, before the object is built, because two things need it: the
   * settings view below, and the migration flag. See `pendingStageModeAdoption`
   * for why a read has to record what it found.
   */
  const resolvedMode = presentationModeFromRust(rust.stageBehavior, overlay.stage ?? mapped.stage);
  const modeIsPersisted =
    rust.stageBehavior.presentationMode === 'prompter' ||
    rust.stageBehavior.presentationMode === 'reader';
  /*
   * MONOTONIC: once Rust has been seen to hold it, never pending again.
   *
   * Every parsed document writes this flag, and documents do not arrive in the
   * order they were produced — a read that began before the other window's
   * migration can resolve after it, parse a document from before the write,
   * and put the flag back to "pending". The migration then runs a second time
   * and mints a settings revision nobody asked for, broadcast to both windows,
   * for work that was already done.
   *
   * Latching on the RAW AUTHORITY CHECK rather than on this window having
   * performed the write is what makes it hold across windows: `modeIsPersisted`
   * reads Rust's own field, so a document adopted from the other window's
   * broadcast closes it just as a local write does.
   *
   * Not the composed value — `presentationMode` on the composed document falls
   * back to the overlay precisely so an upgrading reader keeps working, so it
   * always equals the pending value and would report the migration as done
   * before it had happened.
   */
  if (modeIsPersisted) stageModeMigrated = true;
  stageModeAwaitingAdoption =
    !stageModeMigrated && overlayStatedAMode(overlay.stage) ? resolvedMode : null;

  /*
   * The pinned panel (#272): Rust once it owns the pin, the overlay until then.
   *
   * Ownership is the flag OR a pin, and the flag is the one that matters — it is
   * how an operator who unpinned stays unpinned when the overlay still holds the
   * old answer (a failed local write, another window, a document restored from
   * a backup). A pin with no flag is a document somebody wrote by hand or an
   * older shape; Rust holding a value is answer enough.
   *
   * The latch governs the fallback as well as the adoption, unlike the mode's:
   * once this window has seen Rust own the pin, the overlay is never an answer
   * again, however stale the document a later read happens to parse.
   */
  const rustPin = displayPinFromStored(rust.stageBehavior.displayFingerprint);
  if (rustPin !== null || rust.stageBehavior.displayPinMigrated === true) {
    displayPinMigrated = true;
  }
  const overlayPin = isPlainObject(overlay.stage)
    ? displayPinFromStored(overlay.stage['displayFingerprint'])
    : null;
  const resolvedPin = rustPin ?? (displayPinMigrated ? null : overlayPin);
  displayPinAwaitingAdoption = displayPinMigrated ? null : overlayPin;

  /*
   * Calibrated rigs: Rust the moment it has any, the overlay until then.
   *
   * The same shape as the presentation-mode migration above, and for the same
   * reason. Reading the overlay as a fallback is only half a move: somebody
   * who calibrated a rig last month and has not opened Calibrate since would
   * leave Rust holding nothing, so the day their WebView store is cleared the
   * measurement is gone — which is precisely the failure the move is for.
   *
   * So the read RECORDS what it found and `loadSettings` writes it through
   * once. `profiles` is the test rather than `activeRig`: a document can
   * legitimately have rigs and no active selection, but an active selection
   * with no rigs is not a calibration anyone made.
   */
  /*
   * The AUTHORITY MARKER, not "does Rust hold any rigs?".
   *
   * The first version tested `profiles` for emptiness, which has a nasty
   * failure: delete your last calibration, and the document looks unmigrated
   * again — so the stale overlay copy becomes authoritative, the rig you just
   * deleted comes back, and the migration re-adopts it. A calibration
   * returning from the dead is worse than one that was never saved: the picker
   * offers a measurement of a room the presenter has left.
   */
  const rustOwnsOptical = rust.optical?.migrated === true;
  /* Monotonic, for the same reason as the mode above. */
  if (rustOwnsOptical) opticalMigrated = true;
  const storedOptical = rustOwnsOptical
    ? opticalFromStored(defaults.optical, rust.optical as Partial<OpticalSettings>)
    : opticalFromStored(defaults.optical, overlay.optical);

  /*
   * Per-panel mirroring (#206): Rust's map the moment it has written one, and
   * until then the retired global switch carried onto the glass.
   *
   * PRESENCE of the map is the authority marker, not its contents — an empty
   * map is somebody who switched every panel's mirror off, and reading it as
   * "not migrated yet" would put the old global straight back on the glass at
   * the next launch. Rust keeps `None` and `{}` apart for exactly this.
   *
   * The horizontal switch is the DOCUMENT's, never the overlay's copy (#271).
   * `mirrorX` used to round-trip through both, so the two agree for anybody
   * whose saves succeeded — and where they disagree, it is because the
   * document changed without the overlay, which is exactly what Settings ›
   * Data › Restore does. Reading the overlay there carried the pre-restore
   * mirror onto the glass of a restored install. `mirrorY` never reached Rust
   * at all, so the overlay is the only record of it and is still read.
   */
  const rustOwnsPanelMirror = isPlainObject(rust.optical?.panelMirror);
  /* Monotonic, for the same reason as the mode above. */
  if (rustOwnsPanelMirror) panelMirrorMigrated = true;
  const overlayTeleprompter: Record<string, unknown> = isPlainObject(overlay.teleprompter)
    ? overlay.teleprompter
    : {};
  const legacyMirror = {
    horizontal: rust.stageBehavior.horizontalMirror === true,
    vertical: overlayTeleprompter['mirrorY'] === true,
  };
  // The RESOLVED pin, not the overlay's: once the pin is adopted the overlay
  // copy is gone, and the old switch would lose the one panel it is carried to.
  const carriedMirror = carriedPanelMirror(storedOptical, resolvedPin, legacyMirror);
  const resolvedOptical: OpticalSettings = {
    ...storedOptical,
    panelMirror: rustOwnsPanelMirror
      ? panelMirrorFromStored(rust.optical?.panelMirror)
      : carriedMirror,
  };
  /*
   * Latched like the two above, and NOT pending when nothing was carried: an
   * empty adoption would plant the marker with no mirror in it, and a pin or a
   * calibration made later — evidence about the glass that is not here yet —
   * could then never pick the old switch up. Until something writes the map,
   * every read carries it afresh.
   */
  panelMirrorAwaitingAdoption =
    panelMirrorMigrated || Object.keys(carriedMirror).length === 0 ? null : carriedMirror;
  /*
   * BOTH guards, and they answer different questions.
   *
   * `overlayHoldsRigs` is main's: an overlay with no rigs in it has nothing to
   * migrate, so claiming a pending adoption would write an empty calibration
   * over whatever Rust holds.
   *
   * `opticalMigrated` is the monotonic latch (see the mode above): once ANY
   * parsed document has shown Rust owning the calibration, this never reports
   * pending again — because documents do not arrive in the order they were
   * produced, and a stale read landing after another window's migration would
   * otherwise revive it. It subsumes `rustOwnsOptical`, which sets it.
   */
  opticalAwaitingAdoption =
    opticalMigrated || !overlayHoldsRigs(overlay.optical) ? null : resolvedOptical;

  return {
    ...mapped,
    // Both Rust-owned fields are spread over the merge, the way `stage` and
    // `audio` do theirs (#271). An older build cached them in the overlay on
    // every save, and a document restored from a backup arrives without that
    // overlay changing — so a merge alone showed the pre-restore launch choice,
    // and the next save in this section wrote it back over the restored one.
    general: withoutRetiredGeneralKeys({
      ...mergeSection(mapped.general, overlay.general),
      launchBehavior: mapped.general.launchBehavior,
      defaultSessionMode: mapped.general.defaultSessionMode,
      checkForUpdates: mapped.general.checkForUpdates,
    }),
    // The recogniser name and locale are Rust-owned: they describe what
    // is built from, and an overlay disagreeing with the document would mean
    // the session declares one language and the settings screen shows another.
    speech: mapped.speech,
    // The device id and the three processing toggles are per-machine capture
    // state and overlay; `vadSensitivity` is Rust-owned and wins (§28.4).
    audio: {
      ...mergeSection(mapped.audio, overlay.audio),
      vadSensitivity: mapped.audio.vadSensitivity,
    },
    // `fixedSpeedWpm` is Rust-owned and wins, for the same reason as the two in
    // `general` (#271).
    teleprompter: withoutRetiredTeleprompterKeys({
      ...mergeSection(mapped.teleprompter, overlay.teleprompter),
      fixedSpeedWpm: mapped.teleprompter.fixedSpeedWpm,
    }),
    // All three are UI-only sections with no Rust twin, so the overlay IS the
    // document for them. A merge that is missing here does not fail loudly —
    // the setting simply reverts on every read, which is how a control ends up
    // looking live and being inert.
    stage: {
      ...mergeSection(mapped.stage, overlay.stage),
      /*
       * Three Rust-owned fields in an otherwise-local section, all spread over
       * the merge above so a stale overlay copy can never contradict the
       * document. The pin used to keep the overlay merge as "genuinely
       * per-machine"; that was before Present moved takes onto it (#272).
       *
       * The mode is resolved rather than merged for a second reason as well: the
       * stored section may still be carrying the retired `fullscreen` boolean and
       * nothing else, and `mergeSection` would spread that straight through —
       * leaving a dead key on the section and `presentationMode` silently on its
       * default. See `presentationModeFromRust`, which reads the document first
       * and falls back to `migrateStageMode`.
       */
      presentationMode: resolvedMode,
      readerFrame: readerFrameFromRust(rust.stageBehavior.readerFrame),
      displayFingerprint: resolvedPin,
    },
    optical: resolvedOptical,
    revision: revisioned.revision,
  };
}

function toSessionMode(promptMode: string): SessionMode {
  return promptMode === 'manual' || promptMode === 'fixed' ? promptMode : 'voice';
}

/** UI patch → the subset that has a Rust home (recursive-merge patch shape). */
function toRustPatch(patch: Partial<AppSettings>): Record<string, unknown> {
  const rust: Record<string, Record<string, unknown>> = {};
  const put = (section: string, key: string, value: unknown) => {
    if (value === undefined) return;
    (rust[section] ??= {})[key] = value;
  };
  if (patch.general) {
    if (patch.general.launchBehavior !== undefined) {
      put('general', 'openTo', patch.general.launchBehavior === 'recent' ? 'last_script' : 'library');
    }
    put('stageBehavior', 'promptMode', patch.general.defaultSessionMode);
    put('general', 'checkForUpdates', patch.general.checkForUpdates);
  }
  if (patch.audio) {
    // §28.4 — the missing half of the mapping. The slider persisted in the
    // localStorage overlay only, so the sensitivity a presenter tuned for their
    // room could not survive a cleared store.
    for (const [key, value] of Object.entries(audioToRustPatch(patch.audio))) {
      put('audio', key, value);
    }
  }
  if (patch.speech) {
    put('audio', 'transcriptionModel', patch.speech.transcriptionModel);
    put('audio', 'language', patch.speech.language);
  }
  if (patch.stage) {
    // The half this file keeps losing. `saveTranscript` and `vadSensitivity`
    // both shipped mapped in one direction only, which reads as a control that
    // works and silently forgets — so both stage fields are written here, next
    // to where they are read.
    put('stageBehavior', 'presentationMode', patch.stage.presentationMode);
    /*
     * `null` is a meaningful value rather than an omission: Rust's `merge_json`
     * REMOVES a key whose patch value is null, which is exactly how a frame is
     * forgotten. So this passes null through and only skips `undefined`, which
     * is a patch that says nothing about the frame at all.
     */
    if (patch.stage.readerFrame !== undefined) {
      (rust.stageBehavior ??= {}).readerFrame = patch.stage.readerFrame;
    }
    /*
     * The pin (#272), with null passed through as the unpin — and the
     * ownership flag stamped in the same patch, the way `optical.migrated` is
     * below. The flag is what keeps an unpin from reading as "never moved" once
     * `merge_json` has turned the null into an absent key.
     *
     * Anything Rust would refuse goes as null rather than as itself. Every
     * stage save carries this field, so a value Rust rejects would fail every
     * save of the section, not just the one that set it.
     */
    if (patch.stage.displayFingerprint !== undefined) {
      const stageBehavior = (rust.stageBehavior ??= {});
      stageBehavior.displayFingerprint = displayPinFromStored(patch.stage.displayFingerprint);
      stageBehavior.displayPinMigrated = true;
    }
  }
  if (patch.teleprompter) {
    // No `horizontalMirror`: mirroring is per panel now and lives in `optical`
    // (#206). The field stays in the document only as the source of the
    // one-time move, so writing it would change nothing anybody reads.
    put('stageBehavior', 'fixedSpeedWpm', patch.teleprompter.fixedSpeedWpm);
  }
  if (patch.following) {
    const following = followingToRustPatch(patch.following);
    for (const [key, value] of Object.entries(following)) put('following', key, value);
  }
  if (patch.optical) {
    /*
     * §52 calibrated rigs — the section this file lost hardest.
     *
     * It had no Rust mapping at all, so every measured viewing distance and
     * lens placement lived only in the localStorage overlay: cleared by the
     * OS under storage pressure, wiped by a "clear website data" action nobody
     * associates with an app, and written through a `try` that swallowed every
     * failure. A calibrated rig is user-created data produced by measuring a
     * physical room, and it is the single most expensive thing in this
     * document to lose.
     *
     * Both maps are sent WHOLE, and Rust REPLACES them rather than merging
     * (see `REPLACED_MAPS` in settings/mod.rs). `merge_json` recurses into
     * objects, which is right for a document of named scalars and wrong for a
     * map whose keys are the data: a rig the user deleted is simply not
     * mentioned by the patch, so a merge would leave it in place. A
     * calibration that comes back from the dead is worse than one that was
     * never saved — the picker offers a measurement of a room the presenter
     * has left.
     */
    if (patch.optical.profiles !== undefined) {
      (rust.optical ??= {}).profiles = patch.optical.profiles;
    }
    if (patch.optical.activeRig !== undefined) {
      (rust.optical ??= {}).activeRig = patch.optical.activeRig;
    }
    // Whole, and replaced rather than merged, for the same reason as the two
    // maps above. Writing it at all is what takes ownership of per-panel
    // mirroring from the retired global switch (#206).
    if (patch.optical.panelMirror !== undefined) {
      (rust.optical ??= {}).panelMirror = patch.optical.panelMirror;
    }
    // Any write of this section takes ownership. After this the document is
    // the answer whether or not it holds a single rig.
    (rust.optical ??= {}).migrated = true;
  }
  return rust;
}

/**
 * Everything in the patch persists in the overlay so the UI view sticks —
 * except `following` (§47) and `speech` (§18.2), which are
 * Rust-owned in both directions, and the individual Rust-owned fields inside
 * otherwise-overlaid sections (`audio.vadSensitivity` §28.4, the stage mode,
 * reader frame and display pin #272, `general.launchBehavior`/`defaultSessionMode`
 * and `teleprompter.fixedSpeedWpm` #271).
 */
function applyOverlayPatch(patch: Partial<AppSettings>): void {
  const overlay = loadOverlay();
  for (const key of Object.keys(patch) as Array<keyof AppSettings>) {
    if (key === 'revision' || key === 'schemaVersion') continue;
    // Rust-owned in both directions. `optical` joined them when calibrated
    // rigs moved out of the overlay (§52): a cached copy of a measurement
    // would outlive the document and could contradict it, which is how a rig
    // somebody deleted comes back.
    if (key === 'following' || key === 'speech' || key === 'optical') continue;
    const section = patch[key];
    if (typeof section !== 'object' || section === null) continue;
    // Rust-owned fields never enter the overlay (§28.4, §47) — a cached copy
    // would outlive the document and could contradict it.
    const merged: Record<string, unknown> = {
      ...((overlay as Record<string, Record<string, unknown> | undefined>)[key] ?? {}),
      ...(section as Record<string, unknown>),
    };
    /*
     * Rust-owned fields never enter the overlay (§28.4, §47) — a cached copy
     * would outlive the document and could contradict it.
     *
     * Stripped from the MERGED result, not from the incoming patch. Stripping
     * the patch alone is the mistake this used to make: the line below spreads
     * whatever the overlay already held back in, so a key retired from the
     * overlay was deleted from the new half and immediately restored from the
     * old one. It would sit there forever — and for `stage.presentationMode`
     * that is not inert, because the migration fallback reads exactly that key
     * whenever Rust has no answer, so a stale choice could come back from the
     * dead.
     */
    if (key === 'audio') {
      for (const owned of RUST_OWNED_AUDIO_KEYS) delete merged[owned];
    }
    if (key === 'stage') {
      // Rust-owned since the mode moved out of here.
      delete merged.presentationMode;
      delete merged.readerFrame;
      // The retired predecessor goes with it: it is only ever read as a stand-in
      // for a mode Rust does not hold, and Rust holds one by now.
      delete merged.fullscreen;
      /*
       * The pin (#272) — but only when THIS patch carried it. `toRustPatch`
       * sent it to Rust in that case, and this runs only once that write has
       * committed, so the overlay copy is now a second answer. A patch that
       * never mentioned the pin wrote nothing to Rust about it, and until the
       * adoption lands the overlay copy is the only one there is.
       */
      if ((section as Partial<AppSettings['stage']>).displayFingerprint !== undefined) {
        delete merged.displayFingerprint;
      }
    }
    if (key === 'general') {
      // Both persisted by Rust (`openTo`, `promptMode`). A copy here outlived
      // every restore and was read back over the restored document (#271).
      delete merged.launchBehavior;
      delete merged.defaultSessionMode;
      // Rust-owned too, and Rust is what refuses an automatic check when it
      // is off; a cached copy here could only ever disagree with it.
      delete merged.checkForUpdates;
      // Rows that changed nothing (#218). Nothing reads the stored copy.
      for (const retired of RETIRED_GENERAL_ROWS) delete merged[retired];
    }
    if (key === 'teleprompter') {
      // `stageBehavior.fixedSpeedWpm`, for the same reason as `general`.
      delete merged.fixedSpeedWpm;
      // The retired global switch (#206) is read from the document now, so the
      // overlay's copy is a second answer nobody asks for. `mirrorY` STAYS: it
      // never reached Rust, and the per-panel move still needs it until a pin
      // or a calibration names the glass.
      delete merged.mirrorX;
      // Replaced by `diagnosticTake` (#300). Every stored copy is the old
      // default, saved alongside some other change, never a choice.
      delete merged.stageMode;
      for (const retired of RETIRED_TELEPROMPTER_ROWS) delete merged[retired];
    }
    (overlay as Record<string, object>)[key] = merged;
  }
  // The retired retention window (#215) is the only thing a `privacy` section
  // ever held. Nothing reads it, so it goes the next time the overlay is
  // written rather than riding along in every copy forever — after the loop,
  // so not even a stray untyped patch can write it back.
  delete (overlay as Record<string, unknown>).privacy;
  saveOverlay(overlay);
}

/* ---------------------------------------------------------------------------
 * Service surface (unchanged for callers)
 * ------------------------------------------------------------------------- */

export async function getSettings(): Promise<AppSettings> {
  if (!isTauriRuntime()) return mockSettings.get();
  try {
    const revisioned = await ipcInvoke<RustRevisioned>('get_settings');
    return fromRust(revisioned);
  } catch (err) {
    if (err instanceof BackendUnavailableError) return mockSettings.get();
    throw err;
  }
}

/**
 * Persist a settings patch.
 *
 * ## Rust first, then the overlay
 *
 * The order is the fix, and the old order was a real defect. This used to call
 * `applyOverlayPatch(patch)` FIRST and then send the Rust update. A rejected
 * write — a revision conflict, a validation failure, a database that had gone
 * away — left the store reverted and the overlay holding the value anyway, and
 * on a later launch that stale overlay could override the Rust-owned document
 * for any field duplicated into an overlaid section. The user's screen showed a
 * setting that had failed to save, and kept showing it.
 *
 * So Rust commits first and the overlay is only written once it has. The
 * remaining window — Rust committed, the overlay write then failed — leaves the
 * authoritative half correct and the local presentation half stale until the
 * next successful write, which is the right way round for the two to disagree.
 */
export async function updateSettings(
  expectedRevision: number,
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  if (!isTauriRuntime()) return mockSettings.update(expectedRevision, patch);

  const rustPatch = toRustPatch(patch);
  if (Object.keys(rustPatch).length === 0) {
    // Nothing Rust owns changed, so there is no authoritative write to wait
    // for. The overlay IS the document for these fields.
    applyOverlayPatch(patch);
    return getSettings();
  }

  const revisioned = await ipcInvoke<RustRevisioned>('update_settings', {
    expectedRevision,
    patch: rustPatch,
  });

  // Only now. A throw above leaves the overlay untouched, which is what makes
  // a failed save actually fail.
  applyOverlayPatch(patch);

  return fromRust(revisioned);
}

/**
 * Export every script plus a consistent database snapshot (spec §47.7).
 *
 * C5: this used to take a `destination` the caller had no way to obtain — the
 * dialog plugin is deliberately not granted to JavaScript — and passed
 * `undefined`, which JSON drops, which made Rust's non-optional `String`
 * parameter fail to deserialize. Rust now runs the folder picker itself, the
 * same as `import_script`/`export_script`, and returns `null` when the
 * operator cancels.
 */
export async function exportAllData(): Promise<DataExportResult> {
  if (!isTauriRuntime()) return { cancelled: true };
  const result = await ipcInvoke<RustExportResult | null>('export_all_data');
  if (result === null) return { cancelled: true };
  /*
   * Every field is carried through, and `complete` is the one that matters.
   *
   * This adapter used to return `{ path, cancelled }` and throw away both the
   * script count and the warnings — so a failed database snapshot arrived here
   * as a warning string, was discarded, and Settings said "Export ready" about
   * a folder with no database in it. The type now makes that impossible to
   * repeat by accident: a caller cannot report success without reading
   * `complete`, because there is no other way to know.
   */
  return {
    cancelled: false,
    path: result.path,
    complete: result.complete,
    scriptsCopied: result.scriptsCopied,
    fileCount: result.fileCount,
    totalBytes: result.totalBytes,
    warnings: result.warnings,
    excluded: result.excluded,
  };
}

/**
 * The sentence Settings shows after an export.
 *
 * Pure and exported so the claim is testable without a filesystem. The failure
 * it exists to prevent is specific and was live: "Export ready" displayed over
 * an export that is missing the database.
 */
export function describeExport(result: DataExportResult): string | null {
  if (result.cancelled) return null;
  if (result.complete) {
    return `Export complete — ${result.fileCount} files.`;
  }
  const first = result.warnings?.[0] ?? 'part of the export could not be written';
  return `Export INCOMPLETE and must not be used as a backup: ${first}`;
}

/**
 * SCHEDULE a restore from an export folder.
 *
 * Rust validates the manifest and every checksum, then writes a marker; the
 * swap happens at the next launch, before any database pool exists. Replacing
 * the file underneath the open pool — which the first version of this did —
 * leaves existing connections writing to the renamed inode on Unix and fails
 * outright on Windows, in both cases after the scripts tree has already moved.
 *
 * So the caller must tell the user to restart. A schedule that succeeded looks
 * exactly like nothing happening otherwise.
 */
export async function restoreAllData(): Promise<RestoreResult> {
  if (!isTauriRuntime()) return { cancelled: true };
  const result = await ipcInvoke<RustRestoreResult | null>('restore_all_data');
  if (result === null) return { cancelled: true };
  return {
    cancelled: false,
    scriptsInExport: result.scriptsInExport,
    createdAt: result.createdAt,
    appVersion: result.appVersion,
    restartRequired: result.restartRequired,
  };
}

export async function clearCache(kind: 'logs'): Promise<ClearResult> {
  if (!isTauriRuntime()) return mockSettings.clearCache(kind);
  /*
   * §46.8. Logs are the only thing Settings clears now: "Clear analysis cache"
   * emptied `cache/vocabulary`, a directory nothing has ever written (#218).
   *
   * C6: `logs` used to map onto `all`, which emptied the compiled, vocabulary,
   * thumbnail and download caches and never touched the log directory — so
   * "Clear logs" destroyed four caches, left the logs, and reported success.
   * `logs` got its own arm, and since #219 it is the only kind Rust accepts.
   */
  const result = await ipcInvoke<{ kind: string; removedFiles: number; removedBytes: number }>(
    'clear_cache',
    { kind },
  );
  // `clearedBytes` used to be handed `removedFiles` — a count wearing the name
  // of a size. Rust reports both now.
  return { kind, clearedFiles: result.removedFiles, clearedBytes: result.removedBytes };
}

/*
 * The update commands live in `services/updates.ts`, and the flow that uses
 * them in `stores/updates.ts`. What stays here is the one sentence Settings
 * shows about them, because it is a privacy statement and is tested as one.
 */

/**
 * The version of the running build.
 *
 * Rust is the authority: `app_version` reads the package info of the SIGNED
 * BUNDLE, which is the number a support request needs. The fallback is the
 * generated `DEV_APP_VERSION` rather than a literal — two hard-coded `0.1.0`
 * strings used to sit in this file and were never touched by a version bump,
 * so a browser-dev diagnostics paste reported a version that had not been real
 * for months. `pnpm version:check` now fails on a literal here at all.
 */
export async function getAppVersion(): Promise<string> {
  if (!isTauriRuntime()) return DEV_APP_VERSION;
  try {
    return await ipcInvoke<string>('app_version');
  } catch (err) {
    if (err instanceof BackendUnavailableError) return DEV_APP_VERSION;
    throw err;
  }
}

/**
 * What Settings tells a presenter about updates.
 *
 * Exported and pure so the claim is testable without mounting the route. It is
 * a privacy statement before it is anything else, so it says exactly what the
 * check is (docs/updates.md, docs/network-inventory.md): which host, when, what
 * the request carries, and what it never does. It is not a RESULT — it never
 * says "up to date" or "update available", because it does not know.
 *
 * `automatic` is the "Check for updates automatically" switch, so the sentence
 * under the switch always describes the position it is in.
 */
export function describeUpdatePolicy(currentVersion: string, automatic: boolean): string {
  const when = automatic
    ? `CandidCue asks updates.candidcue.com whether a newer version exists shortly after it ` +
      `opens and every six hours while it runs, and whenever you choose Check for Updates… in the ` +
      `Help menu.`
    : `Automatic checks are off, so CandidCue contacts updates.candidcue.com only when you ` +
      `choose Check for Updates… in the Help menu.`;
  return (
    `You are running CandidCue ${currentVersion}. ${when} ` +
    `A check sends this version, your operating system and processor type, and — as any web ` +
    `request does — your IP address; nothing that identifies you, and none of your scripts or ` +
    `audio. An update is installed only when you choose to, never during a take, and only if it ` +
    `carries the signature built into CandidCue. Installing one replaces the app; your scripts, ` +
    `settings and calibrations are stored separately and are left untouched.`
  );
}
