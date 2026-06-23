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
export type DocumentKind = 'primary' | 'reference';
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
  kind: DocumentKind;
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
  kind: DocumentKind;
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
