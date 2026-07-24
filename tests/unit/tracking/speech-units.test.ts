/**
 * Companion §6.1 — the parts of the speech-unit axis that were missing.
 *
 * The unit axis is what the stage's motion path is parameterised on, so an
 * error here is not an abstract accounting mistake: it is the text running
 * ahead of the presenter through punctuated prose, and running straight
 * through a silence the writer explicitly asked for.
 *
 * Two of §6.1's seven rules had no implementation and, crucially, no place to
 * *get* an implementation from:
 *
 *   - "comma or light clause boundary: virtual pause weight". `speech-units.ts`
 *     zeroed `TOKEN_FLAG.punctuation`, but `markdown/tokenize.ts` says in its
 *     own header that "pure punctuation never becomes a token", and nothing in
 *     the compiler ever sets `TOKEN_FLAGS.PUNCTUATION`. The branch could not
 *     fire, and there was no comma anywhere in the tracking document to fire on.
 *   - "explicit pause directive: authored duration or weight". `[Pause]`
 *     compiles to a `CueEvent`, and `TrackingDocument` did not carry cues.
 *
 * Both are therefore asserted against *known totals* rather than against
 * "more than before", and both are asserted through the real compiler, because
 * the recovery path (render-node text + `tokenIndexes`) is the thing under
 * test.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown/compile';
import { DEFAULT_TRACKING_PROFILE } from '../../../src/shared/tracking/profile';
import { SpeechUnitScale } from '../../../src/shared/tracking/speech-units';
import { buildTrackingDocument } from '../../../src/shared/tracking/types';
import type { TrackingDocument } from '../../../src/shared/tracking/types';

const PROFILE = DEFAULT_TRACKING_PROFILE;

function documentFor(source: string): TrackingDocument {
  const script = compile(source, { scriptId: 'units' });
  return buildTrackingDocument(script, script.literalCommandRanges);
}

function scaleFor(source: string): SpeechUnitScale {
  return new SpeechUnitScale(documentFor(source), PROFILE);
}

describe('§6.1 comma and light-clause weight', () => {
  it('gives a known total on a passage with a known comma count', () => {
    // Four ordinary content words (none long enough for `unitLongWeight`, none
    // a stopword), three commas, one paragraph end.
    const document = documentFor('Alpha, beta, gamma, delta.');
    expect(document.spokenTokens.map((t) => t.normalized)).toEqual([
      'alpha',
      'beta',
      'gamma',
      'delta',
    ]);
    expect(document.clauseEndTokenIndexes).toEqual([0, 1, 2]);

    const scale = new SpeechUnitScale(document, PROFILE);
    const expected =
      4 * PROFILE.unitNormalWeight + 3 * PROFILE.unitClausePause + PROFILE.unitBlockEndPause;
    expect(scale.totalUnits).toBeCloseTo(expected, 10);
    // The number that would come out if the comma rule were still missing.
    expect(scale.totalUnits).toBeCloseTo(8.2, 10);
    expect(4 * PROFILE.unitNormalWeight + PROFILE.unitBlockEndPause).toBeCloseTo(6.4, 10);
  });

  it('scales with the comma count and nothing else', () => {
    const plain = scaleFor('Alpha beta gamma delta.');
    const commas = scaleFor('Alpha, beta, gamma, delta.');
    expect(commas.totalUnits - plain.totalUnits).toBeCloseTo(3 * PROFILE.unitClausePause, 10);
  });

  it('reads a comma that emphasis pushed into the next render node', () => {
    // `**first**,` splits into a bare-text node and a marked node, so the comma
    // arrives at the head of the run *after* the token it belongs to.
    const document = documentFor('Well, **first**, we ship.');
    expect(document.spokenTokens.map((t) => t.normalized)).toEqual([
      'well',
      'first',
      'we',
      'ship',
    ]);
    expect(document.clauseEndTokenIndexes).toEqual([0, 1]);
  });

  it('counts semicolons, colons and dashes as clause breaks and full stops as neither', () => {
    expect(documentFor('Alpha; beta: gamma — delta.').clauseEndTokenIndexes).toEqual([0, 1, 2]);
    expect(documentFor('Alpha. Beta. Gamma.').clauseEndTokenIndexes).toBeUndefined();
  });

  it('does not let a clause break and a sentence end both charge the same token', () => {
    // "…gamma," then a full stop: the token is a sentence end, and a sentence
    // end is the larger of the two, not the sum.
    const scale = scaleFor('Alpha, beta. Gamma delta.');
    const expected =
      4 * PROFILE.unitNormalWeight +
      PROFILE.unitClausePause +
      PROFILE.unitSentenceEndPause +
      PROFILE.unitBlockEndPause;
    expect(scale.totalUnits).toBeCloseTo(expected, 10);
  });

  it('leaves a document with no blocks exactly where it was', () => {
    const script = compile('Alpha, beta, gamma, delta.', { scriptId: 'units' });
    const withoutBlocks = buildTrackingDocument({
      scriptId: script.scriptId,
      spokenTokens: script.spokenTokens,
      sentences: script.sentences,
      outline: script.outline,
      navigationTargets: script.navigationTargets,
    });
    expect(withoutBlocks.clauseEndTokenIndexes).toBeUndefined();
    expect(new SpeechUnitScale(withoutBlocks, PROFILE).totalUnits).toBeCloseTo(6.4, 10);
  });
});

describe('§6.1 authored pause directives', () => {
  it('lengthens the predicted interval across an authored [Pause]', () => {
    const withPause = documentFor('Alpha beta. [Pause] Gamma delta.');
    const without = documentFor('Alpha beta. Gamma delta.');
    expect(withPause.pauseAnchors).toEqual([{ tokenIndex: 1, kind: 'pause' }]);
    expect(without.pauseAnchors).toBeUndefined();

    const paused = new SpeechUnitScale(withPause, PROFILE);
    const straight = new SpeechUnitScale(without, PROFILE);

    // The prediction between two tokens *is* the unit distance between them:
    // the beam advances `paceUnitsPerSecond * dt` units per update, so a wider
    // interval is exactly "expect the presenter to still be here".
    expect(straight.distanceUnits(1, 2)).toBeCloseTo(
      PROFILE.unitNormalWeight + PROFILE.unitSentenceEndPause,
      10,
    );
    expect(paused.distanceUnits(1, 2)).toBeCloseTo(
      PROFILE.unitNormalWeight + PROFILE.unitSentenceEndPause + PROFILE.unitAuthoredPause,
      10,
    );
    expect(paused.totalUnits - straight.totalUnits).toBeCloseTo(PROFILE.unitAuthoredPause, 10);

    // And the prediction lands somewhere else: two seconds of coasting at three
    // units a second sits inside the silence rather than two tokens on.
    const from = straight.unitAt(1);
    expect(straight.tokenIndexAt(from + 3.0)).toBe(2);
    expect(paused.tokenIndexAt(paused.unitAt(1) + 3.0)).toBe(1);
  });

  it('honours the relative length of [Beat], [Pause] and [Breathe]', () => {
    const base = scaleFor('Alpha beta. Gamma delta.').totalUnits;
    const beat = scaleFor('Alpha beta. [Beat] Gamma delta.').totalUnits;
    const pause = scaleFor('Alpha beta. [Pause] Gamma delta.').totalUnits;
    const breathe = scaleFor('Alpha beta. [Breathe] Gamma delta.').totalUnits;
    expect(beat - base).toBeCloseTo(PROFILE.unitBeatPause, 10);
    expect(pause - base).toBeCloseTo(PROFILE.unitAuthoredPause, 10);
    expect(breathe - base).toBeCloseTo(PROFILE.unitBreathePause, 10);
    expect(beat).toBeLessThan(pause);
    expect(pause).toBeLessThan(breathe);
  });

  it('adds an authored pause on top of the punctuation already there', () => {
    // A `[Pause]` after a full stop is the writer asking for more than the
    // full stop already implies, so the two are not exclusive.
    const scale = scaleFor('Alpha beta. [Pause] Gamma delta.');
    const expected =
      4 * PROFILE.unitNormalWeight +
      PROFILE.unitSentenceEndPause +
      PROFILE.unitAuthoredPause +
      PROFILE.unitBlockEndPause;
    expect(scale.totalUnits).toBeCloseTo(expected, 10);
  });

  it('drops a pause with no token in front of it and keeps a trailing one', () => {
    expect(documentFor('[Pause] Alpha beta.').pauseAnchors).toBeUndefined();
    const trailing = documentFor('Alpha beta. [Breathe]');
    expect(trailing.pauseAnchors).toEqual([{ tokenIndex: 1, kind: 'breathe' }]);
  });

  it('ignores a [Cue: …] label, which is direction rather than silence', () => {
    expect(documentFor('Alpha beta. [Cue: smile] Gamma delta.').pauseAnchors).toBeUndefined();
  });
});
