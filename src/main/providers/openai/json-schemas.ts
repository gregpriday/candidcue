/**
 * Hand-authored JSON Schemas mirroring the Zod schemas in
 * `@shared/schemas/provider`. These are passed to the OpenAI Responses API as
 * structured-output `text.format` definitions on the live path only; unit tests
 * inject a fake responder that ignores them. The Zod schema remains the source
 * of truth for validation — these merely steer generation.
 *
 * Kept permissive but structurally accurate (correct property names, enums, and
 * array/object nesting) so generated output round-trips through Zod.
 */

type JsonSchema = Record<string, unknown>;

const string: JsonSchema = { type: 'string' };
const boolean: JsonSchema = { type: 'boolean' };
const integer: JsonSchema = { type: 'integer' };
const number: JsonSchema = { type: 'number' };
const stringArray: JsonSchema = { type: 'array', items: { type: 'string' } };

/** Build an `object` schema with all listed properties required (strict mode). */
function object(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const sourceRef = object({
  documentId: string,
  startLine: integer,
  endLine: integer,
});
const sourceRefs: JsonSchema = { type: 'array', items: sourceRef };

const questionType: JsonSchema = {
  type: 'string',
  enum: [
    'opening', 'context', 'clarification', 'example', 'evidence', 'stakes',
    'mechanism', 'implication', 'transition', 'synthesis', 'closing',
  ],
};
const coverageStatus: JsonSchema = {
  type: 'string',
  enum: ['not_started', 'partial', 'covered', 'skipped'],
};
const coveragePriority: JsonSchema = { type: 'string', enum: ['must', 'should', 'optional'] };

const factualAnchor = object({
  id: string,
  statement: string,
  confidenceFromSource: { type: 'string', enum: ['explicit', 'inferred'] },
  importance: { type: 'string', enum: ['must_not_misstate', 'important', 'supporting'] },
  sourceRefs,
});

const glossaryTerm = object({
  id: string,
  canonical: string,
  aliases: stringArray,
  pronunciationHint: { type: ['string', 'null'] },
  category: {
    type: 'string',
    enum: ['person', 'company', 'product', 'place', 'acronym', 'technical', 'other'],
  },
  sourceRefs,
});

const coverageItem = object({
  id: string,
  label: string,
  objective: string,
  priority: coveragePriority,
  status: coverageStatus,
  evidenceTurnIds: stringArray,
  maxFollowUps: integer,
  sourceRefs,
  // Candidate questions the live interviewer adapts for this objective (its
  // backbone). object() marks every key required, so the model must author them.
  suggestedQuestions: stringArray,
});

const interviewSection = object({
  id: string,
  label: string,
  objective: string,
  order: integer,
  entryCondition: string,
  exitCriteria: stringArray,
  coverageItemIds: stringArray,
  suggestedQuestionTypes: { type: 'array', items: questionType },
});

const plannedQuestion = object({
  text: string,
  type: questionType,
  targetCoverageItemIds: stringArray,
  useWhen: string,
});

const interviewBrief = object({
  title: string,
  oneSentencePremise: string,
  audience: string,
  intendedOutcome: string,
  recommendedTone: string,
  factualAnchors: { type: 'array', items: factualAnchor },
  terminology: { type: 'array', items: glossaryTerm },
  coverageItems: { type: 'array', items: coverageItem },
  arc: { type: 'array', items: interviewSection },
  exclusions: stringArray,
  openingQuestion: plannedQuestion,
  fallbackQuestions: { type: 'array', items: plannedQuestion },
  closingStrategy: string,
});

const preparationWarning = object({
  type: {
    type: 'string',
    enum: [
      'contradictory_source', 'missing_audience', 'missing_goal',
      'uncertain_fact', 'source_too_vague', 'sensitive_topic',
    ],
  },
  message: string,
  sourceRefs,
});

export const preparedInterviewOutputJsonSchema: JsonSchema = object({
  brief: interviewBrief,
  warnings: { type: 'array', items: preparationWarning },
});

export const nextInterviewerActionJsonSchema: JsonSchema = object({
  action: { type: 'string', enum: ['ask', 'complete'] },
  spokenText: string,
  questionType,
  targetCoverageItemIds: stringArray,
  coverageUpdates: {
    type: 'array',
    items: object({
      coverageItemId: string,
      status: coverageStatus,
      evidenceTurnIds: stringArray,
    }),
  },
  followUpCounts: {
    type: 'array',
    items: object({ coverageItemId: string, count: integer }),
  },
  updatedSessionSummary: string,
  currentSectionId: { type: ['string', 'null'] },
  shouldCloseAfterAnswer: boolean,
  qualityFlags: {
    type: 'array',
    items: {
      type: 'string',
      enum: [
        'none', 'answer_was_incomplete', 'answer_contradicted_source',
        'answer_repeated_prior_content', 'needs_specific_example', 'needs_clarification',
      ],
    },
  },
  deliveryHint: object({
    speakingRate: { type: 'number', minimum: 0.85, maximum: 1.15 },
  }),
  stageCue: object({
    headline: string,
    prompt: { type: ['string', 'null'] },
  }),
});

export const transcriptCleanupResultJsonSchema: JsonSchema = object({
  cleanedText: string,
  paragraphs: stringArray,
  glossaryCorrections: {
    type: 'array',
    items: object({ from: string, to: string, glossaryTermId: string }),
  },
  uncertainTerms: {
    type: 'array',
    items: object({ raw: string, proposed: { type: ['string', 'null'] }, reason: string }),
  },
  materialChanges: {
    type: 'array',
    items: object({
      before: string,
      after: string,
      type: {
        type: 'string',
        enum: ['deduplication', 'punctuation', 'filler', 'terminology', 'other'],
      },
    }),
  },
});

export const endpointDecisionJsonSchema: JsonSchema = object({
  shouldCommit: boolean,
  completeProbability: number,
  incompleteReason: {
    type: 'string',
    enum: [
      'none', 'trailing_conjunction', 'unfinished_list', 'setup_without_conclusion',
      'self_correction', 'too_short', 'other',
    ],
  },
});

export const questionRepairResultJsonSchema: JsonSchema = object({
  spokenText: string,
});
