import type { ProjectId, PlanId, CoverageItemId, TurnId } from './ids';

export type QuestionType =
  | 'opening'
  | 'context'
  | 'clarification'
  | 'example'
  | 'evidence'
  | 'stakes'
  | 'mechanism'
  | 'implication'
  | 'transition'
  | 'synthesis'
  | 'closing';

export type CoveragePriority = 'must' | 'should' | 'optional';
export type CoverageStatus = 'not_started' | 'partial' | 'covered' | 'skipped';

export interface SourceRef {
  documentId: string;
  startLine: number;
  endLine: number;
}

export interface FactualAnchor {
  id: string;
  statement: string;
  confidenceFromSource: 'explicit' | 'inferred';
  importance: 'must_not_misstate' | 'important' | 'supporting';
  sourceRefs: SourceRef[];
}

export interface GlossaryTerm {
  id: string;
  canonical: string;
  aliases: string[];
  pronunciationHint: string | null;
  category: 'person' | 'company' | 'product' | 'place' | 'acronym' | 'technical' | 'other';
  sourceRefs: SourceRef[];
}

export interface CoverageItem {
  id: CoverageItemId;
  label: string;
  objective: string;
  priority: CoveragePriority;
  status: CoverageStatus;
  evidenceTurnIds: TurnId[];
  maxFollowUps: number;
  sourceRefs: SourceRef[];
  /**
   * Prep-authored candidate questions for this objective — the live interviewer's
   * backbone to ADAPT (not recite). Optional so plans prepared before this field
   * existed still load (they were persisted by a `JSON.parse … as InterviewBrief`
   * cast, not re-validated); a prompt-version bump re-prepares them with values.
   */
  suggestedQuestions?: string[];
}

export interface InterviewSection {
  id: string;
  label: string;
  objective: string;
  order: number;
  entryCondition: string;
  exitCriteria: string[];
  coverageItemIds: string[];
  suggestedQuestionTypes: QuestionType[];
}

export interface PlannedQuestion {
  text: string;
  type: QuestionType;
  targetCoverageItemIds: string[];
  useWhen: string;
}

export interface InterviewBrief {
  title: string;
  oneSentencePremise: string;
  audience: string;
  intendedOutcome: string;
  recommendedTone: string;
  factualAnchors: FactualAnchor[];
  terminology: GlossaryTerm[];
  coverageItems: CoverageItem[];
  arc: InterviewSection[];
  exclusions: string[];
  openingQuestion: PlannedQuestion;
  fallbackQuestions: PlannedQuestion[];
  closingStrategy: string;
}

export type PlanStatus = 'generating' | 'ready' | 'failed' | 'superseded';

export interface InterviewPlan {
  id: PlanId;
  projectId: ProjectId;
  version: number;
  sourceHash: string;
  status: PlanStatus;
  brief: InterviewBrief;
  promptVersion: string;
  createdAt: string;
}

export interface PreparationWarning {
  type:
    | 'contradictory_source'
    | 'missing_audience'
    | 'missing_goal'
    | 'uncertain_fact'
    | 'source_too_vague'
    | 'sensitive_topic';
  message: string;
  sourceRefs: SourceRef[];
}

/** The raw structured output returned by the project-preparation model. */
export interface PreparedInterviewOutput {
  brief: InterviewBrief;
  warnings: PreparationWarning[];
}
