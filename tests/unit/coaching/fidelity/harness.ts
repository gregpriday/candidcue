/**
 * Test harness for the critical-term comparator.
 *
 * The important property of this harness is that **it does not place the
 * alignment anchors around the answer**. Anchors are derived by greedy monotone
 * exact matching of normalized authored tokens against normalized spoken
 * tokens — the same kind of evidence the real aligner produces — so a term the
 * presenter reworded is genuinely unanchored, exactly as it would be live. A
 * harness that hand-anchored each term would make every test pass for the wrong
 * reason.
 */
import { tokenizeText } from '../../../../src/shared/markdown/tokenize';
import { normalizeSurface } from '../../../../src/shared/coaching/fidelity/normalize';
import type {
  AlignmentLink,
  FidelitySpanObservation,
  SpokenTokenObservation,
} from '../../../../src/shared/coaching/fidelity/comparator';
import type { AuthoredToken } from '../../../../src/shared/coaching/fidelity/terms';
import { TOKEN_FLAGS } from '../../../../src/shared/contracts/compiler';

const TOKEN_MS = 400;

export interface SpanOptions {
  /**
   * Authored surfaces to flag as proper nouns, mirroring the compiler's
   * `PROPER_NOUN` flag. When omitted no flags are supplied at all and the
   * comparator's capitalization fallback is exercised instead.
   */
  properNouns?: readonly string[];
  /** Number of trailing spoken tokens left provisional. Default 0. */
  provisionalTailTokens?: number;
  /** Override the derived alignment entirely. */
  alignment?: readonly AlignmentLink[];
  coachingDisabled?: boolean;
  trackingEpoch?: number;
  takePassId?: string;
  spanId?: string | null;
}

function normalizedKey(surface: string): string {
  return normalizeSurface(surface).join(' ');
}

export function authoredTokens(script: string, options: SpanOptions = {}): AuthoredToken[] {
  const properNouns = options.properNouns;
  return tokenizeText(script).map((raw, index) => {
    const token: AuthoredToken = {
      tokenIndex: index,
      surface: raw.surface,
      sentenceId: 's1',
    };
    if (properNouns !== undefined) {
      token.flags = properNouns.includes(raw.surface) ? TOKEN_FLAGS.PROPER_NOUN : 0;
    }
    return token;
  });
}

export function spokenTokens(spoken: string, options: SpanOptions = {}): SpokenTokenObservation[] {
  const raws = tokenizeText(spoken);
  const provisionalFrom = raws.length - (options.provisionalTailTokens ?? 0);
  return raws.map((raw, index) => ({
    transcriptIndex: index,
    surface: raw.surface,
    final: index < provisionalFrom,
    audioStartMs: 1000 + index * TOKEN_MS,
    audioEndMs: 1000 + index * TOKEN_MS + (TOKEN_MS - 20),
    commitSequence: 7,
  }));
}

/** Greedy monotone exact-match anchors, standing in for the aligner's pairs. */
export function deriveAlignment(
  authored: readonly AuthoredToken[],
  spoken: readonly SpokenTokenObservation[],
): AlignmentLink[] {
  const links: AlignmentLink[] = [];
  let cursor = 0;
  for (const token of authored) {
    const key = normalizedKey(token.surface);
    if (key.length === 0) continue;
    for (let index = cursor; index < spoken.length; index++) {
      const candidate = spoken[index];
      if (candidate === undefined) continue;
      if (normalizedKey(candidate.surface) !== key) continue;
      links.push({ scriptTokenIndex: token.tokenIndex, transcriptIndex: candidate.transcriptIndex });
      cursor = index + 1;
      break;
    }
  }
  return links;
}

export function makeSpan(
  script: string,
  spoken: string,
  options: SpanOptions = {},
): FidelitySpanObservation {
  const authored = authoredTokens(script, options);
  const spokenList = spokenTokens(spoken, options);
  const observation: FidelitySpanObservation = {
    spanId: options.spanId === undefined ? 'sentence-1' : options.spanId,
    authored,
    spoken: spokenList,
    alignment: options.alignment ?? deriveAlignment(authored, spokenList),
    trackingEpoch: options.trackingEpoch ?? 4,
    takePassId: options.takePassId ?? 'take-a',
  };
  if (options.coachingDisabled === true) observation.coachingDisabled = true;
  return observation;
}
