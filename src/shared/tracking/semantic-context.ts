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
 */
import { candidateIdFor, type AlignmentMeasurement } from './alignment-v2';
import type { DocumentIndex } from './document-index';
import type {
  AssistSchedulingContext,
  CandidateDistance,
  CandidateRelationHint,
  LocalCandidate,
  LocalSupportKind,
} from '../semantic/types';
import type { ScoredCandidate } from './types';

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

export interface SchedulingContextInput extends LocalCandidateInput {
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
 * `criticalChecks` is deliberately empty: the local engine has no critical-term
 * comparator yet, and inventing one here would produce `critical_token` triggers
 * (the highest-urgency lane) out of nothing. An absent signal is reported as
 * absent.
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
    criticalChecks: [],
    sourceItemIds: [...input.measurement.sourceItemIds],
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
