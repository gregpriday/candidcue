import { beforeEach, describe, expect, it } from 'vitest';
import { CommitLedger } from './commitLedger';
import { ManualCommitDriver } from './commitDriver';
import type { CommitReason } from '../../../shared/contracts';

describe('CommitLedger (spec §29.3)', () => {
  it('assigns a monotonically increasing commitSequence across generations', () => {
    const ledger = new CommitLedger();
    ledger.beginSessionGeneration();
    const a = ledger.recordPending({ reason: 'vad_silence', speechStartMs: 0, speechEndMs: 900 });
    const b = ledger.recordPending({ reason: 'max_utterance', speechStartMs: 1000, speechEndMs: 6000 });
    expect(a.commitSequence).toBe(1);
    expect(b.commitSequence).toBe(2);
    expect(a.sessionGeneration).toBe(1);
    ledger.beginSessionGeneration();
    const c = ledger.recordPending({ reason: 'vad_silence', speechStartMs: 0, speechEndMs: 100 });
    expect(c.commitSequence).toBe(3); // never reused
    expect(c.sessionGeneration).toBe(2);
  });

  it('associates item ids FIFO and is idempotent per item', () => {
    const ledger = new CommitLedger();
    ledger.beginSessionGeneration();
    ledger.recordPending({ reason: 'vad_silence', speechStartMs: 0, speechEndMs: 1 });
    ledger.recordPending({ reason: 'vad_silence', speechStartMs: 2, speechEndMs: 3 });
    expect(ledger.associateItem('item_a')?.commitSequence).toBe(1);
    expect(ledger.associateItem('item_a')?.commitSequence).toBe(1); // idempotent
    expect(ledger.associateItem('item_b')?.commitSequence).toBe(2);
    expect(ledger.associateItem('item_c')).toBeNull(); // nothing pending
    expect(ledger.getByItemId('item_b')?.reason).toBe('vad_silence');
  });

  it('drops unassociated pendings on a new session generation', () => {
    const ledger = new CommitLedger();
    ledger.beginSessionGeneration();
    ledger.recordPending({ reason: 'vad_silence', speechStartMs: 0, speechEndMs: 1 });
    ledger.beginSessionGeneration();
    expect(ledger.associateItem('item_after_reconnect')).toBeNull();
  });
});

describe('ManualCommitDriver (spec §29.3, E.3)', () => {
  let ledger: CommitLedger;
  let sent: CommitReason[];
  let cleared: number;
  let driver: ManualCommitDriver;

  beforeEach(() => {
    ledger = new CommitLedger();
    ledger.beginSessionGeneration();
    sent = [];
    cleared = 0;
    driver = new ManualCommitDriver({
      sendCommit: (reason) => sent.push(reason),
      clearBufferedAudio: () => {
        cleared += 1;
      },
      ledger,
      now: () => 9999,
      getAlignmentAnchor: () => 42,
      isLikelyCommand: () => false,
    });
  });

  it('commits when VAD closes a speech turn, recording full meta', () => {
    driver.handleVadEvent({ type: 'speech_started', atMs: 1000 });
    driver.handleVadEvent({ type: 'speech_ended', atMs: 2420, speechStartMs: 1000, durationMs: 1000 });
    expect(sent).toEqual(['vad_silence']);
    const meta = ledger.getCommits()[0];
    expect(meta).toMatchObject({
      commitSequence: 1,
      reason: 'vad_silence',
      speechStartMs: 1000,
      speechEndMs: 2420,
      alignmentAnchor: 42,
      likelyCommand: false,
      sessionGeneration: 1,
    });
    expect(driver.hasUncommittedSpeech).toBe(false);
  });

  it('forces a commit at max utterance and keeps the segment open', () => {
    driver.handleVadEvent({ type: 'speech_started', atMs: 0 });
    driver.handleVadEvent({ type: 'max_utterance', atMs: 5000, speechStartMs: 0, durationMs: 5000 });
    expect(sent).toEqual(['max_utterance']);
    expect(driver.hasUncommittedSpeech).toBe(true);
    // The tail commits from the forced boundary onward.
    driver.handleVadEvent({ type: 'speech_ended', atMs: 7000, speechStartMs: 0, durationMs: 6580 });
    expect(sent).toEqual(['max_utterance', 'vad_silence']);
  });

  it('suppresses commits for empty segments; teardown reasons clear the buffer instead', () => {
    driver.forceCommit('soft_pause');
    expect(sent).toEqual([]);
    expect(cleared).toBe(1); // E.3: never commit an empty segment
    driver.forceCommit('command_finalization');
    expect(cleared).toBe(1); // non-teardown reason: no clear either
    expect(sent).toEqual([]);
  });

  it('commits pending speech immediately on pause/stop/mic switch', () => {
    driver.handleVadEvent({ type: 'speech_started', atMs: 100 });
    driver.forceCommit('mic_switch');
    expect(sent).toEqual(['mic_switch']);
    const meta = ledger.getCommits()[0];
    expect(meta?.speechStartMs).toBe(100);
    expect(meta?.speechEndMs).toBe(9999); // injected clock
    expect(driver.hasUncommittedSpeech).toBe(false);
  });

  it('ignores speech_ended without a preceding start (stale VAD after reset)', () => {
    driver.reset();
    driver.handleVadEvent({ type: 'speech_ended', atMs: 500, speechStartMs: 0, durationMs: 400 });
    expect(sent).toEqual([]);
  });
});
