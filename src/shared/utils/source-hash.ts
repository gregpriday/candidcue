import { createHash } from 'node:crypto';
import type { ProjectDocument } from '../domain/project';

/** Preparation-relevant project settings that influence the generated plan. */
export interface PreparationSettings {
  audience: string | null;
  intendedOutcome: string | null;
  targetMode: string;
  targetValue: number;
  interviewerCharacterId: string;
  notesToInterviewer: string | null;
}

/** A document as it contributes to the compiled preparation source. */
export interface PreparationDocument {
  id: string;
  title: string;
  mimeType: string;
  content: string;
  sortOrder: number;
}

/**
 * Hash the FULL preparation input — setup fields plus source documents — so that
 * editing audience/outcome/target/interviewer/notes (not just document content)
 * marks an existing plan stale (PROJ-03). Documents are hashed in the SAME order
 * the compiler emits them (sortOrder, then id), so reordering a document is
 * detected too.
 */
export function hashProjectPreparation(
  settings: PreparationSettings,
  documents: readonly PreparationDocument[],
): string {
  const hash = createHash('sha256');
  hash.update('audience:');
  hash.update(settings.audience ?? '');
  hash.update('\noutcome:');
  hash.update(settings.intendedOutcome ?? '');
  hash.update('\ntargetMode:');
  hash.update(settings.targetMode);
  hash.update('\ntargetValue:');
  hash.update(String(settings.targetValue));
  hash.update('\ncharacter:');
  hash.update(settings.interviewerCharacterId);
  hash.update('\nnotes:');
  hash.update(settings.notesToInterviewer ?? '');
  hash.update('\ndocs:');
  const ordered = [...documents].sort((a, b) =>
    a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const doc of ordered) {
    hash.update('\n');
    hash.update(doc.id);
    hash.update(' ');
    hash.update(doc.title);
    hash.update(' ');
    hash.update(doc.mimeType);
    hash.update(' ');
    hash.update(doc.content);
  }
  return hash.digest('hex');
}

/** Convenience over {@link ProjectDocument}[] for a project's settings. */
export function hashProjectPreparationFromDocuments(
  settings: PreparationSettings,
  documents: readonly ProjectDocument[],
): string {
  return hashProjectPreparation(
    settings,
    documents.map((d) => ({
      id: d.id,
      title: d.title,
      mimeType: d.mimeType,
      content: d.content,
      sortOrder: d.sortOrder,
    })),
  );
}
