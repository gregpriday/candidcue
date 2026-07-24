import { describe, expect, it } from 'vitest';
import { CommitLedger } from './commitLedger';
import { normalizeLogprobs, TranscriptEventAdapter } from './eventAdapter';
import type { TranscriptEvent } from '../../../shared/contracts';
import singleTurn from '../../../../tests/fixtures/audio/realtime-single-turn.json';
import outOfOrder from '../../../../tests/fixtures/audio/realtime-two-turns-out-of-order.json';
import errorEvents from '../../../../tests/fixtures/audio/realtime-errors.json';
import unknownEvents from '../../../../tests/fixtures/audio/realtime-unknown-events.json';

function makeAdapter(): { adapter: TranscriptEventAdapter; ledger: CommitLedger } {
  const ledger = new CommitLedger();
  ledger.beginSessionGeneration();
  const adapter = new TranscriptEventAdapter({ ledger, now: () => 12345 });
  return { adapter, ledger };
}

function commitPending(ledger: CommitLedger, n: number): void {
  for (let i = 0; i < n; i += 1) {
    ledger.recordPending({ reason: 'vad_silence', speechStartMs: i * 1000, speechEndMs: i * 1000 + 900 });
  }
}

describe('TranscriptEventAdapter (spec E.4/§30.1)', () => {
  it('adapts a full single-turn sequence into item_started, deltas, completed', () => {
    const { adapter, ledger } = makeAdapter();
    commitPending(ledger, 1);
    const events = (singleTurn.events as unknown[])
      .map((raw) => adapter.adapt(raw))
      .filter((e): e is TranscriptEvent => e !== null);

    expect(events.map((e) => e.type)).toEqual([
      'item_started',
      'delta',
      'delta',
      'delta',
      'completed',
    ]);
    expect(events[0]).toEqual({ type: 'item_started', itemId: 'item_001', commitSequence: 1 });
    const deltas = events.filter((e) => e.type === 'delta') as Extract<TranscriptEvent, { type: 'delta' }>[];
    expect(deltas.map((d) => d.text).join('')).toBe('CandidCue is following my voice.');
    expect(deltas[0]?.receivedAtMs).toBe(12345);
    const completed = events.at(-1) as Extract<TranscriptEvent, { type: 'completed' }>;
    expect(completed.text).toBe('CandidCue is following my voice.');
    expect(completed.logprobs).toHaveLength(7);
    expect(completed.logprobs?.[0]).toEqual({ token: 'Candid', logprob: -0.12 });
  });

  it('accepts JSON strings (data-channel payloads)', () => {
    const { adapter, ledger } = makeAdapter();
    commitPending(ledger, 1);
    const event = adapter.adapt(JSON.stringify(singleTurn.events[0]));
    expect(event).toEqual({ type: 'item_started', itemId: 'item_001', commitSequence: 1 });
  });

  it('keeps commitSequence association when completions arrive out of order', () => {
    const { adapter, ledger } = makeAdapter();
    commitPending(ledger, 2);
    const events = (outOfOrder.events as unknown[])
      .map((raw) => adapter.adapt(raw))
      .filter((e): e is TranscriptEvent => e !== null);

    const started = events.filter((e) => e.type === 'item_started') as Extract<
      TranscriptEvent,
      { type: 'item_started' }
    >[];
    expect(started).toEqual([
      { type: 'item_started', itemId: 'item_001', commitSequence: 1 },
      { type: 'item_started', itemId: 'item_002', commitSequence: 2 },
    ]);

    // Completions arrived item_002 first — the ledger still orders them.
    const completed = events.filter((e) => e.type === 'completed') as Extract<
      TranscriptEvent,
      { type: 'completed' }
    >[];
    expect(completed[0]?.itemId).toBe('item_002');
    expect(ledger.getCommitSequenceForItem('item_001')).toBe(1);
    expect(ledger.getCommitSequenceForItem('item_002')).toBe(2);
    const bySequence = [...completed].sort(
      (a, b) =>
        (ledger.getCommitSequenceForItem(a.itemId) ?? 0) - (ledger.getCommitSequenceForItem(b.itemId) ?? 0),
    );
    expect(bySequence.map((e) => e.itemId)).toEqual(['item_001', 'item_002']);
    // Missing logprobs (null) must not break anything (§27.5).
    expect(completed[0]?.logprobs).toBeUndefined();
  });

  it('maps provider failures per the E.7 table', () => {
    const { adapter } = makeAdapter();
    const events = (errorEvents.events as unknown[])
      .map((raw) => adapter.adapt(raw))
      .filter((e): e is TranscriptEvent => e !== null);

    expect(events.every((e) => e.type === 'failed')).toBe(true);
    const failed = events as Extract<TranscriptEvent, { type: 'failed' }>[];
    expect(failed[0]).toMatchObject({ itemId: 'item_009', code: 'PROVIDER_UNAVAILABLE', recoverable: true });
    expect(failed[1]).toMatchObject({ code: 'AUTH_KEY_INVALID', recoverable: false });
    expect(failed[2]).toMatchObject({ code: 'RATE_LIMITED', recoverable: true });
    expect(failed[3]).toMatchObject({ code: 'REALTIME_CONNECTION_LOST', recoverable: true });
    expect(failed[4]).toMatchObject({ code: 'QUOTA_EXHAUSTED', recoverable: false });
  });

  it('returns null for unknown/bookkeeping events but remembers them redacted', () => {
    const { adapter } = makeAdapter();
    for (const raw of unknownEvents.events as unknown[]) {
      expect(adapter.adapt(raw)).toBeNull();
    }
    const diagnostics = adapter.getDiagnosticEvents();
    expect(diagnostics.length).toBe(unknownEvents.events.length);
    const future = diagnostics.find((d) => d.type === 'some.future.event_type');
    expect(future?.audio).toBe('[redacted]');
  });

  it('ignores a committed event with no matching local commit', () => {
    const { adapter } = makeAdapter(); // no pending commits recorded
    expect(adapter.adapt({ type: 'input_audio_buffer.committed', item_id: 'item_x' })).toBeNull();
  });

  it('flags unparseable payloads as recoverable provider failures', () => {
    const { adapter } = makeAdapter();
    expect(adapter.adapt('{not json')).toMatchObject({ type: 'failed', recoverable: true });
  });
});

describe('normalizeLogprobs', () => {
  it('filters malformed entries and returns undefined for empty/absent input', () => {
    expect(normalizeLogprobs(null)).toBeUndefined();
    expect(normalizeLogprobs([])).toBeUndefined();
    expect(normalizeLogprobs([{ token: 'a', logprob: -0.5 }, { bad: true }, 'x'])).toEqual([
      { token: 'a', logprob: -0.5 },
    ]);
  });
});
