/**
 * Validated application-settings view consumed by the Settings screen
 * (spec §18) and defaults used until `get_settings` lands in Rust.
 */
import { defaultFollowingSettings, type FollowingSettings } from '../lib/follow-profiles';

export type {
  CoachingDisplay,
  FidelityMode,
  FollowFeel,
  FollowingSettings,
  VoiceLead,
} from '../lib/follow-profiles';

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
  };
  openai: {
    realtimeModel: string;
    commandModel: string;
    scriptAnalysis: boolean;
    commandFallback: boolean;
    /** `store: false` is fixed on for Responses requests (spec §18.2). */
    storeResponses: false;
  };
  audio: {
    preferredDeviceId?: string;
    followSystemDefault: boolean;
    noiseSuppression: boolean;
    echoCancellation: boolean;
    autoGainControl: boolean;
    vadSensitivity: number;
  };
  teleprompter: {
    fontFamilyId: string;
    fontSizePx: number;
    lineHeight: number;
    mirrorX: boolean;
    mirrorY: boolean;
    readingBandCenterPercent: number;
    phraseHighlight: boolean;
    pastDimming: boolean;
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
  commands: {
    enabled: boolean;
    wakePhrase: string;
    wakeAliases: string[];
    strictWake: boolean;
  };
  listeners: {
    defaultPackId?: string;
    autoplay: boolean;
    dimPercent: number;
  };
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
    },
    openai: {
      realtimeModel: 'gpt-realtime-whisper',
      commandModel: 'gpt-5.6-luna',
      scriptAnalysis: true,
      commandFallback: true,
      storeResponses: false,
    },
    audio: {
      followSystemDefault: true,
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
      vadSensitivity: 0.5,
    },
    teleprompter: {
      fontFamilyId: 'system-sans',
      fontSizePx: 64,
      lineHeight: 1.32,
      mirrorX: false,
      mirrorY: false,
      readingBandCenterPercent: 38,
      phraseHighlight: true,
      pastDimming: true,
      fixedSpeedWpm: 150,
      stageEndBehavior: 'close',
      hidePointer: true,
    },
    following: defaultFollowingSettings(),
    commands: {
      enabled: true,
      wakePhrase: 'CandidCue',
      wakeAliases: ['candy cue', 'candid q'],
      strictWake: true,
    },
    listeners: {
      autoplay: true,
      dimPercent: 40,
    },
    privacy: {
      diagnosticLogging: false,
      updateChannel: 'stable',
      saveTranscript: 'off',
    },
  };
}
