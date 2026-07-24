/**
 * Provider log probabilities → per-token ASR confidence (spec §30.5, §60).
 *
 * `requestLogprobs: true` is set on every realtime session and the values are
 * transported all the way to the tracking worker, but `TranscriptLedger`
 * built its tokens without a `confidence` field, so `getAlignableTail`'s
 * `token.confidence ?? 1` pinned the answer at 1.0 for the life of the app.
 * These tests cover the mapping that closes that gap, and the two ways it is
 * allowed to answer "I don't know".
 */
import { describe, expect, it } from 'vitest';
import { tokenConfidencesFromLogprobs } from '../../../src/shared/tracking/transcript-confidence';
import { TranscriptLedger } from '../../../src/shared/tracking/ledger';
import { AlignmentEngine } from '../../../src/shared/tracking/engine';
import { confidenceModel } from '../../../src/shared/tracking/confidence';
import { DEFAULT_TRACKING_PROFILE } from '../../../src/shared/tracking/profile';
import { demoDocument } from '../../fixtures/alignment/fixture-script';
import { TranscriptScripter } from '../../fixtures/transcript-events/builder';
import type { TokenLogprob } from '../../../src/shared/contracts/tracking';
import type { SequenceAlignment, TranscriptEvent } from '../../../src/shared/tracking/types';

/** The shape the fixture `realtime-single-turn.json` actually returns. */
const SINGLE_TURN_TEXT = 'CandidCue is following my voice.';
const SINGLE_TURN_LOGPROBS: TokenLogprob[] = [
  { token: 'Candid', logprob: -0.12 },
  { token: 'Cue', logprob: -0.31 },
  { token: ' is', logprob: -0.02 },
  { token: ' following', logprob: -0.05 },
  { token: ' my', logprob: -0.01 },
  { token: ' voice', logprob: -0.04 },
  { token: '.', logprob: -0.01 },
];

/** Uniform logprobs for `text`, one piece per word, at a chosen probability. */
function evenLogprobs(text: string, probability: number): TokenLogprob[] {
  return text
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((word, index) => ({
      token: index === 0 ? word : ` ${word}`,
      logprob: Math.log(probability),
    }));
}

describe('tokenConfidencesFromLogprobs (§30.5)', () => {
  it('regroups subword pieces into words — seven pieces, five words', () => {
    const out = tokenConfidencesFromLogprobs(SINGLE_TURN_TEXT, SINGLE_TURN_LOGPROBS);
    expect(out).toHaveLength(5); // candidcue is following my voice
    // `CandidCue` is two pieces; its confidence is their GEOMETRIC mean, not
    // the joint probability — being split by the tokenizer is not evidence of
    // uncertainty. exp((-0.12 + -0.31)/2) ≈ 0.807; exp(-0.43) ≈ 0.651.
    expect(out![0]).toBeCloseTo(Math.exp(-0.215), 6);
    expect(out![1]).toBeCloseTo(Math.exp(-0.02), 6);
    expect(out![4]).toBeCloseTo(Math.exp(-0.04), 6);
  });

  it('a punctuation piece neither adds a token nor dilutes the word it follows', () => {
    // The trailing `.` arrives glued to `voice` with no leading space. It must
    // not shift every later confidence by one, and the model's certainty about
    // a full stop is not certainty about the word.
    const out = tokenConfidencesFromLogprobs(SINGLE_TURN_TEXT, SINGLE_TURN_LOGPROBS)!;
    expect(out[out.length - 1]).toBeCloseTo(Math.exp(-0.04), 6); // "voice", not "voice."
  });

  it('one raw word that normalizes to several tokens shares its confidence', () => {
    // `normalizeText` splits hyphens and expands `%`; both are one provider
    // word, so both normalized tokens carry that word's certainty.
    const out = tokenConfidencesFromLogprobs('forty-two percent', [
      { token: 'forty', logprob: -0.5 },
      { token: '-two', logprob: -0.5 },
      { token: ' percent', logprob: -0.1 },
    ]);
    expect(out).toEqual([
      Math.exp(-0.5),
      Math.exp(-0.5),
      Math.exp(-0.1),
    ]);
  });

  it('handles a provider that puts the space inside the piece', () => {
    const out = tokenConfidencesFromLogprobs('hello there', [
      { token: 'hello ', logprob: -0.2 },
      { token: 'there', logprob: -0.4 },
    ]);
    expect(out).toEqual([Math.exp(-0.2), Math.exp(-0.4)]);
  });

  it('returns undefined rather than guessing when the pieces do not rebuild the text', () => {
    // A confidence attached to the wrong word moves a threshold on evidence
    // about a different part of the sentence, which is worse than none.
    expect(
      tokenConfidencesFromLogprobs('the quick brown fox', evenLogprobs('the quick brown', 0.9)),
    ).toBeUndefined();
    expect(
      tokenConfidencesFromLogprobs('the quick brown fox', [
        { token: 'the', logprob: -0.1 },
        { token: ' slow', logprob: -0.1 },
        { token: ' brown', logprob: -0.1 },
        { token: ' fox', logprob: -0.1 },
      ]),
    ).toBeUndefined();
  });

  it('rejects malformed entries instead of producing NaN weights', () => {
    expect(
      tokenConfidencesFromLogprobs('hello there', [
        { token: 'hello', logprob: -0.2 },
        { token: ' there', logprob: Number.NaN },
      ]),
    ).toBeUndefined();
    expect(tokenConfidencesFromLogprobs('hello', [])).toBeUndefined();
    expect(tokenConfidencesFromLogprobs('hello', undefined)).toBeUndefined();
  });
});

describe('the ledger carries confidence into the alignable tail (§30.5)', () => {
  function ledgerWith(
    text: string,
    logprobs?: TokenLogprob[],
  ): TranscriptLedger {
    const ledger = new TranscriptLedger();
    ledger.setSessionGeneration(1);
    ledger.apply({
      type: 'item_started',
      sessionGeneration: 1,
      itemId: 'item-1',
      commitSequence: 1,
      audioStartMs: 0,
      receivedAtMs: 0,
    });
    ledger.apply({
      type: 'completed',
      sessionGeneration: 1,
      itemId: 'item-1',
      text,
      ...(logprobs ? { logprobs } : {}),
      receivedAtMs: 10,
    });
    return ledger;
  }

  it('a low-confidence token arrives at the tail with its real value, not 1', () => {
    const ledger = ledgerWith('barely audible words here', [
      { token: 'barely', logprob: Math.log(0.31) },
      { token: ' audible', logprob: Math.log(0.22) },
      { token: ' words', logprob: Math.log(0.9) },
      { token: ' here', logprob: Math.log(0.9) },
    ]);
    const tail = ledger.getAlignableTail({ maxTokens: 30 });
    expect(tail.tokens.map((t) => t.confidence)).toEqual([0.31, 0.22, 0.9, 0.9]);
    // The tail mean is what the confidence model consumes.
    expect(tail.confidence).toBeCloseTo((0.31 + 0.22 + 0.9 + 0.9) / 4, 10);
    expect(tail.confidence).toBeLessThan(1);
  });

  it('no logprobs still means confidence 1 — absence is not low confidence', () => {
    const tail = ledgerWith('barely audible words here').getAlignableTail({ maxTokens: 30 });
    expect(tail.tokens.every((t) => t.confidence === undefined)).toBe(true);
    expect(tail.confidence).toBe(1);
  });

  it('provisional deltas carry no confidence; the completion supplies it', () => {
    const ledger = new TranscriptLedger();
    ledger.setSessionGeneration(1);
    ledger.apply({
      type: 'item_started',
      sessionGeneration: 1,
      itemId: 'item-1',
      commitSequence: 1,
      audioStartMs: 0,
      receivedAtMs: 0,
    });
    ledger.apply({
      type: 'delta',
      sessionGeneration: 1,
      itemId: 'item-1',
      text: 'barely audible',
      receivedAtMs: 5,
    });
    expect(
      ledger.getAlignableTail({ maxTokens: 30 }).tokens.every((t) => t.confidence === undefined),
    ).toBe(true);
    expect(ledger.getAlignableTail({ maxTokens: 30 }).confidence).toBe(1);

    ledger.apply({
      type: 'completed',
      sessionGeneration: 1,
      itemId: 'item-1',
      text: 'barely audible',
      logprobs: evenLogprobs('barely audible', 0.4),
      receivedAtMs: 10,
    });
    expect(ledger.getAlignableTail({ maxTokens: 30 }).confidence).toBeCloseTo(0.4, 10);
  });

  it('a conflicting completion replaces the confidences with its own (§30.7)', () => {
    const ledger = ledgerWith('barely audible', evenLogprobs('barely audible', 0.3));
    expect(ledger.getAlignableTail({ maxTokens: 30 }).confidence).toBeCloseTo(0.3, 10);
    // Latest authoritative completion wins — including for confidence, which
    // otherwise would describe text that is no longer in the ledger.
    ledger.apply({
      type: 'completed',
      sessionGeneration: 1,
      itemId: 'item-1',
      text: 'clearly audible',
      logprobs: evenLogprobs('clearly audible', 0.95),
      receivedAtMs: 20,
    });
    expect(ledger.getAlignableTail({ maxTokens: 30 }).confidence).toBeCloseTo(0.95, 10);

    // And a restatement with NO logprobs must not keep the old ones.
    ledger.apply({
      type: 'completed',
      sessionGeneration: 1,
      itemId: 'item-1',
      text: 'clearly audible indeed',
      receivedAtMs: 30,
    });
    expect(ledger.getAlignableTail({ maxTokens: 30 }).confidence).toBe(1);
  });
});

/* ---------------------------------------------------------------------------
 * The consumers. A value pinned at 1.0 since the beginning is only worth
 * carrying if something downstream moves when it changes — and the same tests
 * have to show that what moves is bounded, because every threshold in
 * `DEFAULT_TRACKING_PROFILE` was tuned against that constant.
 * ------------------------------------------------------------------------- */

describe('what responds to real transcript confidence', () => {
  const sequence: SequenceAlignment = {
    score: 9,
    normalizedScore: 0.9,
    scriptStartOffset: 0,
    scriptEndOffset: 6,
    matchedPairs: [],
    contentMatches: 5,
    longestOrderedRun: 5,
    matchedWeight: 5,
    rareAnchorMatches: 0,
  };

  it('confidenceModel (§31.7) — the only reader of the tail mean', () => {
    const certain = confidenceModel(
      { sequence, prior: 1, transcriptConfidence: 1, final: true },
      DEFAULT_TRACKING_PROFILE,
    );
    const doubtful = confidenceModel(
      { sequence, prior: 1, transcriptConfidence: 0.2, final: true },
      DEFAULT_TRACKING_PROFILE,
    );
    expect(doubtful).toBeLessThan(certain);
    // §30.5 layering: transcript confidence "contributes but cannot rescue" —
    // and equally, cannot destroy. The factor is `0.85 + 0.15·c`, so even a
    // hopeless transcript costs at most 15 % of the alignment confidence.
    // Anything larger would put the whole profile's threshold tuning at risk.
    expect(doubtful / certain).toBeGreaterThanOrEqual(0.85);
    expect(doubtful / certain).toBeLessThan(1);
  });

  it('end to end: the same words, badly heard, commit at lower confidence', () => {
    const speech = [
      'Hello everyone and welcome to the channel',
      'Today we are talking about building a teleprompter that actually listens',
    ];

    const readWith = (probability: number | null): number => {
      const engine = new AlignmentEngine(demoDocument(), {
        sessionId: `conf-${probability ?? 'none'}`,
        sessionGeneration: 1,
        stageGeneration: 1,
        layoutGeneration: 1,
      });
      const scripter = new TranscriptScripter(10_000, 1);
      let last = 0;
      for (const text of speech) {
        for (const event of scripter.speak({ text })) {
          const withLogprobs: TranscriptEvent =
            probability !== null && event.type === 'completed'
              ? { ...event, logprobs: evenLogprobs(event.text, probability) }
              : event;
          const output = engine.handleTranscriptEvent(withLogprobs);
          if (output.snapshot) last = output.snapshot.confidence;
        }
      }
      return last;
    };

    const clean = readWith(null); // today's behaviour: no logprobs at all
    const heard = readWith(0.97); // an ordinary, good transcript
    const muddy = readWith(0.2); // a genuinely bad one

    // Absence of evidence is not evidence of doubt: no logprobs must behave
    // exactly as it did before this signal existed.
    expect(heard).toBeLessThanOrEqual(clean);
    expect(muddy).toBeLessThan(clean);
    // …and the aligner still committed. §60 degradation is meant to make the
    // engine more cautious, not to stop it following.
    expect(muddy).toBeGreaterThan(0);
  });
});
