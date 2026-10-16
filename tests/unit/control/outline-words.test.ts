/**
 * Outline section word counts (#246).
 *
 * The outline's per-section times subtracted `startTokenIndex` from an
 * INCLUSIVE `endTokenIndex`, so every section lost a word, and the compiler's
 * clamp makes `+1` no fix: an empty section and a one-word section carry the
 * same endpoints. These run the real compiler, because it is the compiler's
 * nesting the counts have to agree with.
 */
import { describe, expect, it } from 'vitest';
import { sectionWordCounts } from '../../../src/control/lib/outline-words';
import { compile } from '../../../src/shared/markdown';
import type { OutlineNode } from '../../../src/shared/contracts';

function compiled(source: string, readHeadings = false) {
  return compile(source, { scriptId: 'outline-words', readHeadings });
}

/** Every section's word count by title, in document order. */
function countsByTitle(source: string, readHeadings = false): Array<[string, number]> {
  const script = compiled(source, readHeadings);
  const counts = sectionWordCounts(script.outline, script.statistics.spokenWordCount);
  const out: Array<[string, number]> = [];
  const walk = (nodes: OutlineNode[]): void => {
    for (const node of nodes) {
      out.push([node.title, counts.get(node.id) ?? -1]);
      walk(node.children);
    }
  };
  walk(script.outline);
  return out;
}

/** Top-level sections cover the script exactly once, so they sum to it. */
function expectRootsCoverScript(source: string, readHeadings = false): void {
  const script = compiled(source, readHeadings);
  const counts = sectionWordCounts(script.outline, script.statistics.spokenWordCount);
  const roots = script.outline.reduce((sum, node) => sum + (counts.get(node.id) ?? 0), 0);
  expect(roots).toBe(script.statistics.spokenWordCount);
}

const SECTIONS = [
  '# Intro',
  '',
  'One two three.',
  '',
  '## Empty',
  '',
  '## Single',
  '',
  'Word.',
  '',
  '# Close',
  '',
].join('\n');

describe('sectionWordCounts', () => {
  it('counts every word in a section, the last one included', () => {
    expect(countsByTitle(SECTIONS)).toEqual([
      ['Intro', 4],
      ['Empty', 0],
      ['Single', 1],
      ['Close', 0],
    ]);
    expectRootsCoverScript(SECTIONS);
  });

  it('tells an empty section from a one-word one, which the endpoints cannot', () => {
    const script = compiled(SECTIONS);
    const [intro] = script.outline;
    const [empty, single] = intro!.children;
    // The ambiguity this module exists for: identical endpoints, different sizes.
    expect(empty!.endTokenIndex - empty!.startTokenIndex).toBe(0);
    expect(single!.endTokenIndex - single!.startTokenIndex).toBe(0);
    const counts = sectionWordCounts(script.outline, script.statistics.spokenWordCount);
    expect(counts.get(empty!.id)).toBe(0);
    expect(counts.get(single!.id)).toBe(1);
  });

  it('counts heading words when headings are read aloud', () => {
    expect(countsByTitle(SECTIONS, true)).toEqual([
      ['Intro', 7],
      ['Empty', 1],
      ['Single', 2],
      ['Close', 1],
    ]);
    expectRootsCoverScript(SECTIONS, true);
  });

  it('includes a section’s subsections in its own count', () => {
    const source = '# Part\n\nAlpha beta.\n\n## Sub\n\nGamma delta epsilon.\n\n### Deep\n\nZeta.\n\n# Next\n\nEta.\n';
    expect(countsByTitle(source)).toEqual([
      ['Part', 6],
      ['Sub', 4],
      ['Deep', 1],
      ['Next', 1],
    ]);
    expectRootsCoverScript(source);
  });

  it('ends an empty last subsection where the next top-level section starts', () => {
    // `B` is empty, so its clamped end lands on `C`'s first token, and widening
    // carries `A` there too. The starts say where `A` really stops.
    const source = '# A\n\nAlpha beta.\n\n## B\n\n# C\n\nGamma.\n';
    const script = compiled(source);
    expect(script.outline[0]!.endTokenIndex).toBe(script.outline[1]!.startTokenIndex);
    expect(countsByTitle(source)).toEqual([
      ['A', 2],
      ['B', 0],
      ['C', 1],
    ]);
    expectRootsCoverScript(source);
  });

  it('gives the opening the words above the first heading, and what nests under it', () => {
    const source = 'Before any heading.\n\n## Two\n\nAlpha beta.\n\n# One\n\nGamma.\n';
    // The compiler nests a leading H2 under the synthetic level-1 Opening, and
    // widens Opening over it; the count follows the same tree.
    expect(countsByTitle(source)).toEqual([
      ['Opening', 5],
      ['Two', 2],
      ['One', 1],
    ]);
    expectRootsCoverScript(source);
  });

  it('gives a script without headings one section holding all of it', () => {
    const source = 'Just a few spoken words here.\n';
    expect(countsByTitle(source)).toEqual([['Script', 6]]);
  });

  it('counts nothing in a script with nothing spoken', () => {
    expect(countsByTitle('')).toEqual([['Script', 0]]);
    expect(countsByTitle('# Only a heading\n')).toEqual([['Only a heading', 0]]);
  });

  it('returns an empty map for an empty outline', () => {
    expect(sectionWordCounts([], 10).size).toBe(0);
  });
});
