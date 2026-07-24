/**
 * Synthetic TranscriptEvent sequence builders (spec §55.2/§55.3 fixtures).
 * Deterministic: item ids, commit sequences, and timestamps are derived from
 * an incrementing clock.
 */
import type { TranscriptEvent } from '../../../src/shared/tracking/types';

export interface SpeechTurn {
  /** Spoken text for one committed item. */
  text: string;
  /** Silence before this item starts (ms). */
  gapMs?: number;
  /** Emit per-word deltas before completion (default true). */
  withDeltas?: boolean;
  /** Speaking speed in ms per word. */
  msPerWord?: number;
}

export class TranscriptScripter {
  private commitSequence = 0;
  private nowMs: number;
  private readonly generation: number;

  constructor(startMs = 10_000, sessionGeneration = 1) {
    this.nowMs = startMs;
    this.generation = sessionGeneration;
  }

  get clockMs(): number {
    return this.nowMs;
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }

  /** Build the events for one spoken item. */
  speak(turn: SpeechTurn): TranscriptEvent[] {
    const events: TranscriptEvent[] = [];
    this.nowMs += turn.gapMs ?? 300;
    const itemId = `item-${this.generation}-${this.commitSequence}`;
    const commitSequence = this.commitSequence++;
    const audioStartMs = this.nowMs;
    const msPerWord = turn.msPerWord ?? 220;
    const words = turn.text.split(/\s+/).filter((w) => w.length > 0);

    events.push({
      type: 'item_started',
      sessionGeneration: this.generation,
      itemId,
      commitSequence,
      audioStartMs,
      receivedAtMs: this.nowMs,
    });

    if (turn.withDeltas !== false) {
      let running = '';
      for (const word of words) {
        this.nowMs += msPerWord;
        running = running.length === 0 ? word : `${running} ${word}`;
        events.push({
          type: 'delta',
          sessionGeneration: this.generation,
          itemId,
          text: running,
          receivedAtMs: this.nowMs,
        });
      }
    } else {
      this.nowMs += msPerWord * words.length;
    }

    this.nowMs += 120; // commit latency
    events.push({
      type: 'completed',
      sessionGeneration: this.generation,
      itemId,
      text: turn.text,
      audioEndMs: audioStartMs + msPerWord * words.length,
      receivedAtMs: this.nowMs,
    });
    return events;
  }

  /** Convenience: events for several turns in order. */
  speakAll(turns: readonly SpeechTurn[]): TranscriptEvent[] {
    return turns.flatMap((turn) => this.speak(turn));
  }
}
