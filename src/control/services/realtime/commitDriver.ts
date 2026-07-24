/**
 * Manual audio commit driver (spec §29.3, Appendix E.3).
 *
 * Bridges the local VAD to the transport's manual `input_audio_buffer.commit`
 * strategy. Commit boundaries:
 * - VAD speech turn followed by the configured silence;
 * - active speech reaching the maximum turn duration;
 * - user pause/stop, command finalization, mic switch/disconnect (forced).
 *
 * Never commits an empty/noise-only buffer (suppressed and, on teardown
 * reasons, the buffered audio is cleared instead).
 */
import type { CommitReason } from '../../../shared/contracts';
import type { VadEvent } from '../audio/vad';
import { CommitLedger } from './commitLedger';

export interface CommitDriverDeps {
  /** Send the commit client event (transport.commit). */
  sendCommit: (reason: CommitReason) => void;
  /** Clear the provider-side audio buffer without transcribing it. */
  clearBufferedAudio: () => void;
  ledger: CommitLedger;
  now?: () => number;
  /** Current alignment anchor, recorded with each commit (spec §29.3). */
  getAlignmentAnchor?: () => number | undefined;
  /** Heuristic flag: is the segment likely a command? (spec §29.3). */
  isLikelyCommand?: () => boolean;
}

/** Reasons that tear down or interrupt capture; empty buffers are cleared. */
const TEARDOWN_REASONS: ReadonlySet<CommitReason> = new Set([
  'soft_pause',
  'hard_pause',
  'stop',
  'mic_switch',
  'mic_disconnect',
]);

export class ManualCommitDriver {
  private speechActive = false;
  private speechStartMs = 0;
  private readonly now: () => number;

  constructor(private readonly deps: CommitDriverDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  get hasUncommittedSpeech(): boolean {
    return this.speechActive;
  }

  /** Wire this to `MicrophoneMonitor.onVadEvent` / `LocalVad` output. */
  handleVadEvent(event: VadEvent): void {
    switch (event.type) {
      case 'speech_started':
        this.speechActive = true;
        this.speechStartMs = event.atMs;
        break;
      case 'speech_ended':
        if (this.speechActive) {
          this.commit('vad_silence', event.speechStartMs, event.atMs);
          this.speechActive = false;
        }
        break;
      case 'max_utterance':
        if (this.speechActive) {
          // Forced commit; speech continues, so the segment stays active
          // and the next segment starts at the forced boundary.
          this.commit('max_utterance', event.speechStartMs, event.atMs);
          this.speechStartMs = event.atMs;
        }
        break;
      case 'calibrated':
        break;
    }
  }

  /**
   * Commit immediately for pause/stop/mic-switch/command finalization
   * (spec §28.4/§29.3). With no uncommitted speech, a teardown reason clears
   * the provider buffer instead — never commit an empty segment (E.3).
   */
  forceCommit(reason: CommitReason): void {
    if (this.speechActive) {
      this.commit(reason, this.speechStartMs, this.now());
      this.speechActive = false;
      return;
    }
    if (TEARDOWN_REASONS.has(reason)) {
      this.deps.clearBufferedAudio();
    }
  }

  /** Reset local segment tracking (fresh connection / new session). */
  reset(): void {
    this.speechActive = false;
    this.speechStartMs = 0;
  }

  private commit(reason: CommitReason, speechStartMs: number, speechEndMs: number): void {
    this.deps.ledger.recordPending({
      reason,
      speechStartMs,
      speechEndMs,
      alignmentAnchor: this.deps.getAlignmentAnchor?.(),
      likelyCommand: this.deps.isLikelyCommand?.(),
    });
    this.deps.sendCommit(reason);
  }
}
