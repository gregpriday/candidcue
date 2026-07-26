/**
 * The app's own starter script, read word for word, must be followed.
 *
 * This is the smallest honest end-to-end question the product has, and until
 * now the answer was no — for this script and for every other one.
 *
 * A perfect match scored 0.549. `matchTokens` weighs a word by the SCRIPT
 * token's weight and stopword flag; `idealTokenScore` weighed the same word by
 * the TRANSCRIPT token's `content` flag. Those judgements come from different
 * lists: the compiler marked `say`, `way` and `them` low-weight, the ledger
 * called them content. Each such word scored 0.175 against a demanded 3.0, so
 * a word-perfect read was normalized against an ideal it could not reach. The
 * confidence model turned 0.549 into 0.60 and `lockedThreshold` is 0.78, so
 * the aligner committed nothing, ever, on any script.
 *
 * Live evidence, 2026-07-26: a full read of this exact script produced two
 * items of 14 and 12 words — the two sentences, transcribed perfectly — and a
 * summary card reading "Script followed 0 of 26 words (0%)".
 *
 * The transcript below is that take. Both the fixture and the expectations are
 * the real thing, so this test fails if the scoring asymmetry ever returns.
 */
import { describe, expect, it } from 'vitest';
import { AlignmentEngine } from '../../src/shared/tracking/engine';
import { compile } from '../../src/shared/markdown/compile';
import { buildTrackingDocument } from '../../src/shared/tracking/types';
import type { TranscriptEvent } from '../../src/shared/tracking/types';

/** `scripts/<id>/script.md` as the app creates it for a new user. */
const STARTER_SCRIPT = `# Your first section

Write the words you plan to say, exactly the way you would say them. When you present, the stage follows your voice and keeps your place.

[Cue: smile and hold eye contact]
`;

/** The two utterances Inworld returned, at the word counts the trace recorded. */
const TAKE = [
  {
    itemId: '1-0',
    partials: [
      'Write the words you plan to',
      'Write the words you plan to say',
      'Write the words you plan to say exactly the way',
      'Write the words you plan to say exactly the way you would say them',
    ],
    final: 'Write the words you plan to say, exactly the way you would say them.',
  },
  {
    itemId: '1-1',
    partials: [
      'When you present the stage',
      'When you present the stage follows your voice',
      'When you present the stage follows your voice and keeps your place',
    ],
    final: 'When you present, the stage follows your voice and keeps your place.',
  },
];

function engineForStarterScript(): AlignmentEngine {
  const compiled = compile(STARTER_SCRIPT, { scriptId: 'script-1' });
  const document = buildTrackingDocument(compiled, compiled.literalCommandRanges);
  return new AlignmentEngine(document, {
    sessionId: 'session-1',
    sessionGeneration: 1,
    stageGeneration: 1,
    layoutGeneration: 1,
  });
}

describe('the starter script, read verbatim', () => {
  it('is followed to the last word', () => {
    const engine = engineForStarterScript();
    let now = 1_000;
    const send = (event: Record<string, unknown>): void => {
      now += 800;
      engine.handleTranscriptEvent({
        sessionGeneration: 1,
        receivedAtMs: now,
        ...event,
      } as unknown as TranscriptEvent);
    };

    let commitSequence = 0;
    for (const utterance of TAKE) {
      send({
        type: 'item_started',
        itemId: utterance.itemId,
        commitSequence: commitSequence++,
        audioStartMs: now,
      });
      for (const text of utterance.partials) {
        send({ type: 'delta', itemId: utterance.itemId, text });
      }
      send({
        type: 'completed',
        itemId: utterance.itemId,
        text: utterance.final,
        audioEndMs: now + 400,
      });
    }

    const snapshot = engine.toSnapshot(now);
    // 26 spoken tokens, indexed 0..25 — the heading is not spoken.
    expect(
      snapshot.committedTokenIndex,
      'a word-perfect read of the app’s own starter script was not followed',
    ).toBe(25);
    expect(snapshot.state).toBe('following');
    expect(snapshot.confidence).toBeGreaterThanOrEqual(0.78);
  });

  it('commits the first sentence before the second is spoken', () => {
    /*
     * Following at the END is not following. The cursor has to move as the
     * presenter reads, so the first utterance alone must commit — this is the
     * assertion that fails if the aligner only ever resolves in hindsight.
     */
    const engine = engineForStarterScript();
    let now = 1_000;
    const send = (event: Record<string, unknown>): void => {
      now += 800;
      engine.handleTranscriptEvent({
        sessionGeneration: 1,
        receivedAtMs: now,
        ...event,
      } as unknown as TranscriptEvent);
    };

    const [first] = TAKE;
    if (first === undefined) throw new Error('fixture');
    send({ type: 'item_started', itemId: first.itemId, commitSequence: 0, audioStartMs: now });
    for (const text of first.partials) send({ type: 'delta', itemId: first.itemId, text });
    send({ type: 'completed', itemId: first.itemId, text: first.final, audioEndMs: now + 400 });

    // Sentence one is tokens 0..13.
    expect(engine.toSnapshot(now).committedTokenIndex).toBe(13);
  });

  it('reaches full confidence on a perfect match, not 0.60', () => {
    /*
     * The number the whole defect reduces to. A verbatim read scored 0.549
     * normalized, 0.60 after the confidence model, against a lock threshold of
     * 0.78 — so close that it looked like tuning rather than a broken metric.
     */
    const engine = engineForStarterScript();
    let now = 1_000;
    const [first] = TAKE;
    if (first === undefined) throw new Error('fixture');
    engine.handleTranscriptEvent({
      type: 'completed',
      sessionGeneration: 1,
      itemId: first.itemId,
      text: first.final,
      audioEndMs: 6_000,
      receivedAtMs: (now += 800),
    } as unknown as TranscriptEvent);

    expect(engine.toSnapshot(now).confidence).toBeGreaterThan(0.9);
  });
});
