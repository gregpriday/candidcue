/**
 * Candidate window generation (spec §31.3, G.2). Windows come from the
 * continuity band, the current-paragraph retake window, the active section,
 * recent checkpoints, rare-token anchors, and meaningful n-grams. Windows are
 * deduplicated (merged when overlapping within the same scope) and capped.
 */
import type { DocumentIndex } from './document-index';
import type { TrackingProfile } from './profile';
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

  // 1. Continuity window (§31.3.1).
  add(cursor - profile.continuityBackTokens, cursor + profile.continuityForwardTokens, 'continuity');

  // 2. Current-block retake window (§31.3.2).
  const blockStart = index.blockStartFor(cursor);
  add(Math.max(0, blockStart - 10), cursor + 10, 'retake');

  // 3. Current-section window (§31.3.3).
  const section = index.sectionAt(cursor);
  if (section) add(section.startTokenIndex, section.endTokenIndex, 'section');

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
  // beating local candidates unless anchors are genuinely strong.
  const contentWords = input.transcriptTail.filter((t) => t.content).map((t) => t.normalized);
  for (const word of contentWords) {
    const positions = index.rareTokenPositions.get(word);
    if (!positions) continue;
    for (const position of positions) {
      add(position - profile.anchorBackTokens, position + profile.anchorForwardTokens, 'rare_anchor');
    }
  }
  for (let size = 3; size >= 2; size--) {
    for (let i = 0; i + size <= contentWords.length; i++) {
      const key = contentWords.slice(i, i + size).join(' ');
      const positions = index.ngramPositions.get(key);
      if (!positions) continue;
      for (const position of positions) {
        add(position - 30, position + 100, 'ngram'); // G.2 windowAround(position, -30, 100)
      }
    }
  }

  return dedupeAndLimit(windows, profile.maxCandidateWindows);
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

/** Merge overlapping same-scope windows, then cap by scope priority (G.2). */
export function dedupeAndLimit(windows: CandidateWindow[], limit: number): CandidateWindow[] {
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
      if (current && window.startTokenIndex <= current.endTokenIndex + 1) {
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
  merged.sort(
    (a, b) =>
      (SCOPE_PRIORITY[a.scope] ?? 9) - (SCOPE_PRIORITY[b.scope] ?? 9) ||
      a.startTokenIndex - b.startTokenIndex,
  );
  return merged.slice(0, Math.max(1, limit));
}
