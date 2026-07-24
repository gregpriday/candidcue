/**
 * Tracking-engine types (spec §30, §31, §45.4).
 *
 * The tracking worker never receives the full `CompiledScript` (spec §25.3
 * warns against shipping it on every update). Instead it is initialized once
 * with a compact `TrackingDocument` projection. `SpokenToken` mirrors the
 * illustrative contract in spec §25.3 structurally, so any compiler output
 * that satisfies that shape can be projected with `buildTrackingDocument`
 * without importing compiler internals.
 */
import { TOKEN_FLAGS } from '../contracts/compiler';
import type {
  NavigationTarget,
  OutlineNode,
  SentenceUnit,
  SpokenToken,
} from '../contracts/compiler';
import type { TokenLogprob, TranscriptToken, TrackingState } from '../contracts/tracking';

export type { SpokenToken } from '../contracts/compiler';

/* ---------------------------------------------------------------------------
 * Spoken tokens (spec §25.2/§25.3)
 * ------------------------------------------------------------------------- */

/** Bit flags carried by `SpokenToken.flags` (alias of contract TOKEN_FLAGS). */
export const TOKEN_FLAG = {
  punctuation: TOKEN_FLAGS.PUNCTUATION,
  stopword: TOKEN_FLAGS.STOPWORD,
  number: TOKEN_FLAGS.NUMBER,
  properNoun: TOKEN_FLAGS.PROPER_NOUN,
  directiveAlias: TOKEN_FLAGS.DIRECTIVE_ALIAS,
  nonNavigation: TOKEN_FLAGS.NON_NAVIGATION,
} as const;

export interface TokenRange {
  startTokenIndex: number;
  endTokenIndex: number;
}

/** A flattened heading section derived from the outline. */
export interface SectionSpan extends TokenRange {
  id: string;
  title: string;
  level: number;
}

/**
 * Compact projection of a compiled script consumed by the tracking worker
 * (spec §45.4 "compiled spoken tokens/indexes").
 */
export interface TrackingDocument {
  scriptId: string;
  /**
   * Compile hash of the script revision these tokens came from (companion
   * §26.1). Stamped on every `SemanticMotionFrame` so the stage can discard
   * frames belonging to a superseded compile. Defaults to `scriptId`.
   */
  scriptCompileHash?: string;
  spokenTokens: SpokenToken[];
  sentences: SentenceUnit[];
  outline: OutlineNode[];
  navigationTargets: NavigationTarget[];
  /** Token ranges covered by `literal-command` blocks (spec §33.5). */
  literalCommandRanges?: TokenRange[];
}

/**
 * Minimal structural view of a compiled script — any `CompiledScript`
 * (contracts Appendix C.1/§25.3) satisfies this. Only the fields the tracker
 * needs are required, so tests can hand-build tiny fixtures.
 */
export interface CompiledScriptLike {
  scriptId: string;
  spokenTokens: SpokenToken[];
  sentences: SentenceUnit[];
  outline: OutlineNode[];
  navigationTargets: NavigationTarget[];
}

export function buildTrackingDocument(
  compiled: CompiledScriptLike,
  literalCommandRanges: TokenRange[] = [],
): TrackingDocument {
  return {
    scriptId: compiled.scriptId,
    spokenTokens: compiled.spokenTokens,
    sentences: compiled.sentences,
    outline: compiled.outline,
    navigationTargets: compiled.navigationTargets,
    literalCommandRanges,
  };
}

/* ---------------------------------------------------------------------------
 * Transcript event model (spec §30.1)
 * ------------------------------------------------------------------------- */

export type TransportState = 'connecting' | 'connected' | 'degraded' | 'closed';

export type TranscriptEvent =
  | {
      type: 'item_started';
      sessionGeneration: number;
      itemId: string;
      commitSequence: number;
      audioStartMs: number;
      receivedAtMs: number;
    }
  | {
      type: 'delta';
      sessionGeneration: number;
      itemId: string;
      text: string;
      receivedAtMs: number;
    }
  | {
      type: 'completed';
      sessionGeneration: number;
      itemId: string;
      text: string;
      audioEndMs?: number;
      logprobs?: TokenLogprob[];
      receivedAtMs: number;
    }
  | {
      type: 'failed';
      sessionGeneration: number;
      itemId?: string;
      code: string;
      recoverable: boolean;
      receivedAtMs: number;
    }
  | {
      type: 'transport_state';
      sessionGeneration: number;
      state: TransportState;
      receivedAtMs: number;
    };

/** How a ledger item may be consumed downstream (spec §30.2). */
export type CommandDisposition = 'unknown' | 'script' | 'command' | 'discarded';

export interface LedgerItem {
  sessionGeneration: number;
  itemId: string;
  commitSequence: number;
  audioStartMs: number;
  audioEndMs: number;
  provisionalText: string;
  finalText?: string;
  status: 'open' | 'complete' | 'failed';
  normalizedTokens: LedgerToken[];
  /**
   * Provider log probabilities for the final transcript (§30.5), kept so
   * retokenization can attribute a confidence to each normalized token. Only
   * ever set from a `completed` event — deltas carry no logprobs, and
   * provisional text therefore carries no confidence evidence either.
   */
  logprobs?: TokenLogprob[];
  commandDisposition: CommandDisposition;
  /** Last wall-clock (worker-clock) time an event touched this item. */
  updatedAtMs: number;
}

/** A normalized transcript token annotated for alignment. */
export interface LedgerToken extends TranscriptToken {
  itemId: string;
  /** Index of this token within its item. */
  indexInItem: number;
  /** True when the token belongs to final (committed) text. */
  final: boolean;
  /** Near-zero alignment weight when true (spec §30.6). */
  filler: boolean;
  /** Content tokens are non-filler, non-stopword tokens. */
  content: boolean;
}

/**
 * The reconciler's per-update projection handed to the aligner and the
 * command router (spec §45.4 `ReconciledTranscriptUpdate`).
 */
export interface ReconciledTranscriptUpdate {
  sessionGeneration: number;
  itemId: string;
  /** True when this update reflects a completed item. */
  final: boolean;
  receivedAtMs: number;
}

/* ---------------------------------------------------------------------------
 * Alignment engine surface (spec §31)
 * ------------------------------------------------------------------------- */

export type CandidateScope =
  | 'continuity'
  | 'retake'
  | 'section'
  | 'checkpoint'
  | 'rare_anchor'
  /** Opened by the alias inverted index (§14.2, §14.4). */
  | 'alias_anchor'
  | 'ngram'
  | 'global'
  | 'navigation';

export interface CandidateWindow extends TokenRange {
  scope: CandidateScope;
}

/** One transcript↔script token pairing from the sequence aligner. */
export interface MatchedPair {
  transcriptIndex: number;
  scriptTokenIndex: number;
  kind: 'exact' | 'alias' | 'equivalent' | 'fuzzy' | 'phonetic' | 'weak';
  score: number;
}

export interface SequenceAlignment {
  /** Raw accumulated local-alignment score. */
  score: number;
  /** Score normalized to [0, 1] against the ideal transcript-tail score. */
  normalizedScore: number;
  /** Offset (inclusive) of the first matched script token in the window. */
  scriptStartOffset: number;
  /** Offset (inclusive) of the last matched script token in the window. */
  scriptEndOffset: number;
  matchedPairs: MatchedPair[];
  /** Matched non-stopword, non-filler tokens. */
  contentMatches: number;
  /** Longest run of consecutive in-order matches. */
  longestOrderedRun: number;
  /** Sum of matched script-token weights (anchor total, spec §31.7). */
  matchedWeight: number;
  /** Matched tokens flagged rare/high weight. */
  rareAnchorMatches: number;
}

export interface ScoredCandidate {
  window: CandidateWindow;
  sequence: SequenceAlignment;
  /** Absolute spoken-token index the cursor would move to. */
  absolutePosition: number;
  prior: number;
  confidence: number;
}

export type MovementKind = 'hold' | 'advance' | 'skip' | 'retake' | 'command' | 'manual';

export interface AlignmentDecision {
  movement: MovementKind;
  state: TrackingState;
  tokenIndex: number;
  committedTokenIndex: number;
  confidence: number;
  provisional: boolean;
  reason: string;
  best?: ScoredCandidate;
  margin: number;
}

/** Developer diagnostics (spec §31.17); no audio, text optional downstream. */
export interface AlignmentDiagnostic {
  revision: number;
  reason: string;
  state: TrackingState;
  movement: MovementKind;
  cursorTokenIndex: number;
  committedTokenIndex: number;
  confidence: number;
  margin: number;
  candidates: Array<{
    scope: CandidateScope;
    startTokenIndex: number;
    endTokenIndex: number;
    absolutePosition: number;
    normalizedScore: number;
    prior: number;
    confidence: number;
    contentMatches: number;
    rareAnchorMatches: number;
  }>;
  generatedAtMs: number;
}

export interface AlignmentCheckpoint {
  tokenIndex: number;
  sentenceId: string;
  blockId: string;
  atMs: number;
  kind: 'paragraph_start' | 'manual' | 'command' | 'take';
}
