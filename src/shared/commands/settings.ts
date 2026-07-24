/**
 * Command-channel settings and defaults (spec §33.2–§33.3, Appendix A.8).
 */

export type WakeMode = 'strict' | 'double_gate' | 'push_to_command';

export interface CommandSettings {
  /** Visible wake phrase (default "CandidCue", §33.2). */
  wakePhrase: string;
  /** Accepted normalized transcript aliases (§33.2). */
  wakeAliases: string[];
  wakeMode: WakeMode;
  lunaFallback: boolean;
  commandModel: string;
  /** Deterministic parser must answer immediately; Luna soft/hard (§33.11). */
  lunaSoftTimeoutMs: number;
  lunaHardTimeoutMs: number;
  stageAcknowledgementMs: number;
  commandHistorySize: number;
  /** Minimum wake-token model confidence (G.7). */
  minimumWakeConfidence: number;
  /** Normalized script-alignment score above which a candidate is treated
   *  as authored script, not a command (§33.5, G.7). */
  scriptCollisionThreshold: number;
  /**
   * Normalized alignment score against an authored `:::literal-command` block
   * above which the phrase is demonstration text, never an instruction
   * (§33.5). Lower than `scriptCollisionThreshold`: the author has explicitly
   * declared this text non-executable, so the bar to honour that is lower than
   * the bar for inferring an accidental collision with ordinary prose.
   */
  literalCommandThreshold: number;
  /** Max tokens collected after the wake phrase (§33.4 step 3). */
  maxCommandTokens: number;
  /** Silence gap (ms) that terminates command collection (§33.4). */
  commandSilenceMs: number;
  /** Pause required before a wake token mid-item (§33.4 step 2). */
  wakeBoundaryPauseMs: number;
}

export const DEFAULT_COMMAND_SETTINGS: CommandSettings = {
  wakePhrase: 'CandidCue', // A.8
  wakeAliases: ['candidcue', 'candid cue', 'candid q', 'candy cue'], // §33.2
  wakeMode: 'strict', // A.8
  lunaFallback: true, // A.8
  commandModel: 'gpt-5.6-luna', // A.8
  lunaSoftTimeoutMs: 1500, // A.8 / §33.11
  lunaHardTimeoutMs: 3000, // A.8 / §33.11
  stageAcknowledgementMs: 900, // A.8 (0–2000)
  commandHistorySize: 50, // A.8 (10–200)
  minimumWakeConfidence: 0.5,
  scriptCollisionThreshold: 0.62,
  literalCommandThreshold: 0.5, // §33.5 authored literal-command blocks
  maxCommandTokens: 14,
  commandSilenceMs: 900,
  wakeBoundaryPauseMs: 250,
};

export function resolveCommandSettings(partial?: Partial<CommandSettings>): CommandSettings {
  const merged = { ...DEFAULT_COMMAND_SETTINGS, ...(partial ?? {}) };
  merged.stageAcknowledgementMs = Math.max(0, Math.min(2000, merged.stageAcknowledgementMs));
  merged.commandHistorySize = Math.max(10, Math.min(200, merged.commandHistorySize));
  return merged;
}

/** Numeric bounds for voice-adjustable settings (§34.4 "clamped"). */
export interface CommandBounds {
  fontSizeMinPx: number;
  fontSizeMaxPx: number;
  marginsMinPercent: number;
  marginsMaxPercent: number;
  readingBandMinPercent: number;
  readingBandMaxPercent: number;
  scrollWpmMin: number;
  scrollWpmMax: number;
}

export const DEFAULT_COMMAND_BOUNDS: CommandBounds = {
  fontSizeMinPx: 16,
  fontSizeMaxPx: 200,
  marginsMinPercent: 0,
  marginsMaxPercent: 40,
  readingBandMinPercent: 20, // §32.5
  readingBandMaxPercent: 70, // §32.5
  scrollWpmMin: 60,
  scrollWpmMax: 320,
};
