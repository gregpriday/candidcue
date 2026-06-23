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
  it('sums characters and reports an ok budget under the soft threshold', () => {
    const stats = computeSourceLibraryStats([
      draft({ key: 'p', kind: 'primary', content: 'abc' }),
      draft({ key: 'a', content: 'de' }),
    ]);
    expect(stats.totalCharacters).toBe(5);
    expect(stats.documentCount).toBe(2);
    expect(stats.budget).toBe('ok');
    expect(stats.remainingCharacters).toBe(L.maxTotalCharacters - 5);
    expect(canSaveSources(stats)).toBe(true);
  });

  it('flags the budget as approaching at the soft warning threshold', () => {
    // Three docs of 80k = 240k total, each under the 100k per-doc cap.
    const chunk = L.softWarningTotalCharacters / 3;
    expect(Number.isInteger(chunk) && chunk <= L.maxCharactersPerDocument).toBe(true);
    const stats = computeSourceLibraryStats([
      draft({ key: 'p', kind: 'primary', content: 'x'.repeat(chunk) }),
      draft({ key: 'a', content: 'y'.repeat(chunk) }),
      draft({ key: 'b', content: 'z'.repeat(chunk) }),
    ]);
    expect(stats.totalCharacters).toBe(L.softWarningTotalCharacters);
    expect(stats.budget).toBe('approaching');
    // soft warning is still saveable — only the hard cap blocks.
    expect(canSaveSources(stats)).toBe(true);
  });

  it('blocks a save when the aggregate exceeds the hard cap', () => {
    // Four 80k docs = 320k aggregate; each stays under the per-doc cap, so the
    // only blocker is the aggregate one (not a per-document overflow).
    const stats = computeSourceLibraryStats([
      draft({ key: 'p', kind: 'primary', content: 'x'.repeat(80_000) }),
      draft({ key: 'a', content: 'y'.repeat(80_000) }),
      draft({ key: 'b', content: 'z'.repeat(80_000) }),
      draft({ key: 'c', content: 'w'.repeat(80_000) }),
    ]);
    expect(stats.totalCharacters).toBe(320_000);
    expect(stats.budget).toBe('over');
    expect(stats.remainingCharacters).toBe(0);
    expect(stats.blockers.map((b) => b.code)).toEqual(['total_over_limit']);
    expect(canSaveSources(stats)).toBe(false);
  });

  it('blocks a save when a single document exceeds the per-document cap', () => {
    const stats = computeSourceLibraryStats([
      draft({ key: 'p', kind: 'primary', content: 'x'.repeat(L.maxCharactersPerDocument + 1) }),
    ]);
    expect(stats.perDocument[0]?.overCharacterLimit).toBe(true);
    expect(stats.blockers.map((b) => b.code)).toContain('document_over_limit');
    expect(canSaveSources(stats)).toBe(false);
  });

  it('reports the document limit and primary emptiness', () => {
    const atLimit = Array.from({ length: L.maxDocuments }, (_, i) =>
      draft({ key: `k${i}`, kind: i === 0 ? 'primary' : 'reference', content: i === 0 ? '' : 'x' }),
    );
    const stats = computeSourceLibraryStats(atLimit);
    expect(stats.atDocumentLimit).toBe(true);
    expect(stats.primaryEmpty).toBe(true);
    // primaryEmpty blocks prepare, not save.
    expect(canSaveSources(stats)).toBe(true);
  });

  it('blocks a save when more than the max documents are present', () => {
    const tooMany = Array.from({ length: L.maxDocuments + 1 }, (_, i) =>
      draft({ key: `k${i}`, kind: i === 0 ? 'primary' : 'reference', content: 'x' }),
    );
    const stats = computeSourceLibraryStats(tooMany);
    expect(stats.blockers.map((b) => b.code)).toContain('too_many_documents');
    expect(canSaveSources(stats)).toBe(false);
  });
});
