import { describe, expect, it } from 'vitest';
import { TranscriptLedger } from '../../../src/shared/tracking/ledger';
import type { TranscriptEvent } from '../../../src/shared/tracking/types';
import outOfOrder from '../../fixtures/transcript-events/out-of-order-completion.json';
import duplicates from '../../fixtures/transcript-events/duplicates-and-stale.json';
import { mulberry32 } from '../helpers/rand';

function applyAll(ledger: TranscriptLedger, events: readonly TranscriptEvent[]): void {
  for (const event of events) ledger.apply(event);
}

function orderedText(ledger: TranscriptLedger): string {
  return ledger
    .itemsInOrder()
    .filter((i) => i.status === 'complete')
    .map((i) => i.finalText)
    .join(' ');
}

describe('TranscriptLedger (§30)', () => {
  it('keeps commit order when completion order differs (fixture)', () => {
    const ledger = new TranscriptLedger();
    applyAll(ledger, outOfOrder.events as unknown as TranscriptEvent[]);
    expect(orderedText(ledger)).toBe(outOfOrder.expectedOrderedText);
  });

  it('handles duplicates, stale generations, and conflicting completions (fixture)', () => {
    const ledger = new TranscriptLedger();
    applyAll(ledger, duplicates.events as unknown as TranscriptEvent[]);
    expect(orderedText(ledger)).toBe(duplicates.expectedOrderedText);
    const codes = ledger.recordedAnomalies().map((a) => a.code);
    for (const expected of duplicates.expectedAnomalyCodes) {
      expect(codes).toContain(expected);
    }
  });

  it('completed item supersedes later deltas (§30.7)', () => {
    const ledger = new TranscriptLedger();
    applyAll(ledger, [
      { type: 'item_started', sessionGeneration: 1, itemId: 'a', commitSequence: 1, audioStartMs: 0, receivedAtMs: 0 },
      { type: 'completed', sessionGeneration: 1, itemId: 'a', text: 'final words', receivedAtMs: 100 },
      { type: 'delta', sessionGeneration: 1, itemId: 'a', text: 'final words plus ghost', receivedAtMs: 150 },
    ]);
    expect(orderedText(ledger)).toBe('final words');
    const tail = ledger.getAlignableTail({ maxTokens: 30 });
    expect(tail.tokens.map((t) => t.normalized)).toEqual(['final', 'words']);
    expect(tail.final).toBe(true);
  });

  it('masks command items out of the alignable tail (§33.4)', () => {
    const ledger = new TranscriptLedger();
    applyAll(ledger, [
      { type: 'completed', sessionGeneration: 1, itemId: 'a', text: 'reading the script', receivedAtMs: 10 },
      { type: 'completed', sessionGeneration: 1, itemId: 'b', text: 'candid cue pause', receivedAtMs: 20 },
    ]);
    ledger.setCommandDisposition(['b'], 'command');
    const tail = ledger.getAlignableTail({ maxTokens: 30 });
    expect(tail.itemIds).toEqual(['a']);
    expect(tail.tokens.map((t) => t.normalized)).toEqual(['reading', 'the', 'script']);
  });

  it('classifies fillers and content in tail tokens (§30.6)', () => {
    const ledger = new TranscriptLedger();
    ledger.apply({
      type: 'completed', sessionGeneration: 1, itemId: 'a',
      text: 'um the kaleidoscope demo', receivedAtMs: 10,
    });
    const tail = ledger.getAlignableTail({ maxTokens: 10 });
    const byWord = new Map(tail.tokens.map((t) => [t.normalized, t]));
    expect(byWord.get('um')?.filler).toBe(true);
    expect(byWord.get('the')?.content).toBe(false);
    expect(byWord.get('kaleidoscope')?.content).toBe(true);
  });

  it('event permutations consistent with item order produce the same ledger (§55.3 property)', () => {
    const base: TranscriptEvent[] = [];
    for (let i = 0; i < 5; i++) {
      base.push({
        type: 'item_started', sessionGeneration: 1, itemId: `i${i}`,
        commitSequence: i + 1, audioStartMs: i * 1000, receivedAtMs: i * 1000,
      });
      base.push({
        type: 'completed', sessionGeneration: 1, itemId: `i${i}`,
        text: `item ${i} words number${i}`, receivedAtMs: i * 1000 + 500,
      });
    }
    const reference = new TranscriptLedger();
    applyAll(reference, base);
    const referenceText = orderedText(reference);

    const rand = mulberry32(99);
    for (let trial = 0; trial < 50; trial++) {
      // Shuffle while keeping each item's own started-before-completed order.
      const shuffled = [...base];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const a = shuffled[i];
        const b = shuffled[j];
        if (a === undefined || b === undefined) continue;
        const sameItem =
          'itemId' in a && 'itemId' in b && a.itemId === b.itemId;
        if (sameItem) continue;
        shuffled[i] = b;
        shuffled[j] = a;
      }
      const ledger = new TranscriptLedger();
      applyAll(ledger, shuffled);
      expect(orderedText(ledger)).toBe(referenceText);
    }
  });

  it('resets on a new session generation (§30.7)', () => {
    const ledger = new TranscriptLedger();
    ledger.apply({ type: 'completed', sessionGeneration: 1, itemId: 'a', text: 'old words', receivedAtMs: 10 });
    ledger.apply({ type: 'completed', sessionGeneration: 2, itemId: 'b', text: 'new words', receivedAtMs: 20 });
    expect(orderedText(ledger)).toBe('new words');
    // Late event from generation 1 is ignored.
    ledger.apply({ type: 'completed', sessionGeneration: 1, itemId: 'c', text: 'ghost', receivedAtMs: 30 });
    expect(orderedText(ledger)).toBe('new words');
  });
});
