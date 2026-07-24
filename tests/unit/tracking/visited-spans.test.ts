/**
 * S2 — the recently visited span ring buffer (§14.4, §21.1).
 *
 * §21.1 lists "the destination was visited recently" among the positive retake
 * evidence features, and §14.4 lists the ring buffer that would let anyone
 * compute it. Neither existed. What the engine had instead was
 * `previouslyPassed = startPosition <= committedTokenIndex` — true of every
 * token behind the cursor, so it distinguishes nothing — and
 * `matchesPreviouslyReadOpening`, which needs two of the destination's leading
 * content words to reach the aligner intact.
 *
 * The second one is the gap that bites, and it is structural rather than bad
 * luck: the heuristic looks for content words in the destination's first eight
 * tokens, so a sentence that opens on function words — "And so it is that we
 * have to…", which is simply how spoken English starts a sentence — has no
 * openingit can match, and the retake is refused however perfectly it was
 * transcribed. A recent visit is independent evidence: it does not depend on
 * the shape of the destination's first few words, only on the cursor having
 * genuinely been there a moment ago.
 */
import { describe, expect, it } from 'vitest';
import { AlignmentEngine } from '../../../src/shared/tracking/engine';
import { VisitedSpanRing } from '../../../src/shared/tracking/visited';
import { compileFixtureScript } from '../../fixtures/alignment/fixture-script';
import { TranscriptScripter } from '../../fixtures/transcript-events/builder';
import type { TrackingSnapshot } from '../../../src/shared/contracts/tracking';

describe('S2: the visited ring records where the cursor actually went', () => {
  it('coalesces a continuous read into one span', () => {
    const ring = new VisitedSpanRing(8);
    for (let i = 0; i < 40; i += 4) ring.record(i, i + 4, 1000 + i);
    expect(ring.recent()).toHaveLength(1);
    expect(ring.recent()[0]).toMatchObject({ startTokenIndex: 0, endTokenIndex: 40 });
  });

  it('opens a new span across a discontinuity and keeps both', () => {
    const ring = new VisitedSpanRing(8);
    ring.record(0, 20, 1000);
    ring.record(400, 410, 2000);
    expect(ring.recent()).toHaveLength(2);
    expect(ring.visitedRecently(10, 2000, 30_000)).toBe(true);
    expect(ring.visitedRecently(405, 2000, 30_000)).toBe(true);
    // The gap between them was never read.
    expect(ring.visitedRecently(200, 2000, 30_000)).toBe(false);
  });

  it('forgets a span once it is no longer recent', () => {
    const ring = new VisitedSpanRing(8);
    ring.record(0, 20, 1_000);
    expect(ring.visitedRecently(10, 25_000, 30_000)).toBe(true);
    expect(ring.visitedRecently(10, 40_000, 30_000)).toBe(false);
  });

  it('stays bounded — capacity, not script length (§63)', () => {
    const ring = new VisitedSpanRing(4);
    for (let i = 0; i < 100; i++) ring.record(i * 50, i * 50 + 5, 1000 + i);
    expect(ring.recent()).toHaveLength(4);
    // The oldest spans are gone, the newest are kept.
    expect(ring.visitedRecently(0, 1100, 30_000)).toBe(false);
    expect(ring.visitedRecently(99 * 50 + 2, 1100, 30_000)).toBe(true);
  });

  it('a position behind the cursor that was never read is not "visited"', () => {
    // The distinction `previouslyPassed` could not make: the cursor jumped from
    // 0 to 400 under command authority, so 200 is behind it and unread.
    const ring = new VisitedSpanRing(8);
    ring.record(0, 5, 1000);
    ring.record(400, 420, 1200);
    expect(ring.visitedRecently(200, 1200, 30_000)).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */

/**
 * Three paragraphs in one section. The middle one — the paragraph the
 * presenter restarts — opens on eight consecutive function words, which is an
 * entirely ordinary way for spoken English to begin a sentence and a blind
 * spot for `matchesPreviouslyReadOpening`: that heuristic collects the first
 * up-to-three *content* words within the first eight tokens, finds none here,
 * and gives up. No amount of correct transcription rescues it.
 */
const RETAKE_SOURCE = `# Calibration Notes

The kaleidoscope colours drift across the polished marble floor tonight before anyone arrives.

And so it is that we have to be extremely careful about the calibration harness we rebuilt last winter.

Afterwards the ensemble packs away the folding chairs and the music stands in silence.`;

const RESTARTED_PARAGRAPH =
  'And so it is that we have to be extremely careful about the calibration harness we rebuilt last winter';

function retakeDocument() {
  return compileFixtureScript(RETAKE_SOURCE, {
    rareWords: ['kaleidoscope', 'calibration', 'harness', 'ensemble'],
  });
}

interface Run {
  movements: string[];
  reasons: string[];
  committed: number[];
}

/**
 * Read all three paragraphs, then start the middle one again — verbatim, with
 * no "sorry" or "from the top" to fall back on, which is how a presenter
 * usually restarts when the camera is rolling.
 */
function runRestart(): Run {
  const document = retakeDocument();
  const engine = new AlignmentEngine(document, {
    sessionId: 'visited-retake',
    sessionGeneration: 1,
    stageGeneration: 1,
  });
  const scripter = new TranscriptScripter(10_000, 1);
  const turns = [
    'The kaleidoscope colours drift across the polished marble floor tonight before anyone arrives.',
    RESTARTED_PARAGRAPH,
    'Afterwards the ensemble packs away the folding chairs and the music stands in silence.',
    RESTARTED_PARAGRAPH,
    RESTARTED_PARAGRAPH,
  ];

  const movements: string[] = [];
  const committed: number[] = [];
  for (const text of turns) {
    let last: TrackingSnapshot | undefined;
    for (const event of scripter.speak({ text })) {
      const output = engine.handleTranscriptEvent(event);
      if (output.snapshot) {
        last = output.snapshot;
        movements.push(output.snapshot.movement);
      }
    }
    committed.push(last?.committedTokenIndex ?? -1);
  }
  return {
    movements,
    reasons: engine.decisionRecords().map((record) => record.reason),
    committed,
  };
}

describe('S2: a restart whose opening the heuristic cannot see (§21.1)', () => {
  it('a recent visit is enough evidence to commit the retake', () => {
    const run = runRestart();
    const context =
      `movements ${[...new Set(run.movements)].join(',')}; committed ${run.committed.join(',')}; ` +
      `reasons ${run.reasons.slice(-4).join('|')}`;

    // The presenter really did move past the paragraph before restarting it.
    expect(run.committed[2], context).toBeGreaterThan(run.committed[1] ?? 0);
    expect(run.movements, context).toContain('retake');
    // And it landed back on the paragraph, not somewhere convenient.
    expect(run.committed[run.committed.length - 1], context).toBe(run.committed[1]);
    // Persistence still applies: the first backward proposal is a candidate,
    // not a commit (§21.3).
    expect(run.reasons, context).toContain('retake_candidate');
    // Without the visited ring this run ends in `backward_not_retake` — the
    // paragraph opens on eight function words, so `repeatedOpening` is false
    // however perfectly it was transcribed.
    expect(run.reasons[run.reasons.length - 1], context).toBe('commit_retake');
  });
});
