/**
 * Application settings + maintenance service (spec §46.8).
 *
 * Rust owns the persisted settings document as `Revisioned<AppSettings>`
 * ({ revision, value }) with the §47.9 schema (general / editor /
 * stageBehavior / audio / commands / listener). The control UI consumes the
 * flatter view in `settings-types.ts`, so this service is an explicit
 * adapter:
 *
 *  - fields with a Rust home are mapped bidirectionally (wake phrase, prompt
 *    mode, models, mirror, fixed speed, …);
 *  - UI-only presentation fields (per-display appearance, audio processing
 *    toggles, …) persist in a local overlay (localStorage) — they belong to
 *    display profiles / frontend state per §52, not the Rust document.
 */
import { describeError, errorCode } from './errors';
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
  listenerFromRust,
  listenerToRustPatch,
  type RustListenerSettings,
} from './settings-listener';
import {
  defaultAppSettings,
  type AppSettings,
  type ClearResult,
  type SessionMode,
  type TranscriptRetention,
  type UpdateCheckResult,
} from './settings-types';

/* ---------------------------------------------------------------------------
 * Rust settings twins (src-tauri/src/settings/mod.rs, camelCase over IPC)
 * ------------------------------------------------------------------------- */

interface RustSettings {
  schemaVersion: number;
  general: {
    openTo: string;
    autosaveDebounceMs: number;
    revisionIntervalMinutes: number;
    wordsPerMinuteEstimate: number;
    updateCheck: string;
    analyticsEnabled: boolean;
    saveTranscript: string;
  };
  editor: Record<string, unknown>;
  stageBehavior: {
    promptMode: string;
    manualWheelMultiplier: number;
    fixedSpeedWpm: number;
    pointerHideDelaySeconds: number;
    manualMoveTrackingGraceSeconds: number;
    stageAcknowledgement: string;
    horizontalMirror: boolean;
    keepScreenAwake: boolean;
    blankColor: string;
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
   * §37 Listener defaults. This used to be `Record<string, unknown>` — an
   * opaque bag on the TypeScript side while Rust declared five typed fields —
   * which is how the feature ended up with two settings structures and no
   * mapping between them.
   */
  listener?: Partial<RustListenerSettings>;
}

interface RustRevisioned {
  revision: number;
  value: RustSettings;
}

const OVERLAY_KEY = 'candidcue.settings-overlay.v1';

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

function saveOverlay(overlay: Overlay): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
    }
  } catch {
    // Non-fatal; overlay fields fall back to defaults next launch.
  }
}

function mergeSection<T extends object>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return base;
  return { ...base, ...patch };
}

/** Rust document + overlay → the UI settings view. */
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
    },
    inworld: {
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
      mirrorX: rust.stageBehavior.horizontalMirror,
      fixedSpeedWpm: rust.stageBehavior.fixedSpeedWpm,
      hidePointer: rust.stageBehavior.pointerHideDelaySeconds > 0,
    },
    // Following settings are Rust-owned end to end (§47) — no overlay merge,
    // so a stale local overlay can never resurrect an old assist mode.
    following: followingFromRust(rust.following),
    // §37. Rust-owned end to end for the same reason: these are the values the
    // stage renders from, and a localStorage copy that outlived the document
    // would put the UI and the glass in disagreement about what the Listener
    // looks like.
    listeners: listenerFromRust(rust.listener),
    privacy: {
      ...defaults.privacy,
      saveTranscript: toTranscriptRetention(rust.general.saveTranscript),
    },
  };

  return {
    ...mapped,
    general: mergeSection(mapped.general, overlay.general),
    // Inworld model and locale are Rust-owned: they are what the config frame
    // is built from, and an overlay disagreeing with the document would mean
    // the session declares one language and the settings screen shows another.
    inworld: mapped.inworld,
    // The device id and the three processing toggles are per-machine capture
    // state and overlay; `vadSensitivity` is Rust-owned and wins (§28.4).
    audio: {
      ...mergeSection(mapped.audio, overlay.audio),
      vadSensitivity: mapped.audio.vadSensitivity,
    },
    teleprompter: mergeSection(mapped.teleprompter, overlay.teleprompter),
    // Both are UI-only sections with no Rust twin, so the overlay IS the
    // document for them. A merge that is missing here does not fail loudly —
    // the setting simply reverts on every read, which is how a control ends up
    // looking live and being inert.
    stage: mergeSection(mapped.stage, overlay.stage),
    listenerFraming: mergeSection(mapped.listenerFraming, overlay.listenerFraming),
    // `saveTranscript` is Rust-owned (§36.2): a stale local overlay must never
    // be able to claim retention is on when the persisted document says off.
    privacy: {
      ...mergeSection(mapped.privacy, overlay.privacy),
      saveTranscript: mapped.privacy.saveTranscript,
    },
    revision: revisioned.revision,
  };
}

function toSessionMode(promptMode: string): SessionMode {
  return promptMode === 'manual' || promptMode === 'fixed' ? promptMode : 'voice';
}

/** Unknown values read as 'off' — the safe side of a privacy setting. */
function toTranscriptRetention(value: string): TranscriptRetention {
  return value === '1d' || value === '7d' || value === '30d' || value === 'forever'
    ? value
    : 'off';
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
  }
  if (patch.audio) {
    // §28.4 — the missing half of the mapping. The slider persisted in the
    // localStorage overlay only, so the sensitivity a presenter tuned for their
    // room could not survive a cleared store.
    for (const [key, value] of Object.entries(audioToRustPatch(patch.audio))) {
      put('audio', key, value);
    }
  }
  if (patch.inworld) {
    put('audio', 'transcriptionModel', patch.inworld.transcriptionModel);
    put('audio', 'language', patch.inworld.language);
  }
  if (patch.teleprompter) {
    put('stageBehavior', 'horizontalMirror', patch.teleprompter.mirrorX);
    put('stageBehavior', 'fixedSpeedWpm', patch.teleprompter.fixedSpeedWpm);
    if (patch.teleprompter.hidePointer !== undefined) {
      put('stageBehavior', 'pointerHideDelaySeconds', patch.teleprompter.hidePointer ? 1.5 : 0);
    }
  }
  if (patch.following) {
    const following = followingToRustPatch(patch.following);
    for (const [key, value] of Object.entries(following)) put('following', key, value);
  }
  if (patch.listeners) {
    const listener = listenerToRustPatch(patch.listeners);
    // `put` keeps `null`, which is what clearing `defaultPackId` has to send.
    for (const [key, value] of Object.entries(listener)) put('listener', key, value);
  }
  if (patch.privacy) {
    // §36.2 — the missing half of the mapping. Without it the setting that
    // decides whether spoken words reach disk could not be changed at all.
    put('general', 'saveTranscript', patch.privacy.saveTranscript);
  }
  return rust;
}

/**
 * Everything in the patch persists in the overlay so the UI view sticks —
 * except `following` (§47), `inworld` (§18.2) and `listeners` (§37), which are
 * Rust-owned in both directions, and the individual Rust-owned fields inside
 * otherwise-overlaid sections (`privacy.saveTranscript` §36.2,
 * `audio.vadSensitivity` §28.4). A cached copy of a retention consent is
 * exactly the thing that must not exist.
 */
function applyOverlayPatch(patch: Partial<AppSettings>): void {
  const overlay = loadOverlay();
  for (const key of Object.keys(patch) as Array<keyof AppSettings>) {
    if (key === 'revision' || key === 'schemaVersion') continue;
    if (key === 'following' || key === 'inworld' || key === 'listeners') continue;
    const section = patch[key];
    if (typeof section !== 'object' || section === null) continue;
    // Rust-owned fields never enter the overlay (§28.4, §36.2, §47) — a cached
    // copy would outlive the document and could contradict it.
    const overlayable = { ...(section as Record<string, unknown>) };
    delete overlayable.saveTranscript;
    if (key === 'audio') {
      for (const owned of RUST_OWNED_AUDIO_KEYS) delete overlayable[owned];
    }
    (overlay as Record<string, object>)[key] = {
      ...((overlay as Record<string, object | undefined>)[key] ?? {}),
      ...overlayable,
    };
  }
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

export async function updateSettings(
  expectedRevision: number,
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  if (!isTauriRuntime()) return mockSettings.update(expectedRevision, patch);

  applyOverlayPatch(patch);
  const rustPatch = toRustPatch(patch);
  if (Object.keys(rustPatch).length === 0) {
    // Overlay-only change: nothing to persist in Rust.
    return getSettings();
  }
  const revisioned = await ipcInvoke<RustRevisioned>('update_settings', {
    expectedRevision,
    patch: rustPatch,
  });

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
export async function exportAllData(): Promise<{ path?: string; cancelled: boolean }> {
  if (!isTauriRuntime()) return { cancelled: true };
  const result = await ipcInvoke<{ path: string } | null>('export_all_data');
  if (result === null) return { cancelled: true };
  return { path: result.path, cancelled: false };
}

export async function clearCache(
  kind: 'analysis' | 'listeners' | 'logs',
): Promise<ClearResult> {
  if (!isTauriRuntime()) return mockSettings.clearCache(kind);
  /*
   * UI kinds map onto the Rust kinds (§46.8).
   *
   * C6: `logs` used to map onto `all`, which empties the compiled, vocabulary,
   * thumbnail and download caches and never touches the log directory — so
   * "Clear logs" destroyed four caches, left the logs, and reported success.
   * There is a real `logs` arm now.
   */
  const rustKind = kind === 'analysis' ? 'vocabulary' : kind === 'listeners' ? 'downloads' : 'logs';
  const result = await ipcInvoke<{ kind: string; removedFiles: number; removedBytes: number }>(
    'clear_cache',
    { kind: rustKind },
  );
  // `clearedBytes` used to be handed `removedFiles` — a count wearing the name
  // of a size. Rust reports both now.
  return { kind, clearedFiles: result.removedFiles, clearedBytes: result.removedBytes };
}

/**
 * Check for an application update.
 *
 * C8: every error used to be swallowed into `{ status: 'up_to_date' }`, so the
 * `'error'` branch was unreachable and a network or auth failure would read as
 * "you are up to date" the moment a real updater shipped. NOT_IMPLEMENTED — the
 * v1 state, where no updater plugin is wired (spec §44.10) — is now reported as
 * `unsupported`; everything else is reported as the failure it is.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!isTauriRuntime()) return mockSettings.checkForUpdate();
  const version = await getAppVersion().catch(() => '0.1.0');
  try {
    return await ipcInvoke<UpdateCheckResult>('check_for_update');
  } catch (err) {
    if (errorCode(err) === 'NOT_IMPLEMENTED') {
      return { status: 'unsupported', currentVersion: version };
    }
    return { status: 'error', currentVersion: version, message: describeError(err) };
  }
}

export async function getAppVersion(): Promise<string> {
  if (!isTauriRuntime()) return '0.1.0-dev';
  try {
    return await ipcInvoke<string>('app_version');
  } catch (err) {
    if (err instanceof BackendUnavailableError) return '0.1.0-dev';
    throw err;
  }
}
