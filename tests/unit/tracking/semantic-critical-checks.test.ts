/**
 * A6: `criticalChecks` was a hard-coded `[]`, so the highest-urgency signal in
 * the product never existed.
 *
 * `buildSchedulingContext` filled every field of `AssistSchedulingContext`
 * except this one, which meant `hasMinimumUsefulInput`'s critical branch and
 * the `critical_token` burst trigger were unreachable code, and Appendix C.2's
 * `critical_checks` / `critical_evidence` were permanently blank. Number, name,
 * unit and negation mismatches — the one class of error Luna is uniquely good
 * at judging — were the one class it was never asked about.
 *
 * These tests exercise the REAL pieces on both sides of the seam: the real
 * `TranscriptLedger` (so the spoken tokens are the ones the engine actually
 * has, with no per-token `startMs`), the real `alignSequences` (so the matched
 * pairs are genuinely window-relative rather than hand-placed), the real
 * comparator, and the real `classifyAssistTrigger`.
 *
 * Every negative assertion here is paired with a positive control in the same
 * test, so a test cannot pass by the wiring being dead again.
 */
import { describe, expect, it } from 'vitest';
import { AlignmentEngine } from '../../../src/shared/tracking/engine';
import { alignSequences } from '../../../src/shared/tracking/sequence';
import { DocumentIndex } from '../../../src/shared/tracking/document-index';
import { TranscriptLedger } from '../../../src/shared/tracking/ledger';
import { DEFAULT_TRACKING_PROFILE } from '../../../src/shared/tracking/profile';
import { buildSchedulingContext } from '../../../src/shared/tracking/semantic-context';
import { TOKEN_FLAG } from '../../../src/shared/tracking/types';
import { classifyAssistTrigger } from '../../../src/shared/semantic/scheduler';
import type { AlignmentMeasurement } from '../../../src/shared/tracking/alignment-v2';
import type {
  CandidateWindow,
  LedgerToken,
  ScoredCandidate,
  TrackingDocument,
} from '../../../src/shared/tracking/types';
import type { AssistSchedulingContext } from '../../../src/shared/semantic/types';
import { compileFixtureScript } from '../../fixtures/alignment/fixture-script';
import { TranscriptScripter } from '../../fixtures/transcript-events/builder';

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

/**
 * The first and last sentences are identical apart from the number. That is
 * what makes the window-rebasing test meaningful: an alignment that forgets to
 * add `window.startTokenIndex` lands on the *other* copy and quotes the wrong
 * authored number back at the presenter.
 */
const SOURCE = `# Quarterly Report

Revenue grew by 50 percent across the northern region last year.
The latency budget is 200 milliseconds for every request we serve.
The rollout is not complete until every region reports success.
Revenue grew by 90 percent across the northern region last year.`;

const NAME_SOURCE = `# People

Okonkwo approved the northern rollout yesterday morning.`;

function documentFor(source: string, properNouns: readonly string[] = []): TrackingDocument {
  const document = compileFixtureScript(source);
  if (properNouns.length > 0) {
    // The fixture compiler assigns stopword/number flags only, and the
    // comparator treats present flags as authoritative — without this every
    // proper noun would read as "not a name" and no name check could exist.
    for (const token of document.spokenTokens) {
      if (properNouns.includes(token.surface)) token.flags |= TOKEN_FLAG.properNoun;
    }
  }
  return document;
}

function indexFor(document: TrackingDocument): DocumentIndex {
  return new DocumentIndex(document, { rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight });
}

/** Token range of the sentence starting with `opening`, by authored surface. */
function sentenceRange(
  document: TrackingDocument,
  opening: string,
  occurrence = 0,
): { startTokenIndex: number; endTokenIndex: number; id: string } {
  const hits = document.sentences.filter((sentence) => {
    const first = document.spokenTokens[sentence.startTokenIndex];
    return first?.surface === opening;
  });
  const sentence = hits[occurrence];
  if (sentence === undefined) throw new Error(`no sentence ${occurrence} opening "${opening}"`);
  return {
    startTokenIndex: sentence.startTokenIndex,
    endTokenIndex: sentence.endTokenIndex,
    id: sentence.id,
  };
}

interface Turn {
  text: string;
  /** False leaves the item open, so its tokens stay provisional. */
  final?: boolean;
}

interface Tail {
  tokens: LedgerToken[];
  itemTiming: (itemId: string) =>
    | { audioStartMs: number; audioEndMs: number; commitSequence: number | null; tokenCount: number }
    | undefined;
}

/** Drive the real ledger, exactly as the engine does, and take its tail. */
function tailFor(turns: readonly Turn[]): Tail {
  const ledger = new TranscriptLedger();
  const scripter = new TranscriptScripter();
  for (const turn of turns) {
    for (const event of scripter.speak({ text: turn.text })) {
      if (turn.final === false && event.type === 'completed') continue;
      ledger.apply(event);
    }
  }
  const tail = ledger.getAlignableTail({
    maxTokens: DEFAULT_TRACKING_PROFILE.recentTranscriptMaxTokens,
  });
  return {
    tokens: tail.tokens,
    itemTiming: (itemId) => {
      const item = ledger.getItem(itemId);
      if (item === undefined) return undefined;
      return {
        audioStartMs: item.audioStartMs,
        audioEndMs: item.audioEndMs,
        commitSequence: item.commitSequence,
        tokenCount: item.normalizedTokens.length,
      };
    },
  };
}

/**
 * A measurement whose single candidate is the real output of the real sequence
 * aligner over the chosen window — so `matchedPairs.scriptTokenIndex` really is
 * window-relative and the rebasing under test is not simulated.
 */
function measurementFor(
  document: TrackingDocument,
  tail: readonly LedgerToken[],
  window: CandidateWindow,
  declaredWindowStart?: number,
): AlignmentMeasurement {
  const slice = document.spokenTokens.slice(window.startTokenIndex, window.endTokenIndex + 1);
  const sequence = alignSequences(tail, slice, DEFAULT_TRACKING_PROFILE);
  const candidate: ScoredCandidate = {
    // The pairs are always produced against `window`; `declaredWindowStart`
    // only changes what the candidate *claims* the window start was, which is
    // exactly the mistake the rebasing test reproduces.
    window:
      declaredWindowStart === undefined
        ? window
        : { ...window, startTokenIndex: declaredWindowStart },
    sequence,
    absolutePosition: window.startTokenIndex + sequence.scriptEndOffset,
    prior: 0.5,
    confidence: 0.8,
  };
  return {
    revision: 3,
    sessionTimeMs: 20_000,
    bestTokenPosition: candidate.absolutePosition,
    bestPositionUnits: candidate.absolutePosition,
    committedCandidatePosition: candidate.absolutePosition,
    positionVariance: 1,
    confidence: 0.8,
    secondBestMargin: 0.9,
    sectionId: '',
    finalEvidence: true,
    sourceItemIds: [],
    hypotheses: [],
    candidates: [candidate],
    blockedCount: 0,
    transitionProposal: {
      kind: 'none',
      fromUnit: 0,
      toUnit: 0,
      destinationTokenIndex: candidate.absolutePosition,
      renderedLines: 0,
    },
    challengerPersistence: { finalTokens: 0, ms: 0 },
    activeLineageId: null,
  };
}

interface ContextOptions {
  document: TrackingDocument;
  spoken: readonly Turn[];
  window: CandidateWindow;
  /** Claim a different window start than the one the pairs came from. */
  declaredWindowStart?: number;
}

function contextFor(options: ContextOptions): AssistSchedulingContext {
  const index = indexFor(options.document);
  const tail = tailFor(options.spoken);
  const measurement = measurementFor(
    options.document,
    tail.tokens,
    options.window,
    options.declaredWindowStart,
  );
  return buildSchedulingContext({
    index,
    measurement,
    transcriptTail: tail.tokens,
    itemTiming: tail.itemTiming,
    committedTokenIndex: options.window.startTokenIndex,
    largeForwardDistance: DEFAULT_TRACKING_PROFILE.largeForwardDistance,
    softThreshold: DEFAULT_TRACKING_PROFILE.softThreshold,
    lockedThreshold: DEFAULT_TRACKING_PROFILE.lockedThreshold,
    sessionId: 'session-1',
    sessionGeneration: 1,
    scriptCompileHash: 'hash-1',
    semanticEpoch: 2,
    transcriptRevision: 5,
    sessionTimeMs: 20_000,
    trackingState: 'following',
    behavior: 'reading',
    recentFinalTranscript: tail.tokens.map((token) => token.surface).join(' '),
    provisionalTail: '',
    newFinalTokenCount: 6,
    atPhraseBoundary: true,
    commandPending: false,
    sessionPaused: false,
    reanchorActive: false,
    localConfidence: 0.8,
    sustainedAmbiguityMs: 0,
    lexicalFailureMs: 0,
  });
}

/* ---------------------------------------------------------------------------
 * The escalation itself
 * ------------------------------------------------------------------------- */

describe('critical checks reach the semantic scheduler', () => {
  it('escalates a misread number and fires the critical_token trigger', () => {
    const document = documentFor(SOURCE);
    const window: CandidateWindow = { scope: 'continuity', ...sentenceRange(document, 'Revenue') };

    const misread = contextFor({
      document,
      window,
      spoken: [{ text: 'revenue grew by fifteen percent across the northern region last year' }],
    });

    expect(misread.criticalChecks.map((check) => check.kind)).toContain('number');
    const check = misread.criticalChecks.find((entry) => entry.kind === 'number');
    expect(check?.scriptFragment).toBe('50');
    expect(check?.transcriptFragment).toBe('fifteen');
    // The span id must be a *span*, never a token index (see
    // `CoachCandidate.scriptSpanId`): a token id there is cancelled downstream
    // on the first tick.
    expect(check?.spanId).toBe(sentenceRange(document, 'Revenue').id);

    const trigger = classifyAssistTrigger(misread, 'balanced');
    expect(trigger.reason).toBe('critical_token');
    expect(trigger.material).toBe(true);
    expect(trigger.burst).toBe(true);
    expect(trigger.urgency).toBe(5);
  });

  it('escalates a unit substitution as `unit`, not as `number` and not as `uncertain`', () => {
    const document = documentFor(SOURCE);
    const window: CandidateWindow = { scope: 'continuity', ...sentenceRange(document, 'The') };

    // `The` opens three sentences; take the latency one explicitly.
    const latency = document.sentences.find((sentence) =>
      sentence.normalizedText.startsWith('the latency budget'),
    );
    expect(latency).toBeDefined();
    const latencyWindow: CandidateWindow = {
      scope: 'continuity',
      startTokenIndex: latency?.startTokenIndex ?? window.startTokenIndex,
      endTokenIndex: latency?.endTokenIndex ?? window.endTokenIndex,
    };

    const context = contextFor({
      document,
      window: latencyWindow,
      spoken: [{ text: 'the latency budget is 200 seconds for every request we serve' }],
    });

    const kinds = context.criticalChecks.map((entry) => entry.kind);
    expect(kinds).toContain('unit');
    expect(kinds).not.toContain('number');
    // `classifyAssistTrigger` treats a check as material iff its kind is
    // neither `none` nor `uncertain`, so `unit` has to survive the whole path.
    expect(classifyAssistTrigger(context, 'balanced').reason).toBe('critical_token');
  });

  it('escalates a dropped negation', () => {
    const document = documentFor(SOURCE);
    const rollout = document.sentences.find((sentence) =>
      sentence.normalizedText.startsWith('the rollout is not complete'),
    );
    expect(rollout).toBeDefined();
    const window: CandidateWindow = {
      scope: 'continuity',
      startTokenIndex: rollout?.startTokenIndex ?? 0,
      endTokenIndex: rollout?.endTokenIndex ?? 0,
    };

    const dropped = contextFor({
      document,
      window,
      spoken: [{ text: 'the rollout is complete until every region reports success' }],
    });
    expect(dropped.criticalChecks.map((entry) => entry.kind)).toContain('negation');

    // Positive control for the negative direction: the same span read
    // correctly must stay silent.
    const read = contextFor({
      document,
      window,
      spoken: [{ text: 'the rollout is not complete until every region reports success' }],
    });
    expect(read.criticalChecks).toEqual([]);
  });

  it('escalates a substituted name but not a phonetic rendering of it', () => {
    const document = documentFor(NAME_SOURCE, ['Okonkwo']);
    const window: CandidateWindow = { scope: 'continuity', ...sentenceRange(document, 'Okonkwo') };

    const substituted = contextFor({
      document,
      window,
      spoken: [{ text: 'beatrice approved the northern rollout yesterday morning' }],
    });
    expect(substituted.criticalChecks.map((entry) => entry.kind)).toContain('name');

    const phonetic = contextFor({
      document,
      window,
      spoken: [{ text: 'okonjo approved the northern rollout yesterday morning' }],
    });
    expect(phonetic.criticalChecks).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * The false-positive direction
 * ------------------------------------------------------------------------- */

describe('the comparator gates survive the wiring', () => {
  it('stays silent on a correct reading worded differently', () => {
    const document = documentFor(SOURCE);
    const window: CandidateWindow = { scope: 'continuity', ...sentenceRange(document, 'Revenue') };

    // "fifty percent" for the authored "50 percent": every word around the
    // number is identical to the misread case, so the only thing that can
    // decide between them is the comparator's own numeric-variant matching.
    const correct = contextFor({
      document,
      window,
      spoken: [{ text: 'revenue grew by fifty percent across the northern region last year' }],
    });
    expect(correct.criticalChecks).toEqual([]);
    expect(classifyAssistTrigger(correct, 'balanced').reason).not.toBe('critical_token');

    const misread = contextFor({
      document,
      window,
      spoken: [{ text: 'revenue grew by fifteen percent across the northern region last year' }],
    });
    expect(misread.criticalChecks).not.toEqual([]);
  });

  it('stays silent when the presenter corrects themselves', () => {
    const document = documentFor(SOURCE);
    const window: CandidateWindow = { scope: 'continuity', ...sentenceRange(document, 'Revenue') };

    const corrected = contextFor({
      document,
      window,
      spoken: [
        {
          text: 'revenue grew by fifteen percent sorry fifty percent across the northern region last year',
        },
      ],
    });
    expect(corrected.criticalChecks).toEqual([]);

    // Positive control: the identical misreading *without* the correction is
    // escalated, so the silence above is the suppression rule and not the
    // wiring being absent.
    const uncorrected = contextFor({
      document,
      window,
      spoken: [
        { text: 'revenue grew by fifteen percent across the northern region last year' },
      ],
    });
    expect(uncorrected.criticalChecks.map((entry) => entry.kind)).toContain('number');
  });

  it('does not escalate provisional evidence', () => {
    const document = documentFor(SOURCE);
    const window: CandidateWindow = { scope: 'continuity', ...sentenceRange(document, 'Revenue') };

    const turns: Turn[] = [
      { text: 'revenue grew by' },
      { text: 'fifteen percent across the northern region last year', final: false },
    ];
    const provisional = contextFor({ document, window, spoken: turns });
    expect(provisional.criticalChecks).toEqual([]);

    // The only difference is the completion event. If the wiring leaked
    // provisional evidence, both would escalate; if the wiring were dead,
    // neither would.
    const finalized = contextFor({
      document,
      window,
      spoken: turns.map((turn) => ({ text: turn.text })),
    });
    expect(finalized.criticalChecks.map((entry) => entry.kind)).toContain('number');
  });
});

/* ---------------------------------------------------------------------------
 * Window-relative rebasing
 * ------------------------------------------------------------------------- */

describe('matched pairs are rebased onto the script', () => {
  it('anchors to the window that was aligned, not to token zero', () => {
    const document = documentFor(SOURCE);
    const early = sentenceRange(document, 'Revenue', 0);
    const late = sentenceRange(document, 'Revenue', 1);
    expect(late.startTokenIndex).toBeGreaterThan(0);
    expect(early.id).not.toBe(late.id);

    // The presenter is reading the *second* copy ("90 percent") and misreads it.
    const spoken = [
      { text: 'revenue grew by nineteen percent across the northern region last year' },
    ];
    const window: CandidateWindow = { scope: 'continuity', ...late };
    const context = contextFor({ document, window, spoken });

    const check = context.criticalChecks.find((entry) => entry.kind === 'number');
    expect(check?.scriptFragment).toBe('90');
    expect(check?.spanId).toBe(late.id);

    // The bug this guards against: `MatchedPair.scriptTokenIndex` is relative
    // to the candidate window, so a consumer that treats it as absolute points
    // every window at the head of the script. Reproduce that by declaring a
    // window that starts at zero while the pairs came from the late copy.
    const unrebased = contextFor({ document, window, spoken, declaredWindowStart: 0 });
    const wrong = unrebased.criticalChecks.find((entry) => entry.kind === 'number');
    expect(wrong?.scriptFragment).not.toBe('90');
  });
});

/* ---------------------------------------------------------------------------
 * The engine actually threads the tail through
 * ------------------------------------------------------------------------- */

const ENGINE_SOURCE = `# Report

The northern region delivered steady growth throughout the whole year.
Revenue grew by 50 percent across the eastern territory last quarter.
Everyone agreed the numbers looked healthy and the meeting ended early.`;

describe('AlignmentEngine emits critical checks on the live path', () => {
  function checksFromEngine(spoken: readonly string[]): string[][] {
    const engine = new AlignmentEngine(documentFor(ENGINE_SOURCE), {
      sessionId: 'session-1',
      sessionGeneration: 1,
      stageGeneration: 1,
    });
    const scripter = new TranscriptScripter(10_000, 1);
    const emitted: string[][] = [];
    for (const text of spoken) {
      for (const event of scripter.speak({ text })) {
        const context = engine.handleTranscriptEvent(event).semanticContext;
        if (context !== undefined) {
          emitted.push(context.criticalChecks.map((check) => `${check.kind}:${check.scriptFragment ?? ''}`));
        }
      }
    }
    return emitted;
  }

  it('reports a misread number from a real transcript stream', () => {
    const misread = checksFromEngine([
      'the northern region delivered steady growth throughout the whole year',
      'revenue grew by fifteen percent across the eastern territory last quarter',
      'everyone agreed the numbers looked healthy and the meeting ended early',
    ]);
    expect(misread.flat()).toContain('number:50');

    // Same stream, read correctly: the tail, the ledger and the aligner are
    // identical in kind, so only the comparator can be deciding.
    const correct = checksFromEngine([
      'the northern region delivered steady growth throughout the whole year',
      'revenue grew by fifty percent across the eastern territory last quarter',
      'everyone agreed the numbers looked healthy and the meeting ended early',
    ]);
    expect(correct.flat()).toEqual([]);
  });
});
