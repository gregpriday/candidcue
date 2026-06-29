import type {
  InterviewModelAdapter,
  PrepareProjectInput,
  GenerateNextActionInput,
  CleanTranscriptInput,
  ClassifyEndpointInput,
  RepairQuestionInput,
} from '@shared/contracts/adapters';
import type {
  PreparedInterviewOutput,
  NextInterviewerAction,
  TranscriptCleanupResult,
  EndpointDecision,
  InterviewBrief,
  CoverageItem,
  PlannedQuestion,
} from '@shared/domain';
import { splitParagraphs, normalizeWhitespace, wordCount } from '@shared/utils';

import { throwIfAborted, delay, neverResolve } from './abort';

/**
 * Knobs that let a test steer {@link FakeInterviewModel} without subclassing.
 * Every field is optional; sensible deterministic defaults apply otherwise.
 */
export interface FakeInterviewModelConfig {
  /**
   * A queue of scripted actions returned by `generateNextAction`, in order.
   * When exhausted, the model falls back to its cycling default questions.
   * Each entry may be a full action or a partial overriding the default.
   */
  scriptedActions?: Array<Partial<NextInterviewerAction>>;
  /** Default cycling question texts (each rendered with a trailing '?'). */
  questionTexts?: string[];
  /** Endpoint decision returned by `classifyEndpoint`. */
  endpoint?: Partial<EndpointDecision>;
  /**
   * When > 0, the *next* `generateNextAction` call hangs (never resolves on its
   * own) and only rejects when its AbortSignal fires — used to simulate a
   * provider timeout. Decremented after each hanging call.
   */
  failNext?: number;
  /** Artificial latency (ms) applied to each async call. Default 0. */
  delayMs?: number;
}

/**
 * Deterministic stand-in for the OpenAI-backed interview model adapter. It
 * produces small, schema-valid outputs derived from its inputs so orchestrator
 * and integration tests can run without network access while still exercising
 * the real data shapes.
 */
export class FakeInterviewModel implements InterviewModelAdapter {
  private readonly scripted: Array<Partial<NextInterviewerAction>>;
  private readonly questionTexts: string[];
  private readonly endpoint: EndpointDecision;
  private readonly delayMs: number;

  /** How many upcoming `generateNextAction` calls should hang on the signal. */
  private failNextRemaining: number;
  /** Round-robin cursor into {@link questionTexts}. */
  private cycleIndex = 0;
  /** Number of `generateNextAction` invocations so far (for assertions). */
  public callCount = 0;

  constructor(config: FakeInterviewModelConfig = {}) {
    this.scripted = [...(config.scriptedActions ?? [])];
    this.questionTexts = config.questionTexts ?? [
      'What first drew you to this work',
      'Can you walk me through a concrete example',
      'What surprised you most along the way',
    ];
    this.endpoint = {
      shouldCommit: config.endpoint?.shouldCommit ?? true,
      completeProbability: config.endpoint?.completeProbability ?? 0.95,
      incompleteReason: config.endpoint?.incompleteReason ?? 'none',
    };
    this.failNextRemaining = config.failNext ?? 0;
    this.delayMs = config.delayMs ?? 0;
  }

  // -------------------------------------------------------------------------
  // prepareProject
  // -------------------------------------------------------------------------

  async prepareProject(
    input: PrepareProjectInput,
    signal?: AbortSignal,
  ): Promise<PreparedInterviewOutput> {
    throwIfAborted(signal);
    if (this.delayMs > 0) await delay(this.delayMs, signal);
    throwIfAborted(signal);

    const title = input.title?.trim() || deriveTitle(input.compiledSource);
    const coverage = buildCoverage();
    const brief: InterviewBrief = {
      title,
      oneSentencePremise: `A conversation exploring ${title.toLowerCase()}.`,
      audience: input.audience?.trim() || 'general interested listeners',
      intendedOutcome: input.intendedOutcome?.trim() || 'a clear, candid account of the topic',
      recommendedTone: input.tone ?? 'curious and warm',
      factualAnchors: [],
      terminology: [],
      coverageItems: coverage,
      arc: [
        {
          id: 'section-1',
          label: 'Main arc',
          objective: 'Cover the core of the topic',
          order: 0,
          entryCondition: 'session start',
          // CoverageItem ids are typed but stored as plain strings.
          exitCriteria: ['all must-cover items addressed'],
          coverageItemIds: coverage.map((c) => c.id as string),
          suggestedQuestionTypes: ['opening', 'context', 'example'],
        },
      ],
      exclusions: [...input.exclusions],
      openingQuestion: ask('To start, what should people understand about this'),
      fallbackQuestions: [
        ask('What is something most people get wrong about this'),
        ask('Where would you like to take the conversation next'),
      ],
      closingStrategy: 'Invite a final reflection, then thank the guest.',
    };

    return { brief, warnings: [] };
  }

  // -------------------------------------------------------------------------
  // generateNextAction
  // -------------------------------------------------------------------------

  async generateNextAction(
    input: GenerateNextActionInput,
    signal?: AbortSignal,
  ): Promise<NextInterviewerAction> {
    this.callCount += 1;
    throwIfAborted(signal);

    // Simulate a hung provider: never resolve, only reject on abort. This lets
    // tests drive the deadline/timeout path via an AbortController.
    if (this.failNextRemaining > 0) {
      this.failNextRemaining -= 1;
      return neverResolve(signal);
    }

    if (this.delayMs > 0) await delay(this.delayMs, signal);
    throwIfAborted(signal);

    // A scripted action takes precedence; otherwise build a cycling 'ask'.
    const scripted = this.scripted.shift();
    const base = this.defaultAction(input);
    return scripted ? { ...base, ...scripted } : base;
  }

  /** Build the default cycling 'ask' action for the current input/turn. */
  private defaultAction(input: GenerateNextActionInput): NextInterviewerAction {
    const text = this.nextQuestionText();
    const target = input.coverage[0]?.coverageItemId ?? null;
    return {
      action: 'ask',
      spokenText: text,
      questionType: input.nextOrdinal <= 1 ? 'opening' : 'context',
      targetCoverageItemIds: target ? [target] : [],
      coverageUpdates: [],
      followUpCounts: [],
      updatedSessionSummary: input.rollingSummary,
      currentSectionId: input.currentSectionId,
      shouldCloseAfterAnswer: input.endAfterTurn,
      qualityFlags: ['none'],
    };
  }

  /** Round-robin through the configured question texts, ensuring a single '?'. */
  private nextQuestionText(): string {
    const total = this.questionTexts.length;
    const raw = total > 0 ? this.questionTexts[this.cycleIndex % total] : 'Tell me more';
    this.cycleIndex += 1;
    return ensureSingleQuestionMark(raw ?? 'Tell me more');
  }

  // -------------------------------------------------------------------------
  // cleanTranscript
  // -------------------------------------------------------------------------

  async cleanTranscript(
    input: CleanTranscriptInput,
    signal?: AbortSignal,
  ): Promise<TranscriptCleanupResult> {
    throwIfAborted(signal);
    if (this.delayMs > 0) await delay(this.delayMs, signal);
    throwIfAborted(signal);

    const paragraphs = splitParagraphs(input.rawTranscript);
    return {
      cleanedText: input.rawTranscript,
      paragraphs,
      glossaryCorrections: [],
      uncertainTerms: [],
      materialChanges: [],
    };
  }

  // -------------------------------------------------------------------------
  // classifyEndpoint
  // -------------------------------------------------------------------------

  async classifyEndpoint(
    _input: ClassifyEndpointInput,
    signal?: AbortSignal,
  ): Promise<EndpointDecision> {
    throwIfAborted(signal);
    if (this.delayMs > 0) await delay(this.delayMs, signal);
    throwIfAborted(signal);
    // Return a fresh copy so callers can't mutate the configured decision.
    return { ...this.endpoint };
  }

  // -------------------------------------------------------------------------
  // repairQuestion
  // -------------------------------------------------------------------------

  async repairQuestion(
    input: RepairQuestionInput,
    signal?: AbortSignal,
  ): Promise<{ spokenText: string }> {
    throwIfAborted(signal);
    if (this.delayMs > 0) await delay(this.delayMs, signal);
    throwIfAborted(signal);

    const trimmed = trimToWords(input.spokenText, input.maxWords);
    return { spokenText: ensureSingleQuestionMark(trimmed) };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Wrap a question stem into a minimal valid PlannedQuestion. */
function ask(stem: string): PlannedQuestion {
  return {
    text: ensureSingleQuestionMark(stem),
    type: 'opening',
    targetCoverageItemIds: [],
    useWhen: 'always',
  };
}

/** Derive a short human-ish title from the compiled source's first line/words. */
function deriveTitle(source: string): string {
  const firstLine = normalizeWhitespace(source.split('\n')[0] ?? '');
  if (firstLine.length === 0) return 'Untitled Topic';
  const words = firstLine.split(' ').slice(0, 6).join(' ');
  return words.length > 0 ? words : 'Untitled Topic';
}

/**
 * Seed the launch-video coverage beats (issue #64). CandidCue is a founder
 * launch-video tool, so the prepared plan always targets these moments by
 * design. Stable ids let tests assert the beats flow through the brief and arc.
 */
function buildCoverage(): CoverageItem[] {
  return [
    beat('coverage-origin-story', 'The origin story', 'Surface why the founder set out to build this and the problem they personally felt.'),
    beat('coverage-founding-insight', 'The founding insight', 'Capture the why-now insight that makes this the right thing to build at this moment.'),
    beat('coverage-wedge', 'Wedge versus competitors', 'Draw out how this differs from existing options and why that difference matters.'),
    beat('coverage-traction', 'Customer or traction story', 'Elicit a concrete, real-world signal that the product delivers for someone.'),
    beat('coverage-demo-aha', 'The demo aha-moment', 'Pinpoint the specific thing the product does that makes people suddenly get it.'),
    beat('coverage-takeaway', 'The viewer takeaway', 'Define what the audience should feel, remember, or do after watching.'),
  ];
}

/** Build one mandatory launch-video coverage beat with a stable id. */
function beat(id: string, label: string, objective: string): CoverageItem {
  return {
    id,
    label,
    objective,
    priority: 'must',
    status: 'not_started',
    evidenceTurnIds: [],
    maxFollowUps: 2,
    sourceRefs: [],
  };
}

/** Trim text to at most `maxWords` words (>=1), preserving order. */
function trimToWords(text: string, maxWords: number): string {
  const normalized = normalizeWhitespace(text);
  const limit = Math.max(1, maxWords);
  if (wordCount(normalized) <= limit) return normalized;
  return normalized.split(' ').slice(0, limit).join(' ');
}

/** Strip extra '?' and guarantee the string ends with exactly one '?'. */
function ensureSingleQuestionMark(text: string): string {
  const stripped = normalizeWhitespace(text).replace(/\?+/g, '').replace(/[.\s]+$/, '');
  return `${stripped}?`;
}
