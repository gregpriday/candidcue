import { describe, expect, it } from 'vitest';
import { saveProjectInputSchema } from '@shared/schemas/ipc';
import { PROJECT_SOURCE_LIMITS } from '@shared/constants/project-source-limits';

/**
 * Cross-document invariants on the authoritative save schema (spec §10.2,
 * §12.2): Markdown-only writes, exactly one primary, unique ids, dense sort
 * order, and title trimming. Content size and reference count are uncapped —
 * the operator supplies their own material.
 */

function sourceDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'primary',
    title: 'Doc',
    mimeType: 'text/markdown',
    content: 'body',
    sortOrder: 0,
    ...overrides,
  };
}

function projectInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Project',
    targetMode: 'question_count',
    targetValue: 12,
    interviewerCharacterId: 'mira',
    documents: [sourceDoc()],
    ...overrides,
  };
}

/** `count` documents: index 0 is the primary, the rest references, densely ordered. */
function denseDocuments(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) =>
    sourceDoc({ kind: i === 0 ? 'primary' : 'reference', sortOrder: i, title: `Doc ${i}` }),
  );
}

/** Documents sized to the given content lengths; index 0 is the primary. */
function documentsOfSizes(sizes: number[]): Record<string, unknown>[] {
  return sizes.map((n, i) =>
    sourceDoc({ kind: i === 0 ? 'primary' : 'reference', sortOrder: i, title: `Doc ${i}`, content: 'x'.repeat(n) }),
  );
}

describe('saveProjectInputSchema', () => {
  it('accepts a well-formed single-primary project', () => {
    expect(saveProjectInputSchema.safeParse(projectInput()).success).toBe(true);
  });

  it('rejects zero primaries', () => {
    const result = saveProjectInputSchema.safeParse(
      projectInput({ documents: [sourceDoc({ kind: 'reference' })] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects multiple primaries', () => {
    const result = saveProjectInputSchema.safeParse(
      projectInput({
        documents: [sourceDoc(), sourceDoc({ sortOrder: 1, title: 'Two' })],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('does not cap the document count', () => {
    expect(
      saveProjectInputSchema.safeParse(
        projectInput({ documents: denseDocuments(PROJECT_SOURCE_LIMITS.maxDocuments + 25) }),
      ).success,
    ).toBe(true);
  });

  it('does not cap per-document content size', () => {
    const result = saveProjectInputSchema.safeParse(
      projectInput({
        documents: [sourceDoc({ content: 'x'.repeat(PROJECT_SOURCE_LIMITS.maxCharactersPerDocument * 3) })],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('does not cap aggregate content size', () => {
    const perDoc = PROJECT_SOURCE_LIMITS.maxCharactersPerDocument;
    // Three oversize documents put the aggregate well past the former total cap.
    expect(
      saveProjectInputSchema.safeParse(
        projectInput({ documents: documentsOfSizes([perDoc * 2, perDoc * 2, perDoc * 2]) }),
      ).success,
    ).toBe(true);
  });

  it('accepts a title at the length limit but rejects one character longer', () => {
    const max = PROJECT_SOURCE_LIMITS.maxTitleCharacters;
    expect(
      saveProjectInputSchema.safeParse(projectInput({ documents: [sourceDoc({ title: 'x'.repeat(max) })] })).success,
    ).toBe(true);
    expect(
      saveProjectInputSchema.safeParse(projectInput({ documents: [sourceDoc({ title: 'x'.repeat(max + 1) })] })).success,
    ).toBe(false);
  });

  it('rejects a blank title and trims surrounding whitespace on a valid one', () => {
    expect(
      saveProjectInputSchema.safeParse(projectInput({ documents: [sourceDoc({ title: '   ' })] })).success,
    ).toBe(false);

    const parsed = saveProjectInputSchema.safeParse(
      projectInput({ documents: [sourceDoc({ title: '  Trimmed  ' })] }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.documents[0]?.title).toBe('Trimmed');
  });

  it('rejects duplicate document ids', () => {
    const result = saveProjectInputSchema.safeParse(
      projectInput({
        documents: [
          sourceDoc({ id: 'dup' }),
          sourceDoc({ id: 'dup', kind: 'reference', sortOrder: 1 }),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a non-dense sort order', () => {
    const result = saveProjectInputSchema.safeParse(
      projectInput({
        documents: [sourceDoc({ sortOrder: 0 }), sourceDoc({ kind: 'reference', sortOrder: 2 })],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a duplicate sort order', () => {
    const result = saveProjectInputSchema.safeParse(
      projectInput({
        documents: [sourceDoc({ sortOrder: 0 }), sourceDoc({ kind: 'reference', sortOrder: 0 })],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts references in any order as long as the set is dense and the primary is first', () => {
    const result = saveProjectInputSchema.safeParse(
      projectInput({
        documents: [
          sourceDoc({ kind: 'primary', sortOrder: 0 }),
          sourceDoc({ kind: 'reference', sortOrder: 2, title: 'Third' }),
          sourceDoc({ kind: 'reference', sortOrder: 1, title: 'Second' }),
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a primary that is not first (sort order 0)', () => {
    const result = saveProjectInputSchema.safeParse(
      projectInput({
        documents: [
          sourceDoc({ kind: 'reference', sortOrder: 0, title: 'Ref' }),
          sourceDoc({ kind: 'primary', sortOrder: 1, title: 'Main' }),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a negative sort order', () => {
    expect(
      saveProjectInputSchema.safeParse(projectInput({ documents: [sourceDoc({ sortOrder: -1 })] })).success,
    ).toBe(false);
  });

  it('rejects a non-Markdown mime type (Markdown-only writes)', () => {
    expect(
      saveProjectInputSchema.safeParse(projectInput({ documents: [sourceDoc({ mimeType: 'text/plain' })] }))
        .success,
    ).toBe(false);
  });
});
