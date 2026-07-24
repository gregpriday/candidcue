/**
 * H4 regression: the FULL adapter → transcript-ledger path.
 *
 * The defect this pins: OpenAI's
 * `conversation.item.input_audio_transcription.delta` carries an INCREMENTAL
 * chunk, but `TranscriptLedger` treats each `delta.text` as a complete
 * cumulative transcript and keeps whichever whole string is longer. Forwarding
 * chunks verbatim therefore left the provisional transcript as the single
 * longest FRAGMENT ("is following ") instead of the utterance, so the follower
 * was fed misleading speech for the whole turn until the completion repaired
 * it — the teleprompter visibly tracking the wrong words while looking healthy.
 *
 * Why it survived: `eventAdapter.test.ts` joined the delta chunks itself
 * (`deltas.map(d => d.text).join('')`) and never fed the real ledger, so the
 * one component that actually consumes the field was never in the test.
 */
import { describe, expect, it } from 'vitest';
import { CommitLedger } from '../../../src/control/services/realtime/commitLedger';
import { TranscriptEventAdapter } from '../../../src/control/services/realtime/eventAdapter';
import { TranscriptLedger } from '../../../src/shared/tracking/ledger';
import type { TranscriptEvent } from '../../../src/shared/contracts';
import type { TranscriptEvent as TrackingEvent } from '../../../src/shared/tracking/types';
import singleTurn from '../../fixtures/audio/realtime-single-turn.json';

const SESSION_GENERATION = 1;

/** The exact conversion `voice-session.ts` performs, kept in one place. */
function toTrackingEvent(event: TranscriptEvent, receivedAtMs: number): TrackingEvent | null {
  switch (event.type) {
    case 'item_started':
      return {
        type: 'item_started',
        sessionGeneration: SESSION_GENERATION,
        itemId: event.itemId,
        commitSequence: event.commitSequence,
        audioStartMs: receivedAtMs,
        receivedAtMs,
      };
    case 'delta':
      return {
        type: 'delta',
        sessionGeneration: SESSION_GENERATION,
        itemId: event.itemId,
        text: event.text,
        receivedAtMs,
      };
    case 'completed':
      return {
        type: 'completed',
        sessionGeneration: SESSION_GENERATION,
        itemId: event.itemId,
        text: event.text,
        receivedAtMs,
      };
    default:
      return null;
  }
}

interface Harness {
  feed(raw: unknown): void;
  provisionalText(itemId: string): string;
}

function harness(): Harness {
  const commits = new CommitLedger();
  commits.beginSessionGeneration();
  commits.recordPending({ reason: 'vad_silence', speechStartMs: 0, speechEndMs: 900 });
  commits.recordPending({ reason: 'vad_silence', speechStartMs: 1000, speechEndMs: 1900 });
  const adapter = new TranscriptEventAdapter({ ledger: commits, now: () => 1000 });
  const transcripts = new TranscriptLedger();
  transcripts.setSessionGeneration(SESSION_GENERATION);
  let clock = 1000;
  return {
    feed(raw: unknown): void {
      const event = adapter.adapt(raw);
      if (!event) return;
      const tracked = toTrackingEvent(event, (clock += 10));
      if (tracked) transcripts.apply(tracked);
    },
    provisionalText: (itemId) => transcripts.getItem(itemId)?.provisionalText ?? '',
  };
}

function delta(itemId: string, chunk: string): unknown {
  return {
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: itemId,
    delta: chunk,
  };
}

function completed(itemId: string, transcript: string): unknown {
  return {
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  };
}

describe('adapter → transcript ledger (H4 incremental deltas)', () => {
  it('accumulates incremental chunks into the live provisional transcript', () => {
    const h = harness();
    h.feed({ type: 'input_audio_buffer.committed', item_id: 'item_001' });

    // The exact failing sequence from the review: each chunk is shorter than
    // the utterance, and chunk 3 is shorter than chunk 2.
    h.feed(delta('item_001', 'CandidCue '));
    expect(h.provisionalText('item_001')).toBe('CandidCue ');

    h.feed(delta('item_001', 'is following '));
    // Pre-fix this was 'is following ' — the longest single fragment.
    expect(h.provisionalText('item_001')).toBe('CandidCue is following ');

    h.feed(delta('item_001', 'my voice.'));
    expect(h.provisionalText('item_001')).toBe('CandidCue is following my voice.');
  });

  it('drives the same result from the recorded provider fixture', () => {
    const h = harness();
    for (const raw of singleTurn.events as unknown[]) h.feed(raw);
    expect(h.provisionalText('item_001')).toBe('CandidCue is following my voice.');
  });

  it('the authoritative completion still wins over the accumulator', () => {
    const h = harness();
    h.feed({ type: 'input_audio_buffer.committed', item_id: 'item_001' });
    h.feed(delta('item_001', 'candid q '));
    h.feed(delta('item_001', 'is folloing'));
    h.feed(completed('item_001', 'CandidCue is following.'));
    expect(h.provisionalText('item_001')).toBe('CandidCue is following.');
  });

  it('a late delta after completion cannot resurrect a stale prefix', () => {
    const h = harness();
    h.feed({ type: 'input_audio_buffer.committed', item_id: 'item_001' });
    h.feed(delta('item_001', 'CandidCue is following my voice.'));
    h.feed(completed('item_001', 'CandidCue is following my voice.'));
    h.feed(delta('item_001', ' and then some extra words that never happened'));
    expect(h.provisionalText('item_001')).toBe('CandidCue is following my voice.');
  });

  it('keeps two interleaved items' + ' accumulators separate', () => {
    const h = harness();
    h.feed({ type: 'input_audio_buffer.committed', item_id: 'item_001' });
    h.feed({ type: 'input_audio_buffer.committed', item_id: 'item_002' });
    h.feed(delta('item_001', 'first '));
    h.feed(delta('item_002', 'second '));
    h.feed(delta('item_001', 'utterance'));
    h.feed(delta('item_002', 'utterance'));
    expect(h.provisionalText('item_001')).toBe('first utterance');
    expect(h.provisionalText('item_002')).toBe('second utterance');
  });

  it('tolerates whitespace-only and empty chunks without losing the prefix', () => {
    const h = harness();
    h.feed({ type: 'input_audio_buffer.committed', item_id: 'item_001' });
    h.feed(delta('item_001', 'hello'));
    h.feed(delta('item_001', ''));
    h.feed(delta('item_001', '   '));
    h.feed(delta('item_001', 'world'));
    expect(h.provisionalText('item_001')).toBe('hello   world');
  });

  it('drops per-item accumulators on reset so a reconnect cannot splice utterances', () => {
    const commits = new CommitLedger();
    commits.beginSessionGeneration();
    const adapter = new TranscriptEventAdapter({ ledger: commits, now: () => 1 });
    adapter.adapt(delta('item_001', 'before reconnect '));
    adapter.reset();
    const after = adapter.adapt(delta('item_001', 'after reconnect'));
    expect(after).toMatchObject({ type: 'delta', text: 'after reconnect' });
  });
});
