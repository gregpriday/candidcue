/**
 * Layer A detection (§16.1) and the §2.4 false-positive guarantee.
 *
 * The bulk of this file asserts **zero** events on ordinary English. A
 * detector that flagged every "and", "so", "like" and "right" would pass a
 * naive suite trivially, so every negative case here is paired with something
 * that proves the detector actually ran on that text: either an opener
 * observation, or an explicit assertion about *which* rule rejected the token.
 * `expect(detections).toHaveLength(0)` on its own would also pass for a
 * detector that returns a constant empty array — the positive controls in
 * `describe('detects real disfluencies')` are what make that impossible.
 */
import { describe, expect, it } from 'vitest';
import { createFillerLexicon } from '../../../../src/shared/coaching/disfluency/filler-lexicon';
import {
  RealtimeFillerDetector,
  type RealtimeDetectionResult,
} from '../../../../src/shared/coaching/disfluency/realtime-filler-detector';
import type {
  AuthoredSpanContext,
  RealtimeTranscriptItem,
} from '../../../../src/shared/coaching/disfluency/types';
import { isCountableFiller } from '../../../../src/shared/coaching/disfluency/types';

const TAKE = { takePassId: 'take-1', trackingEpoch: 7 };

function detector(options: { repetitionWindowMs?: number } = {}): RealtimeFillerDetector {
  return new RealtimeFillerDetector({
    lexicon: createFillerLexicon(),
    ...(options.repetitionWindowMs === undefined
      ? {}
      : { repetitionWindowMs: options.repetitionWindowMs }),
  });
}

function item(text: string, startMs = 1_000, endMs = 5_000): RealtimeTranscriptItem {
  return {
    itemId: `item-${startMs}`,
    commitSequence: 12,
    audioStartMs: startMs,
    audioEndMs: endMs,
    text,
  };
}

/**
 * Authored text that shares no vocabulary with the probe sentences, so the
 * only rule that can reject a contextual token is the lexical/structural one —
 * not "it was in the script".
 */
function authored(text = 'The quarterly figures moved in the direction we projected.'): AuthoredSpanContext {
  return { spanId: 'span-1', scriptAnchorTokenId: 'tok-9', text };
}

function fillerKinds(result: RealtimeDetectionResult): string[] {
  return result.detections.map((detection) => detection.event.kind);
}

describe('§2.4 ordinary language is not a filler', () => {
  const ordinary: Array<{ text: string; note: string }> = [
    { text: 'And then we continue with the rollout.', note: 'connector, used once' },
    { text: 'I like this approach a lot.', note: '"like" as a verb' },
    { text: 'It looks like a caching problem.', note: '"looks like" simile' },
    { text: 'We would like to ship on Friday.', note: '"would like to"' },
    { text: 'So we shipped it on Friday.', note: 'consequence connector' },
    { text: 'That is so much faster than before.', note: '"so much" intensifier' },
    { text: 'Turn right at the second junction.', note: '"right" as a direction' },
    { text: 'We got the right answer on the first pass.', note: '"right" as an adjective' },
    { text: 'Do you know the release date?', note: '"you know" as a real question' },
    { text: 'The migration works well under load.', note: '"well" as an adverb' },
    { text: 'As well as the second option, there is a third.', note: '"as well as"' },
    { text: 'It is a kind of caching layer.', note: '"a kind of" partitive' },
    { text: 'We had had a plan before that meeting.', note: 'legitimate doubled word' },
    { text: 'I mean what I say about the deadline.', note: '"I mean" as a verb phrase' },
    { text: 'Basically sound engineering carried the release.', note: 'sentence adverb, used once' },
  ];

  for (const probe of ordinary) {
    it(`emits nothing for: ${probe.note}`, () => {
      const result = detector().observeFinal(item(probe.text), authored(), TAKE);
      expect(fillerKinds(result)).toEqual([]);
    });
  }

  it('logs "and" as an opener observation without ever creating a filler event', () => {
    // Proves the negative above is not vacuous: the detector did tokenize this
    // sentence, recognised "and" as an opener, and still refused to make it a
    // filler event (§15.3 — an opener is a session pattern, not an event).
    const result = detector().observeFinal(item('And then we continue.'), authored(), TAKE);
    expect(result.tokens.map((token) => token.normalized)).toEqual([
      'and',
      'then',
      'we',
      'continue',
    ]);
    expect(result.openers.map((opener) => opener.form)).toEqual(['and']);
    expect(result.detections).toHaveLength(0);
  });

  it('rejects "like" for the lexical-use rule, not for some incidental reason', () => {
    const result = detector().observeFinal(item('I like this approach a lot.'), authored(), TAKE);
    // The authored span deliberately contains none of these words, so
    // "absent from authored text" is satisfied and only the veto can save us.
    expect(result.rejectedContextual.map((entry) => entry.verdict.veto)).toEqual([
      'lexical:prev=i',
    ]);
  });

  it('rejects "you know" because the following noun phrase proves lexical use', () => {
    const result = detector().observeFinal(item('Do you know the release date?'), authored(), TAKE);
    const vetoes = result.rejectedContextual.map((entry) => entry.verdict.veto);
    expect(vetoes).toContain('lexical:prev=do');
  });

  it('rejects an embedded "so" as not isolated rather than as unauthored', () => {
    const result = detector().observeFinal(item('So we shipped it on Friday.'), authored(), TAKE);
    const entry = result.rejectedContextual.find((candidate) => candidate.form === 'so');
    expect(entry?.verdict.veto).toBe('lexical:next=we');
  });

  it('does not treat a quoted discourse marker as a filler', () => {
    const result = detector().observeFinal(
      item('He said "you know" during the whole interview.'),
      authored(),
      TAKE,
    );
    const entry = result.rejectedContextual.find((candidate) => candidate.form === 'you know');
    expect(entry?.verdict.veto).toBe('quotation');
    expect(result.detections).toHaveLength(0);
  });
});

describe('detects real disfluencies', () => {
  it('detects a strict vocalized filler and marks it probable, never confirmed', () => {
    const result = detector().observeFinal(item('Um, let me start again.'), authored(), TAKE);
    expect(result.detections).toHaveLength(1);
    const event = result.detections[0]?.event;
    expect(event?.kind).toBe('strict_vocalized');
    expect(event?.normalizedForm).toBe('um');
    // §2.3: Layer A alone can never confirm.
    expect(event?.confidence).toBe('probable');
    expect(event?.evidenceSources).toEqual(['realtime']);
    // Only strict forms may ever be quoted back (§25.3).
    expect(event?.displayForm).toBe('um');
    expect(isCountableFiller(event!)).toBe(false);
  });

  it('never quotes a contextual filler back to the presenter', () => {
    const result = detector().observeFinal(
      item('It was, like, a completely different result.'),
      authored(),
      TAKE,
    );
    const contextual = result.detections.find((detection) => detection.event.kind === 'contextual');
    expect(contextual?.event.normalizedForm).toBe('like');
    expect(contextual?.event.displayForm).toBeNull();
    // §16.4's own example pair: same word, opposite verdict, decided by the
    // pauses around it.
    const lexical = detector().observeFinal(item('I like this approach.'), authored(), TAKE);
    expect(lexical.detections).toHaveLength(0);
  });

  it('normalizes spelling variants onto the canonical strict form', () => {
    const result = detector().observeFinal(item('Uhm... okay, uhh, next slide.'), authored(), TAKE);
    const forms = result.detections
      .filter((detection) => detection.event.kind === 'strict_vocalized')
      .map((detection) => detection.event.normalizedForm);
    expect(forms).toEqual(['um', 'uh']);
  });

  it('catches a repeated word across an intervening filler (§15.4)', () => {
    const result = detector().observeFinal(
      item('We can use the, um, the second option.'),
      authored(),
      TAKE,
    );
    const kinds = fillerKinds(result).sort();
    expect(kinds).toEqual(['repeated_word', 'strict_vocalized']);
    const repeat = result.detections.find((detection) => detection.event.kind === 'repeated_word');
    expect(repeat?.event.normalizedForm).toBe('the');
  });

  it('classifies a restarted phrase as a false start, not two repeated words', () => {
    const result = detector().observeFinal(
      item('The next— the next thing is the migration.'),
      authored(),
      TAKE,
    );
    expect(fillerKinds(result)).toEqual(['false_start']);
    expect(result.detections[0]?.event.normalizedForm).toBe('the next');
  });

  it('marks an explicit correction cue as a self-correction', () => {
    const result = detector().observeFinal(
      item('We ship in April, sorry, in May.'),
      authored(),
      TAKE,
    );
    expect(fillerKinds(result)).toContain('self_correction');
  });
});

describe('authored intent (§15.5)', () => {
  it('never counts a filler the script deliberately contains', () => {
    const result = detector().observeFinal(
      item('I was, um, not expecting that.'),
      authored('I was, *um*, not expecting that.'),
      TAKE,
    );
    const event = result.detections.find((detection) => detection.event.kind === 'strict_vocalized');
    expect(event?.event.authoredIntentional).toBe(true);
    // Even if a later layer confirms it, it must not reach the count.
    expect(isCountableFiller({ ...event!.event, confidence: 'confirmed' })).toBe(false);
  });

  it('honours an explicit intentional annotation when the span text lacks the word', () => {
    const result = detector().observeFinal(item('Um, let me think.'), {
      spanId: 'span-2',
      scriptAnchorTokenId: 'tok-2',
      text: 'Let me think.',
      intentionalForms: ['um'],
    }, TAKE);
    expect(result.detections[0]?.event.authoredIntentional).toBe(true);
  });

  it('counts an inserted filler that the script does not contain', () => {
    const result = detector().observeFinal(
      item('Um, let me think.'),
      authored('Let me think.'),
      TAKE,
    );
    expect(result.detections[0]?.event.authoredIntentional).toBe(false);
  });

  it('makes no insertion claim when alignment is unreliable', () => {
    // Fail closed: without a trustworthy authored span we cannot say a
    // contextual token was inserted, so no contextual event may be raised.
    const result = detector().observeFinal(item('It was, like, a different result.'), {
      spanId: null,
      scriptAnchorTokenId: null,
      text: 'It was a different result.',
      alignmentUnreliable: true,
    }, TAKE);
    expect(result.detections.filter((d) => d.event.kind === 'contextual')).toHaveLength(0);
    const entry = result.rejectedContextual.find((candidate) => candidate.form === 'like');
    expect(entry?.verdict.veto).toBe('authored');
  });

  it('emits nothing at all for a span with coaching disabled', () => {
    const result = detector().observeFinal(item('Um, like, whatever.'), {
      spanId: 'span-3',
      scriptAnchorTokenId: null,
      text: 'Anything.',
      coachingDisabled: true,
    }, TAKE);
    expect(result.detections).toHaveLength(0);
  });
});

describe('repetition requirement for meaningful words', () => {
  it('needs three uses of "actually" before the third becomes a candidate', () => {
    const shared = detector();
    const span = authored('The rollout completed without incident.');
    const first = shared.observeFinal(item('Actually, we shipped early.', 1_000, 3_000), span, TAKE);
    const second = shared.observeFinal(item('Actually, it went fine.', 5_000, 7_000), span, TAKE);
    const third = shared.observeFinal(item('Actually, nobody noticed.', 9_000, 11_000), span, TAKE);

    expect(first.detections).toHaveLength(0);
    expect(second.detections).toHaveLength(0);
    expect(first.rejectedContextual[0]?.verdict.veto).toBe('insufficient_repetition');
    expect(third.detections.map((detection) => detection.event.normalizedForm)).toEqual([
      'actually',
    ]);
  });

  it('does not let lexical uses of a word unlock its repetition gate', () => {
    // Three legitimate uses of "right" must not make the fourth a filler.
    const shared = detector();
    const span = authored('The navigation demo runs on the second machine.');
    shared.observeFinal(item('Turn right at the junction.', 1_000, 3_000), span, TAKE);
    shared.observeFinal(item('That is the right answer.', 4_000, 6_000), span, TAKE);
    shared.observeFinal(item('Turn right again.', 7_000, 9_000), span, TAKE);
    const fourth = shared.observeFinal(item('We shipped it, right, on Tuesday.', 10_000, 12_000), span, TAKE);
    expect(fourth.detections).toHaveLength(0);
    expect(fourth.rejectedContextual[0]?.verdict.veto).toBe('insufficient_repetition');
  });
});

describe('provisional transcript (§16.1)', () => {
  it('returns hints, which are structurally incapable of becoming a visible event', () => {
    const hints = detector().observeProvisional(item('Um, I think'), authored());
    expect(hints).toEqual([
      {
        itemId: 'item-1000',
        normalizedForm: 'um',
        kind: 'strict_vocalized',
        audioStartMs: expect.any(Number),
        audioEndMs: expect.any(Number),
      },
    ]);
    // A hint carries no confidence, no eventId and no countedLive: there is no
    // field a renderer could tick from.
    expect(Object.keys(hints[0] ?? {})).not.toContain('confidence');
  });
});

describe('audio-clock stamping (§5.4)', () => {
  it('places a filler inside the commit interval it was spoken in', () => {
    const result = detector().observeFinal(
      item('We should, um, take that again.', 20_000, 24_000),
      authored(),
      TAKE,
    );
    const event = result.detections.find((d) => d.event.kind === 'strict_vocalized')?.event;
    expect(event?.audioStartMs).toBeGreaterThanOrEqual(20_000);
    expect(event?.audioEndMs).toBeLessThanOrEqual(24_000);
    // Proportional placement is honest about being an estimate.
    expect(event?.timingConfidence).toBeLessThan(0.9);
  });

  it('uses provider word timings when they exist, with higher timing confidence', () => {
    const withTimings: RealtimeTranscriptItem = {
      ...item('Um yes', 30_000, 31_000),
      wordTimings: [
        { startMs: 30_000, endMs: 30_400 },
        { startMs: 30_600, endMs: 31_000 },
      ],
    };
    const result = detector().observeFinal(withTimings, authored(), TAKE);
    const event = result.detections[0]?.event;
    expect(event?.audioStartMs).toBe(30_000);
    expect(event?.audioEndMs).toBe(30_400);
    expect(event?.timingConfidence).toBeGreaterThan(0.8);
  });
});
