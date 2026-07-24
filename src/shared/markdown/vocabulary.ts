/**
 * Local vocabulary candidate extraction (spec §26.4). Deterministic and
 * offline: identifies unusual tokens the alignment engine should know about.
 * This is source #3 in the vocabulary merge order (§26.3); explicit
 * overrides and user dictionary entries always win.
 */
import type { CompiledScript, SpokenToken } from '../contracts';
import { TOKEN_FLAGS } from '../contracts';
import { isStopword } from './stopwords';

export type VocabularyCandidateKind =
  | 'proper_noun_phrase'
  | 'camel_case'
  | 'acronym'
  | 'numeric'
  | 'low_frequency'
  | 'hyphenated'
  | 'domain_like'
  | 'heading_term'
  | 'spoken_override';

export interface VocabularyCandidate {
  /** Display form (surface text as authored). */
  term: string;
  normalized: string;
  kinds: VocabularyCandidateKind[];
  occurrences: number;
  blockIds: string[];
  /** Spoken aliases carried by the tokens (from overrides and normalization). */
  aliases: string[];
}

const MAX_OPAQUE_HASH = /^[a-f0-9]{24,}$/i;
const DOMAIN_LIKE = /^[\w.-]+\.(com|org|net|io|dev|ai|app|co|me|tv|us|uk)$/i;
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_LIKE = /^(https?|ftp):\/\//i;
// Mixed-case: an uppercase letter after the first position plus at least
// one lowercase letter ("QuantumFlow", "OAuth", "iPhone"), which plain
// capitalization ("Sarah") never has.
const MIXED_CASE = /^.[^\s]*[\p{Lu}]/u;
const HAS_LOWER = /[\p{Ll}]/u;
const ACRONYM = /^\p{Lu}{2,8}s?$/u;

function isExcluded(token: SpokenToken): boolean {
  if (isStopword(token.normalized)) return true;
  if (URL_LIKE.test(token.surface)) return true; // URLs as URLs (§26.4)
  if (MAX_OPAQUE_HASH.test(token.normalized)) return true;
  if (token.normalized.length <= 1) return true;
  return false;
}

interface Accumulator {
  term: string;
  normalized: string;
  kinds: Set<VocabularyCandidateKind>;
  occurrences: number;
  blockIds: Set<string>;
  aliases: Set<string>;
}

/**
 * Extract vocabulary candidates from a compiled script. Pure function of
 * its input; identical compiles yield identical candidate lists.
 */
export function extractVocabularyCandidates(compiled: CompiledScript): VocabularyCandidate[] {
  const byNormalized = new Map<string, Accumulator>();
  const frequency = new Map<string, number>();
  for (const token of compiled.spokenTokens) {
    frequency.set(token.normalized, (frequency.get(token.normalized) ?? 0) + 1);
  }
  const totalTokens = compiled.spokenTokens.length;

  // Terms appearing in headings (normalized word set).
  const headingTerms = new Set<string>();
  const walkOutline = (nodes: typeof compiled.outline) => {
    for (const node of nodes) {
      for (const word of node.normalizedTitle.split(' ')) {
        if (word.length >= 4 && !isStopword(word)) headingTerms.add(word);
      }
      walkOutline(node.children);
    }
  };
  walkOutline(compiled.outline);

  const record = (
    token: SpokenToken,
    kind: VocabularyCandidateKind,
    termOverride?: string,
  ) => {
    const key = termOverride ? termOverride.toLowerCase() : token.normalized;
    let acc = byNormalized.get(key);
    if (!acc) {
      acc = {
        term: termOverride ?? token.surface,
        normalized: key,
        kinds: new Set(),
        occurrences: 0,
        blockIds: new Set(),
        aliases: new Set(),
      };
      byNormalized.set(key, acc);
    }
    acc.kinds.add(kind);
    acc.occurrences += 1;
    acc.blockIds.add(token.blockId);
    for (const alias of token.aliases) acc.aliases.add(alias);
  };

  const tokens = compiled.spokenTokens;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isExcluded(token)) continue;
    const surface = token.surface;
    const bare = surface.replace(/\./g, '');

    if ((token.flags & TOKEN_FLAGS.DIRECTIVE_ALIAS) !== 0) record(token, 'spoken_override');
    if (ACRONYM.test(bare)) record(token, 'acronym');
    else if (MIXED_CASE.test(bare) && HAS_LOWER.test(bare)) record(token, 'camel_case');
    if (/\d/.test(token.normalized) && !/^[\d.,%$]+$/.test(token.normalized)) {
      record(token, 'numeric'); // mixed digit tokens like "GPT-5" or "v2"
    }
    if (token.normalized.includes('-') && token.normalized.length >= 5) record(token, 'hyphenated');
    if (DOMAIN_LIKE.test(surface) || EMAIL_LIKE.test(surface)) record(token, 'domain_like');
    if (
      totalTokens >= 80 &&
      (frequency.get(token.normalized) ?? 0) === 1 &&
      token.normalized.length >= 7 &&
      !/\d/.test(token.normalized)
    ) {
      record(token, 'low_frequency');
    }
    if (headingTerms.has(token.normalized)) record(token, 'heading_term');
  }

  // Capitalized multiword phrases that are not merely sentence starts:
  // consecutive PROPER_NOUN-flagged tokens form a phrase.
  let runStart = -1;
  for (let i = 0; i <= tokens.length; i++) {
    const token = tokens[i];
    const isProper =
      token !== undefined &&
      (token.flags & TOKEN_FLAGS.PROPER_NOUN) !== 0 &&
      !isExcluded(token);
    const sameSentence =
      token !== undefined && runStart >= 0 && token.sentenceId === tokens[runStart]!.sentenceId;
    if (isProper && (runStart === -1 || sameSentence)) {
      if (runStart === -1) runStart = i;
      continue;
    }
    if (runStart >= 0 && i - runStart >= 2) {
      const phraseTokens = tokens.slice(runStart, i);
      const term = phraseTokens.map((t) => t.surface).join(' ');
      record(phraseTokens[0]!, 'proper_noun_phrase', term);
    }
    runStart = isProper && token ? i : -1;
  }

  const candidates: VocabularyCandidate[] = [];
  for (const acc of byNormalized.values()) {
    candidates.push({
      term: acc.term,
      normalized: acc.normalized,
      kinds: [...acc.kinds].sort(),
      occurrences: acc.occurrences,
      blockIds: [...acc.blockIds],
      aliases: [...acc.aliases],
    });
  }
  candidates.sort(
    (a, b) => b.occurrences - a.occurrences || a.normalized.localeCompare(b.normalized),
  );
  return candidates;
}
