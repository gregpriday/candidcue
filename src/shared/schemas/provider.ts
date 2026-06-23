import { z } from 'zod';

export const questionTypeSchema = z.enum([
  'opening', 'context', 'clarification', 'example', 'evidence', 'stakes',
  'mechanism', 'implication', 'transition', 'synthesis', 'closing',
]);

export const coverageStatusSchema = z.enum(['not_started', 'partial', 'covered', 'skipped']);
export const coveragePrioritySchema = z.enum(['must', 'should', 'optional']);

export const sourceRefSchema = z.object({
  documentId: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
});

export const factualAnchorSchema = z.object({
  id: z.string(),
  statement: z.string(),
  confidenceFromSource: z.enum(['explicit', 'inferred']),
  importance: z.enum(['must_not_misstate', 'important', 'supporting']),
  sourceRefs: z.array(sourceRefSchema),
});

export const glossaryTermSchema = z.object({
  id: z.string(),
  canonical: z.string(),
  aliases: z.array(z.string()),
  pronunciationHint: z.string().nullable(),
  category: z.enum(['person', 'company', 'product', 'place', 'acronym', 'technical', 'other']),
  sourceRefs: z.array(sourceRefSchema),
});

export const coverageItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  objective: z.string(),
  priority: coveragePrioritySchema,
  status: coverageStatusSchema,
  evidenceTurnIds: z.array(z.string()),
  maxFollowUps: z.number().int().nonnegative(),
  sourceRefs: z.array(sourceRefSchema),
});

export const interviewSectionSchema = z.object({
  id: z.string(),
  label: z.string(),
  objective: z.string(),
  order: z.number().int(),
  entryCondition: z.string(),
  exitCriteria: z.array(z.string()),
  coverageItemIds: z.array(z.string()),
  suggestedQuestionTypes: z.array(questionTypeSchema),
});

export const plannedQuestionSchema = z.object({
  text: z.string().min(1),
  type: questionTypeSchema,
  targetCoverageItemIds: z.array(z.string()),
  useWhen: z.string(),
});

export const interviewBriefSchema = z.object({
  title: z.string(),
  oneSentencePremise: z.string(),
  audience: z.string(),
  intendedOutcome: z.string(),
  recommendedTone: z.string(),
  factualAnchors: z.array(factualAnchorSchema),
  terminology: z.array(glossaryTermSchema),
  coverageItems: z.array(coverageItemSchema).min(1),
  arc: z.array(interviewSectionSchema),
  exclusions: z.array(z.string()),
  openingQuestion: plannedQuestionSchema,
  fallbackQuestions: z.array(plannedQuestionSchema),
  closingStrategy: z.string(),
});

export const preparationWarningSchema = z.object({
  type: z.enum([
    'contradictory_source', 'missing_audience', 'missing_goal',
    'uncertain_fact', 'source_too_vague', 'sensitive_topic',
  ]),
  message: z.string(),
  sourceRefs: z.array(sourceRefSchema),
});

export const preparedInterviewOutputSchema = z.object({
  brief: interviewBriefSchema,
  warnings: z.array(preparationWarningSchema),
});

export const nextInterviewerActionSchema = z.object({
  action: z.enum(['ask', 'complete']),
  spokenText: z.string(),
  questionType: questionTypeSchema,
  targetCoverageItemIds: z.array(z.string()),
  coverageUpdates: z.array(
    z.object({
      coverageItemId: z.string(),
      status: coverageStatusSchema,
      evidenceTurnIds: z.array(z.string()),
    }),
  ),
  followUpCounts: z.array(z.object({ coverageItemId: z.string(), count: z.number().int().nonnegative() })),
  updatedSessionSummary: z.string(),
  currentSectionId: z.string().nullable(),
  shouldCloseAfterAnswer: z.boolean(),
  qualityFlags: z.array(
    z.enum([
      'none', 'answer_was_incomplete', 'answer_contradicted_source',
      'answer_repeated_prior_content', 'needs_specific_example', 'needs_clarification',
    ]),
  ),
});

export const transcriptCleanupResultSchema = z.object({
  cleanedText: z.string(),
  paragraphs: z.array(z.string()),
  glossaryCorrections: z.array(
    z.object({ from: z.string(), to: z.string(), glossaryTermId: z.string() }),
  ),
  uncertainTerms: z.array(
    z.object({ raw: z.string(), proposed: z.string().nullable(), reason: z.string() }),
  ),
  materialChanges: z.array(
    z.object({
      before: z.string(),
      after: z.string(),
      type: z.enum(['deduplication', 'punctuation', 'filler', 'terminology', 'other']),
    }),
  ),
});

export const endpointDecisionSchema = z.object({
  shouldCommit: z.boolean(),
  completeProbability: z.number().min(0).max(1),
  incompleteReason: z.enum([
    'none', 'trailing_conjunction', 'unfinished_list', 'setup_without_conclusion',
    'self_correction', 'too_short', 'other',
  ]),
});

export const questionRepairResultSchema = z.object({
  spokenText: z.string().min(1),
});
