import type { ProjectId, DocumentId } from './ids';
import type { InterviewPlan } from './plan';

export type ProjectStatus = 'draft' | 'prepared' | 'stale' | 'archived';
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
  interviewerCharacterId: string;
  sessionCount: number;
  lastSessionAt: string | null;
  updatedAt: string;
}
