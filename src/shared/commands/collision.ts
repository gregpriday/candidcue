/**
 * Script-collision suppression (spec §33.5, G.7 `alignCommandAsScript`).
 * A wake+command phrase that strongly aligns to the nearby script is
 * authored content, not an address to the app.
 */
import { DEFAULT_TRACKING_PROFILE, type TrackingProfile } from '../tracking/profile';
import { alignSequences } from '../tracking/sequence';
import type { LedgerToken, SpokenToken, TokenRange } from '../tracking/types';
import type { CommandSettings } from './settings';

export interface CollisionInput {
  /** Wake + command tokens in transcript order. */
  phraseTokens: readonly LedgerToken[];
  /** Full spoken-token array of the compiled script. */
  scriptTokens: readonly SpokenToken[];
  /** Current cursor position (committed token index). */
  cursorTokenIndex: number;
  /** Literal-command ranges (spec §33.5). */
  literalCommandRanges?: readonly TokenRange[];
  /** How far around the cursor to test (tokens). */
  windowTokens?: number;
  /** Alignment score against a literal range that suppresses the command. */
  literalCommandThreshold?: number;
}

export interface CollisionResult {
  /** Normalized alignment score of the phrase against nearby script. */
  score: number;
  /**
   * The phrase is authored `:::literal-command` text, not an address to the
   * app. True when the phrase *aligns* inside a literal range, wherever the
   * cursor happens to be.
   */
  inLiteralRegion: boolean;
  /**
   * Absolute script token index where the phrase best aligns, or -1 when it
   * aligned nowhere. This — not the cursor — is where the presenter's mouth
   * actually is, and it is what every "is this authored text?" test must key
   * off (§33.5).
   */
  alignedTokenIndex: number;
  /** Best normalized alignment against any literal-command range. */
  literalScore: number;
}

/** How strongly a phrase must align to a literal range to be suppressed. */
export const DEFAULT_LITERAL_COMMAND_THRESHOLD = 0.5;

/**
 * …and how much of the phrase that alignment must actually explain. Score
 * alone is not enough: every literal-command block contains the wake alias by
 * construction, so "candid cue" always matches something in every range. A
 * genuine reading of the block accounts for nearly all of its content words; a
 * real command that merely shares the wake alias does not.
 */
export const LITERAL_COMMAND_COVERAGE = 0.7;

export interface LiteralRangeMatch {
  matched: boolean;
  /** Absolute token index of the best literal-range alignment, or -1. */
  tokenIndex: number;
  score: number;
}

/**
 * Does the phrase read as one of the script's authored `:::literal-command`
 * blocks — *anywhere* in the document (spec §33.5)?
 *
 * The cursor is deliberately not consulted. A literal-command block is the
 * author stating "these words are demonstration text, never an instruction",
 * and that statement does not stop being true because the tracker's cursor has
 * fallen behind: an ad-lib of twenty seconds is enough to put the cursor a
 * hundred tokens away from the block the presenter is at that moment reading
 * aloud, and keying the guard off the cursor is exactly how "to blank the stage
 * you say CandidCue blank the screen" blanks the stage mid-take.
 */
export function matchLiteralCommandRange(
  phraseTokens: readonly LedgerToken[],
  scriptTokens: readonly SpokenToken[],
  literalCommandRanges: readonly TokenRange[] | undefined,
  profile: TrackingProfile = DEFAULT_TRACKING_PROFILE,
  threshold = DEFAULT_LITERAL_COMMAND_THRESHOLD,
): LiteralRangeMatch {
  let best: LiteralRangeMatch = { matched: false, tokenIndex: -1, score: 0 };
  if (phraseTokens.length === 0) return best;
  let phraseContent = 0;
  for (const token of phraseTokens) if (token.content) phraseContent++;
  const neededMatches = Math.max(2, Math.ceil(phraseContent * LITERAL_COMMAND_COVERAGE));
  for (const range of literalCommandRanges ?? []) {
    const start = Math.max(0, range.startTokenIndex);
    const end = Math.min(scriptTokens.length - 1, range.endTokenIndex);
    if (end < start) continue;
    const slice = scriptTokens.slice(start, end + 1);
    if (slice.length === 0) continue;
    const alignment = alignSequences(phraseTokens, slice, profile);
    if (alignment.matchedPairs.length === 0) continue;
    if (alignment.normalizedScore > best.score) {
      best = {
        matched:
          alignment.normalizedScore >= threshold && alignment.contentMatches >= neededMatches,
        tokenIndex: start + alignment.scriptStartOffset,
        score: alignment.normalizedScore,
      };
    }
  }
  return best;
}

/** Score how strongly the candidate phrase reads as nearby script (§33.5). */
export function scoreScriptCollision(
  input: CollisionInput,
  profile: TrackingProfile = DEFAULT_TRACKING_PROFILE,
): CollisionResult {
  const window = input.windowTokens ?? 80;
  const start = Math.max(0, input.cursorTokenIndex - Math.floor(window / 2));
  const end = Math.min(input.scriptTokens.length, input.cursorTokenIndex + window);
  const slice = input.scriptTokens.slice(start, end);

  // Three independent tests, all of which suppress. They are complementary,
  // not alternatives — the first covers "the presenter is standing in the
  // block", the other two cover "the presenter is reading the block, wherever
  // the tracker currently thinks they are".
  //
  // 1. Region: the cursor is inside an authored literal block, so everything
  //    said here is demonstration.
  let inLiteralRegion = false;
  for (const range of input.literalCommandRanges ?? []) {
    if (
      input.cursorTokenIndex >= range.startTokenIndex - 4 &&
      input.cursorTokenIndex <= range.endTokenIndex + 4
    ) {
      inLiteralRegion = true;
      break;
    }
  }

  // 2. Document-wide: the phrase reads as a literal block, independent of the
  //    cursor entirely. This is the one that matters after an ad-lib, when the
  //    cursor has stalled a hundred tokens behind the presenter's mouth.
  const literal = matchLiteralCommandRange(
    input.phraseTokens,
    input.scriptTokens,
    input.literalCommandRanges,
    profile,
    input.literalCommandThreshold ?? DEFAULT_LITERAL_COMMAND_THRESHOLD,
  );
  if (literal.matched) inLiteralRegion = true;

  if (slice.length === 0 || input.phraseTokens.length === 0) {
    return { score: 0, inLiteralRegion, alignedTokenIndex: -1, literalScore: literal.score };
  }
  const alignment = alignSequences(input.phraseTokens, slice, profile);
  const alignedTokenIndex =
    alignment.matchedPairs.length === 0 ? -1 : start + alignment.scriptStartOffset;

  // 3. Local test, anchored to where the phrase aligned rather than to the
  //    cursor. Gated on the alignment being real: every literal-command block
  //    contains the wake alias, so bare containment of the aligned index would
  //    suppress any command spoken anywhere near one.
  const localThreshold = input.literalCommandThreshold ?? DEFAULT_LITERAL_COMMAND_THRESHOLD;
  if (!inLiteralRegion && alignedTokenIndex >= 0 && alignment.normalizedScore >= localThreshold) {
    for (const range of input.literalCommandRanges ?? []) {
      if (
        alignedTokenIndex >= range.startTokenIndex - 4 &&
        alignedTokenIndex <= range.endTokenIndex + 4
      ) {
        inLiteralRegion = true;
        break;
      }
    }
  }

  return {
    score: alignment.normalizedScore,
    inLiteralRegion,
    alignedTokenIndex,
    literalScore: literal.score,
  };
}

/**
 * Preparation-time scan: find wake aliases in the authored script followed
 * by likely command verbs (spec §33.5 "Preparation scans the script").
 */
const COMMAND_VERBS = new Set([
  'start', 'stop', 'pause', 'resume', 'go', 'goto', 'find', 'restart',
  'move', 'make', 'set', 'mirror', 'blank', 'show', 'hide', 'turn',
  'use', 'switch', 'speed', 'slow', 'retake', 'mark', 'next', 'previous',
]);

export interface ScriptWakeCollision {
  tokenIndex: number;
  alias: string;
  followedByCommandVerb: boolean;
}

export function scanScriptForWakeCollisions(
  scriptTokens: readonly SpokenToken[],
  settings: CommandSettings,
): ScriptWakeCollision[] {
  const collisions: ScriptWakeCollision[] = [];
  const aliases = settings.wakeAliases.map((a) => a.split(/\s+/).filter((w) => w.length > 0));
  for (let i = 0; i < scriptTokens.length; i++) {
    for (const alias of aliases) {
      if (alias.length === 0 || i + alias.length > scriptTokens.length) continue;
      let matches = true;
      for (let j = 0; j < alias.length; j++) {
        if (scriptTokens[i + j]?.normalized !== alias[j]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      const following = scriptTokens[i + alias.length]?.normalized ?? '';
      collisions.push({
        tokenIndex: i,
        alias: alias.join(' '),
        followedByCommandVerb: COMMAND_VERBS.has(following),
      });
    }
  }
  return collisions;
}
