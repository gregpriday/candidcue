/**
 * Wake-phrase detection (spec §33.2–§33.4, G.7). Scans the recent normalized
 * token tail for wake aliases at a plausible phrase boundary, then collects
 * the following command phrase.
 */
import { phoneticallySimilar } from '../tracking/normalize';
import type { LedgerToken } from '../tracking/types';
import type { CommandSettings } from './settings';

export interface WakeMatch {
  /** Index in the scanned tail where the wake alias starts. */
  startIndex: number;
  /** Index one past the last wake token (command tokens start here). */
  endIndex: number;
  alias: string;
  confidence: number;
  /** True when a pause/item boundary precedes the wake token (§33.4.2). */
  atBoundary: boolean;
}

function aliasTokenLists(settings: CommandSettings): string[][] {
  return settings.wakeAliases
    .map((alias) => alias.trim().split(/\s+/).filter((w) => w.length > 0))
    // Longest alias first so "candid cue" beats a phonetic hit on the
    // single-token "candidcue" against just "candid".
    .sort((a, b) => b.length - a.length);
}

/**
 * Find the most recent wake-alias occurrence in the token tail (G.7
 * `wakeMatcher.find`). Exact alias matches beat phonetic ones; longer
 * aliases beat shorter ones. In double-gate mode the literal token
 * "command" must follow the wake phrase (§33.3.2) — endIndex is placed
 * after it.
 */
export function findWake(
  tail: readonly LedgerToken[],
  settings: CommandSettings,
): WakeMatch | undefined {
  const aliases = aliasTokenLists(settings);
  for (let start = tail.length - 1; start >= 0; start--) {
    let phoneticMatch: WakeMatch | undefined;
    for (const alias of aliases) {
      if (alias.length === 0 || start + alias.length > tail.length) continue;
      let exact = true;
      let phonetic = true;
      let confidenceSum = 0;
      for (let j = 0; j < alias.length; j++) {
        const token = tail[start + j];
        const expected = alias[j];
        if (token === undefined || expected === undefined) {
          exact = false;
          phonetic = false;
          break;
        }
        confidenceSum += token.confidence ?? 1;
        if (token.normalized !== expected) {
          exact = false;
          if (!phoneticallySimilar(token.normalized, expected)) phonetic = false;
        }
      }
      if (!exact && !phonetic) continue;

      const modelConfidence = confidenceSum / alias.length;
      const aliasConfidence = exact ? 1 : 0.7;
      let endIndex = start + alias.length;

      if (settings.wakeMode === 'double_gate') {
        const gate = tail[endIndex];
        if (gate === undefined || gate.normalized !== 'command') continue; // §33.3.2
        endIndex += 1;
      }

      const match: WakeMatch = {
        startIndex: start,
        endIndex,
        alias: alias.join(' '),
        confidence: Math.max(0, Math.min(1, modelConfidence * aliasConfidence)),
        atBoundary: isBoundaryBefore(tail, start, settings),
      };
      if (exact) return match; // longest exact alias wins at this start
      phoneticMatch ??= match;
    }
    if (phoneticMatch !== undefined) return phoneticMatch;
  }
  return undefined;
}

/** Likely phrase boundary before index (§33.4.2): item start or pause gap. */
function isBoundaryBefore(
  tail: readonly LedgerToken[],
  index: number,
  settings: CommandSettings,
): boolean {
  if (index === 0) return true;
  const token = tail[index];
  const previous = tail[index - 1];
  if (token === undefined || previous === undefined) return true;
  if (token.itemId !== previous.itemId) return true; // new committed item
  if (token.indexInItem === 0) return true;
  const gap =
    token.startMs !== undefined && previous.endMs !== undefined
      ? token.startMs - previous.endMs
      : undefined;
  return gap !== undefined && gap >= settings.wakeBoundaryPauseMs;
}

export interface CollectedPhrase {
  /** Command tokens following the wake phrase (wake excluded). */
  tokens: LedgerToken[];
  /** All item ids touched by wake + command tokens (for masking, §33.4.5). */
  itemIds: string[];
  /** True when every contributing item is final. */
  final: boolean;
  /** True when a silence gap or max length closed the phrase (§33.4.3). */
  closed: boolean;
}

/** Collect command tokens after the wake phrase (G.7 `collectCommandPhrase`). */
export function collectCommandPhrase(
  tail: readonly LedgerToken[],
  wake: WakeMatch,
  settings: CommandSettings,
  isItemFinal: (itemId: string) => boolean,
): CollectedPhrase {
  const tokens: LedgerToken[] = [];
  const itemIds: string[] = [];
  const push = (id: string): void => {
    if (!itemIds.includes(id)) itemIds.push(id);
  };
  for (let i = wake.startIndex; i < wake.endIndex; i++) {
    const token = tail[i];
    if (token !== undefined) push(token.itemId);
  }

  let closed = false;
  let previous: LedgerToken | undefined;
  for (let i = wake.endIndex; i < tail.length; i++) {
    const token = tail[i];
    if (token === undefined) continue;
    if (previous !== undefined) {
      const gap =
        token.startMs !== undefined && previous.endMs !== undefined
          ? token.startMs - previous.endMs
          : undefined;
      if (gap !== undefined && gap >= settings.commandSilenceMs) {
        closed = true; // silence terminates the command (§33.4.3)
        break;
      }
    }
    tokens.push(token);
    push(token.itemId);
    previous = token;
    if (tokens.length >= settings.maxCommandTokens) {
      closed = true;
      break;
    }
  }

  const final = itemIds.every((id) => isItemFinal(id));
  return { tokens, itemIds, final, closed: closed || final };
}
