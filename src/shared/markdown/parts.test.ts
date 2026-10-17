import { describe, expect, it } from 'vitest';
import { compile } from './compile';
import { deriveParts, nextPart, outlineSectionAt, partAt } from './parts';
import type { CueEvent, OutlineNode, SentenceUnit } from '../contracts';

/**
 * One `[Take: …]` marker as the compiler emits it.
 *
 * `anchorTokenIndex` is the compiler's own -1 when nothing spoken follows the
 * marker — see `DerivePartsInput.cues` for why parts read the cue rather than
 * the navigation target, which is clamped instead.
 */
function marker(id: string, label: string, anchorTokenIndex: number): CueEvent {
  return {
    id,
    blockId: `b-${id}`,
    cueType: 'take',
    label,
    anchorTokenIndex,
    source: { utf16Start: 0, utf16End: 1 },
  };
}

function heading(id: string, title: string, level: number, startTokenIndex: number): OutlineNode {
  return {
    id,
    level,
    title,
    normalizedTitle: title.toLowerCase(),
    blockId: `b-${id}`,
    startTokenIndex,
    endTokenIndex: startTokenIndex,
    children: [],
  };
}

describe('deriveParts', () => {
  it('has no parts for a script with no spoken words', () => {
    expect(deriveParts({ cues: [], outline: [], sentences: [], totalTokens: 0 })).toEqual([]);
  });

  it('has no parts when the only boundary is the beginning', () => {
    // A script with one heading at the top divides into one piece, which is
    // the whole script — not an offer worth making.
    const parts = deriveParts({
      cues: [],
      sentences: [],
      outline: [heading('h1', 'Script', 1, 0)],
      totalTokens: 50,
    });
    expect(parts).toEqual([]);
  });

  it('ignores the outline\'s synthetic nodes when picking the heading level', () => {
    /*
     * The regression: `buildOutline` synthesises a level-1 "Opening" for the
     * prose above the first heading, whatever level the author actually wrote.
     * Counting it made the shallowest level 1 for a document whose headings are
     * all H2, so the only boundary selected was the synthetic one and the
     * script came out undivided.
     *
     * A synthetic node is the one with an empty `blockId`.
     */
    const synthetic = { ...heading('h0', 'Opening', 1, 0), blockId: '' };
    const parts = deriveParts({
      cues: [],
      sentences: [],
      outline: [synthetic, heading('h1', 'Setup', 2, 10), heading('h2', 'Demo', 2, 30)],
      totalTokens: 50,
    });
    expect(parts.map((p) => p.label)).toEqual(['Opening', 'Setup', 'Demo']);
    expect(parts[0]).toMatchObject({ startTokenIndex: 0, endTokenIndex: 9 });
  });

  it('leaves a script with only the synthetic node undivided', () => {
    const parts = deriveParts({
      cues: [],
      sentences: [],
      outline: [{ ...heading('h1', 'Script', 1, 0), blockId: '' }],
      totalTokens: 50,
    });
    expect(parts).toEqual([]);
  });

  it('drops a marker with nothing spoken after it', () => {
    // The compiler writes -1 rather than a position when a marker has no
    // following spoken token. It is not a boundary and must not become a part.
    const parts = deriveParts({
      cues: [marker('t1', 'Pricing', 20), marker('t2', 'End', -1)],
      sentences: [],
      outline: [],
      totalTokens: 40,
    });
    expect(parts.map((p) => p.label)).toEqual(['Beginning', 'Pricing']);
    expect(parts[1]?.endTokenIndex).toBe(39);
  });

  it('divides on take markers and spans each to the next', () => {
    const parts = deriveParts({
      sentences: [],
      cues: [marker('t1', 'Opening', 0), marker('t2', 'Pricing', 30)],
      outline: [],
      totalTokens: 50,
    });
    expect(parts.map((p) => [p.label, p.startTokenIndex, p.endTokenIndex, p.ordinal])).toEqual([
      ['Opening', 0, 29, 1],
      ['Pricing', 30, 49, 2],
    ]);
    expect(parts.every((p) => p.origin === 'marker')).toBe(true);
  });

  it('gives the content above the first marker a part of its own', () => {
    const parts = deriveParts({
      sentences: [],
      cues: [marker('t1', 'Pricing', 30)],
      outline: [heading('h0', 'Opening', 1, 0)],
      totalTokens: 50,
    });
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ label: 'Opening', startTokenIndex: 0, endTokenIndex: 29 });
    expect(parts[1]).toMatchObject({ label: 'Pricing', startTokenIndex: 30, endTokenIndex: 49 });
  });

  it('names an unnamed opening "Beginning" when the outline offers nothing', () => {
    const parts = deriveParts({
      sentences: [],
      cues: [marker('t1', 'Pricing', 30)],
      outline: [],
      totalTokens: 50,
    });
    expect(parts[0]?.label).toBe('Beginning');
  });

  it('falls back to headings, at the shallowest level only', () => {
    const parts = deriveParts({
      cues: [],
      sentences: [],
      outline: [
        { ...heading('h1', 'One', 1, 0), children: [heading('h2', 'One a', 2, 5)] },
        { ...heading('h3', 'Two', 1, 20), children: [heading('h4', 'Two a', 2, 25)] },
      ],
      totalTokens: 40,
    });
    expect(parts.map((p) => p.label)).toEqual(['One', 'Two']);
    expect(parts.every((p) => p.origin === 'heading')).toBe(true);
    expect(parts[0]?.endTokenIndex).toBe(19);
  });

  it('prefers markers over headings when a script has both', () => {
    const parts = deriveParts({
      sentences: [],
      cues: [marker('t1', 'Take one', 0), marker('t2', 'Take two', 10)],
      outline: [heading('h1', 'One', 1, 0), heading('h2', 'Two', 1, 5), heading('h3', 'Three', 1, 20)],
      totalTokens: 40,
    });
    expect(parts.map((p) => p.label)).toEqual(['Take one', 'Take two']);
  });

  it('collapses two boundaries on one token, keeping the one the words follow', () => {
    // An author who renames a break by writing a new one above it has said
    // which name they meant; the content below belongs to the later marker.
    const parts = deriveParts({
      sentences: [],
      cues: [marker('t1', 'First', 0), marker('t2', 'Also first', 0), marker('t3', 'Second', 10)],
      outline: [],
      totalTokens: 20,
    });
    expect(parts.map((p) => p.label)).toEqual(['Also first', 'Second']);
  });

  it('ignores boundaries past the end of the script', () => {
    const parts = deriveParts({
      sentences: [],
      cues: [marker('t1', 'A', 0), marker('t2', 'B', 5), marker('t3', 'Off the end', 99)],
      outline: [],
      totalTokens: 20,
    });
    expect(parts.map((p) => p.label)).toEqual(['A', 'B']);
    expect(parts[1]?.endTokenIndex).toBe(19);
  });

  it('snaps a boundary inside a sentence back to the whole sentence', () => {
    const sentences: SentenceUnit[] = [
      {
        id: 's-a',
        blockId: 'b1',
        startTokenIndex: 0,
        endTokenIndex: 9,
        normalizedText: 'first',
        source: { utf16Start: 0, utf16End: 1 },
      },
      {
        id: 's-b',
        blockId: 'b1',
        startTokenIndex: 10,
        endTokenIndex: 19,
        normalizedText: 'second',
        source: { utf16Start: 1, utf16End: 2 },
      },
    ];
    // The marker is written mid-sentence, at token 14. The sentence it splits
    // belongs whole to the part it opens, so the boundary moves back to 10.
    const parts = deriveParts({
      sentences,
      cues: [marker('t1', 'Second half', 14)],
      outline: [],
      totalTokens: 20,
    });
    expect(parts).toHaveLength(2);
    expect(parts[0]?.endTokenIndex).toBe(9);
    expect(parts[1]).toMatchObject({ label: 'Second half', startTokenIndex: 10 });
  });

  it('leaves a boundary that is already between sentences alone', () => {
    const sentences: SentenceUnit[] = [
      {
        id: 's-a',
        blockId: 'b1',
        startTokenIndex: 0,
        endTokenIndex: 9,
        normalizedText: 'first',
        source: { utf16Start: 0, utf16End: 1 },
      },
    ];
    // Token 10 is past the last sentence — a heading's own start, say. It is
    // already a boundary between units and must not be dragged backwards.
    const parts = deriveParts({
      sentences,
      cues: [marker('t1', 'Next', 10)],
      outline: [],
      totalTokens: 20,
    });
    expect(parts[1]?.startTokenIndex).toBe(10);
  });

  it('covers every spoken token exactly once, with no gaps', () => {
    const parts = deriveParts({
      sentences: [],
      cues: [marker('t1', 'A', 0), marker('t2', 'B', 7), marker('t3', 'C', 13)],
      outline: [],
      totalTokens: 20,
    });
    expect(parts[0]?.startTokenIndex).toBe(0);
    expect(parts[parts.length - 1]?.endTokenIndex).toBe(19);
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]!.startTokenIndex).toBe(parts[i - 1]!.endTokenIndex + 1);
    }
  });
});

describe('partAt / nextPart', () => {
  const parts = deriveParts({
    sentences: [],
    cues: [marker('t1', 'A', 0), marker('t2', 'B', 10), marker('t3', 'C', 20)],
    outline: [],
    totalTokens: 30,
  });

  it('finds the part a token is inside', () => {
    expect(partAt(parts, 0)?.label).toBe('A');
    expect(partAt(parts, 9)?.label).toBe('A');
    expect(partAt(parts, 10)?.label).toBe('B');
    expect(partAt(parts, 29)?.label).toBe('C');
  });

  it('walks forward and stops at the last part', () => {
    expect(nextPart(parts, partAt(parts, 0))?.label).toBe('B');
    expect(nextPart(parts, partAt(parts, 20))).toBeNull();
    expect(nextPart(parts, null)).toBeNull();
  });
});

/*
 * The section a position is in (#285). The take summary counts these and names
 * its ending from them, so the rule has to be the innermost heading — a parent
 * spans its children, and "in the parent" would be true of every token.
 */
describe('outlineSectionAt', () => {
  const nested: OutlineNode[] = [
    {
      ...heading('h1', 'Talk', 1, 0),
      children: [heading('h2a', 'Setup', 2, 10), heading('h2b', 'Demo', 2, 20)],
    },
  ];

  it('names the innermost heading the token is under', () => {
    expect(outlineSectionAt(nested, 0)?.id).toBe('h1');
    expect(outlineSectionAt(nested, 9)?.id).toBe('h1');
    expect(outlineSectionAt(nested, 10)?.id).toBe('h2a');
    expect(outlineSectionAt(nested, 25)?.id).toBe('h2b');
  });

  it('does not reach a heading half a token early', () => {
    expect(outlineSectionAt(nested, 9.6)?.id).toBe('h1');
  });

  it('gives a shared start to the later heading', () => {
    // A heading with nothing spoken under it starts on the same token as the
    // next one, and the words there belong to the next.
    const empty: OutlineNode[] = [heading('a', 'Empty', 2, 0), heading('b', 'Full', 2, 0)];
    expect(outlineSectionAt(empty, 0)?.id).toBe('b');
  });

  it('has no section without an outline, or before its first node', () => {
    expect(outlineSectionAt([], 5)).toBeNull();
    expect(outlineSectionAt([heading('late', 'Late', 2, 10)], 3)).toBeNull();
  });

  it('resolves the compiler’s own synthetic sections', async () => {
    const compiled = await compile(
      ['An opening line.', '', '## Setup', '', 'Then the setup.'].join('\n'),
      { scriptId: 'outline-at' },
    );
    expect(outlineSectionAt(compiled.outline, 0)?.title).toBe('Opening');
    const plain = await compile('Just prose.', { scriptId: 'outline-at-2' });
    expect(outlineSectionAt(plain.outline, 0)?.title).toBe('Script');
  });
});

describe('compile emits parts', () => {
  it('divides an authored script on its take markers', async () => {
    const source = [
      '# Welcome',
      '',
      'This is the opening of the talk and it runs for a while.',
      '',
      '[Take: Pricing]',
      '',
      'Now we talk about what it costs.',
      '',
      '[Take: Close]',
      '',
      'And that is the end of it.',
    ].join('\n');
    const compiled = await compile(source, { scriptId: 's1' });
    const parts = compiled.parts ?? [];
    expect(parts.map((p) => p.label)).toEqual(['Welcome', 'Pricing', 'Close']);
    expect(parts[0]?.startTokenIndex).toBe(0);
    expect(parts[parts.length - 1]?.endTokenIndex).toBe(
      compiled.statistics.spokenWordCount - 1,
    );
  });

  it('divides an unmarked script on its top-level headings', async () => {
    const source = [
      '# One',
      '',
      'First section body text here.',
      '',
      '## Nested',
      '',
      'A nested section that must not become a part.',
      '',
      '# Two',
      '',
      'Second section body text here.',
    ].join('\n');
    const compiled = await compile(source, { scriptId: 's2' });
    expect((compiled.parts ?? []).map((p) => p.label)).toEqual(['One', 'Two']);
  });

  it('divides an H2 script that opens with prose', async () => {
    /*
     * Through a real compile, because this is exactly the case the direct
     * helper tests could not see: `buildOutline` inserts a synthetic level-1
     * "Opening" here, and counting it as an authored heading left the whole
     * document undivided.
     */
    const source = [
      'A sentence of introduction before anything else.',
      '',
      '## Setup',
      '',
      'How to get everything ready.',
      '',
      '## Demo',
      '',
      'The part where it actually runs.',
    ].join('\n');
    const compiled = await compile(source, { scriptId: 's4' });
    expect((compiled.parts ?? []).map((p) => p.label)).toEqual(['Opening', 'Setup', 'Demo']);
  });

  it('makes no part of a marker with nothing after it', async () => {
    /*
     * `compile.ts` CLAMPS a trailing take marker's navigation target onto the
     * last token so voice navigation still has a destination. Read through that
     * clamp, the marker looked like a boundary sitting on the final word, and
     * snapping dragged it back far enough to steal the closing sentence into a
     * part of its own.
     */
    const source = [
      '# Talk',
      '',
      'First sentence here. Second sentence here.',
      '',
      '[Take: End]',
    ].join('\n');
    const compiled = await compile(source, { scriptId: 's5' });
    expect((compiled.parts ?? []).map((p) => p.label)).not.toContain('End');
    // With that marker gone there is no division left to offer at all.
    expect(compiled.parts).toEqual([]);
  });

  it('leaves a structureless script with no parts', async () => {
    const compiled = await compile('Just one paragraph of plain prose.', { scriptId: 's3' });
    expect(compiled.parts).toEqual([]);
  });
});
