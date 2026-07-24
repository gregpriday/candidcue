/**
 * Local → semantic seam (companion §37.1, §40.2, §51 step 6).
 *
 * The Luna sidecar may only ever *rank candidates the local aligner already
 * produced*. This module is where those candidates are minted, and it is the
 * only place in the codebase that turns alignment state into something the
 * sidecar can see. Three properties are load-bearing and must not be relaxed:
 *
 * 1. **Post-gate only.** The input is `AlignmentMeasurement.candidates`, which
 *    `HypothesisBeam.advance` fills from the `eligible` list — i.e. after the
 *    hard section-eligibility gate has already assigned zero probability to
 *    prohibited transitions (§13). A candidate the section graph blocked is
 *    therefore never even shown to Luna, let alone rankable by it.
 * 2. **Ids are the local engine's.** `id` is exactly `candidateIdFor(scope,
 *    tokenPosition)`, the same string the beam stamps on its hypotheses, so a
 *    returned opinion can only ever attach to a hypothesis the engine already
 *    holds (§40.2). An id Luna invents matches nothing and contributes nothing.
 * 3. **Support is required, not assumed.** A candidate with no lexical,
 *    phonetic or ordered-context support carries an empty `supportKinds`, and
 *    `selectCandidates` drops it before the request is built — semantics cannot
 *    rescue a position the local engine had no evidence for at all (§40.1).
 *
 * The module also assembles `AssistSchedulingContext.criticalChecks` from the
 * local critical-term comparator (`coaching/fidelity`). That is the one input
 * the scheduler treats as urgent enough to burst on, so `buildCriticalChecks`
 * carries its own set of rules — see the docblock there.
 */
import { candidateIdFor, type AlignmentMeasurement } from './alignment-v2';
import type { DocumentIndex } from './document-index';
import {
  alignmentLinksFromMatchedPairs,
  compareSpanFidelity,
  toCriticalChecks,
  type AuthoredToken,
  type SpokenTokenObservation,
} from '../coaching/fidelity';
import type {
  AssistSchedulingContext,
  CandidateDistance,
  CandidateRelationHint,
  CriticalCheck,
  LocalCandidate,
  LocalSupportKind,
} from '../semantic/types';
import type { LedgerToken, ScoredCandidate } from './types';

/**
 * §37.1 sends "normally 3–6" candidates; the sidecar's own `selectCandidates`
 * caps at 6. Building more than that is pure waste, so the cap is applied here
 * too — this is the only per-emission work that scales with anything.
 */
export const MAX_LOCAL_CANDIDATES = 6;

/** Upper bound on the exact script text carried per candidate (§37.1). */
const MAX_CANDIDATE_TOKENS = 40;
const MAX_CANDIDATE_CHARS = 320;

export interface LocalCandidateInput {
  index: DocumentIndex;
  measurement: AlignmentMeasurement;
  committedTokenIndex: number;
  /** `profile.largeForwardDistance`, already section-scaled. */
  largeForwardDistance: number;
  /** Confidence bands used for `localScoreBand`. */
  softThreshold: number;
  lockedThreshold: number;
}

/**
 * Project the post-gate candidate list into `LocalCandidate[]`.
 *
 * Every candidate here is by construction section-eligible, so
 * `sectionTransitionAllowed` is `true` for all of them — the flag is retained
 * because the sidecar's fusion layer re-checks it and a future caller that
 * feeds pre-gate candidates must not silently pass that check.
 */
export function buildLocalCandidates(input: LocalCandidateInput): LocalCandidate[] {
  const { index, measurement, committedTokenIndex } = input;
  const out: LocalCandidate[] = [];
  const seen = new Set<string>();
  const committedSection = index.sectionAt(committedTokenIndex);

  for (const candidate of measurement.candidates) {
    if (out.length >= MAX_LOCAL_CANDIDATES) break;
    const position = index.clampTokenIndex(candidate.absolutePosition);
    // One entry per *location*. The beam mints a separate id per (scope,
    // position) and scores each independently, but four ids pointing at the
    // same sentence are indistinguishable to Luna: they burn candidate slots
    // and prompt tokens while offering nothing to choose between. Keep the
    // best-scoring scope for each position — `measurement.candidates` is
    // already ordered confidence-desc — and the returned opinion still lands
    // on a hypothesis the engine holds.
    if (seen.has(String(position))) continue;
    seen.add(String(position));
    const id = candidateIdFor(candidate.window.scope, candidate.absolutePosition);

    const span = spanFor(index, position);
    const section = index.sectionAt(position);
    const distanceTokens = position - committedTokenIndex;
    const sameSection =
      committedSection !== undefined && section !== undefined
        ? committedSection.id === section.id
        : true;

    out.push({
      id,
      relationHint: relationHintFor(candidate, distanceTokens, sameSection, input),
      distance: distanceFor(index, distanceTokens, sameSection, input),
      text: textFor(index, span.start, span.end),
      sectionId: section?.id ?? '',
      startTokenIndex: span.start,
      endTokenIndex: span.end,
      localLogScore: candidate.confidence,
      localScoreBand: bandFor(candidate.confidence, input),
      supportKinds: supportKindsFor(candidate, distanceTokens),
      // Post-gate by construction — see the module docblock.
      sectionTransitionAllowed: true,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */

function spanFor(index: DocumentIndex, position: number): { start: number; end: number } {
  const sentence = index.sentenceAt(position);
  let start = sentence?.startTokenIndex ?? position;
  let end = sentence?.endTokenIndex ?? position + 11;
  // A one-clause sentence is not enough context to rank against; extend
  // forward rather than sending a fragment.
  if (end - start < 6) end = start + 11;
  start = index.clampTokenIndex(start);
  end = index.clampTokenIndex(Math.min(end, start + MAX_CANDIDATE_TOKENS - 1));
  return { start, end };
}

function textFor(index: DocumentIndex, start: number, end: number): string {
  const parts: string[] = [];
  let chars = 0;
  for (let i = start; i <= end; i++) {
    const surface = index.tokenAt(i)?.surface;
    if (surface === undefined) continue;
    chars += surface.length + 1;
    if (chars > MAX_CANDIDATE_CHARS) break;
    parts.push(surface);
  }
  return parts.join(' ');
}

function relationHintFor(
  candidate: ScoredCandidate,
  distanceTokens: number,
  sameSection: boolean,
  input: LocalCandidateInput,
): CandidateRelationHint {
  if (distanceTokens < 0) return 'retake';
  if (!sameSection) return 'boundary';
  if (distanceTokens > input.largeForwardDistance) return 'forward';
  // Distance zero is "carry on from here", which is continuity. `hold` is
  // deliberately never emitted: the beam's hold branch is not a candidate
  // window, and `RELATION_ALLOWED_HINTS` permits no influencing relation for
  // it — labelling a real candidate `hold` would silently make it unrankable.
  return 'continuity';
}

function distanceFor(
  index: DocumentIndex,
  distanceTokens: number,
  sameSection: boolean,
  input: LocalCandidateInput,
): CandidateDistance {
  if (!sameSection && distanceTokens > 0) return 'next_section';
  if (distanceTokens < 0) {
    // Roughly a sentence back vs. further; the scale is the document's own.
    return distanceTokens >= -Math.max(8, Math.floor(input.largeForwardDistance / 2))
      ? 'previous_sentence'
      : 'previous_paragraph';
  }
  if (distanceTokens === 0) return 'current';
  void index;
  return distanceTokens > input.largeForwardDistance ? 'far_forward' : 'near_forward';
}

function bandFor(confidence: number, input: LocalCandidateInput): 'weak' | 'moderate' | 'strong' {
  if (confidence >= input.lockedThreshold) return 'strong';
  if (confidence >= input.softThreshold) return 'moderate';
  return 'weak';
}

/**
 * §40.2: "at least one local support kind is mandatory for influence". An empty
 * list is the honest answer for a window that scored only on stopwords — and it
 * is what makes `selectCandidates` drop the candidate before Luna sees it.
 */
function supportKindsFor(candidate: ScoredCandidate, distanceTokens: number): LocalSupportKind[] {
  const kinds: LocalSupportKind[] = [];
  const sequence = candidate.sequence;
  if (sequence.rareAnchorMatches > 0) kinds.push('lexical_anchor');
  if (sequence.longestOrderedRun >= 3) kinds.push('ordered_context');
  if (candidate.window.scope === 'checkpoint') kinds.push('checkpoint');
  if (candidate.window.scope === 'retake' && distanceTokens < 0) kinds.push('retake_opening');
  if (kinds.length === 0 && sequence.contentMatches >= 2) kinds.push('lexical_anchor');
  return kinds;
}

/* ---------------------------------------------------------------------------
 * Scheduling context
 * ------------------------------------------------------------------------- */

/**
 * The audio interval and identity of one transcript item, which the alignable
 * tail does not carry.
 *
 * `TranscriptLedger.retokenize` sets no per-token `startMs`/`endMs` — the
 * provider gives an interval per *item*, not per word — so the comparator's
 * per-token audio clock has to be reconstructed from the item. This is the
 * minimum the caller must look up; see {@link tokenTimes} for the distribution.
 */
export interface TranscriptItemTiming {
  audioStartMs: number;
  audioEndMs: number;
  commitSequence: number | null;
  /**
   * Tokens in the *whole* item, which may exceed the number of its tokens
   * present in the tail — the tail is trimmed to `recentTranscriptMaxTokens`
   * and can start mid-item. Distributing over the tail's share instead would
   * stretch a truncated item's tokens across its full interval.
   */
  tokenCount: number;
}

export interface SchedulingContextInput extends LocalCandidateInput {
  /**
   * The alignable tail the measurement was produced from, in the *same array
   * order* the beam handed to `alignSequences`. Array position is exactly
   * `MatchedPair.transcriptIndex`, so this must be the whole tail — including
   * its provisional tokens — and must not be filtered or reordered.
   */
  transcriptTail: readonly LedgerToken[];
  /** Per-item audio interval lookup for {@link transcriptTail}. */
  itemTiming: (itemId: string) => TranscriptItemTiming | undefined;
  sessionId: string;
  sessionGeneration: number;
  scriptCompileHash: string;
  semanticEpoch: number;
  transcriptRevision: number;
  sessionTimeMs: number;
  trackingState: string;
  behavior: string;
  recentFinalTranscript: string;
  provisionalTail: string;
  newFinalTokenCount: number;
  atPhraseBoundary: boolean;
  commandPending: boolean;
  sessionPaused: boolean;
  reanchorActive: boolean;
  localConfidence: number;
  sustainedAmbiguityMs: number;
  lexicalFailureMs: number;
}

/**
 * Assemble the full `AssistSchedulingContext`.
 *
 * `criticalChecks` comes from the local critical-term comparator
 * (`coaching/fidelity`). It was an empty array for the life of the project —
 * originally honest, because no comparator existed — which made
 * `hasMinimumUsefulInput`'s critical branch and the `critical_token` burst
 * trigger unreachable and left Appendix C.2's `critical_checks` and
 * `critical_evidence` permanently blank. The one class of error Luna is
 * uniquely good at judging was the one it was never asked about.
 */
export function buildSchedulingContext(input: SchedulingContextInput): AssistSchedulingContext {
  const section = input.index.sectionAt(input.committedTokenIndex);
  return {
    sessionId: input.sessionId,
    sessionGeneration: input.sessionGeneration,
    scriptCompileHash: input.scriptCompileHash,
    semanticEpoch: input.semanticEpoch,
    transcriptRevision: input.transcriptRevision,
    sessionTimeMs: input.sessionTimeMs,
    trackingState: input.trackingState,
    behavior: input.behavior,
    currentSectionId: section?.id ?? '',
    currentSectionTitle: section?.title ?? '',
    recentFinalTranscript: input.recentFinalTranscript,
    provisionalTail: input.provisionalTail,
    hasNewFinalMeaningfulSpeech: input.newFinalTokenCount > 0,
    newFinalTokenCount: input.newFinalTokenCount,
    atPhraseBoundary: input.atPhraseBoundary,
    commandPending: input.commandPending,
    sessionPaused: input.sessionPaused,
    reanchorActive: input.reanchorActive,
    localConfidence: clamp01(input.localConfidence),
    sustainedAmbiguityMs: Math.max(0, input.sustainedAmbiguityMs),
    localTopMarginLogScore: input.measurement.secondBestMargin,
    lexicalFailureMs: Math.max(0, input.lexicalFailureMs),
    candidates: buildLocalCandidates(input),
    criticalChecks: buildCriticalChecks(input),
    sourceItemIds: [...input.measurement.sourceItemIds],
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/* ---------------------------------------------------------------------------
 * Critical checks (companion §37.1, spec §19, §25.5)
 * ------------------------------------------------------------------------- */

/**
 * Upper bound on the authored span handed to the comparator.
 *
 * The tail is capped at `recentTranscriptMaxTokens` (30 by default), so the
 * aligned script region is small and this bound is not normally reached. It
 * exists so a pathological window cannot turn a 2 Hz emission into an unbounded
 * scan. Trimming drops the *oldest* authored tokens, because the newest are the
 * ones the presenter just read.
 */
const MAX_FIDELITY_AUTHORED_TOKENS = 160;

/**
 * Run the local critical-term comparator over the span the aligner says the
 * presenter just read, and project the result onto `CriticalCheck[]`.
 *
 * Three things here are easy to get silently wrong, and each one would point a
 * priority-90 signal at the wrong words:
 *
 * 1. **`MatchedPair.scriptTokenIndex` is window-relative.** `scoreOne` aligns
 *    the tail against `spokenTokens.slice(window.startTokenIndex, …)`, and
 *    `alignment-v2` adds `window.startTokenIndex` back before it stores
 *    `matchedTokenIndexes`. `alignmentLinksFromMatchedPairs` is the shared
 *    adapter that does the same rebasing; it is used rather than open-coded so
 *    there is one place to be right.
 * 2. **`MatchedPair.transcriptIndex` indexes the whole tail.** The spoken
 *    observations are therefore built from every tail token in order, keeping
 *    array position identical to `transcriptIndex`. Filtering the provisional
 *    tokens out — tempting, since provisional evidence must never escalate —
 *    would shift every index and silently re-point every window. Finality is
 *    carried on the token instead and enforced by the comparator's own
 *    `evidenceFor` gate.
 * 3. **Nothing here decides anything.** No threshold, no tolerance and no
 *    suppression rule is re-implemented at this seam; the comparator's gates
 *    (§25.5 phonetic tolerance, self-correction, provisional suppression,
 *    substitution-only reporting) are the whole defence against false
 *    positives, and duplicating or relaxing any of them here would defeat them.
 */
function buildCriticalChecks(input: SchedulingContextInput): CriticalCheck[] {
  const best = input.measurement.candidates[0];
  if (best === undefined) return [];
  const pairs = best.sequence.matchedPairs;
  if (pairs.length === 0) return [];
  if (input.transcriptTail.length === 0) return [];

  const alignment = alignmentLinksFromMatchedPairs(pairs, best.window.startTokenIndex);
  let firstScriptToken = Number.POSITIVE_INFINITY;
  let lastScriptToken = Number.NEGATIVE_INFINITY;
  for (const link of alignment) {
    if (link.scriptTokenIndex < firstScriptToken) firstScriptToken = link.scriptTokenIndex;
    if (link.scriptTokenIndex > lastScriptToken) lastScriptToken = link.scriptTokenIndex;
  }
  if (!Number.isFinite(firstScriptToken) || !Number.isFinite(lastScriptToken)) return [];

  const index = input.index;
  // Whole sentences, not the matched range: a number run or a two-word name can
  // straddle the edge of what the aligner matched, and half a term extracted
  // from half a sentence is a fabricated term.
  let start = index.clampTokenIndex(
    index.sentenceAt(firstScriptToken)?.startTokenIndex ?? firstScriptToken,
  );
  const end = index.clampTokenIndex(
    index.sentenceAt(lastScriptToken)?.endTokenIndex ?? lastScriptToken,
  );
  if (end < start) return [];
  if (end - start + 1 > MAX_FIDELITY_AUTHORED_TOKENS) {
    start = end - MAX_FIDELITY_AUTHORED_TOKENS + 1;
  }

  const authored: AuthoredToken[] = [];
  for (let position = start; position <= end; position++) {
    const token = index.tokenAt(position);
    if (token === undefined) continue;
    authored.push({
      tokenIndex: token.index,
      surface: token.surface,
      // The compiler's flags are authoritative for proper-noun detection; the
      // comparator falls back to a capitalization heuristic without them, and
      // the two disagree on sentence-initial capitals.
      flags: token.flags,
      sentenceId: token.sentenceId,
    });
  }
  if (authored.length === 0) return [];

  const comparison = compareSpanFidelity({
    // The sentence the presenter is currently in. `CriticalCheck.spanId` is a
    // *span* id and is compared against active span ids downstream, so a token
    // index must never be put here (see `CoachCandidate.scriptSpanId`).
    spanId: index.sentenceAt(lastScriptToken)?.id ?? null,
    authored,
    spoken: spokenObservations(input.transcriptTail, input.itemTiming),
    alignment,
    // The tracking engine keeps one epoch, which it also reports as
    // `semanticEpoch`; there is no separate take-pass identity below the
    // coaching session, so one is derived from the session identity that does
    // exist. Both fields only ever reach `CoachEvidenceStamp`, which
    // `toCriticalChecks` drops — they are recorded for the comparator's own
    // `evidenceId`, not sent to Luna.
    trackingEpoch: input.semanticEpoch,
    takePassId: `${input.sessionId}:${input.sessionGeneration}:${input.semanticEpoch}`,
  });
  return toCriticalChecks(comparison.candidates);
}

/**
 * Project the alignable tail onto the comparator's spoken-token shape.
 *
 * Array position is preserved as `transcriptIndex` — see rule 2 above.
 */
function spokenObservations(
  tail: readonly LedgerToken[],
  itemTiming: (itemId: string) => TranscriptItemTiming | undefined,
): SpokenTokenObservation[] {
  const cache = new Map<string, TranscriptItemTiming | undefined>();
  const out: SpokenTokenObservation[] = [];
  for (let position = 0; position < tail.length; position++) {
    const token = tail[position];
    if (token === undefined) continue;
    if (!cache.has(token.itemId)) cache.set(token.itemId, itemTiming(token.itemId));
    const timing = cache.get(token.itemId);
    const times = tokenTimes(timing, token.indexInItem);
    out.push({
      transcriptIndex: position,
      surface: token.surface,
      final: token.final,
      audioStartMs: times.startMs,
      audioEndMs: times.endMs,
      commitSequence: timing?.commitSequence ?? null,
    });
  }
  return out;
}

/**
 * Spread an item's audio interval evenly across its tokens.
 *
 * The pace lane's `distributeTokenTimes` does the same job with speech weights
 * and VAD-voiced spans; neither is available in the tracking worker, and this
 * seam does not need them. The times leave here only on the comparator's
 * evidence stamp, which `toCriticalChecks` discards — what the comparator
 * actually acts on is token *order* and *finality*, and an even spread keeps
 * the times monotonic within an item, which is the property it relies on.
 */
function tokenTimes(
  timing: TranscriptItemTiming | undefined,
  indexInItem: number,
): { startMs: number; endMs: number } {
  if (timing === undefined) return { startMs: 0, endMs: 0 };
  const count = Math.max(1, timing.tokenCount);
  const span = Math.max(0, timing.audioEndMs - timing.audioStartMs);
  const each = span / count;
  const position = Math.max(0, Math.min(count - 1, indexInItem));
  const startMs = timing.audioStartMs + each * position;
  return { startMs, endMs: startMs + each };
}
