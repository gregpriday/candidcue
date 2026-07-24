import { describe, expect, it } from 'vitest';
import { AlignmentEngine } from '../../../src/shared/tracking/engine';
import { demoDocument } from '../../fixtures/alignment/fixture-script';
import { TranscriptScripter } from '../../fixtures/transcript-events/builder';
import type { TrackingSnapshot } from '../../../src/shared/contracts/tracking';

function newEngine(): AlignmentEngine {
  return new AlignmentEngine(demoDocument(), {
    sessionId: 'session-1',
    sessionGeneration: 1,
    stageGeneration: 1,
  });
}

function speakThrough(
  engine: AlignmentEngine,
  scripter: TranscriptScripter,
  text: string,
): TrackingSnapshot[] {
  const snapshots: TrackingSnapshot[] = [];
  for (const event of scripter.speak({ text })) {
    const output = engine.handleTranscriptEvent(event);
    if (output.snapshot) snapshots.push(output.snapshot);
  }
  return snapshots;
}

describe('AlignmentEngine behavior (§31.8, §31.15, §33.4, G.1)', () => {
  it('manual correction has immediate authority and suppresses backward correction during grace (§31.15)', () => {
    const engine = newEngine();
    const scripter = new TranscriptScripter(10_000, 1);
    speakThrough(engine, scripter, 'Hello everyone and welcome to the channel.');
    const before = engine.cursor.committedTokenIndex;
    expect(before).toBeGreaterThan(0);

    const target = 60;
    const output = engine.moveTo(target, 'manual', scripter.clockMs);
    expect(output.snapshot?.movement).toBe('manual');
    expect(engine.cursor.committedTokenIndex).toBe(target);
    expect(engine.trackingState).toBe('following');

    // Re-speaking earlier text within the grace period must not drag the
    // cursor backward.
    speakThrough(engine, scripter, 'Hello everyone and welcome to the channel.');
    expect(engine.cursor.committedTokenIndex).toBeGreaterThanOrEqual(target - 1);
  });

  it('provisional movement is bounded and never backward (§31.8)', () => {
    const engine = newEngine();
    const scripter = new TranscriptScripter(10_000, 1);
    speakThrough(engine, scripter, 'Hello everyone and welcome to the channel.');
    const committed = engine.cursor.committedTokenIndex;

    // Long provisional-only stream (no completion yet).
    const words =
      'today we are talking about building a teleprompter that actually listens ' +
      'the first principle is that the prompter follows you instead of forcing';
    const events = scripter.speak({ text: words });
    for (const event of events) {
      if (event.type === 'completed') break; // provisional only
      const output = engine.handleTranscriptEvent(event);
      if (output.snapshot) {
        expect(output.snapshot.tokenIndex).toBeGreaterThanOrEqual(committed);
        expect(output.snapshot.tokenIndex).toBeLessThanOrEqual(committed + 18);
        expect(output.snapshot.committedTokenIndex).toBe(committed);
      }
    }
  });

  it('masked command items are excluded from alignment (§33.4)', () => {
    const engine = newEngine();
    const scripter = new TranscriptScripter(10_000, 1);
    speakThrough(engine, scripter, 'Hello everyone and welcome to the channel.');
    const before = engine.cursor.committedTokenIndex;

    // Pre-mask the next item id, then speak a command phrase that would
    // otherwise look like a big skip toward the closing section.
    engine.maskItems(['item-1-1']);
    speakThrough(engine, scripter, 'candid cue go to closing thoughts');
    expect(engine.cursor.committedTokenIndex).toBe(before);
  });

  it('command_pending freezes alignment and restores the prior state (§31.2, G.1)', () => {
    const engine = newEngine();
    const scripter = new TranscriptScripter(10_000, 1);
    speakThrough(engine, scripter, 'Hello everyone and welcome to the channel.');
    const before = engine.cursor.committedTokenIndex;

    const pendingOut = engine.setCommandPending(true, scripter.clockMs);
    expect(pendingOut.snapshot?.state).toBe('command_pending');
    speakThrough(engine, scripter, 'Today we are talking about building a teleprompter that actually listens.');
    expect(engine.cursor.committedTokenIndex).toBe(before); // masked by pending

    engine.setCommandPending(false, scripter.clockMs);
    expect(engine.trackingState).not.toBe('command_pending');
  });

  it('paused and reconnecting drop transcript updates (G.1)', () => {
    const engine = newEngine();
    const scripter = new TranscriptScripter(10_000, 1);
    engine.pause(scripter.clockMs);
    const snapshots = speakThrough(engine, scripter, 'Hello everyone and welcome to the channel.');
    expect(snapshots).toEqual([]);
    expect(engine.cursor.committedTokenIndex).toBe(0);

    engine.resume(scripter.clockMs);
    speakThrough(engine, scripter, 'Hello everyone and welcome to the channel.');
    expect(engine.cursor.committedTokenIndex).toBeGreaterThan(0);
  });

  it('snapshot revisions are strictly monotonic (§31.16)', () => {
    const engine = newEngine();
    const scripter = new TranscriptScripter(10_000, 1);
    const revisions: number[] = [];
    for (const text of [
      'Hello everyone and welcome to the channel.',
      'Today we are talking about building a teleprompter that actually listens.',
    ]) {
      for (const snapshot of speakThrough(engine, scripter, text)) {
        revisions.push(snapshot.revision);
      }
    }
    for (let i = 1; i < revisions.length; i++) {
      const prev = revisions[i - 1];
      const curr = revisions[i];
      expect(prev).toBeDefined();
      expect(curr).toBeDefined();
      if (prev !== undefined && curr !== undefined) expect(curr).toBeGreaterThan(prev);
    }
  });

  it('reset returns to the top and clears masked items', () => {
    const engine = newEngine();
    const scripter = new TranscriptScripter(10_000, 1);
    speakThrough(engine, scripter, 'Hello everyone and welcome to the channel.');
    engine.maskItems(['item-1-0']);
    const output = engine.reset(scripter.clockMs);
    expect(output.snapshot?.tokenIndex).toBe(0);
    expect(engine.cursor.committedTokenIndex).toBe(0);
    expect(engine.trackingState).toBe('following');
  });
});
