/**
 * Weighted banded local sequence alignment (spec §31.5, G.3) —
 * Smith–Waterman-flavored DP between a rolling transcript tail and a script
 * candidate window. Preserves token order, tolerates transcript insertions
 * (cheap for fillers, §30.6) and script omissions, and returns matched
 * positions plus a normalized confidence input.
 */
import { idealPairScore, idealTokenScore, matchTokens } from './matching';
import type { TrackingProfile } from './profile';
import type { LedgerToken, MatchedPair, SequenceAlignment, SpokenToken } from './types';

const enum Step {
  None = 0,
  Match = 1,
  TranscriptInsertion = 2, // move in transcript only
  ScriptGap = 3, // move in script only
}

/**
 * Align `transcript` (m tokens, bounded by profile.recentTranscriptMaxTokens)
 * against `script` (a candidate window slice). O(m·n); never indexes outside
 * either array (§55.3 property).
 */
export function alignSequences(
  transcript: readonly LedgerToken[],
  script: readonly SpokenToken[],
  profile: TrackingProfile,
): SequenceAlignment {
  const m = transcript.length;
  const n = script.length;
  const empty: SequenceAlignment = {
    score: 0,
    normalizedScore: 0,
    scriptStartOffset: 0,
    scriptEndOffset: 0,
    matchedPairs: [],
    contentMatches: 0,
    longestOrderedRun: 0,
    matchedWeight: 0,
    rareAnchorMatches: 0,
  };
  if (m === 0 || n === 0) return empty;

  // DP over (m+1) x (n+1); local alignment: cells floor at 0.
  const width = n + 1;
  const score = new Float64Array((m + 1) * width);
  const step = new Uint8Array((m + 1) * width);

  let bestScore = 0;
  let bestI = 0;
  let bestJ = 0;

  for (let i = 1; i <= m; i++) {
    const t = transcript[i - 1];
    if (t === undefined) continue;
    const insertionPenalty = t.filler
      ? profile.fillerInsertionPenalty
      : profile.transcriptInsertionPenalty;
    for (let j = 1; j <= n; j++) {
      const s = script[j - 1];
      if (s === undefined) continue;
      const idx = i * width + j;

      const match = matchTokens(t, s, profile);
      let cell = 0;
      let how = Step.None;

      if (match !== undefined) {
        const viaMatch = (score[(i - 1) * width + (j - 1)] ?? 0) + match.score;
        if (viaMatch > cell) {
          cell = viaMatch;
          how = Step.Match;
        }
      }
      const viaInsertion = (score[(i - 1) * width + j] ?? 0) + insertionPenalty;
      if (viaInsertion > cell) {
        cell = viaInsertion;
        how = Step.TranscriptInsertion;
      }
      const gapPenalty = profile.scriptGapPenalty * Math.max(s.weight, 0.25);
      const viaGap = (score[idx - 1] ?? 0) + gapPenalty;
      if (viaGap > cell) {
        cell = viaGap;
        how = Step.ScriptGap;
      }

      score[idx] = cell;
      step[idx] = cell === 0 ? Step.None : how;
      if (cell > bestScore) {
        bestScore = cell;
        bestI = i;
        bestJ = j;
      }
    }
  }

  if (bestScore <= 0) return empty;

  // Backtrace for matched pairs and the window-relative span (§31.5).
  const pairs: MatchedPair[] = [];
  let i = bestI;
  let j = bestJ;
  let startJ = bestJ;
  while (i > 0 && j > 0) {
    const how = step[i * width + j];
    if (how === Step.None || how === undefined) break;
    if (how === Step.Match) {
      const t = transcript[i - 1];
      const s = script[j - 1];
      if (t !== undefined && s !== undefined) {
        const match = matchTokens(t, s, profile);
        pairs.push({
          transcriptIndex: i - 1,
          scriptTokenIndex: j - 1,
          kind: match?.kind ?? 'weak',
          score: match?.score ?? 0,
        });
      }
      startJ = j;
      i--;
      j--;
    } else if (how === Step.TranscriptInsertion) {
      i--;
    } else {
      startJ = j;
      j--;
    }
  }
  pairs.reverse();

  let contentMatches = 0;
  let matchedWeight = 0;
  let rareAnchorMatches = 0;
  let longestRun = 0;
  let run = 0;
  let prevT = -2;
  let prevS = -2;
  for (const pair of pairs) {
    const t = transcript[pair.transcriptIndex];
    const s = script[pair.scriptTokenIndex];
    if (t === undefined || s === undefined) continue;
    const isContent = t.content && pair.kind !== 'weak';
    if (isContent) contentMatches++;
    matchedWeight += s.weight * (pair.kind === 'weak' ? 0.25 : 1);
    if (isContent && s.weight >= profile.rareWeight) rareAnchorMatches++;
    if (pair.transcriptIndex === prevT + 1 && pair.scriptTokenIndex === prevS + 1) {
      run++;
    } else {
      run = 1;
    }
    if (run > longestRun) longestRun = run;
    prevT = pair.transcriptIndex;
    prevS = pair.scriptTokenIndex;
  }

  // Normalize against the ideal score of the aligned transcript span PLUS
  // any unmatched trailing content — the aligner estimates where the
  // presenter is *currently* reading (§31.1), so a candidate that only
  // explains stale early-tail text must score poorly. Leading unmatched
  // tokens stay free (local alignment). A floor of the profile's minimum
  // evidence span keeps a single lucky word from normalizing to 1.0
  // (§30.5 rule 6, §31.7).
  const firstPair = pairs[0];
  const spanStart = firstPair !== undefined ? firstPair.transcriptIndex : bestI - 1;
  /*
   * A matched token is normalized against what THAT PAIRING could have scored,
   * not against a guess made from the transcript side alone.
   *
   * `matchTokens` weighs a word by the script token's weight and stopword flag;
   * `idealTokenScore` weighs it by the transcript token's `content` flag. Those
   * judgements come from different lists and disagree often, so a word-perfect
   * read was normalized against an ideal it had no way to reach — 0.55 on the
   * app's own starter script, which the confidence model rendered as 0.60
   * against a lock threshold of 0.78. Nothing could commit.
   *
   * Unmatched tokens keep the transcript-side estimate: nothing in the script
   * explained them, so there is no pairing to ask, and they must still count
   * against a candidate that left the newest speech unexplained.
   */
  const matchedScript = new Map<number, SpokenToken>();
  for (const pair of pairs) {
    const s = script[pair.scriptTokenIndex];
    if (s !== undefined) matchedScript.set(pair.transcriptIndex, s);
  }
  let ideal = 0;
  let spanTokens = 0;
  for (let k = spanStart; k < m; k++) {
    const t = transcript[k];
    if (t === undefined) continue;
    const paired = matchedScript.get(k);
    ideal += paired !== undefined ? idealPairScore(paired, profile) : idealTokenScore(t, profile);
    if (k < bestI && t.content) spanTokens++;
  }
  const minSpan = Math.max(profile.recentTranscriptMinContentTokens, 1);
  if (spanTokens < minSpan) {
    ideal += (minSpan - spanTokens) * profile.exactScore * profile.normalWeight;
  }
  const normalizedScore = ideal > 0 ? Math.min(1, bestScore / ideal) : 0;

  return {
    score: bestScore,
    normalizedScore,
    scriptStartOffset: Math.max(0, startJ - 1),
    scriptEndOffset: bestJ - 1,
    matchedPairs: pairs,
    contentMatches,
    longestOrderedRun: longestRun,
    matchedWeight,
    rareAnchorMatches,
  };
}
