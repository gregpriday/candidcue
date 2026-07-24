/**
 * Validated application-settings view consumed by the Settings screen
 * (spec §18) and defaults used until `get_settings` lands in Rust.
 */

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
  };
}

export interface ClearResult {
  kind: string;
  clearedBytes: number;
}

export interface UpdateCheckResult {
  status: 'up_to_date' | 'available' | 'error';
  currentVersion: string;
  availableVersion?: string;
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
    },
  };
}
