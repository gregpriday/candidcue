/**
 * §16.7 / §16.8 pattern candidates.
 *
 * Candidates are generated from events the **real** tracker produced from
 * transcript text — no hand-built `FillerEvent` arrays. The first test is the
 * one §16.7 leads with: a single filler must produce nothing at all, so a
 * generator that returned a candidate for every event would fail here rather
 * than pass the rest by accident.
 */
import { describe, expect, it } from 'vitest';
import {
  FillerTracker,
  type FillerTrackerOptions,
} from '../../../../src/shared/coaching/disfluency/filler-tracker';
import type { AcousticEvidenceLookup } from '../../../../src/shared/coaching/disfluency/realtime-filler-detector';
import type {
  AuthoredSpanContext,
  RealtimeTranscriptItem,
} from '../../../../src/shared/coaching/disfluency/types';
import type { CoachCandidate, SpeechInterval } from '../../../../src/shared/contracts/coaching';

const TAKE = { takePassId: 'take-1', trackingEpoch: 2 };

const ALWAYS_HESITANT: AcousticEvidenceLookup = {
  hasHesitation: () => true,
  boundaryStartsMs: () => [],
  hesitationRegion: (startMs, endMs) => ({ startMs, endMs }),
};

function speech(startMs: number, endMs: number): SpeechInterval {
  return { startMs, endMs, voicedMs: endMs - startMs, silenceMs: 0, meanSnrDb: 20, takePassId: TAKE.takePassId };
}

function item(text: string, startMs: number, endMs: number): RealtimeTranscriptItem {
  return {
    itemId: `item-${startMs}`,
    commitSequence: Math.floor(startMs / 1000),
    audioStartMs: startMs,
    audioEndMs: endMs,
    text,
  };
}

const AUTHORED: AuthoredSpanContext = {
  spanId: 'span-1',
  scriptAnchorTokenId: 'tok-7',
  text: 'We should ship it now.',
};

function types(candidates: readonly CoachCandidate[]): string[] {
  return candidates.map((candidate) => candidate.type).sort();
}

function trackerWith(options: FillerTrackerOptions): FillerTracker {
  return new FillerTracker(options);
}

describe('§16.7 threshold behaviour', () => {
  it('produces nothing for the first isolated filler', () => {
    const tracker = trackerWith({ take: TAKE, precisionEnabled: true });
    tracker.observeFinalTranscript(item('We should, um, ship it now.', 10_000, 14_000), AUTHORED);
    tracker.observeSpeechInterval(speech(10_000, 14_000));

    expect(tracker.peekDisplayState(14_000).confirmedCount).toBe(1);
    expect(tracker.candidates(14_000)).toEqual([]);
  });

  it('raises a cluster and a repeated-filler candidate at three in twenty seconds', () => {
    const tracker = trackerWith({ take: TAKE, precisionEnabled: true });
    for (const startMs of [10_000, 15_000, 20_000]) {
      tracker.observeFinalTranscript(item('We should, um, ship it now.', startMs, startMs + 4_000), AUTHORED);
      tracker.observeSpeechInterval(speech(startMs, startMs + 4_000));
    }

    const candidates = tracker.candidates(24_000);
    expect(types(candidates)).toEqual(['filler_cluster', 'repeated_filler']);

    const repeated = candidates.find((candidate) => candidate.type === 'repeated_filler');
    // §25.3: the quoted value comes from the fixed allowlist, via detailCode.
    expect(repeated?.detailCode).toBe('um');
    expect(repeated?.finalEvidence).toBe(true);
    expect(repeated?.stamp.takePassId).toBe('take-1');
    expect(repeated?.stamp.trackingEpoch).toBe(2);
    expect(repeated?.stamp.audioStartMs).toBeGreaterThanOrEqual(10_000);
    expect(repeated?.stamp.audioEndMs).toBeLessThanOrEqual(24_000);
    expect(repeated?.stamp.commitSequence).toBe(20);
    // Honest confidence: exactly at the threshold is a weak claim.
    expect(repeated?.localConfidence).toBeGreaterThan(0.5);
    expect(repeated?.localConfidence).toBeLessThan(0.7);
  });

  it('does not raise a repeated-filler candidate for a form that may not be quoted', () => {
    const tracker = trackerWith({
      take: TAKE,
      precisionEnabled: true,
      acoustics: ALWAYS_HESITANT,
    });
    const authored: AuthoredSpanContext = {
      spanId: 'span-2',
      scriptAnchorTokenId: 'tok-2',
      text: 'It was a different result.',
    };
    for (const startMs of [10_000, 20_000, 30_000]) {
      tracker.observeFinalTranscript(
        item('It was, like, a different result.', startMs, startMs + 4_000),
        authored,
      );
      tracker.observeSpeechInterval(speech(startMs, startMs + 4_000));
    }

    // Three in thirty seconds is a repeated *form*, but not a cluster: the
    // cluster thresholds are 3-in-20 s or 5-in-60 s and neither is met.
    const candidates = tracker.candidates(35_000);
    expect(types(candidates)).toEqual(['contextual_filler']);
    const contextual = candidates.find((candidate) => candidate.type === 'contextual_filler');
    expect(contextual?.detailCode).toBe('like');
    // A contextual pattern is proposed with visibly less confidence than a
    // strict one, because the classification itself is the uncertain part.
    expect(contextual!.localConfidence).toBeLessThan(0.55);
    expect(candidates.some((candidate) => candidate.type === 'repeated_filler')).toBe(false);
  });

  it('raises repeated_stumble for restarts that block progress (§24)', () => {
    const tracker = trackerWith({ take: TAKE, precisionEnabled: true });
    for (const startMs of [10_000, 18_000]) {
      tracker.observeFinalTranscript(
        item('The next— the next thing is the migration.', startMs, startMs + 4_000),
        AUTHORED,
      );
      tracker.observeSpeechInterval(speech(startMs, startMs + 4_000));
    }
    const candidates = tracker.candidates(23_000);
    expect(types(candidates)).toContain('repeated_stumble');
    // A stumble is not a filler: the tile's number stays at zero.
    expect(tracker.peekDisplayState(23_000).confirmedCount).toBe(0);
  });
});

describe('repetitive openers (§15.3)', () => {
  const OPENER_TEXT =
    'And we shipped. And they tested. And I reviewed. And she deployed. ' +
    'And nobody complained. And the metrics held. And the team celebrated. And that was that.';
  const openerAuthored: AuthoredSpanContext = {
    spanId: 'span-4',
    scriptAnchorTokenId: 'tok-4',
    text: 'We shipped, they tested, I reviewed, she deployed.',
  };

  it('never turns an opener into a filler event or a filler count', () => {
    const tracker = trackerWith({ take: TAKE, precisionEnabled: true });
    tracker.observeFinalTranscript(item(OPENER_TEXT, 10_000, 26_000), openerAuthored);
    tracker.observeSpeechInterval(speech(10_000, 26_000));

    expect(tracker.openerObservations()).toHaveLength(8);
    expect(tracker.events().filter((event) => event.kind === 'strict_vocalized')).toHaveLength(0);
    expect(tracker.events().filter((event) => event.kind === 'contextual')).toHaveLength(0);
    expect(tracker.peekDisplayState(26_000).confirmedCount).toBe(0);
  });

  it('is off by default and only fires live when explicitly enabled', () => {
    const off = trackerWith({ take: TAKE, precisionEnabled: true });
    off.observeFinalTranscript(item(OPENER_TEXT, 10_000, 26_000), openerAuthored);
    expect(off.candidates(26_000)).toEqual([]);

    const on = trackerWith({
      take: TAKE,
      precisionEnabled: true,
      candidateConfig: { repetitiveOpenerLiveTips: true },
    });
    on.observeFinalTranscript(item(OPENER_TEXT, 10_000, 26_000), openerAuthored);
    const candidates = on.candidates(26_000);
    expect(types(candidates)).toEqual(['repetitive_opener']);
    expect(candidates[0]?.detailCode).toBe('and');
  });

  it('stays silent when the script itself opens with the word', () => {
    const on = trackerWith({
      take: TAKE,
      precisionEnabled: true,
      candidateConfig: { repetitiveOpenerLiveTips: true },
    });
    on.observeFinalTranscript(item(OPENER_TEXT, 10_000, 26_000), {
      ...openerAuthored,
      // §15.3: the pattern must be *confidently absent* from the script.
      text: 'And we shipped. And they tested.',
    });
    expect(on.candidates(26_000)).toEqual([]);
  });

  it('makes no claim when there is no usable authored span', () => {
    const on = trackerWith({
      take: TAKE,
      precisionEnabled: true,
      candidateConfig: { repetitiveOpenerLiveTips: true },
    });
    on.observeFinalTranscript(item(OPENER_TEXT, 10_000, 26_000), {
      spanId: null,
      scriptAnchorTokenId: null,
      text: '',
    });
    expect(on.candidates(26_000)).toEqual([]);
  });
});

describe('positive reinforcement (§16.8, §25.6)', () => {
  const cleanRun = (tracker: FillerTracker): void => {
    tracker.observeFinalTranscript(item('We should, um, ship it now.', 10_000, 14_000), AUTHORED);
    tracker.observeSpeechInterval(speech(10_000, 14_000));
    tracker.publishDisplayState(14_000);
  };

  it('is disabled by default', () => {
    const tracker = trackerWith({ take: TAKE, precisionEnabled: true });
    cleanRun(tracker);
    expect(tracker.candidates(60_000)).toEqual([]);
  });

  it('fires once per clean stretch when enabled, and only after there was something to improve', () => {
    const tracker = trackerWith({
      take: TAKE,
      precisionEnabled: true,
      candidateConfig: { positiveReinforcementEnabled: true },
    });
    // No fillers yet: a streak claim would be meaningless.
    expect(tracker.candidates(60_000)).toEqual([]);

    cleanRun(tracker);
    expect(tracker.candidates(20_000)).toEqual([]); // streak too short

    const first = tracker.candidates(60_000);
    expect(types(first)).toEqual(['positive_filler_streak']);
    // §16.8: not more than once per take segment.
    expect(tracker.candidates(70_000)).toEqual([]);
  });
});
