import { describe, expect, it } from 'vitest';
import {
  canSaveSources,
  computeSourceLibraryStats,
} from '@shared/project-source-stats';
import type { SourceDraft } from '@shared/project-source-draft';
import { PROJECT_SOURCE_LIMITS } from '@shared/constants/project-source-limits';

const L = PROJECT_SOURCE_LIMITS;

function draft(partial: Partial<SourceDraft> & { key: string }): SourceDraft {
  return {
    kind: 'reference',
    title: partial.key,
    originalFilename: null,
    mimeType: 'text/markdown',
    content: '',
    ...partial,
  };
}

describe('computeSourceLibraryStats', () => {
  it('sums characters and document count and is saveable by default', () => {
    const stats = computeSourceLibraryStats([
      draft({ key: 'p', kind: 'primary', content: 'abc' }),
      draft({ key: 'a', content: 'de' }),
    ]);
    expect(stats.totalCharacters).toBe(5);
    expect(stats.documentCount).toBe(2);
    expect(stats.primaryEmpty).toBe(false);
    expect(stats.blockers).toHaveLength(0);
    expect(canSaveSources(stats)).toBe(true);
  });

  it('reports primary emptiness (blocks prepare, not save)', () => {
    const stats = computeSourceLibraryStats([
      draft({ key: 'p', kind: 'primary', content: '   ' }),
      draft({ key: 'a', content: 'x' }),
    ]);
    expect(stats.primaryEmpty).toBe(true);
    // An empty primary still saves; it only blocks preparing the interview.
    expect(canSaveSources(stats)).toBe(true);
  });

  it('does not cap content size — a very large aggregate stays saveable', () => {
    const big = 'x'.repeat(L.maxCharactersPerDocument * 2);
    const stats = computeSourceLibraryStats([
      draft({ key: 'p', kind: 'primary', content: big }),
      draft({ key: 'a', content: big }),
      draft({ key: 'b', content: big }),
    ]);
    expect(stats.totalCharacters).toBe(big.length * 3);
    expect(stats.blockers).toHaveLength(0);
    expect(canSaveSources(stats)).toBe(true);
  });

  it('does not cap the reference count', () => {
    const many = Array.from({ length: L.maxDocuments + 25 }, (_, i) =>
      draft({ key: `k${i}`, kind: i === 0 ? 'primary' : 'reference', content: 'x' }),
    );
    const stats = computeSourceLibraryStats(many);
    expect(stats.documentCount).toBe(L.maxDocuments + 25);
    expect(stats.blockers).toHaveLength(0);
    expect(canSaveSources(stats)).toBe(true);
  });

  it('blocks a save when a title exceeds the title-length limit', () => {
    const stats = computeSourceLibraryStats([
      draft({ key: 'p', kind: 'primary', content: 'x', title: 'x'.repeat(L.maxTitleCharacters + 1) }),
    ]);
    expect(stats.perDocument[0]?.titleTooLong).toBe(true);
    expect(stats.blockers.map((b) => b.code)).toEqual(['title_too_long']);
    expect(canSaveSources(stats)).toBe(false);
  });
});
