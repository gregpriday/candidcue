import { describe, it, expect } from 'vitest';

import type {
  PrepareProjectInput,
  GenerateNextActionInput,
  CleanTranscriptInput,
  ClassifyEndpointInput,
  RepairQuestionInput,
} from '@shared/contracts/adapters';
import type { InterviewBrief } from '@shared/domain';
import { isAppError } from '@shared/errors/app-error';

import {
  createOpenAiAdapters,
  type StructuredRequest,
  type StructuredResponder,
  type Moderator,
} from '../../src/main/providers/openai/index';

// ---------------------------------------------------------------------------
// Canned, schema-valid model outputs
// ---------------------------------------------------------------------------

const SOURCE_REF = { documentId: 'doc-1', startLine: 1, endLine: 2 };

const PREPARED_OUTPUT = {
  brief: {
    title: 'A Project',
    oneSentencePremise: 'It does a thing.',
    audience: 'Builders',
    intendedOutcome: 'Understand the thing.',
    recommendedTone: 'curious',
    factualAnchors: [
      {
        id: 'fa-1',
        statement: 'The thing exists.',
        confidenceFromSource: 'explicit',
        importance: 'important',
        sourceRefs: [SOURCE_REF],
      },
    ],
    terminology: [
      {
        id: 'g-1',
        canonical: 'Widget',
        aliases: ['widgit'],
        pronunciationHint: null,
        category: 'product',
        sourceRefs: [SOURCE_REF],
      },
    ],
    coverageItems: [
      {
        id: 'cov-1',
        label: 'Origin',
        objective: 'Why it was built.',
        priority: 'must',
        status: 'not_started',
        evidenceTurnIds: [],
        maxFollowUps: 2,
        sourceRefs: [SOURCE_REF],
      },
    ],
    arc: [
      {
        id: 'sec-1',
        label: 'Intro',
        objective: 'Open the conversation.',
        order: 0,
        entryCondition: 'always',
        exitCriteria: ['opening asked'],
        coverageItemIds: ['cov-1'],
        suggestedQuestionTypes: ['opening'],
      },
    ],
    exclusions: [],
    openingQuestion: {
      text: 'What got you started?',
      type: 'opening',
      targetCoverageItemIds: ['cov-1'],
      useWhen: 'at the start',
    },
    fallbackQuestions: [],
    closingStrategy: 'Thank them and wrap.',
  } satisfies InterviewBrief,
  warnings: [],
};

const NEXT_ACTION = {
  action: 'ask',
  spokenText: 'What happened next?',
  questionType: 'context',
  targetCoverageItemIds: ['cov-1'],
  coverageUpdates: [
    { coverageItemId: 'cov-1', status: 'partial', evidenceTurnIds: ['turn-1'] },
  ],
  followUpCounts: [{ coverageItemId: 'cov-1', count: 1 }],
  updatedSessionSummary: 'They described the origin.',
  currentSectionId: 'sec-1',
  shouldCloseAfterAnswer: false,
  qualityFlags: ['none'],
  deliveryHint: { speakingRate: 1.05 },
};

const CLEANUP_RESULT = {
  cleanedText: 'We built the widget in 2024.',
  paragraphs: ['We built the widget in 2024.'],
  glossaryCorrections: [{ from: 'widgit', to: 'widget', glossaryTermId: 'g-1' }],
  uncertainTerms: [{ raw: 'foo', proposed: null, reason: 'unclear' }],
  materialChanges: [{ before: 'widgit', after: 'widget', type: 'terminology' }],
};

const ENDPOINT_DECISION = {
  shouldCommit: true,
  completeProbability: 0.91,
  incompleteReason: 'none',
};

const REPAIR_RESULT = { spokenText: 'What got you started?' };

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

interface ResponderSpy {
  responder: StructuredResponder;
  calls: StructuredRequest[];
}

/** A fake responder that records every request and returns a fixed JSON body. */
function spyResponder(body: string): ResponderSpy {
  const calls: StructuredRequest[] = [];
  const responder: StructuredResponder = async (req) => {
    calls.push(req);
    return body;
  };
  return { responder, calls };
}

/** A responder that always returns the given string regardless of request. */
function fixedResponder(body: string): StructuredResponder {
  return async () => body;
}

const PASS_MODERATOR: Moderator = async () => ({
  flagged: false,
  categories: { violence: false },
  category_scores: { violence: 0.01 },
});

const FLAG_MODERATOR: Moderator = async () => ({
  flagged: true,
  categories: { hate: true, violence: false },
  category_scores: { hate: 0.97, violence: 0.02 },
});

const MODELS = { moderationModel: 'omni-moderation-latest' };

function adapters(responder: StructuredResponder, moderator: Moderator = PASS_MODERATOR) {
  return createOpenAiAdapters({ responder, moderator, models: MODELS });
}

// ---------------------------------------------------------------------------
// Canonical adapter inputs
// ---------------------------------------------------------------------------

const PREPARE_INPUT: PrepareProjectInput = {
  compiledSource: '<CANDIDCUE_PROJECT_SOURCE version="1"></CANDIDCUE_PROJECT_SOURCE>',
  targetQuestionCount: 12,
  title: 'Product Launch Interview',
  audience: 'prospective investors',
  intendedOutcome: 'showcase early traction',
  tone: 'curious',
  exclusions: ['salary'],
  modelId: 'gpt-5.5',
};

const NEXT_ACTION_INPUT: GenerateNextActionInput = {
  characterSystemPrompt: 'You are Mira.',
  brief: PREPARED_OUTPUT.brief as InterviewBrief,
  coverage: [
    {
      coverageItemId: 'cov-1',
      label: 'Origin',
      objective: 'Why it was built.',
      priority: 'must',
      status: 'not_started',
      followUpCount: 0,
      maxFollowUps: 2,
    },
  ],
  rollingSummary: 'Nothing yet.',
  recentTurns: [
    { turnId: 'turn-1', question: 'Hi?', answer: 'Hello.', targetCoverageIds: ['cov-1'] },
  ],
  currentAnswer: 'We started in a garage.',
  rawAnswerFallback: 'we started in a garage',
  moderationGuidance: '',
  nextOrdinal: 2,
  targetQuestionCount: 12,
  endAfterTurn: false,
  currentSectionId: 'sec-1',
  modelId: 'gpt-5.5',
};

const CLEAN_INPUT: CleanTranscriptInput = {
  rawTranscript: 'we built the widgit in twenty twenty four',
  glossary: [
    {
      id: 'g-1',
      canonical: 'widget',
      aliases: ['widgit'],
      pronunciationHint: null,
      category: 'product',
      sourceRefs: [SOURCE_REF],
    },
  ],
  modelId: 'gpt-5.4-mini',
};

const CLASSIFY_INPUT: ClassifyEndpointInput = {
  question: 'What happened next?',
  transcript: 'We built the widget.',
  speechDurationMs: 4200,
  silenceDurationMs: 1700,
  mode: 'balanced',
  modelId: 'gpt-5.4-nano',
};

const REPAIR_INPUT: RepairQuestionInput = {
  spokenText: 'So, um, what I really wanted to ask you was, what got you started?',
  maxWords: 42,
  reason: 'too_many_words',
  modelId: 'gpt-5.4-mini',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createOpenAiAdapters — interview model', () => {
  it('prepareProject returns a validated PreparedInterviewOutput', async () => {
    const { model } = adapters(fixedResponder(JSON.stringify(PREPARED_OUTPUT)));
    const result = await model.prepareProject(PREPARE_INPUT);

    expect(result.brief.title).toBe('A Project');
    expect(result.brief.coverageItems).toHaveLength(1);
    expect(result.brief.coverageItems[0]?.id).toBe('cov-1');
    expect(result.warnings).toEqual([]);
  });

  it('prepareProject builds the prompt from config and source', async () => {
    const spy = spyResponder(JSON.stringify(PREPARED_OUTPUT));
    const { model } = adapters(spy.responder);
    await model.prepareProject(PREPARE_INPUT);

    expect(spy.calls).toHaveLength(1);
    const req = spy.calls[0]!;
    expect(req.model).toBe('gpt-5.5');
    expect(req.schemaName).toBe('prepared_interview_output');
    expect(req.system).toContain('12'); // targetQuestionCount
    expect(req.system).toContain('Product Launch Interview'); // title
    expect(req.system).toContain('prospective investors'); // audience
    expect(req.system).toContain('showcase early traction'); // intended outcome
    expect(req.system).toContain('curious'); // tone
    expect(req.system).toContain('salary'); // exclusions
    expect(req.system).toContain('CANDIDCUE_PROJECT_SOURCE'); // compiled source
    // No {{...}} placeholders should remain unfilled.
    expect(req.system).not.toMatch(
      /\{\{(titleOrInferred|audienceOrInferred|intendedOutcomeOrInferred|targetQuestionCount|toneOrDefault|exclusionsOrNone|compiledSource)\}\}/,
    );
  });

  it('generateNextAction returns a validated NextInterviewerAction', async () => {
    const { model } = adapters(fixedResponder(JSON.stringify(NEXT_ACTION)));
    const result = await model.generateNextAction(NEXT_ACTION_INPUT);

    expect(result.action).toBe('ask');
    expect(result.spokenText).toBe('What happened next?');
    expect(result.questionType).toBe('context');
    expect(result.coverageUpdates[0]?.status).toBe('partial');
    expect(result.qualityFlags).toEqual(['none']);
    expect(result.deliveryHint?.speakingRate).toBe(1.05);
  });

  it('generateNextAction tolerates a missing delivery hint (optional field)', async () => {
    const { deliveryHint: _omit, ...withoutHint } = NEXT_ACTION;
    const { model } = adapters(fixedResponder(JSON.stringify(withoutHint)));
    const result = await model.generateNextAction(NEXT_ACTION_INPUT);

    expect(result.deliveryHint).toBeUndefined();
  });

  it('generateNextAction uses the character prompt as system and a JSON user payload', async () => {
    const spy = spyResponder(JSON.stringify(NEXT_ACTION));
    const { model } = adapters(spy.responder);
    await model.generateNextAction(NEXT_ACTION_INPUT);

    const req = spy.calls[0]!;
    expect(req.system).toBe('You are Mira.');
    expect(req.schemaName).toBe('next_interviewer_action');

    const payload = JSON.parse(req.user) as Record<string, unknown>;
    expect(payload.currentAnswer).toBe('We started in a garage.');
    expect(payload.brief).toBeTruthy();
    expect(payload.coverage).toBeTruthy();
    expect(payload.recentTurns).toBeTruthy();
    const sessionControl = payload.sessionControl as Record<string, unknown>;
    expect(sessionControl.nextOrdinal).toBe(2);
    expect(sessionControl.targetQuestionCount).toBe(12);
    expect(sessionControl.endAfterTurn).toBe(false);
    expect(sessionControl.currentSectionId).toBe('sec-1');
  });

  it('cleanTranscript returns a validated TranscriptCleanupResult', async () => {
    const { model } = adapters(fixedResponder(JSON.stringify(CLEANUP_RESULT)));
    const result = await model.cleanTranscript(CLEAN_INPUT);

    expect(result.cleanedText).toContain('widget');
    expect(result.paragraphs).toHaveLength(1);
    expect(result.glossaryCorrections[0]?.glossaryTermId).toBe('g-1');
    expect(result.uncertainTerms[0]?.proposed).toBeNull();
    expect(result.materialChanges[0]?.type).toBe('terminology');
  });

  it('cleanTranscript embeds the serialized glossary and raw transcript', async () => {
    const spy = spyResponder(JSON.stringify(CLEANUP_RESULT));
    const { model } = adapters(spy.responder);
    await model.cleanTranscript(CLEAN_INPUT);

    const req = spy.calls[0]!;
    expect(req.system).toContain('"canonical":"widget"');
    expect(req.system).toContain('we built the widgit in twenty twenty four');
    expect(req.schemaName).toBe('transcript_cleanup_result');
  });

  it('classifyEndpoint returns a validated EndpointDecision', async () => {
    const { model } = adapters(fixedResponder(JSON.stringify(ENDPOINT_DECISION)));
    const result = await model.classifyEndpoint(CLASSIFY_INPUT);

    expect(result.shouldCommit).toBe(true);
    expect(result.completeProbability).toBeCloseTo(0.91);
    expect(result.incompleteReason).toBe('none');
  });

  it('classifyEndpoint interpolates durations and mode into the prompt', async () => {
    const spy = spyResponder(JSON.stringify(ENDPOINT_DECISION));
    const { model } = adapters(spy.responder);
    await model.classifyEndpoint(CLASSIFY_INPUT);

    const req = spy.calls[0]!;
    expect(req.system).toContain('4200'); // speechDurationMs
    expect(req.system).toContain('1700'); // silenceDurationMs
    expect(req.system).toContain('balanced'); // mode
    expect(req.system).toContain('What happened next?'); // question
  });

  it('repairQuestion returns only the validated spokenText', async () => {
    const { model } = adapters(fixedResponder(JSON.stringify(REPAIR_RESULT)));
    const result = await model.repairQuestion(REPAIR_INPUT);

    expect(result).toEqual({ spokenText: 'What got you started?' });
  });

  it('repairQuestion interpolates the question, limit, and reason', async () => {
    const spy = spyResponder(JSON.stringify(REPAIR_RESULT));
    const { model } = adapters(spy.responder);
    await model.repairQuestion(REPAIR_INPUT);

    const req = spy.calls[0]!;
    expect(req.system).toContain('42'); // maxWords
    expect(req.system).toContain('too_many_words'); // reason
    expect(req.schemaName).toBe('question_repair_result');
  });
});

describe('createOpenAiAdapters — schema failures map to AppError OPENAI_SCHEMA', () => {
  it('malformed (non-JSON) output → AppError OPENAI_SCHEMA', async () => {
    const { model } = adapters(fixedResponder('not json at all {'));
    await expect(model.prepareProject(PREPARE_INPUT)).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'OPENAI_SCHEMA',
    );
  });

  it('well-formed JSON that violates the schema → AppError OPENAI_SCHEMA', async () => {
    // `action` is an invalid enum value; everything else omitted.
    const { model } = adapters(fixedResponder(JSON.stringify({ action: 'noop' })));
    await expect(model.generateNextAction(NEXT_ACTION_INPUT)).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'OPENAI_SCHEMA',
    );
  });

  it('delivery-hint speaking rate out of range → AppError OPENAI_SCHEMA', async () => {
    // 2.0 is outside the safe [0.85, 1.15] band the Zod schema enforces.
    const bad = { ...NEXT_ACTION, deliveryHint: { speakingRate: 2.0 } };
    const { model } = adapters(fixedResponder(JSON.stringify(bad)));
    await expect(model.generateNextAction(NEXT_ACTION_INPUT)).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'OPENAI_SCHEMA',
    );
  });

  it('endpoint probability out of range → AppError OPENAI_SCHEMA', async () => {
    const bad = { shouldCommit: true, completeProbability: 1.5, incompleteReason: 'none' };
    const { model } = adapters(fixedResponder(JSON.stringify(bad)));
    await expect(model.classifyEndpoint(CLASSIFY_INPUT)).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'OPENAI_SCHEMA',
    );
  });

  it('empty repaired spokenText (min(1)) → AppError OPENAI_SCHEMA', async () => {
    const { model } = adapters(fixedResponder(JSON.stringify({ spokenText: '' })));
    await expect(model.repairQuestion(REPAIR_INPUT)).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'OPENAI_SCHEMA',
    );
  });
});

describe('createOpenAiAdapters — moderation', () => {
  it('maps clean content to decision "allow"', async () => {
    const { moderation } = adapters(fixedResponder('{}'), PASS_MODERATOR);
    const record = await moderation.moderate('a polite question');

    expect(record.flagged).toBe(false);
    expect(record.decision).toBe('allow');
    expect(record.modelId).toBe('omni-moderation-latest');
    expect(record.categories.violence).toBe(false);
    expect(record.categoryScores.violence).toBeCloseTo(0.01);
  });

  it('maps flagged content to decision "redirect"', async () => {
    const { moderation } = adapters(fixedResponder('{}'), FLAG_MODERATOR);
    const record = await moderation.moderate('something harmful');

    expect(record.flagged).toBe(true);
    expect(record.decision).toBe('redirect');
    expect(record.categories.hate).toBe(true);
    expect(record.categoryScores.hate).toBeCloseTo(0.97);
  });
});

describe('createOpenAiAdapters — AbortSignal forwarding', () => {
  it('forwards the signal to the responder', async () => {
    const spy = spyResponder(JSON.stringify(PREPARED_OUTPUT));
    const { model } = adapters(spy.responder);
    const controller = new AbortController();

    await model.prepareProject(PREPARE_INPUT, controller.signal);

    expect(spy.calls[0]?.signal).toBe(controller.signal);
  });

  it('omits the signal when none is supplied', async () => {
    const spy = spyResponder(JSON.stringify(ENDPOINT_DECISION));
    const { model } = adapters(spy.responder);

    await model.classifyEndpoint(CLASSIFY_INPUT);

    expect(spy.calls[0]?.signal).toBeUndefined();
  });

  it('forwards the signal to the moderator', async () => {
    let received: AbortSignal | undefined;
    const moderator: Moderator = async (_text, signal) => {
      received = signal;
      return { flagged: false, categories: {}, category_scores: {} };
    };
    const { moderation } = adapters(fixedResponder('{}'), moderator);
    const controller = new AbortController();

    await moderation.moderate('text', controller.signal);

    expect(received).toBe(controller.signal);
  });
});
