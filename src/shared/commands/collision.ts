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
}

export interface CollisionResult {
  /** Normalized alignment score of the phrase against nearby script. */
  score: number;
  /** Cursor sits inside a literal-command region. */
  inLiteralRegion: boolean;
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

  if (slice.length === 0 || input.phraseTokens.length === 0) {
    return { score: 0, inLiteralRegion };
  }
  const alignment = alignSequences(input.phraseTokens, slice, profile);
  return { score: alignment.normalizedScore, inLiteralRegion };
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
