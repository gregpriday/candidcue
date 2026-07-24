/**
 * Deterministic indexes over a TrackingDocument (spec §31.3, §31.14, G.2):
 * token → sentence/block/section lookup, paragraph/sentence starts, rare
 * token positions, and n-gram positions for global reacquisition.
 */
import type { SentenceUnit } from '../contracts/compiler';
import { STOPWORDS } from './normalize';
import type { SectionSpan, SpokenToken, TrackingDocument } from './types';
import { TOKEN_FLAG } from './types';

/** Shortest alias word that can carry retrieval weight (see below). */
const ALIAS_MIN_WORD_LENGTH = 3;
/** Above this document frequency an alias key is an ordinary word, not an anchor. */
const ALIAS_MAX_OWN_FREQUENCY = 2;

function aliasIsDistinctive(key: string, frequency: ReadonlyMap<string, number>): boolean {
  if ((frequency.get(key) ?? 0) > ALIAS_MAX_OWN_FREQUENCY) return false;
  for (const word of key.split(' ')) {
    if (word.length >= ALIAS_MIN_WORD_LENGTH && !STOPWORDS.has(word)) return true;
  }
  return false;
}

export class DocumentIndex {
  readonly document: TrackingDocument;
  readonly tokenCount: number;
  private sentenceByToken: Int32Array;
  private sectionByToken: Int32Array;
  readonly sections: SectionSpan[];
  private sentenceStarts: Set<number>;
  private blockStarts: Set<number>;
  private blockFirstToken = new Map<string, number>();
  readonly rareTokenPositions = new Map<string, number[]>();
  readonly ngramPositions = new Map<string, number[]>();
  /**
   * Normalized *alias* → spoken token positions (§14.2, §14.4).
   *
   * Aliases used to be reachable only from `matchTokens`, i.e. only once a
   * window was already open around the token. A presenter who says "doctor
   * halvorsen" where the script says "Dr. Halvorsen", or "forty seven" where
   * it says "47", produced nothing that `rareTokenPositions` or
   * `ngramPositions` could key on, so no window opened and the alias score had
   * nothing to raise. Keys may be multi-word (transcript normalization splits
   * hyphens and number words), which is why `generateCandidates` probes this
   * map with tail n-grams as well as single words.
   */
  readonly aliasTokenPositions = new Map<string, number[]>();
  /** Document frequency of each normalized token. */
  readonly tokenFrequency = new Map<string, number>();

  constructor(document: TrackingDocument, options?: { rareWeight?: number }) {
    this.document = document;
    const tokens = document.spokenTokens;
    this.tokenCount = tokens.length;
    const rareWeight = options?.rareWeight ?? 1.5;

    // Sentence lookup.
    this.sentenceByToken = new Int32Array(this.tokenCount).fill(-1);
    this.sentenceStarts = new Set();
    document.sentences.forEach((sentence, index) => {
      this.sentenceStarts.add(sentence.startTokenIndex);
      for (
        let i = Math.max(0, sentence.startTokenIndex);
        i <= Math.min(this.tokenCount - 1, sentence.endTokenIndex);
        i++
      ) {
        this.sentenceByToken[i] = index;
      }
    });

    // Block (paragraph) starts.
    this.blockStarts = new Set();
    for (const token of tokens) {
      if (!this.blockFirstToken.has(token.blockId)) {
        this.blockFirstToken.set(token.blockId, token.index);
        this.blockStarts.add(token.index);
      }
    }

    // Flattened sections from the outline.
    this.sections = [];
    const flatten = (nodes: TrackingDocument['outline']): void => {
      for (const node of nodes) {
        this.sections.push({
          id: node.id,
          title: node.title,
          level: node.level,
          startTokenIndex: node.startTokenIndex,
          endTokenIndex: node.endTokenIndex,
        });
        flatten(node.children);
      }
    };
    flatten(document.outline);
    this.sections.sort((a, b) => a.startTokenIndex - b.startTokenIndex);
    this.sectionByToken = new Int32Array(this.tokenCount).fill(-1);
    this.sections.forEach((section, index) => {
      for (
        let i = Math.max(0, section.startTokenIndex);
        i <= Math.min(this.tokenCount - 1, section.endTokenIndex);
        i++
      ) {
        // Deepest (latest-starting) section wins.
        this.sectionByToken[i] = index;
      }
    });

    // Frequency, rare tokens, and content n-grams (spec §31.14 step 1).
    for (const token of tokens) {
      if ((token.flags & TOKEN_FLAG.punctuation) !== 0) continue;
      this.tokenFrequency.set(
        token.normalized,
        (this.tokenFrequency.get(token.normalized) ?? 0) + 1,
      );
    }
    const contentTokens: SpokenToken[] = tokens.filter(
      (t) =>
        (t.flags & TOKEN_FLAG.punctuation) === 0 &&
        (t.flags & TOKEN_FLAG.stopword) === 0 &&
        !STOPWORDS.has(t.normalized),
    );
    for (const token of contentTokens) {
      const frequency = this.tokenFrequency.get(token.normalized) ?? 1;
      const rare = token.weight >= rareWeight || (frequency <= 2 && token.normalized.length >= 4);
      if (rare) {
        const list = this.rareTokenPositions.get(token.normalized) ?? [];
        list.push(token.index);
        this.rareTokenPositions.set(token.normalized, list);
      }
    }
    // Alias anchors (§14.4). Gated exactly like the compile-time index in
    // `markdown/indexes.ts`: an alias only nominates when it carries a
    // non-stopword word of real length and is not itself an ordinary frequent
    // word of this script — otherwise "and" (from `&`) or "number" (from `no`)
    // would open windows across the whole document (§23.2).
    for (const token of tokens) {
      if ((token.flags & TOKEN_FLAG.punctuation) !== 0) continue;
      if ((token.flags & TOKEN_FLAG.stopword) !== 0) continue;
      if (STOPWORDS.has(token.normalized)) continue;
      for (const alias of token.aliases) {
        if (!alias || alias === token.normalized) continue;
        if (!aliasIsDistinctive(alias, this.tokenFrequency)) continue;
        const list = this.aliasTokenPositions.get(alias) ?? [];
        list.push(token.index);
        this.aliasTokenPositions.set(alias, list);
      }
    }
    for (let size = 2; size <= 3; size++) {
      for (let i = 0; i + size <= contentTokens.length; i++) {
        const slice = contentTokens.slice(i, i + size);
        const key = slice.map((t) => t.normalized).join(' ');
        const first = slice[0];
        if (first === undefined) continue;
        const list = this.ngramPositions.get(key) ?? [];
        list.push(first.index);
        this.ngramPositions.set(key, list);
      }
    }
  }

  /* -------------------------------------------------------------------------
   * Repetition and distinctiveness (§14.3, §23.1)
   *
   * §23.1 asks for a repetition index storing a `distinctiveness` score per
   * anchor; §14.3 asks for script-local inverse frequency rather than a binary
   * stopword bucket. Both were missing, and the engine approximated them with
   * `RARE_MAX_FREQUENCY = 2` plus a stopword list — a two-bucket answer to a
   * continuous question.
   *
   * What is *not* built here is a second physical index. The occurrence lists
   * that a repetition index would hold already exist (`ngramPositions`,
   * `aliasTokenPositions`, `tokenFrequency`), and section membership is an O(1)
   * lookup away, so a parallel table would be duplicated state that can fall
   * out of sync. What was genuinely missing was the *measure* and a consumer
   * for it, and that is what these accessors are.
   * ----------------------------------------------------------------------- */

  /** Occurrences of a normalized 2/3-gram across the whole script. */
  phraseOccurrences(key: string): number {
    return this.ngramPositions.get(key)?.length ?? 0;
  }

  /** Occurrences of a phrase inside the section owning `tokenIndex`. */
  phraseOccurrencesInSection(key: string, tokenIndex: number): number {
    const positions = this.ngramPositions.get(key);
    if (positions === undefined) return 0;
    const section = this.sectionAt(tokenIndex);
    if (section === undefined) return positions.length;
    let count = 0;
    for (const position of positions) {
      if (position >= section.startTokenIndex && position <= section.endTokenIndex) count++;
    }
    return count;
  }

  /**
   * Distinctiveness of an anchor in (0, 1]: the reciprocal of how many times it
   * occurs. Unique phrase → 1; a refrain said four times → 0.25. Reciprocal
   * occurrence count rather than a token distance, so the measure itself
   * carries no scale assumption — the *threshold* is where script length
   * enters, and that lives in `generateCandidates` (see
   * `globalAnchorRepeatAllowance`).
   */
  static distinctivenessOf(occurrences: number): number {
    return 1 / Math.max(1, occurrences);
  }

  /**
   * §14.3 script-local inverse frequency, combined with the language stopword
   * weight rather than replaced by it. Reported for diagnostics and available
   * to callers that need a continuous alternative to the rare/not-rare bucket.
   */
  tokenDistinctiveness(normalized: string): number {
    const base = DocumentIndex.distinctivenessOf(this.tokenFrequency.get(normalized) ?? 0);
    return STOPWORDS.has(normalized) ? base * 0.35 : base;
  }

  clampTokenIndex(index: number): number {
    if (this.tokenCount === 0) return 0;
    return Math.max(0, Math.min(this.tokenCount - 1, Math.floor(index)));
  }

  tokenAt(index: number): SpokenToken | undefined {
    return this.document.spokenTokens[index];
  }

  sentenceAt(tokenIndex: number): SentenceUnit | undefined {
    const clamped = this.clampTokenIndex(tokenIndex);
    const sentenceIndex = this.sentenceByToken[clamped] ?? -1;
    return sentenceIndex >= 0 ? this.document.sentences[sentenceIndex] : undefined;
  }

  sectionAt(tokenIndex: number): SectionSpan | undefined {
    const clamped = this.clampTokenIndex(tokenIndex);
    const sectionIndex = this.sectionByToken[clamped] ?? -1;
    return sectionIndex >= 0 ? this.sections[sectionIndex] : undefined;
  }

  sameSection(a: number, b: number): boolean {
    const sa = this.sectionAt(a);
    const sb = this.sectionAt(b);
    if (sa === undefined || sb === undefined) return sa === sb;
    return sa.id === sb.id;
  }

  blockStartFor(tokenIndex: number): number {
    const token = this.tokenAt(this.clampTokenIndex(tokenIndex));
    if (token === undefined) return 0;
    return this.blockFirstToken.get(token.blockId) ?? 0;
  }

  /** G.5: does `position` sit within `tolerance` of a sentence/block start? */
  isSentenceOrParagraphStart(position: number, tolerance: number): boolean {
    for (let i = position - tolerance; i <= position + tolerance; i++) {
      if (this.sentenceStarts.has(i) || this.blockStarts.has(i)) return true;
    }
    return false;
  }

  /** Is the token inside a literal-command range (spec §33.5)? */
  inLiteralCommandRange(tokenIndex: number): boolean {
    for (const range of this.document.literalCommandRanges ?? []) {
      if (tokenIndex >= range.startTokenIndex && tokenIndex <= range.endTokenIndex) return true;
    }
    return false;
  }
}
