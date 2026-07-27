/**
 * Validated application-settings view consumed by the Settings screen
 * (spec §18) and defaults used until `get_settings` lands in Rust.
 */
import type { ListenerPlacementMode } from '../../shared/contracts';
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
    /** 'high-contrast' is pure black; 'near-black' is the #050505 default. */
    background: StageBackground;
    fixedSpeedWpm: number;
    stageEndBehavior: 'close' | 'blank';
    hidePointer: boolean;
  };
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

export type StageBackground = 'near-black' | 'high-contrast';

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
      fontFamilyId: 'system-sans',
      fontSizePx: 64,
      lineHeight: 1.32,
      mirrorX: false,
      mirrorY: false,
      columnWidthPercent: 78,
      readingBandCenterPercent: 38,
      phraseHighlight: true,
      pastDimming: true,
      background: 'near-black',
      fixedSpeedWpm: 150,
      stageEndBehavior: 'close',
      hidePointer: true,
    },
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
