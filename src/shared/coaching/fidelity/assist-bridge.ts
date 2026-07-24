/**
 * Adapters between this module and the two seams that consume it.
 *
 * Both helpers exist because the conversions are easy to get subtly, silently
 * wrong, and a silent error here produces a `critical_token` trigger — the
 * highest-urgency lane — pointed at the wrong words.
 */
import type { CoachCandidate } from '../../contracts/coaching';
import type { CriticalCheck, CriticalMismatch } from '../../semantic/types';
import type { AlignmentLink } from './comparator';

/**
 * `MatchedPair.scriptTokenIndex` is **relative to the candidate window**, not
 * absolute — `alignment-v2.ts` adds `window.startTokenIndex` before it stores
 * `matchedTokenIndexes`, and any consumer that forgets to do the same lands its
 * windows at the wrong place in the script without ever failing loudly.
 *
 * Pass the same `window.startTokenIndex` the pairs were produced against.
 */
export function alignmentLinksFromMatchedPairs(
  matchedPairs: ReadonlyArray<{ transcriptIndex: number; scriptTokenIndex: number }>,
  windowStartTokenIndex: number,
): AlignmentLink[] {
  return matchedPairs.map((pair) => ({
    transcriptIndex: pair.transcriptIndex,
    scriptTokenIndex: pair.scriptTokenIndex + windowStartTokenIndex,
  }));
}

/**
 * Maps a fidelity candidate onto the semantic scheduler's mismatch kinds.
 *
 * `CriticalMismatch` gained a `unit` member specifically so this mapping could
 * stop being lossy. The two rejected alternatives are worth recording, because
 * both are tempting and both are wrong: mapping a unit swap to `uncertain`
 * makes the scheduler ignore it outright (`classifyAssistTrigger` treats a
 * check as material only when its kind is neither `none` nor `uncertain`), so
 * a real milliseconds-read-as-seconds error would vanish — the exact failure
 * this comparator exists to catch. Mapping it to `number` keeps it material but
 * mislabels it, and that label survives all the way into the presenter's tip.
 *
 * `unit` is material by the same rule and says what actually happened.
 */
const KIND_BY_TYPE: Readonly<Record<string, CriticalMismatch>> = {
  critical_number_mismatch: 'number',
  critical_unit_mismatch: 'unit',
  critical_name_mismatch: 'name',
  critical_negation_mismatch: 'negation',
  material_meaning_change: 'meaning_change',
};

/**
 * Project fidelity candidates onto the semantic scheduler's `criticalChecks`.
 *
 * Candidates of any other type are dropped rather than mapped to `uncertain`:
 * a pace or filler candidate is not a critical check, and padding the list with
 * them would only inflate the payload.
 */
export function toCriticalChecks(candidates: readonly CoachCandidate[]): CriticalCheck[] {
  const checks: CriticalCheck[] = [];
  for (const candidate of candidates) {
    const kind = KIND_BY_TYPE[candidate.type];
    if (kind === undefined) continue;
    checks.push({
      kind,
      scriptFragment: candidate.authoredFragment.length > 0 ? candidate.authoredFragment : null,
      transcriptFragment: candidate.spokenFragment.length > 0 ? candidate.spokenFragment : null,
      spanId: candidate.scriptSpanId,
    });
  }
  return checks;
}
