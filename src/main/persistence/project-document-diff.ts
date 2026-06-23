import type { DocumentId, ProjectId, ProjectDocument, SaveProjectInput } from '@shared/domain';
import { AppError } from '@shared/errors/app-error';

/**
 * Pure document-persistence helpers shared by the SQLite and in-memory
 * repositories so their save/read semantics stay byte-for-byte identical
 * (spec §13.4). Kept free of any storage dependency to remain unit-testable.
 */

/** Deterministic order: the single primary first, then references by (sortOrder, id). */
function compareDocuments(a: ProjectDocument, b: ProjectDocument): number {
  if (a.kind !== b.kind) return a.kind === 'primary' ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Materialize the incoming save input into the final document set, diffing
 * against the project's existing documents:
 *
 * - new writes are Markdown-only: any legacy `text/plain` is coerced to
 *   `text/markdown` so the stored bytes, the preparation hash, and the
 *   read-normalized view always agree;
 * - existing documents keep their `id` and `createdAt`; `updatedAt` advances to
 *   `now` only when a field actually changed (otherwise it is preserved);
 * - new documents get a fresh `id` and both timestamps set to `now`;
 * - any supplied `id` that does not belong to this project is rejected, so a
 *   foreign document cannot be re-parented onto another project.
 *
 * New-document ids are minted here, before the caller hashes the result, so the
 * preparation hash covers the same id set that gets persisted.
 */
export function materializeSavedDocuments(
  input: SaveProjectInput,
  projectId: ProjectId,
  now: string,
  existingById: ReadonlyMap<DocumentId, ProjectDocument>,
  generateId: () => DocumentId,
): ProjectDocument[] {
  // Reject duplicate supplied ids so the two repositories behave identically
  // (SQLite would upsert-collapse them, an in-memory store would keep both).
  const seenIds = new Set<DocumentId>();
  for (const doc of input.documents) {
    if (doc.id == null) continue;
    if (seenIds.has(doc.id)) {
      throw new AppError('VALIDATION_FAILED', {
        publicMessage: 'A source document was supplied more than once.',
        message: `saveProject: duplicate document id ${doc.id} on project ${projectId}`,
      });
    }
    seenIds.add(doc.id);
  }

  return input.documents.map((doc) => {
    const mimeType: ProjectDocument['mimeType'] = 'text/markdown';
    const originalFilename = doc.originalFilename ?? null;

    if (doc.id != null) {
      const existing = existingById.get(doc.id);
      if (!existing) {
        throw new AppError('VALIDATION_FAILED', {
          publicMessage: 'A source document could not be matched to this project.',
          message: `saveProject: document ${doc.id} does not belong to project ${projectId}`,
        });
      }
      const changed =
        existing.kind !== doc.kind ||
        existing.title !== doc.title ||
        (existing.originalFilename ?? null) !== originalFilename ||
        existing.mimeType !== mimeType ||
        existing.content !== doc.content ||
        existing.sortOrder !== doc.sortOrder;
      return {
        id: doc.id,
        projectId,
        kind: doc.kind,
        title: doc.title,
        originalFilename,
        mimeType,
        content: doc.content,
        sortOrder: doc.sortOrder,
        createdAt: existing.createdAt,
        updatedAt: changed ? now : existing.updatedAt,
      };
    }
    return {
      id: generateId(),
      projectId,
      kind: doc.kind,
      title: doc.title,
      originalFilename,
      mimeType,
      content: doc.content,
      sortOrder: doc.sortOrder,
      createdAt: now,
      updatedAt: now,
    };
  });
}

/**
 * Defensive read-time normalization (spec §7.2, §12.4). Idempotent, and for
 * well-formed data (exactly one primary, Markdown mime, primary at sortOrder 0)
 * it preserves every field the preparation hash covers — it may reorder the
 * array primary-first, but never changes a hashed field — so it never perturbs
 * the preparation hash of projects saved through the strict schema. It only
 * repairs genuinely legacy/corrupt rows:
 *
 * - legacy `text/plain` is coerced to `text/markdown` (plain text is a subset);
 * - if there is no primary, the first document (in deterministic order) is
 *   promoted; if there are several, only the first stays primary;
 * - documents are returned primary-first, then by (sortOrder, id).
 */
export function normalizeLoadedDocuments(documents: readonly ProjectDocument[]): ProjectDocument[] {
  const coerced = documents.map((doc) =>
    doc.mimeType === 'text/markdown'
      ? doc
      : { ...doc, mimeType: 'text/markdown' as const },
  );

  const ordered = [...coerced].sort(compareDocuments);

  const primaryCount = ordered.filter((doc) => doc.kind === 'primary').length;
  if (primaryCount === 1) return ordered;

  let primaryAssigned = false;
  const repaired = ordered.map((doc) => {
    if (!primaryAssigned) {
      primaryAssigned = true;
      return doc.kind === 'primary' ? doc : { ...doc, kind: 'primary' as const };
    }
    return doc.kind === 'reference' ? doc : { ...doc, kind: 'reference' as const };
  });
  // Re-sort: a demotion/promotion can change the primary-first ordering.
  return repaired.sort(compareDocuments);
}
