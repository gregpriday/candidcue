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
  CompiledBlock,
  CueEvent,
  NavigationTarget,
  OutlineNode,
  SafeRenderNode,
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
  /**
   * Companion §6.1 "comma or light clause boundary": spoken-token indexes
   * *after* which the authored text has a comma, semicolon, colon or dash.
   *
   * This has to be derived at projection time and shipped, because it is the
   * one §6.1 signal that survives nowhere else. The tokenizer never emits a
   * punctuation token (`markdown/tokenize.ts`: "pure punctuation never becomes
   * a token"), so no compiled token has ever carried `TOKEN_FLAGS.PUNCTUATION`
   * and the worker has no access to the source text. What it does have, via
   * `CompiledBlock.renderNodes`, is the authored text with its punctuation
   * intact plus the `tokenIndexes` that text produced — enough to recover the
   * boundary exactly, rather than guessing it from source-offset gaps (which
   * fire on `**bold**` and on double spaces just as readily as on commas).
   */
  clauseEndTokenIndexes?: number[];
  /** Companion §6.1 "explicit pause directive" (§23.1 `[Pause]`/`[Beat]`/`[Breathe]`). */
  pauseAnchors?: PauseAnchor[];
}

/** An authored pause, resolved to the token it follows (companion §6.1). */
export interface PauseAnchor {
  /** Spoken-token index the silence falls *after*. */
  tokenIndex: number;
  kind: 'pause' | 'beat' | 'breathe';
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
  /**
   * Optional so a hand-built fixture stays a valid document. When present they
   * are the only source of the companion §6.1 pause signals; when absent the
   * unit axis simply carries no clause or authored-pause weight, which is what
   * it did before those signals existed.
   */
  blocks?: readonly CompiledBlock[];
  cues?: readonly CueEvent[];
}

export function buildTrackingDocument(
  compiled: CompiledScriptLike,
  literalCommandRanges: TokenRange[] = [],
): TrackingDocument {
  const clauseEndTokenIndexes = deriveClauseEnds(compiled.blocks, compiled.spokenTokens);
  const pauseAnchors = derivePauseAnchors(compiled.cues, compiled.spokenTokens.length);
  return {
    scriptId: compiled.scriptId,
    spokenTokens: compiled.spokenTokens,
    sentences: compiled.sentences,
    outline: compiled.outline,
    navigationTargets: compiled.navigationTargets,
    literalCommandRanges,
    ...(clauseEndTokenIndexes.length > 0 ? { clauseEndTokenIndexes } : {}),
    ...(pauseAnchors.length > 0 ? { pauseAnchors } : {}),
  };
}

/* ---------------------------------------------------------------------------
 * Companion §6.1 pause signals
 * ------------------------------------------------------------------------- */

/** Comma, semicolon, colon, en/em dash — a break in delivery, not a full stop. */
const CLAUSE_PUNCTUATION = /[,;:–—]/;

/** One run of authored text and the spoken tokens it produced, in order. */
interface RenderRun {
  text: string;
  tokenIndexes: readonly number[];
}

function flattenRenderNodes(nodes: readonly SafeRenderNode[], into: RenderRun[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        into.push({ text: node.text, tokenIndexes: node.tokenIndexes ?? [] });
        break;
      case 'link':
        flattenRenderNodes(node.label, into);
        break;
      case 'table':
        for (const row of node.rows) for (const cell of row) flattenRenderNodes(cell, into);
        break;
      // A line break, a cue marker and an image contribute no authored
      // characters *between* two spoken tokens, so they cannot hide a comma.
      default:
        break;
    }
  }
}

/**
 * Spoken-token indexes followed by a clause break.
 *
 * The surfaces of a run's tokens appear inside that run's text in order, so a
 * forward-only `indexOf` walk recovers exactly the characters that sat between
 * two tokens. Text carried over a node boundary matters — `**first**, we` puts
 * the comma at the head of the *next* node — so the pending tail is kept across
 * runs and reset only at a block boundary.
 *
 * Any run whose surfaces cannot be located (a `{say="…"}` override writes a
 * spoken form that is not in the visual text) simply stops contributing; a
 * missed comma costs a fraction of a unit, and a guessed one is worse.
 */
function deriveClauseEnds(
  blocks: readonly CompiledBlock[] | undefined,
  tokens: readonly SpokenToken[],
): number[] {
  if (blocks === undefined || blocks.length === 0) return [];
  const clauseEnds: number[] = [];
  for (const block of blocks) {
    const runs: RenderRun[] = [];
    flattenRenderNodes(block.renderNodes, runs);
    let pending = '';
    let previousTokenIndex = -1;
    for (const run of runs) {
      let cursor = 0;
      for (const tokenIndex of run.tokenIndexes) {
        const surface = tokens[tokenIndex]?.surface;
        if (surface === undefined || surface.length === 0) continue;
        const at = run.text.indexOf(surface, cursor);
        if (at < 0) break;
        const between = pending + run.text.slice(cursor, at);
        if (previousTokenIndex >= 0 && CLAUSE_PUNCTUATION.test(between)) {
          clauseEnds.push(previousTokenIndex);
        }
        pending = '';
        cursor = at + surface.length;
        previousTokenIndex = tokenIndex;
      }
      pending += run.text.slice(cursor);
    }
  }
  clauseEnds.sort((a, b) => a - b);
  return clauseEnds.filter((value, i) => value !== clauseEnds[i - 1]);
}

/**
 * `CueEvent.anchorTokenIndex` is the token the cue *precedes*, so the silence
 * belongs to the token before it. A cue at the very start of the script anchors
 * to token 0 and is dropped: `unitAt(0)` is 0 by definition, so there is no
 * interval for it to lengthen. A cue with nothing after it (`-1`) lands on the
 * last token, where a trailing `[Breathe]` correctly widens the final interval.
 */
function derivePauseAnchors(
  cues: readonly CueEvent[] | undefined,
  tokenCount: number,
): PauseAnchor[] {
  if (cues === undefined || cues.length === 0 || tokenCount === 0) return [];
  const anchors: PauseAnchor[] = [];
  for (const cue of cues) {
    if (cue.cueType !== 'pause' && cue.cueType !== 'beat' && cue.cueType !== 'breathe') continue;
    const anchor = cue.anchorTokenIndex;
    const tokenIndex = anchor < 0 ? tokenCount - 1 : anchor - 1;
    if (tokenIndex < 0 || tokenIndex >= tokenCount) continue;
    anchors.push({ tokenIndex, kind: cue.cueType });
  }
  return anchors;
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
  /**
   * Consecutive provider revisions in which this token has survived at this
   * position, counting from 1 on the revision that introduced it.
   *
   * A streaming recogniser restates an utterance repeatedly and the tail of
   * each restatement is the part it is least sure of — "we should build a
   * very complicated system" becoming "we should build a complicated system"
   * is a correction, not new speech. Words that have survived several
   * revisions are evidence; the newest word in a partial is a guess. Prefer
   * `isStableToken` over reading this directly.
   */
  stability: number;
}

/**
 * Revisions a provisional token must survive before it is treated as evidence
 * rather than as the recogniser thinking aloud.
 */
export const STABLE_REVISIONS = 2;

/** Final text is authoritative; provisional text has to earn it. */
export function isStableToken(token: LedgerToken): boolean {
  return token.final || token.stability >= STABLE_REVISIONS;
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
  /**
   * Tokens the provider withdrew in this revision — text it had previously
   * offered and has now replaced.
   *
   * Non-zero means evidence the aligner may already have matched on no longer
   * exists, which is a different event from "more speech arrived" and cannot
   * be inferred from the new text alone.
   */
  retractedTokens: number;
  /** Leading tokens this revision left untouched. */
  stablePrefixTokens: number;
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
  /** Opened by the phonetic-key index (§14.4) — the ASR mangled a rare term. */
  | 'phonetic_anchor'
  /**
   * Opened by the section-local number/date/currency/negation/proper-noun
   * index (§14.3, §14.4). Never leaves the section it was keyed in.
   */
  | 'fidelity_anchor'
  | 'ngram'
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
