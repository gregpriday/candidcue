/**
 * The confidence ladder end to end (§16.5, §27.3) and the §5.4 clock rule.
 *
 * Every test here drives the **real** tracker, which drives the real detector,
 * the real contextual classifier and the real reconciler. Nothing
 * hand-assembles a `FillerEvent` and then asserts something about it — the
 * events under assertion are the ones the pipeline produced from transcript
 * text, speech intervals and precision results.
 */
import { describe, expect, it } from 'vitest';
import { FillerTracker } from '../../../../src/shared/coaching/disfluency/filler-tracker';
import type { AcousticEvidenceLookup } from '../../../../src/shared/coaching/disfluency/realtime-filler-detector';
import type {
  AuthoredSpanContext,
  PrecisionTranscriptResult,
  RealtimeTranscriptItem,
} from '../../../../src/shared/coaching/disfluency/types';
import { isUnlocalized } from '../../../../src/shared/coaching/disfluency/types';
import type { SpeechInterval } from '../../../../src/shared/contracts/coaching';

const TAKE = { takePassId: 'take-1', trackingEpoch: 4 };

function speech(startMs: number, endMs: number, takePassId = TAKE.takePassId): SpeechInterval {
  return {
    startMs,
    endMs,
    voicedMs: endMs - startMs,
    silenceMs: 0,
    meanSnrDb: 22,
    takePassId,
  };
}

function fakeAcoustics(regions: Array<{ startMs: number; endMs: number }> = []): AcousticEvidenceLookup {
  return {
    hasHesitation: (startMs, endMs) =>
      regions.some((region) => region.startMs < endMs && region.endMs > startMs),
    boundaryStartsMs: () => [],
    hesitationRegion: (startMs, endMs) =>
      regions.find((region) => region.startMs < endMs && region.endMs > startMs) ?? null,
  };
}

function item(
  text: string,
  startMs: number,
  endMs: number,
  wordTimings?: Array<{ startMs: number; endMs: number }>,
): RealtimeTranscriptItem {
  return {
    itemId: `item-${startMs}`,
    commitSequence: Math.floor(startMs / 1000),
    audioStartMs: startMs,
    audioEndMs: endMs,
    text,
    ...(wordTimings ? { wordTimings } : {}),
  };
}

const AUTHORED: AuthoredSpanContext = {
  spanId: 'span-1',
  scriptAnchorTokenId: 'tok-41',
  text: 'We should ship it now.',
};

function precision(
  text: string,
  startMs: number,
  endMs: number,
  overrides: Partial<PrecisionTranscriptResult> = {},
): PrecisionTranscriptResult {
  return {
    chunkId: `chunk-${startMs}`,
    audioStartMs: startMs,
    audioEndMs: endMs,
    takePassId: TAKE.takePassId,
    trackingEpoch: TAKE.trackingEpoch,
    commitSequence: 10,
    text,
    ...overrides,
  };
}

describe('the §16.5 three-part ladder', () => {
  it('confirms a strict filler from a final transcript with no local audio at all', () => {
    // The whole point of the three-part rule: an "um" sitting in a finalized
    // transcript clears all three terms on its own. Requiring acoustic
    // corroboration as well would pin the tile at zero whenever the audio
    // worklet is unavailable — a silent lie rather than a visible failure.
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: true });
    tracker.observeFinalTranscript(item('We should, um, ship it now.', 10_000, 14_000), AUTHORED);

    const event = tracker.events()[0];
    expect(event?.confidence).toBe('confirmed');
    expect(event?.evidenceSources).toEqual(['realtime']);
    expect(tracker.publishDisplayState(14_000).confirmedCount).toBe(1);
    expect(event?.countedLive).toBe(true);
  });

  it('never confirms from a provisional tail', () => {
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: true });
    const provisional = item('We should, um, ship it now.', 10_000, 14_000);

    // Identical text, identical interval — only the finality differs.
    const hints = tracker.observeProvisional(provisional, AUTHORED);
    expect(hints.map((hint) => hint.normalizedForm)).toEqual(['um']);
    expect(tracker.events()).toEqual([]);
    expect(tracker.peekDisplayState(14_000).confirmedCount).toBe(0);

    tracker.observeFinalTranscript(provisional, AUTHORED);
    expect(tracker.events()[0]?.confidence).toBe('confirmed');
    expect(tracker.peekDisplayState(14_000).confirmedCount).toBe(1);
  });

  it('lets local audio veto the timing term, in either arrival order', () => {
    // VAD first: the transcript arrives knowing the region was silent.
    const vadFirst = new FillerTracker({ take: TAKE, precisionEnabled: true });
    vadFirst.observeSpeechInterval(speech(40_000, 44_000));
    vadFirst.observeFinalTranscript(item('We should, um, ship it now.', 10_000, 14_000), AUTHORED);
    expect(vadFirst.events()[0]?.confidence).toBe('probable');

    // Transcript first: it confirms on the permissive branch, then the VAD
    // reports through the region and contradicts it. Same evidence, same
    // outcome — the ladder must not depend on arrival order.
    const transcriptFirst = new FillerTracker({ take: TAKE, precisionEnabled: true });
    transcriptFirst.observeFinalTranscript(
      item('We should, um, ship it now.', 10_000, 14_000),
      AUTHORED,
    );
    expect(transcriptFirst.publishDisplayState(14_000).confirmedCount).toBe(1);
    transcriptFirst.observeSpeechInterval(speech(40_000, 44_000));

    const event = transcriptFirst.events()[0];
    // Back to `probable`, not `rejected`: bad timing is not the claim that a
    // legitimate word was spoken.
    expect(event?.confidence).toBe('probable');
    expect(transcriptFirst.peekDisplayState(44_000).confirmedCount).toBe(0);
    expect(event?.countedLive).toBe(true);
  });

  it('does not veto on silence the VAD has not reported through yet', () => {
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: true });
    // The VAD has only reported up to 9 s; it has said nothing about 10–14 s.
    tracker.observeSpeechInterval(speech(5_000, 9_000));
    tracker.observeFinalTranscript(item('We should, um, ship it now.', 10_000, 14_000), AUTHORED);
    expect(tracker.events()[0]?.confidence).toBe('confirmed');
  });

  /**
   * The watermark used to advance only on interval *closes*, and a run closes
   * on a silence gap — so trailing silence read as "the VAD has not got here
   * yet" and took the permissive branch. That is exactly the audio a
   * transcription model hallucinates fillers into, and exactly where a Realtime
   * commit's ~420 ms endpoint tail lands. The event was confirmed, the tile
   * counted it, and the next close demoted it: the presenter watched the number
   * go up and then back down.
   */
  it('rejects a filler in silence the VAD has scanned but not closed a run over', () => {
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: true });
    tracker.observeSpeechInterval(speech(5_000, 9_000));
    // The VAD has now processed frames through 20 s and found no speech after
    // 9 s. No run closed, because there was nothing to close.
    tracker.noteVadObservedThrough(20_000);
    tracker.observeFinalTranscript(item('We should, um, ship it now.', 10_000, 14_000), AUTHORED);
    expect(tracker.events()[0]?.confidence).toBe('probable');
    expect(tracker.peekDisplayState(20_000).confirmedCount).toBe(0);
  });

  it('the heartbeat demotes an already-counted filler exactly once', () => {
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: true });
    tracker.observeFinalTranscript(item('We should, um, ship it now.', 10_000, 14_000), AUTHORED);
    expect(tracker.publishDisplayState(14_000).confirmedCount).toBe(1);

    tracker.noteVadObservedThrough(20_000);
    expect(tracker.events()[0]?.confidence).toBe('probable');
    // `countedLive` still records what the presenter actually saw (§27.3).
    expect(tracker.events()[0]?.countedLive).toBe(true);
    // A second heartbeat that does not advance is a no-op.
    tracker.noteVadObservedThrough(15_000);
    expect(tracker.events()[0]?.confidence).toBe('probable');
  });

  it('the heartbeat does not veto a filler the VAD covered with speech', () => {
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: true });
    tracker.observeSpeechInterval(speech(10_000, 14_000));
    tracker.noteVadObservedThrough(20_000);
    tracker.observeFinalTranscript(item('We should, um, ship it now.', 10_000, 14_000), AUTHORED);
    expect(tracker.events()[0]?.confidence).toBe('confirmed');
  });

  it('holds a contextual filler at probable until classification passes', () => {
    const authored: AuthoredSpanContext = {
      spanId: 'span-2',
      scriptAnchorTokenId: 'tok-9',
      text: 'It was slow to respond.',
    };
    // "kind of" is a hedge: deleting it changes the meaning, so it scores
    // below the confirmation threshold on structure and repetition alone.
    const weak = new FillerTracker({ take: TAKE, precisionEnabled: true });
    for (const startMs of [10_000, 20_000, 30_000]) {
      weak.observeFinalTranscript(item('It was, kind of, slow.', startMs, startMs + 3_000), authored);
    }
    expect(weak.events().map((event) => event.confidence)).toEqual(['probable']);
    expect(weak.peekDisplayState(35_000).confirmedCount).toBe(0);

    // The same utterances with a hesitation overlapping them clear the gate.
    const strong = new FillerTracker({
      take: TAKE,
      precisionEnabled: true,
      acoustics: fakeAcoustics([{ startMs: 0, endMs: 60_000 }]),
    });
    for (const startMs of [10_000, 20_000, 30_000]) {
      strong.observeFinalTranscript(item('It was, kind of, slow.', startMs, startMs + 3_000), authored);
    }
    expect(strong.events().map((event) => event.confidence)).toEqual(['confirmed']);
  });

  it('requires hesitation evidence for the conditional strict forms (§15.1)', () => {
    const authored: AuthoredSpanContext = {
      spanId: 'span-3',
      scriptAnchorTokenId: 'tok-3',
      text: 'Let me think about that.',
    };
    const withoutAudio = new FillerTracker({ take: TAKE, precisionEnabled: true });
    withoutAudio.observeFinalTranscript(item('Hmm, let me think.', 10_000, 13_000), authored);
    // §15.1 qualifies "hmm" as a filler only when it holds the floor, and only
    // local audio can say whether it did — that is this form's classification
    // term, not an extra corroboration requirement.
    expect(withoutAudio.events().map((event) => event.confidence)).toEqual(['probable']);

    const withAudio = new FillerTracker({
      take: TAKE,
      precisionEnabled: true,
      acoustics: fakeAcoustics([{ startMs: 10_000, endMs: 13_000 }]),
    });
    withAudio.observeFinalTranscript(item('Hmm, let me think.', 10_000, 13_000), authored);
    expect(withAudio.events()[0]?.confidence).toBe('confirmed');
    expect(withAudio.events()[0]?.evidenceSources).toEqual(['realtime', 'local_audio']);
  });
});

describe('demotion after a precision pass (§16.5, §27.3)', () => {
  it('corrects the count while preserving what the presenter already saw', () => {
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: true });
    tracker.observeFinalTranscript(item('We should, um, ship it now.', 10_000, 14_000), AUTHORED);
    tracker.observeSpeechInterval(speech(10_000, 14_000));

    // The presenter sees the tile: one filler.
    const shown = tracker.publishDisplayState(14_000);
    expect(shown.confirmedCount).toBe(1);
    expect(shown.dominantForm).toBe('um');
    expect(tracker.events()[0]?.countedLive).toBe(true);

    // Seconds later the verbatim pass comes back and there is no "um" in it.
    const outcome = tracker.applyPrecisionResult(
      precision('We should ship it now.', 10_000, 14_000),
      AUTHORED,
    );

    expect(outcome.demoted).toEqual([tracker.events()[0]?.eventId]);
    const event = tracker.events()[0];
    expect(event?.confidence).toBe('rejected');
    expect(event?.evidenceSources).toEqual(['realtime', 'precision_transcript']);

    // The number corrects…
    expect(tracker.publishDisplayState(20_000).confirmedCount).toBe(0);
    // …but the record does not pretend the presenter never saw it.
    expect(event?.countedLive).toBe(true);
  });

  it('records corroboration rather than duplicating when the precision pass agrees', () => {
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: true });
    tracker.observeFinalTranscript(item('We should, um, ship it now.', 10_000, 14_000), AUTHORED);
    const outcome = tracker.applyPrecisionResult(
      precision('We should um ship it now.', 10_000, 14_000),
      AUTHORED,
    );

    expect(outcome.created).toHaveLength(0);
    // Already confirmed by the final Realtime transcript, so there is nothing
    // to promote — but both layers agreeing is worth recording.
    expect(outcome.promoted).toEqual([]);
    expect(outcome.corroborated).toEqual([tracker.events()[0]?.eventId]);
    expect(tracker.events()).toHaveLength(1);
    expect(tracker.events()[0]?.evidenceSources).toEqual(['realtime', 'precision_transcript']);
    expect(tracker.peekDisplayState(14_000).confirmedCount).toBe(1);
  });

  it('promotes a probable detection the precision pass rescues', () => {
    // The VAD vetoed the timing, so Layer A alone could not confirm.
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: true });
    tracker.observeSpeechInterval(speech(40_000, 44_000));
    tracker.observeFinalTranscript(item('We should, um, ship it now.', 10_000, 14_000), AUTHORED);
    expect(tracker.events()[0]?.confidence).toBe('probable');

    const outcome = tracker.applyPrecisionResult(
      precision('We should um ship it now.', 10_000, 14_000),
      AUTHORED,
    );
    expect(outcome.promoted).toEqual([tracker.events()[0]?.eventId]);
    expect(tracker.events()[0]?.confidence).toBe('confirmed');
  });

  it('ignores a result belonging to a superseded take pass', () => {
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: true });
    tracker.observeFinalTranscript(item('We should, um, ship it now.', 10_000, 14_000), AUTHORED);
    const outcome = tracker.applyPrecisionResult(
      precision('We should ship it now.', 10_000, 14_000, { takePassId: 'take-0' }),
      AUTHORED,
    );
    expect(outcome.demoted).toEqual([]);
    // Untouched: the stale result may neither demote nor corroborate it.
    expect(tracker.events()[0]?.confidence).toBe('confirmed');
    expect(tracker.events()[0]?.evidenceSources).toEqual(['realtime']);
  });
});

describe('precision-only fillers are mapped back onto their audio (§5.4, §16.3.4)', () => {
  it('places an insertion in the gap between its matched neighbours', () => {
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: true });
    // Provider word timings leave a real 600 ms hole between "should" and "ship".
    tracker.observeFinalTranscript(
      item('We should ship it now.', 10_000, 14_000, [
        { startMs: 10_000, endMs: 10_400 },
        { startMs: 10_400, endMs: 11_800 },
        { startMs: 12_400, endMs: 12_900 },
        { startMs: 12_900, endMs: 13_200 },
        { startMs: 13_200, endMs: 14_000 },
      ]),
      AUTHORED,
    );
    expect(tracker.events()).toHaveLength(0);

    // The result arrives long after the audio; it must not be stamped "now".
    const outcome = tracker.applyPrecisionResult(
      precision('We should um ship it now.', 10_000, 14_000),
      AUTHORED,
    );

    expect(outcome.created).toHaveLength(1);
    const event = tracker.events()[0];
    expect(event?.normalizedForm).toBe('um');
    expect(event?.confidence).toBe('confirmed');
    expect(event?.evidenceSources).toEqual(['precision_transcript']);
    expect(event?.audioStartMs).toBe(11_800);
    expect(event?.audioEndMs).toBe(12_400);
    expect(isUnlocalized(event!)).toBe(false);
  });

  it('counts but does not localize when the neighbours leave no gap (§16.3.4)', () => {
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: true });
    // No provider timings: realtime tokens are placed proportionally and butt
    // up against each other, so there is nowhere to put the insertion.
    tracker.observeFinalTranscript(item('We should ship it now.', 10_000, 14_000), AUTHORED);
    tracker.applyPrecisionResult(precision('We should um ship it now.', 10_000, 14_000), AUTHORED);

    const event = tracker.events()[0];
    expect(event?.confidence).toBe('confirmed');
    expect(isUnlocalized(event!)).toBe(true);
    // Still inside the interval it describes — an unlocalized event is not a
    // licence to stamp it with the arrival time.
    expect(event!.audioStartMs).toBeGreaterThanOrEqual(10_000);
    expect(event!.audioEndMs).toBeLessThanOrEqual(14_000);
  });

  it('snaps an insertion onto an overlapping acoustic hesitation', () => {
    const tracker = new FillerTracker({
      take: TAKE,
      precisionEnabled: true,
      acoustics: fakeAcoustics([{ startMs: 11_900, endMs: 12_300 }]),
    });
    tracker.observeFinalTranscript(
      item('We should ship it now.', 10_000, 14_000, [
        { startMs: 10_000, endMs: 10_400 },
        { startMs: 10_400, endMs: 11_800 },
        { startMs: 12_400, endMs: 12_900 },
        { startMs: 12_900, endMs: 13_200 },
        { startMs: 13_200, endMs: 14_000 },
      ]),
      AUTHORED,
    );
    tracker.applyPrecisionResult(precision('We should um ship it now.', 10_000, 14_000), AUTHORED);

    const event = tracker.events()[0];
    expect(event?.audioStartMs).toBe(11_900);
    expect(event?.audioEndMs).toBe(12_300);
    expect(event?.timingConfidence).toBeGreaterThan(0.7);
  });

  it('produces one event for a filler seen in two overlapping chunks (§29.2)', () => {
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: true });
    tracker.observeFinalTranscript(item('We should ship it now.', 10_000, 14_000), AUTHORED);

    tracker.applyPrecisionResult(precision('We should um ship it', 10_000, 13_000), AUTHORED);
    const second = tracker.applyPrecisionResult(
      // 450 ms overlap, per §16.3.1, so the same "um" is transcribed twice.
      precision('should um ship it now', 12_550, 14_000, { chunkId: 'chunk-overlap' }),
      AUTHORED,
    );

    expect(tracker.events().filter((event) => event.normalizedForm === 'um')).toHaveLength(1);
    expect(second.created).toHaveLength(0);
  });
});

describe('display state (§8, §27.3)', () => {
  it('excludes probable detections and authored fillers from the count', () => {
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: true });
    tracker.observeFinalTranscript(item('Um, we should, um, ship it now.', 10_000, 15_000), {
      ...AUTHORED,
      // The script's own opening "um" is deliberate (§15.5).
      text: 'Um, we should ship it now.',
    });
    tracker.observeSpeechInterval(speech(10_000, 15_000));

    const events = tracker.events();
    expect(events).toHaveLength(2);
    expect(events.filter((event) => event.authoredIntentional)).toHaveLength(1);
    expect(tracker.publishDisplayState(15_000).confirmedCount).toBe(1);
  });

  it('reports degraded while precision transcription is unavailable (§25.1)', () => {
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: false });
    expect(tracker.peekDisplayState(1_000).degraded).toBe(true);
    tracker.setPrecisionEnabled(true);
    expect(tracker.peekDisplayState(1_000).degraded).toBe(false);
    tracker.setTranscriptionDegraded(true);
    expect(tracker.peekDisplayState(1_000).degraded).toBe(true);
  });

  it('only ever offers a strict lexicon form as the dominant form', () => {
    const tracker = new FillerTracker({
      take: TAKE,
      precisionEnabled: true,
      acoustics: fakeAcoustics([{ startMs: 0, endMs: 60_000 }]),
      lexiconOptions: { additionalContextualPhrases: ['at the end of the day'] },
    });
    const authored: AuthoredSpanContext = {
      spanId: 'span-3',
      scriptAnchorTokenId: 'tok-3',
      text: 'The rollout completed.',
    };
    for (let i = 0; i < 3; i++) {
      const startMs = 10_000 + i * 5_000;
      tracker.observeFinalTranscript(
        item('At the end of the day, it completed.', startMs, startMs + 3_000),
        authored,
      );
      tracker.observeSpeechInterval(speech(startMs, startMs + 3_000));
    }
    const state = tracker.publishDisplayState(30_000);
    expect(state.confirmedCount).toBe(3);
    // Counted, but not quotable: §25.3's allowlist is the built-in strict set.
    expect(state.dominantForm).toBeNull();
  });
});

describe('§2.4 end to end', () => {
  it('never lights the tile for a take of ordinary sentences', () => {
    // The harshest configuration the pipeline can be in: the VAD corroborates
    // every interval and the acoustic layer reports hesitation everywhere, so
    // the *only* thing standing between these sentences and a red count is
    // the lexical and structural classification.
    const tracker = new FillerTracker({
      take: TAKE,
      precisionEnabled: true,
      acoustics: fakeAcoustics([{ startMs: 0, endMs: 10 ** 7 }]),
    });
    const script: AuthoredSpanContext = {
      spanId: 'span-9',
      scriptAnchorTokenId: 'tok-9',
      text: 'The quarterly figures moved in the direction we projected.',
    };
    const sentences = [
      'And then we continue with the rollout.',
      'I like this approach a lot.',
      'It looks like a caching problem.',
      'We would like to ship on Friday.',
      'So we shipped it on Friday.',
      'That is so much faster than before.',
      'Turn right at the second junction.',
      'We got the right answer on the first pass.',
      'Do you know the release date?',
      'The migration works well under load.',
      'As well as the second option, there is a third.',
      'It is a kind of caching layer.',
      'I mean what I say about the deadline.',
    ];
    sentences.forEach((text, index) => {
      const startMs = 10_000 + index * 4_000;
      tracker.observeFinalTranscript(item(text, startMs, startMs + 3_000), script);
      tracker.observeSpeechInterval(speech(startMs, startMs + 3_000));
    });

    const state = tracker.publishDisplayState(70_000);
    expect(state.confirmedCount).toBe(0);
    expect(state.dominantForm).toBeNull();
    expect(tracker.candidates(70_000)).toEqual([]);
  });
});

describe('take pass isolation (§23.1)', () => {
  it('drops everything from the previous pass', () => {
    const tracker = new FillerTracker({ take: TAKE, precisionEnabled: true });
    tracker.observeFinalTranscript(item('We should, um, ship it now.', 10_000, 14_000), AUTHORED);
    tracker.observeSpeechInterval(speech(10_000, 14_000));
    expect(tracker.peekDisplayState(14_000).confirmedCount).toBe(1);

    tracker.setTake({ takePassId: 'take-2', trackingEpoch: 5 }, 20_000);
    expect(tracker.events()).toEqual([]);
    expect(tracker.peekDisplayState(24_000).confirmedCount).toBe(0);
    // An interval stamped with the old pass is ignored rather than applied.
    tracker.observeSpeechInterval(speech(20_000, 24_000, 'take-1'));
    expect(tracker.peekDisplayState(24_000).confirmedCount).toBe(0);
  });
});
