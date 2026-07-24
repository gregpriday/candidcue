/**
 * Weighted alignment and reconciliation (§16.3.4, §16.5, §29.2).
 *
 * The `existing` detections handed to the reconciler are produced by the real
 * Layer A detector, and the realtime token stream is produced by the real
 * tokenizer — the test never assembles the intermediate state whose handling
 * it then asserts.
 */
import { describe, expect, it } from 'vitest';
import { createFillerLexicon } from '../../../../src/shared/coaching/disfluency/filler-lexicon';
import { RealtimeFillerDetector } from '../../../../src/shared/coaching/disfluency/realtime-filler-detector';
import {
  alignSequences,
  reconcilePrecisionResult,
} from '../../../../src/shared/coaching/disfluency/transcript-reconciler';
import type {
  AuthoredSpanContext,
  PrecisionTranscriptResult,
} from '../../../../src/shared/coaching/disfluency/types';
import { tokenizeUtterance } from '../../../../src/shared/coaching/disfluency/utterance';

const TAKE = { takePassId: 'take-1', trackingEpoch: 1 };
const LEXICON = createFillerLexicon();

const AUTHORED: AuthoredSpanContext = {
  spanId: 'span-1',
  scriptAnchorTokenId: 'tok-1',
  text: 'We should ship it now.',
};

function realtimeTokens(text: string, startMs = 10_000, endMs = 14_000) {
  return tokenizeUtterance(text, { audioStartMs: startMs, audioEndMs: endMs });
}

function detectionsFor(text: string, authored = AUTHORED, startMs = 10_000, endMs = 14_000) {
  const detector = new RealtimeFillerDetector({ lexicon: LEXICON });
  return detector.observeFinal(
    {
      itemId: 'item-1',
      commitSequence: 4,
      audioStartMs: startMs,
      audioEndMs: endMs,
      text,
    },
    authored,
    TAKE,
  ).detections;
}

function precision(text: string, startMs = 10_000, endMs = 14_000): PrecisionTranscriptResult {
  return {
    chunkId: 'chunk-1',
    audioStartMs: startMs,
    audioEndMs: endMs,
    takePassId: TAKE.takePassId,
    trackingEpoch: TAKE.trackingEpoch,
    commitSequence: 4,
    text,
  };
}

describe('alignSequences', () => {
  const isFillerLike = (token: string): boolean => LEXICON.matchStrict(token) !== null;

  it('marks a precision-only token as an insertion, not a substitution', () => {
    const ops = alignSequences(
      ['we', 'should', 'ship', 'it'],
      ['we', 'should', 'um', 'ship', 'it'],
      isFillerLike,
    );
    expect(ops.map((op) => op.op)).toEqual(['match', 'match', 'insert', 'match', 'match']);
    const insert = ops.find((op) => op.op === 'insert');
    expect(insert).toEqual({ op: 'insert', precisionIndex: 2 });
  });

  it('marks a realtime-only token as a deletion when precision dropped a word', () => {
    const ops = alignSequences(['we', 'should', 'ship'], ['we', 'ship'], isFillerLike);
    expect(ops.map((op) => op.op)).toEqual(['match', 'delete', 'match']);
  });

  it('treats number and contraction spellings as matches, not disfluencies', () => {
    const ops = alignSequences(
      ['we', 'have', '15', 'left'],
      ['we', "we've", 'fifteen', 'left'],
      isFillerLike,
    );
    expect(ops.map((op) => op.op)).not.toContain('insert');
  });
});

describe('precision-only insertions', () => {
  it('creates a confirmed strict filler the realtime path dropped', () => {
    const outcome = reconcilePrecisionResult({
      result: precision('We should um ship it now.'),
      realtimeTokens: realtimeTokens('We should ship it now.'),
      existing: [],
      authored: AUTHORED,
      take: TAKE,
      lexicon: LEXICON,
    });
    expect(outcome.created).toHaveLength(1);
    expect(outcome.created[0]?.event.kind).toBe('strict_vocalized');
    expect(outcome.created[0]?.event.confidence).toBe('confirmed');
    expect(outcome.created[0]?.event.displayForm).toBe('um');
  });

  it('still applies the §16.4 gate to a precision-only contextual token', () => {
    const embedded = reconcilePrecisionResult({
      result: precision('We should like ship it now.'),
      realtimeTokens: realtimeTokens('We should ship it now.'),
      existing: [],
      authored: AUTHORED,
      take: TAKE,
      lexicon: LEXICON,
    });
    // A verbatim transcript proves the word was said. It does not prove it was
    // a filler, and "should like ship" is not set off by anything.
    expect(embedded.created).toEqual([]);

    const isolated = reconcilePrecisionResult({
      result: precision('We should, like, ship it now.'),
      realtimeTokens: realtimeTokens('We should ship it now.'),
      existing: [],
      authored: AUTHORED,
      take: TAKE,
      lexicon: LEXICON,
    });
    expect(isolated.created).toHaveLength(1);
    expect(isolated.created[0]?.event.kind).toBe('contextual');
    expect(isolated.created[0]?.event.displayForm).toBeNull();
  });

  it('does not count a precision-only filler the script authored', () => {
    const outcome = reconcilePrecisionResult({
      result: precision('We should um ship it now.'),
      realtimeTokens: realtimeTokens('We should ship it now.'),
      existing: [],
      authored: { ...AUTHORED, text: 'We should, um, ship it now.' },
      take: TAKE,
      lexicon: LEXICON,
    });
    expect(outcome.created[0]?.event.authoredIntentional).toBe(true);
  });
});

describe('promotion and demotion', () => {
  it('demotes a realtime detection the verbatim pass contradicts', () => {
    const existing = detectionsFor('We should, um, ship it now.');
    expect(existing).toHaveLength(1);

    const outcome = reconcilePrecisionResult({
      result: precision('We should ship it now.'),
      realtimeTokens: realtimeTokens('We should, um, ship it now.'),
      existing,
      authored: AUTHORED,
      take: TAKE,
      lexicon: LEXICON,
    });
    expect(outcome.demoted).toEqual([existing[0]?.event.eventId]);
    expect(outcome.promoted).toEqual([]);
  });

  it('treats an empty precision result as a failed pass, not as clean delivery', () => {
    const existing = detectionsFor('We should, um, ship it now.');
    const outcome = reconcilePrecisionResult({
      result: precision('   '),
      realtimeTokens: realtimeTokens('We should, um, ship it now.'),
      existing,
      authored: AUTHORED,
      take: TAKE,
      lexicon: LEXICON,
    });
    expect(outcome.demoted).toEqual([]);
    expect(outcome.created).toEqual([]);
  });

  it('says nothing about events outside the interval the chunk covers', () => {
    const existing = detectionsFor('We should, um, ship it now.', AUTHORED, 40_000, 44_000);
    const outcome = reconcilePrecisionResult({
      // A chunk from a completely different part of the take.
      result: precision('We should ship it now.', 10_000, 14_000),
      realtimeTokens: realtimeTokens('We should ship it now.', 10_000, 14_000),
      existing,
      authored: AUTHORED,
      take: TAKE,
      lexicon: LEXICON,
    });
    expect(outcome.demoted).toEqual([]);
    expect(outcome.promoted).toEqual([]);
  });

  it('promotes a detection the verbatim pass agrees with', () => {
    const existing = detectionsFor('We should, um, ship it now.');
    const outcome = reconcilePrecisionResult({
      result: precision('We should um ship it now.'),
      realtimeTokens: realtimeTokens('We should, um, ship it now.'),
      existing,
      authored: AUTHORED,
      take: TAKE,
      lexicon: LEXICON,
    });
    expect(outcome.promoted).toEqual([existing[0]?.event.eventId]);
    expect(outcome.created).toEqual([]);
    // Both transcripts contain the "um", so it aligns as a match rather than
    // an insertion: there is nothing to de-duplicate, only to promote.
    expect(outcome.deduplicated).toEqual([]);
  });
});
