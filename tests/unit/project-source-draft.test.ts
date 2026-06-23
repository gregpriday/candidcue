import { describe, expect, it } from 'vitest';
import {
  addBlankSource,
  addImportedSources,
  createSourceDrafts,
  duplicateSource,
  makeSourcePrimary,
  moveSource,
  moveSourceToIndex,
  normalizeSourceDrafts,
  removeSource,
  renameSource,
  sourceDraftsFromAggregate,
  sourceDraftsToSaveInput,
  updateSourceContent,
  type SourceDraft,
} from '@shared/project-source-draft';
import { PROJECT_SOURCE_LIMITS } from '@shared/constants/project-source-limits';
import type {
  ImportedMarkdownDocument,
  ProjectAggregate,
  ProjectDocument,
} from '@shared/domain';

/** Deterministic key factory so transitions are reproducible in assertions. */
function keyer(): () => string {
  let n = 0;
  return () => `k${(n += 1)}`;
}

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

/**
 * The cross-document save invariants that {@link sourceDraftsToSaveInput} must
 * uphold by construction (mirrors `validateProjectSourceInvariants`): exactly one
 * primary, primary at sortOrder 0, dense 0..n-1 order, unique sort orders.
 */
function expectSaveInvariants(drafts: SourceDraft[]): void {
  const docs = sourceDraftsToSaveInput(drafts);
  const primaries = docs.filter((d) => d.kind === 'primary');
  expect(primaries).toHaveLength(1);
  expect(docs[0]?.kind).toBe('primary');
  expect(docs[0]?.sortOrder).toBe(0);
  expect(docs.map((d) => d.sortOrder)).toEqual(docs.map((_, i) => i));
}

describe('createSourceDrafts', () => {
  it('starts with a single empty primary', () => {
    const drafts = createSourceDrafts(keyer());
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.kind).toBe('primary');
    expect(drafts[0]?.content).toBe('');
    expectSaveInvariants(drafts);
  });
});

describe('sourceDraftsFromAggregate', () => {
  it('sorts by sortOrder and normalizes to a single leading primary', () => {
    const aggregate = {
      documents: [
        { id: 'b', kind: 'reference', title: 'B', sortOrder: 2, content: 'b', mimeType: 'text/markdown', originalFilename: null },
        { id: 'p', kind: 'primary', title: 'P', sortOrder: 0, content: 'p', mimeType: 'text/markdown', originalFilename: null },
        { id: 'a', kind: 'reference', title: 'A', sortOrder: 1, content: 'a', mimeType: 'text/markdown', originalFilename: null },
      ] as ProjectDocument[],
    } as ProjectAggregate;
    const drafts = sourceDraftsFromAggregate(aggregate, keyer());
    expect(drafts.map((d) => d.id)).toEqual(['p', 'a', 'b']);
    expect(drafts[0]?.kind).toBe('primary');
    expectSaveInvariants(drafts);
  });

  it('synthesizes a primary when documents have none', () => {
    const aggregate = {
      documents: [
        { id: 'a', kind: 'reference', title: 'A', sortOrder: 0, content: 'a', mimeType: 'text/markdown', originalFilename: null },
      ] as ProjectDocument[],
    } as ProjectAggregate;
    const drafts = sourceDraftsFromAggregate(aggregate, keyer());
    expect(drafts[0]?.kind).toBe('primary');
    expectSaveInvariants(drafts);
  });
});

describe('makeSourcePrimary', () => {
  it('promotes a reference to index 0 and demotes the old primary', () => {
    const drafts = [
      draft({ key: 'a', kind: 'primary', title: 'A' }),
      draft({ key: 'b', title: 'B' }),
      draft({ key: 'c', title: 'C' }),
    ];
    const next = makeSourcePrimary(drafts, 'c');
    expect(next.map((d) => d.key)).toEqual(['c', 'a', 'b']);
    expect(next[0]?.kind).toBe('primary');
    expect(next.filter((d) => d.kind === 'primary')).toHaveLength(1);
    expectSaveInvariants(next);
  });

  it('is a no-op for the existing primary', () => {
    const drafts = [draft({ key: 'a', kind: 'primary' }), draft({ key: 'b' })];
    expect(makeSourcePrimary(drafts, 'a')).toBe(drafts);
  });
});

describe('moveSource / moveSourceToIndex', () => {
  const base = [
    draft({ key: 'p', kind: 'primary' }),
    draft({ key: 'a' }),
    draft({ key: 'b' }),
    draft({ key: 'c' }),
  ];

  it('moves a reference down one slot', () => {
    expect(moveSource(base, 'a', 1).map((d) => d.key)).toEqual(['p', 'b', 'a', 'c']);
  });

  it('never displaces the primary', () => {
    expect(moveSource(base, 'a', -1).map((d) => d.key)).toEqual(['p', 'a', 'b', 'c']);
    expect(moveSourceToIndex(base, 'b', 0).map((d) => d.key)).toEqual(['p', 'b', 'a', 'c']);
    expect(moveSource(base, 'p', 1)).toBe(base);
  });

  it('clamps an out-of-range target into the reference range', () => {
    expect(moveSourceToIndex(base, 'a', 99).map((d) => d.key)).toEqual(['p', 'b', 'c', 'a']);
  });
});

describe('duplicateSource', () => {
  it('inserts a reference copy right after the original', () => {
    const drafts = [draft({ key: 'p', kind: 'primary', title: 'P', content: 'x' }), draft({ key: 'a', title: 'A' })];
    const { drafts: next, addedKey } = duplicateSource(drafts, 'p', keyer());
    expect(next.map((d) => d.title)).toEqual(['P', 'P (copy)', 'A']);
    expect(next[1]?.kind).toBe('reference');
    expect(next[1]?.content).toBe('x');
    expect(addedKey).toBe('k1');
    expectSaveInvariants(next);
  });
});

describe('removeSource', () => {
  it('promotes the next source when the primary is removed', () => {
    const drafts = [draft({ key: 'p', kind: 'primary' }), draft({ key: 'a' })];
    const { drafts: next, selectedKey } = removeSource(drafts, 'p', keyer());
    expect(next).toHaveLength(1);
    expect(next[0]?.key).toBe('a');
    expect(next[0]?.kind).toBe('primary');
    expect(selectedKey).toBe('a');
    expectSaveInvariants(next);
  });

  it('resets to a fresh primary when the last source is removed', () => {
    const drafts = [draft({ key: 'p', kind: 'primary' })];
    const { drafts: next, selectedKey } = removeSource(drafts, 'p', keyer());
    expect(next).toHaveLength(1);
    expect(next[0]?.kind).toBe('primary');
    expect(selectedKey).toBe(next[0]?.key);
  });

  it('selects the prior neighbor after removing a middle reference', () => {
    const drafts = [draft({ key: 'p', kind: 'primary' }), draft({ key: 'a' }), draft({ key: 'b' })];
    const { selectedKey } = removeSource(drafts, 'b', keyer());
    expect(selectedKey).toBe('a');
  });
});

describe('addImportedSources', () => {
  it('appends imported files as references with titles and filenames', () => {
    const drafts = createSourceDrafts(keyer());
    const imported: ImportedMarkdownDocument[] = [
      { title: 'Doc One', originalFilename: 'one.md', mimeType: 'text/markdown', content: '# one', sizeBytes: 5, characterCount: 5 },
    ];
    const { drafts: next, addedKeys } = addImportedSources(drafts, imported, keyer());
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ kind: 'reference', title: 'Doc One', originalFilename: 'one.md', content: '# one' });
    expect(addedKeys).toEqual(['k1']);
    expectSaveInvariants(next);
  });
});

describe('rename / updateContent / addBlank', () => {
  it('renames and clamps to the max title length', () => {
    const drafts = [draft({ key: 'p', kind: 'primary' })];
    const long = 'x'.repeat(PROJECT_SOURCE_LIMITS.maxTitleCharacters + 50);
    const next = renameSource(drafts, 'p', long);
    expect(next[0]?.title).toHaveLength(PROJECT_SOURCE_LIMITS.maxTitleCharacters);
  });

  it('updates content for the matching key only', () => {
    const drafts = [draft({ key: 'p', kind: 'primary' }), draft({ key: 'a' })];
    const next = updateSourceContent(drafts, 'a', 'hello');
    expect(next[0]?.content).toBe('');
    expect(next[1]?.content).toBe('hello');
  });

  it('adds a blank reference and returns its key', () => {
    const drafts = createSourceDrafts(keyer());
    const { drafts: next, addedKey } = addBlankSource(drafts, keyer());
    expect(next).toHaveLength(2);
    expect(next[1]?.kind).toBe('reference');
    expect(addedKey).toBe('k1');
  });
});

describe('normalizeSourceDrafts', () => {
  it('collapses multiple primaries to one, keeping the first', () => {
    const drafts = [
      draft({ key: 'a', kind: 'primary', title: 'A' }),
      draft({ key: 'b', kind: 'primary', title: 'B' }),
    ];
    const next = normalizeSourceDrafts(drafts, keyer());
    expect(next.filter((d) => d.kind === 'primary')).toHaveLength(1);
    expect(next[0]?.key).toBe('a');
    expectSaveInvariants(next);
  });

  it('returns a fresh primary for an empty list', () => {
    const next = normalizeSourceDrafts([], keyer());
    expect(next).toHaveLength(1);
    expect(next[0]?.kind).toBe('primary');
  });
});
