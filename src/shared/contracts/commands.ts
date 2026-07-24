/**
 * Voice-command contracts (spec Appendix C.5). Exact/common commands are
 * parsed locally; only ambiguous natural-language commands go to Luna, and
 * every interpretation passes an allow-listed validator before execution.
 */
import type { Uuid } from './core';

export type CommandAction =
  | { action: 'start' | 'pause' | 'resume' | 'hard_pause' | 'stop' }
  | { action: 'go_to_target'; targetId: string }
  | { action: 'next_section' | 'previous_section' }
  | {
      action: 'move_relative';
      direction: 'forward' | 'backward';
      amount: number;
      unit: 'sentence' | 'paragraph' | 'section';
    }
  | { action: 'restart_unit'; unit: 'sentence' | 'paragraph' | 'section' | 'take' }
  | { action: 'set_font_size'; valuePx: number }
  | { action: 'adjust_font_size'; deltaSteps: number }
  | { action: 'set_margins'; valuePercent: number }
  | { action: 'toggle_mirror'; axis: 'x' | 'y'; value?: boolean }
  | { action: 'blank_stage' | 'unblank_stage' }
  | { action: 'set_listener'; enabled: boolean }
  | { action: 'adjust_reading_band'; deltaPercent: number }
  | { action: 'set_scroll_mode'; mode: 'voice' | 'manual' | 'fixed' }
  /* -------------------------------------------------------------------------
   * Additive extensions beyond Appendix C.5 — required to cover the full §34
   * command catalogue, which includes commands with no C.5 action variant:
   *  - adjust_margins:        "widen/narrow margins" (§34.4)
   *  - set_cue_visibility:    "hide/show cues" (§34.4)
   *  - adjust_listener_opacity: "dim Listener more/less" (§34.5)
   *  - set_scroll_speed:      "set speed to <n> words per minute" (§34.6)
   *  - adjust_scroll_speed:   "speed up / slow down" (§34.6)
   *  - retake:                "CandidCue, retake." (§34.7)
   *  - mark_checkpoint:       "CandidCue, mark here." (§34.7)
   * ----------------------------------------------------------------------- */
  | { action: 'adjust_margins'; deltaPercent: number }
  | { action: 'set_cue_visibility'; visible: boolean }
  | { action: 'adjust_listener_opacity'; deltaPercent: number }
  | { action: 'set_scroll_speed'; wordsPerMinute: number }
  | { action: 'adjust_scroll_speed'; deltaPercent: number }
  | { action: 'retake' }
  | { action: 'mark_checkpoint' }
  | { action: 'unknown'; reason?: string };

export interface CommandCandidate {
  id: Uuid;
  sessionGeneration: number;
  contextRevision: number;
  itemIds: string[];
  rawTranscript: string;
  normalizedTranscript: string;
  wakeAlias: string;
  wakeConfidence: number;
  scriptCollisionScore: number;
  createdAtMs: number;
}

export interface ValidatedCommand {
  candidateId: Uuid;
  source: 'local' | 'luna';
  action: CommandAction;
  confidence: number;
  requiresConfirmation: boolean;
  contextRevision: number;
  humanLabel: string;
}
