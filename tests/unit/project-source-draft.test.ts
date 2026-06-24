import { describe, expect, it } from 'vitest';
import {
  addBlankSource,
  addImportedSources,
  createSourceDrafts,
  duplicateSource,
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
    title: partial.key,
    originalFilename: null,
    mimeType: 'text/markdown',
    content: '',
    ...partial,
  };
}

/**
 * The cross-document save invariant {@link sourceDraftsToSaveInput} must uphold by
 * construction (mirrors `validateProjectSourceInvariants`): a dense 0..n-1 sort
 * order taken from the array index. Sources are equal peers — no primary.
 */
function expectSaveInvariants(drafts: SourceDraft[]): void {
  const docs = sourceDraftsToSaveInput(drafts);
  expect(docs.map((d) => d.sortOrder)).toEqual(docs.map((_, i) => i));
}

describe('createSourceDrafts', () => {
  it('starts with a single empty seed source titled "Source material"', () => {
    const drafts = createSourceDrafts(keyer());
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.title).toBe('Source material');
    expect(drafts[0]?.content).toBe('');
    expectSaveInvariants(drafts);
  });
});

describe('sourceDraftsFromAggregate', () => {
  it('sorts by sortOrder', () => {
    const aggregate = {
      documents: [
        { id: 'b', title: 'B', sortOrder: 2, content: 'b', mimeType: 'text/markdown', originalFilename: null },
        { id: 'p', title: 'P', sortOrder: 0, content: 'p', mimeType: 'text/markdown', originalFilename: null },
        { id: 'a', title: 'A', sortOrder: 1, content: 'a', mimeType: 'text/markdown', originalFilename: null },
      ] as ProjectDocument[],
    } as ProjectAggregate;
    const drafts = sourceDraftsFromAggregate(aggregate, keyer());
    expect(drafts.map((d) => d.id)).toEqual(['p', 'a', 'b']);
    expectSaveInvariants(drafts);
  });

  it('returns a seed source when the aggregate has no documents', () => {
    const aggregate = { documents: [] as ProjectDocument[] } as ProjectAggregate;
    const drafts = sourceDraftsFromAggregate(aggregate, keyer());
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.title).toBe('Source material');
    expectSaveInvariants(drafts);
  });
});

describe('moveSource / moveSourceToIndex', () => {
  const base = [draft({ key: 'p' }), draft({ key: 'a' }), draft({ key: 'b' }), draft({ key: 'c' })];

  it('moves a source down one slot', () => {
    expect(moveSource(base, 'a', 1).map((d) => d.key)).toEqual(['p', 'b', 'a', 'c']);
  });

  it('moves the first source like any other', () => {
    expect(moveSource(base, 'p', 1).map((d) => d.key)).toEqual(['a', 'p', 'b', 'c']);
    expect(moveSourceToIndex(base, 'p', 2).map((d) => d.key)).toEqual(['a', 'b', 'p', 'c']);
  });

  it('moves a later source to the very top', () => {
    expect(moveSourceToIndex(base, 'b', 0).map((d) => d.key)).toEqual(['b', 'p', 'a', 'c']);
  });

  it('clamps an out-of-range target into range', () => {
    expect(moveSourceToIndex(base, 'a', 99).map((d) => d.key)).toEqual(['p', 'b', 'c', 'a']);
  });

  it('is a no-op for an unknown key', () => {
    expect(moveSource(base, 'zzz', 1)).toBe(base);
  });
});

describe('duplicateSource', () => {
  it('inserts a copy right after the original', () => {
    const drafts = [draft({ key: 'p', title: 'P', content: 'x' }), draft({ key: 'a', title: 'A' })];
    const { drafts: next, addedKey } = duplicateSource(drafts, 'p', keyer());
    expect(next.map((d) => d.title)).toEqual(['P', 'P (copy)', 'A']);
    expect(next[1]?.content).toBe('x');
    expect(addedKey).toBe('k1');
    expectSaveInvariants(next);
  });
});

describe('removeSource', () => {
  it('removes a source and selects the prior neighbor', () => {
    const drafts = [draft({ key: 'p' }), draft({ key: 'a' })];
    const { drafts: next, selectedKey } = removeSource(drafts, 'p', keyer());
    expect(next).toHaveLength(1);
    expect(next[0]?.key).toBe('a');
    expect(selectedKey).toBe('a');
    expectSaveInvariants(next);
  });

  it('resets to a fresh seed source when the last source is removed', () => {
    const drafts = [draft({ key: 'p' })];
    const { drafts: next, selectedKey } = removeSource(drafts, 'p', keyer());
    expect(next).toHaveLength(1);
    expect(next[0]?.title).toBe('Source material');
    expect(selectedKey).toBe(next[0]?.key);
  });

  it('selects the prior neighbor after removing a middle source', () => {
    const drafts = [draft({ key: 'p' }), draft({ key: 'a' }), draft({ key: 'b' })];
    const { selectedKey } = removeSource(drafts, 'b', keyer());
    expect(selectedKey).toBe('a');
  });
});

describe('addImportedSources', () => {
  it('appends imported files as sources with titles and filenames', () => {
    const drafts = createSourceDrafts(keyer());
    const imported: ImportedMarkdownDocument[] = [
      { title: 'Doc One', originalFilename: 'one.md', mimeType: 'text/markdown', content: '# one', sizeBytes: 5, characterCount: 5 },
    ];
    const { drafts: next, addedKeys } = addImportedSources(drafts, imported, keyer());
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ title: 'Doc One', originalFilename: 'one.md', content: '# one' });
    expect(addedKeys).toEqual(['k1']);
    expectSaveInvariants(next);
  });
});

describe('rename / updateContent / addBlank', () => {
  it('renames and clamps to the max title length', () => {
    const drafts = [draft({ key: 'p' })];
    const long = 'x'.repeat(PROJECT_SOURCE_LIMITS.maxTitleCharacters + 50);
    const next = renameSource(drafts, 'p', long);
    expect(next[0]?.title).toHaveLength(PROJECT_SOURCE_LIMITS.maxTitleCharacters);
  });

  it('updates content for the matching key only', () => {
    const drafts = [draft({ key: 'p' }), draft({ key: 'a' })];
    const next = updateSourceContent(drafts, 'a', 'hello');
    expect(next[0]?.content).toBe('');
    expect(next[1]?.content).toBe('hello');
  });

  it('adds a blank source and returns its key', () => {
    const drafts = createSourceDrafts(keyer());
    const { drafts: next, addedKey } = addBlankSource(drafts, keyer());
    expect(next).toHaveLength(2);
    expect(next[1]?.title).toBe('Untitled source');
    expect(addedKey).toBe('k1');
  });
});

describe('normalizeSourceDrafts', () => {
  it('leaves a non-empty list unchanged', () => {
    const drafts = [draft({ key: 'a' }), draft({ key: 'b' })];
    expect(normalizeSourceDrafts(drafts, keyer())).toBe(drafts);
  });

  it('returns a seed source for an empty list', () => {
    const next = normalizeSourceDrafts([], keyer());
    expect(next).toHaveLength(1);
    expect(next[0]?.title).toBe('Source material');
  });
});
