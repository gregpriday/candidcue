/**
 * §31.4 script view.
 *
 * The central claim — "do not permanently edit the source Markdown" — is
 * tested two ways, because a text-equality assertion alone would still pass if
 * the module re-derived an identical string from a lossy model. The passages
 * must be the *same objects*, and the whole input is deep-frozen so any write
 * attempt throws in strict mode.
 */
import { describe, expect, it } from 'vitest';
import { annotateScript } from '../../../../src/shared/coaching/review/script-annotations';
import { makeFiller, makePass, makeRecord, TEST_SCRIPT } from './support';
import type { ReviewScript } from '../../../../src/shared/coaching/review/types';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('the source script is never edited', () => {
  it('returns the very same passage objects it was given', () => {
    const annotated = annotateScript(
      TEST_SCRIPT,
      makeRecord([makePass({ fillers: [makeFiller({ atMs: 1_000, scriptAnchorTokenId: 't4' })] })]),
    );
    expect(annotated.passages).toHaveLength(3);
    annotated.passages.forEach((entry, position) => {
      expect(entry.passage).toBe(TEST_SCRIPT.passages[position]);
    });
  });

  it('works against a deep-frozen script and leaves the text byte-identical', () => {
    const frozen = deepFreeze<ReviewScript>(JSON.parse(JSON.stringify(TEST_SCRIPT)));
    const before = frozen.passages.map((passage) => passage.text);
    const annotated = annotateScript(
      frozen,
      makeRecord([
        makePass({
          coveredSpanIds: ['span-a', 'span-b'],
          fillers: [makeFiller({ atMs: 1_000, scriptAnchorTokenId: 't1' })],
        }),
      ]),
    );
    expect(annotated.passages.map((entry) => entry.passage.text)).toEqual(before);
    expect(frozen.passages.map((passage) => passage.text)).toEqual(before);
  });
});

describe('annotation placement', () => {
  const annotated = annotateScript(
    TEST_SCRIPT,
    makeRecord([
      makePass({
        coveredSpanIds: ['span-a', 'span-b', 'span-c'],
        fillers: [
          makeFiller({ atMs: 1_000, scriptAnchorTokenId: 't4' }),
          // §11.2: a filler anchors to the nearest preceding authored token.
          makeFiller({ atMs: 2_000, scriptAnchorTokenId: 't5' }),
          // No anchor at all — §16.3.4 says count it, do not place it.
          makeFiller({ atMs: 3_000, scriptAnchorTokenId: null }),
          // A probable detection must never mark the script.
          makeFiller({ atMs: 4_000, scriptAnchorTokenId: 't1', confidence: 'probable' }),
          makeFiller({
            atMs: 5_000,
            kind: 'contextual',
            normalizedForm: 'like',
            scriptAnchorTokenId: 't7',
          }),
        ],
        boundaries: [
          { atMs: 6_000, strength: 'strong', shaped: false, spanId: 'span-a', scriptAnchorTokenId: 't3' },
          // Weak boundaries are not eligible and carry no claim (§18.3).
          { atMs: 7_000, strength: 'weak', shaped: false, spanId: 'span-a', scriptAnchorTokenId: 't2' },
        ],
        criticalFindings: [
          {
            findingId: 'f1',
            kind: 'critical_number_mismatch',
            atMs: 8_000,
            endMs: 8_500,
            takePassId: 'pass-1',
            spanId: 'span-b',
            scriptAnchorTokenId: null,
            authoredFragment: 'forty percent',
            spokenFragment: 'fourteen percent',
            localConfidence: 0.94,
            selfCorrected: false,
          },
        ],
      }),
    ]),
  );

  const byId = new Map(annotated.passages.map((entry) => [entry.passage.spanId, entry]));

  it('places anchored fillers on the passage that owns the token', () => {
    const spanB = byId.get('span-b');
    expect(spanB?.annotations.filter((a) => a.kind === 'filler_insertion')).toHaveLength(2);
  });

  it('lists an unanchored filler separately instead of guessing a sentence', () => {
    expect(annotated.unanchored).toHaveLength(1);
    expect(annotated.unanchored[0]?.kind).toBe('filler_insertion');
    const placed = annotated.passages.flatMap((entry) => entry.annotations);
    expect(placed.map((a) => a.annotationId)).not.toContain(annotated.unanchored[0]?.annotationId);
  });

  it('never marks the script from a probable detection', () => {
    const spanA = byId.get('span-a');
    expect(spanA?.annotations.some((a) => a.kind === 'filler_insertion')).toBe(false);
  });

  it('quotes a strict filler and does not quote a contextual one (§25.3)', () => {
    const labels = annotated.passages.flatMap((entry) =>
      entry.annotations.map((a) => a.label),
    );
    expect(labels).toContain('“um”');
    expect(labels).toContain('Filler');
    expect(labels.join(' ')).not.toContain('like');
  });

  it('marks only eligible boundaries', () => {
    const spanA = byId.get('span-a');
    const boundaries = spanA?.annotations.filter((a) => a.kind.startsWith('boundary_')) ?? [];
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]?.kind).toBe('boundary_unshaped');
  });

  it('places a span-addressed critical finding and keeps both fragments', () => {
    const spanB = byId.get('span-b');
    const mismatch = spanB?.annotations.find((a) => a.kind === 'critical_mismatch');
    expect(mismatch?.authoredFragment).toBe('forty percent');
    expect(mismatch?.spokenFragment).toBe('fourteen percent');
  });

  it('orders a passage’s annotations by audio time', () => {
    for (const entry of annotated.passages) {
      const times = entry.annotations.map((a) => a.atMs);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });
});

describe('repeated passages and take passes (§11.3)', () => {
  const annotated = annotateScript(
    TEST_SCRIPT,
    makeRecord([
      makePass({
        takePassId: 'p1',
        passOrdinal: 1,
        startMs: 0,
        endMs: 50_000,
        coveredSpanIds: ['span-a', 'span-b', 'span-c'],
        fillers: [makeFiller({ atMs: 10_000, takePassId: 'p1', scriptAnchorTokenId: 't4' })],
      }),
      makePass({
        takePassId: 'p2',
        passOrdinal: 2,
        startMs: 50_000,
        endMs: 100_000,
        coveredSpanIds: ['span-a', 'span-b'],
        fillers: [makeFiller({ atMs: 60_000, takePassId: 'p2', scriptAnchorTokenId: 't4' })],
      }),
    ]),
  );
  const byId = new Map(annotated.passages.map((entry) => [entry.passage.spanId, entry]));

  it('marks a passage read by more than one pass', () => {
    expect(byId.get('span-a')?.annotations.some((a) => a.kind === 'repeated_passage')).toBe(true);
    expect(byId.get('span-b')?.annotations.find((a) => a.kind === 'repeated_passage')?.label).toBe(
      'Read in 2 passes',
    );
  });

  it('does not mark a passage read once', () => {
    expect(byId.get('span-c')?.annotations.some((a) => a.kind === 'repeated_passage')).toBe(false);
    expect(byId.get('span-c')?.passOrdinals).toEqual([1]);
  });

  it('keeps both passes’ fillers, each labelled with its own pass', () => {
    const fillers = byId.get('span-b')?.annotations.filter((a) => a.kind === 'filler_insertion');
    expect(fillers?.map((a) => a.passOrdinal)).toEqual([1, 2]);
    expect(fillers?.map((a) => a.takePassId)).toEqual(['p1', 'p2']);
  });

  it('records which passes covered each passage', () => {
    expect(byId.get('span-a')?.passOrdinals).toEqual([1, 2]);
  });
});

describe('script revision drift', () => {
  it('flags a script that has moved on since the take', () => {
    const annotated = annotateScript(
      { ...TEST_SCRIPT, scriptRevision: 9 },
      makeRecord([makePass()]),
    );
    expect(annotated.revisionMismatch).toBe(true);
  });

  it('does not flag a matching revision', () => {
    expect(annotateScript(TEST_SCRIPT, makeRecord([makePass()])).revisionMismatch).toBe(false);
  });
});

describe('an empty take', () => {
  it('produces a script with no annotations rather than an empty script', () => {
    const annotated = annotateScript(TEST_SCRIPT, makeRecord([]));
    expect(annotated.passages).toHaveLength(3);
    expect(annotated.passages.every((entry) => entry.annotations.length === 0)).toBe(true);
    expect(annotated.unanchored).toEqual([]);
  });
});
