import type { ProjectId, DocumentId } from './ids';
import type { InterviewPlan, PlanStatus } from './plan';

export type ProjectStatus = 'draft' | 'prepared' | 'stale' | 'archived';

/**
 * Renderer-safe readiness of a project's interview plan, derived from the active
 * plan and the current source hash (PROJ-01/02). Distinct from {@link ProjectStatus},
 * which carries the archive lifecycle.
 */
export type ProjectPlanState = 'unprepared' | 'preparing' | 'ready' | 'stale' | 'failed';

/**
 * Derive the plan readiness from a project's source hash + its active plan.
 * `ready` requires a ready plan whose source hash still matches the project's;
 * a hash mismatch means the inputs changed since preparation → `stale`.
 */
export function deriveProjectPlanState(
  project: { sourceHash: string; activePlanVersionId: string | null },
  activePlan: { status: PlanStatus; sourceHash: string } | null,
): ProjectPlanState {
  if (!project.activePlanVersionId || activePlan == null) return 'unprepared';
  switch (activePlan.status) {
    case 'generating':
      return 'preparing';
    case 'failed':
      return 'failed';
    case 'superseded':
      return 'unprepared';
    case 'ready':
      return activePlan.sourceHash === project.sourceHash ? 'ready' : 'stale';
    default:
      return 'unprepared';
  }
}
export type TargetMode = 'question_count' | 'approximate_duration';
export type DocumentMime = 'text/markdown' | 'text/plain';

export interface Project {
  id: ProjectId;
  title: string;
  status: ProjectStatus;
  audience: string | null;
  intendedOutcome: string | null;
  targetMode: TargetMode;
  targetValue: number;
  /** Hard-coded interviewer character id (see character registry). MVP: "mira". */
  interviewerCharacterId: string;
  notesToInterviewer: string | null;
  createdAt: string;
  updatedAt: string;
  sourceHash: string;
  activePlanVersionId: string | null;
}

export interface ProjectDocument {
  id: DocumentId;
  projectId: ProjectId;
  title: string;
  originalFilename: string | null;
  mimeType: DocumentMime;
  content: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** A project plus its documents and the currently active plan (if any). */
export interface ProjectAggregate {
  project: Project;
  documents: ProjectDocument[];
  activePlan: InterviewPlan | null;
  /** Derived plan readiness (PROJ-01/02). */
  planState: ProjectPlanState;
}

export interface SaveProjectDocumentInput {
  id?: DocumentId;
  title: string;
  originalFilename?: string | null;
  mimeType: DocumentMime;
  content: string;
  sortOrder: number;
}

export interface SaveProjectInput {
  id?: ProjectId;
  title: string;
  audience?: string | null;
  intendedOutcome?: string | null;
  targetMode: TargetMode;
  targetValue: number;
  interviewerCharacterId: string;
  notesToInterviewer?: string | null;
  documents: SaveProjectDocumentInput[];
}

export interface ProjectSummary {
  id: ProjectId;
  title: string;
  status: ProjectStatus;
  /** Derived plan readiness (PROJ-01/02). */
  planState: ProjectPlanState;
  interviewerCharacterId: string;
  sessionCount: number;
  lastSessionAt: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Markdown import (multi-file). Results cross main → renderer; absolute paths
// never do — only the basename is ever returned.
// ---------------------------------------------------------------------------

/** A single successfully imported Markdown file, normalized and ready to add. */
export interface ImportedMarkdownDocument {
  /** Default title — the basename without its extension. */
  title: string;
  /** Basename of the imported file (never an absolute path). */
  originalFilename: string;
  mimeType: 'text/markdown';
  /** UTF-8 content, BOM-stripped and normalized to LF line endings. */
  content: string;
  sizeBytes: number;
  characterCount: number;
}

export type MarkdownImportFailureCode =
  | 'unsupported_extension'
  | 'too_large'
  | 'invalid_utf8'
  | 'contains_nul'
  | 'read_failed';

/** A per-file import failure. `filename` is a basename; the message is UI-safe. */
export interface MarkdownImportFailure {
  filename: string;
  code: MarkdownImportFailureCode;
  message: string;
}

/** Partial-success result of a multi-file Markdown import. */
export interface ImportMarkdownDocumentsResult {
  documents: ImportedMarkdownDocument[];
  failures: MarkdownImportFailure[];
}
