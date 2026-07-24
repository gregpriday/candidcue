/**
 * Candidate window generation (spec §31.3, G.2). Windows come from the
 * continuity band, the current-paragraph retake window, the active section,
 * recent checkpoints, rare-token anchors, and meaningful n-grams. Windows are
 * deduplicated (merged when overlapping within the same scope) and capped.
 *
 * ## Cost (companion §63)
 *
 * Per-event alignment cost is proportional to the *total token span* handed to
 * the DP, so every source of unbounded span is capped here rather than left to
 * the window count:
 *
 *   - the `section` window used to span the entire current section, which on a
 *     long single-section script is the entire script;
 *   - a "rare" word in a long document can occur at dozens of positions, each
 *     producing a 161-token window; overlapping windows then *merge* into one
 *     enormous span, so capping the window count does not cap the work;
 *   - merged windows themselves had no size ceiling.
 *
 * With all three capped, per-event cost is a function of the profile alone,
 * not of script length — which is what §63 actually claims.
 */
import type { DocumentIndex } from './document-index';
import type { TrackingProfile } from './profile';
import { scaleToSection } from './scales';
import type {
  AlignmentCheckpoint,
  CandidateScope,
  CandidateWindow,
  LedgerToken,
} from './types';

export interface CandidateInput {
  committedTokenIndex: number;
  transcriptTail: readonly LedgerToken[];
  checkpoints: readonly AlignmentCheckpoint[];
  /** Widen scopes during global reacquisition (spec §31.14). */
  globalSearch: boolean;
}

export function generateCandidates(
  index: DocumentIndex,
  input: CandidateInput,
  profile: TrackingProfile,
): CandidateWindow[] {
  const windows: CandidateWindow[] = [];
  const total = index.tokenCount;
  if (total === 0) return windows;

  const add = (start: number, end: number, scope: CandidateScope): void => {
    const s = Math.max(0, Math.min(total - 1, Math.floor(start)));
    const e = Math.max(s, Math.min(total - 1, Math.floor(end)));
    windows.push({ startTokenIndex: s, endTokenIndex: e, scope });
  };

  const cursor = index.clampTokenIndex(input.committedTokenIndex);
  // §31.14: global reacquisition genuinely widens the search — more windows,
  // wider anchors, and more candidate positions per anchor word. Previously
  // `globalSearch` was accepted and never read, so SEARCHING searched exactly
  // the same space as FOLLOWING and could only ever re-find what it had lost
  // by luck.
  const widen = input.globalSearch ? 2 : 1;
  const anchorPositionLimit = profile.maxAnchorPositionsPerWord * widen;
  const windowLimit = profile.maxCandidateWindows * widen;

  // 1. Continuity window (§31.3.1), clamped to the enclosing section — the
  //    default forward span of 260 tokens spans several short chapters.
  const continuityForward = scaleToSection(
    index,
    cursor,
    profile.continuityForwardTokens,
    profile.continuityWindowMaxFraction,
  );
  add(cursor - profile.continuityBackTokens, cursor + continuityForward, 'continuity');

  // 2. Current-block retake window (§31.3.2).
  const blockStart = index.blockStartFor(cursor);
  add(Math.max(0, blockStart - 10), cursor + 10, 'retake');

  // 3. Current-section window (§31.3.3), banded around the cursor. The band is
  //    already covered by `continuity` near the cursor; what this adds is the
  //    rest of the section, and on a single-section script "the rest of the
  //    section" is the rest of the script (§63).
  const section = index.sectionAt(cursor);
  if (section) {
    const half = Math.floor(profile.maxCandidateWindowTokens / 2);
    add(
      Math.max(section.startTokenIndex, cursor - half),
      Math.min(section.endTokenIndex, cursor + half),
      'section',
    );
  }

  // 4. Recent checkpoint windows (§31.3.4).
  for (const checkpoint of input.checkpoints) {
    add(
      checkpoint.tokenIndex - profile.checkpointBackTokens,
      checkpoint.tokenIndex + profile.checkpointForwardTokens,
      'checkpoint',
    );
  }

  // 5. Global anchors: rare tokens and n-grams from the transcript tail
  // (§31.3.5). Always generated — the continuity prior keeps them from
  // beating local candidates unless anchors are genuinely strong. Only the
  // occurrences nearest the cursor are considered: a word that occurs in
  // eighty places is not an anchor, and scoring all eighty is what made
  // per-event cost track script length.
  const contentWords = input.transcriptTail.filter((t) => t.content).map((t) => t.normalized);
  const anchorBack = profile.anchorBackTokens * widen;
  const anchorForward = profile.anchorForwardTokens * widen;
  for (const word of contentWords) {
    const positions = index.rareTokenPositions.get(word);
    if (!positions) continue;
    for (const position of nearest(positions, cursor, anchorPositionLimit)) {
      add(position - anchorBack, position + anchorForward, 'rare_anchor');
    }
  }
  for (let size = 3; size >= 2; size--) {
    for (let i = 0; i + size <= contentWords.length; i++) {
      const key = contentWords.slice(i, i + size).join(' ');
      const positions = index.ngramPositions.get(key);
      if (!positions) continue;
      for (const position of nearest(positions, cursor, anchorPositionLimit)) {
        add(position - 30, position + 100, 'ngram'); // G.2 windowAround(position, -30, 100)
      }
    }
  }

  return dedupeAndLimit(windows, windowLimit, profile.maxCandidateWindowTokens);
}

/** The `limit` positions closest to `cursor`, in ascending order. */
function nearest(positions: readonly number[], cursor: number, limit: number): number[] {
  if (positions.length <= limit) return positions as number[];
  return [...positions]
    .sort((a, b) => Math.abs(a - cursor) - Math.abs(b - cursor) || a - b)
    .slice(0, limit)
    .sort((a, b) => a - b);
}

const SCOPE_PRIORITY: Record<CandidateScope, number> = {
  navigation: 0,
  continuity: 1,
  retake: 2,
  section: 3,
  checkpoint: 4,
  rare_anchor: 5,
  ngram: 6,
  global: 7,
};

/**
 * Merge overlapping same-scope windows, then cap by scope priority (G.2).
 *
 * `maxWindowTokens` bounds the *merged* result as well as the inputs: a chain
 * of overlapping anchor windows would otherwise coalesce into one span covering
 * half the script, which caps the window count while leaving the DP work
 * unbounded (§63).
 */
export function dedupeAndLimit(
  windows: CandidateWindow[],
  limit: number,
  maxWindowTokens = Number.POSITIVE_INFINITY,
): CandidateWindow[] {
  const byScope = new Map<CandidateScope, CandidateWindow[]>();
  for (const window of windows) {
    const list = byScope.get(window.scope) ?? [];
    list.push(window);
    byScope.set(window.scope, list);
  }
  const merged: CandidateWindow[] = [];
  for (const [scope, list] of byScope) {
    list.sort((a, b) => a.startTokenIndex - b.startTokenIndex);
    let current: CandidateWindow | undefined;
    for (const window of list) {
      const wouldSpan =
        current === undefined
          ? 0
          : Math.max(current.endTokenIndex, window.endTokenIndex) - current.startTokenIndex + 1;
      if (
        current &&
        window.startTokenIndex <= current.endTokenIndex + 1 &&
        wouldSpan <= maxWindowTokens
      ) {
        current = {
          scope,
          startTokenIndex: current.startTokenIndex,
          endTokenIndex: Math.max(current.endTokenIndex, window.endTokenIndex),
        };
      } else {
        if (current) merged.push(current);
        current = window;
      }
    }
    if (current) merged.push(current);
  }
  for (let i = 0; i < merged.length; i++) {
    const window = merged[i];
    if (window === undefined) continue;
    if (window.endTokenIndex - window.startTokenIndex + 1 > maxWindowTokens) {
      merged[i] = {
        scope: window.scope,
        startTokenIndex: window.startTokenIndex,
        endTokenIndex: window.startTokenIndex + Math.floor(maxWindowTokens) - 1,
      };
    }
  }
  merged.sort(
    (a, b) =>
      (SCOPE_PRIORITY[a.scope] ?? 9) - (SCOPE_PRIORITY[b.scope] ?? 9) ||
      a.startTokenIndex - b.startTokenIndex,
  );
  return merged.slice(0, Math.max(1, limit));
}
