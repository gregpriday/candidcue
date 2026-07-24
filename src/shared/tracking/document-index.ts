/**
 * Deterministic indexes over a TrackingDocument (spec §31.3, §31.14, G.2):
 * token → sentence/block/section lookup, paragraph/sentence starts, rare
 * token positions, and n-gram positions for global reacquisition.
 */
import type { SentenceUnit } from '../contracts/compiler';
import { phoneticKey, STOPWORDS } from './normalize';
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

/**
 * §14.4 phonetic-key admission. Deliberately the same shape of gate as the
 * alias one, and for the same reason: a phonetic key is a lossy hash, so
 * without a gate it is a machine for nominating spans document-wide.
 */
const PHONETIC_MIN_WORD_LENGTH = 4;
/** A one- or two-symbol key is a bucket, not an identity ("kl" is `Kaggle`, `cagle`, `coil`, `equal`). */
const PHONETIC_MIN_KEY_LENGTH = 3;
/** Above this many script tokens sharing a key it is an ordinary sound, not an anchor. */
const PHONETIC_MAX_OCCURRENCES = 2;

/** §14.3 "preserve function words that change meaning, especially negation". */
const NEGATIONS: ReadonlySet<string> = new Set([
  'not',
  'no',
  'never',
  'none',
  'nothing',
  'nobody',
  'neither',
  'nor',
  'cannot',
  "can't",
  "don't",
  "won't",
  "doesn't",
  "didn't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "shouldn't",
  "wouldn't",
  "couldn't",
  'without',
]);

/** §14.4 "currency" — the compiler's NUMBER flag already covers `$5` and `5%`. */
function isFidelityToken(token: SpokenToken): boolean {
  if ((token.flags & TOKEN_FLAG.number) !== 0) return true;
  if ((token.flags & TOKEN_FLAG.properNoun) !== 0) return true;
  return NEGATIONS.has(token.normalized);
}

/**
 * Above this many occurrences *inside one section* a fidelity token is that
 * section's own boilerplate. A section that says "not" eleven times must not
 * nominate eleven windows when the presenter says it once.
 */
const SECTION_FIDELITY_MAX_OCCURRENCES = 3;

const EMPTY_POSITIONS: readonly number[] = [];

function sectionFidelityKey(sectionIndex: number, normalized: string): string {
  return `${sectionIndex}\u0000${normalized}`;
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
  /**
   * Phonetic key → spoken token positions (§14.4 "phonetic-key index for
   * unusual and content-heavy words").
   *
   * `phoneticKey` previously ran only inside `matchTokens`, i.e. only pairwise
   * against a script token some *other* index had already put in a window. So
   * the one thing an ASR reliably does to an unusual name — spell it by sound —
   * could raise a candidate's score and never nominate one. Same shape as the
   * alias gap, and the same remedy.
   *
   * Keys are single words. A multi-word phonetic key would be guessing at where
   * the transcriber split the term, and the alias index already covers the
   * splits a script author or the microphone test actually observed.
   */
  readonly phoneticKeyPositions = new Map<string, number[]>();
  /**
   * Section index and normalized token, NUL-joined, → positions: §14.4's
   * "section-local number, date, currency, negation, and proper-noun index".
   *
   * These are §14.3's high-fidelity tokens: things that change the meaning of a
   * sentence but carry no global distinction, so they are worth retrieving
   * *inside the section the presenter is already in* and worthless outside it.
   * `rareTokenPositions` cannot stand in for this — it needs weight ≥ 1.5 or
   * four-plus characters at frequency ≤ 2, which excludes "47", "$5", "12%"
   * and every negation, and negations are additionally filtered out of the
   * content-token stream entirely.
   */
  readonly sectionFidelityPositions = new Map<string, number[]>();
  /** Document frequency of each normalized token. */
  readonly tokenFrequency = new Map<string, number>();
  /**
   * The content-token stream `ngramPositions` is keyed on, and the inverse map
   * from a script token index to its position in that stream (`-1` for
   * punctuation and stopwords). Together they let a caller holding *matched
   * script positions* — the aligner's own evidence — reconstruct exactly the
   * n-gram keys this index stores, without re-deriving the stopword rule.
   */
  private contentNormalized: string[] = [];
  private contentOrdinal: Int32Array;

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
    this.contentOrdinal = new Int32Array(this.tokenCount).fill(-1);
    this.contentNormalized = contentTokens.map((t) => t.normalized);
    contentTokens.forEach((token, ordinal) => {
      if (token.index >= 0 && token.index < this.tokenCount) {
        this.contentOrdinal[token.index] = ordinal;
      }
    });
    for (const token of contentTokens) {
      const frequency = this.tokenFrequency.get(token.normalized) ?? 1;
      const rare = token.weight >= rareWeight || (frequency <= 2 && token.normalized.length >= 4);
      if (rare) {
        const list = this.rareTokenPositions.get(token.normalized) ?? [];
        list.push(token.index);
        this.rareTokenPositions.set(token.normalized, list);
      }
    }
    // Alias anchors (§14.4). An alias only nominates when it carries a
    // non-stopword word of real length and is not itself an ordinary frequent
    // word of this script — otherwise "and" (from `&`) or "number" (from `no`)
    // would open windows across the whole document (§23.2).
    //
    // `markdown/indexes.ts` states the same rule for the compile-time index it
    // ships, and the two are *near*-identical rather than identical: that one
    // reads the compile-side stopword list (`markdown/stopwords.ts`, ~130
    // entries, tuned for token weighting) and this one the transcript-side
    // list in `./normalize` (~70). Sharing the code would mean choosing one
    // list for both, which is a larger decision than either index. Nothing
    // consumes the compile-time copy; see the note in
    // `tests/unit/markdown/indexes.test.ts`.
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
    // Phonetic anchors (§14.4). Two passes, because the gate is a property of
    // the *key* and not of the token: a key is admissible only when nothing
    // ordinary in this script also sounds like it. One stopword sharing the key
    // disqualifies it outright — "no"/"know" and "to"/"too" are how a phonetic
    // index turns into a document-wide nomination engine.
    const phoneticCounts = new Map<string, number>();
    const phoneticBlocked = new Set<string>();
    for (const token of tokens) {
      if ((token.flags & TOKEN_FLAG.punctuation) !== 0) continue;
      const key = phoneticKey(token.normalized);
      if (key.length < PHONETIC_MIN_KEY_LENGTH) continue;
      phoneticCounts.set(key, (phoneticCounts.get(key) ?? 0) + 1);
      const stopword =
        (token.flags & TOKEN_FLAG.stopword) !== 0 || STOPWORDS.has(token.normalized);
      if (stopword || token.normalized.length < PHONETIC_MIN_WORD_LENGTH) {
        phoneticBlocked.add(key);
      }
    }
    for (const token of tokens) {
      if ((token.flags & TOKEN_FLAG.punctuation) !== 0) continue;
      if ((token.flags & TOKEN_FLAG.stopword) !== 0) continue;
      if (STOPWORDS.has(token.normalized)) continue;
      if (token.normalized.length < PHONETIC_MIN_WORD_LENGTH) continue;
      const key = phoneticKey(token.normalized);
      if (key.length < PHONETIC_MIN_KEY_LENGTH) continue;
      if (phoneticBlocked.has(key)) continue;
      if ((phoneticCounts.get(key) ?? 0) > PHONETIC_MAX_OCCURRENCES) continue;
      const list = this.phoneticKeyPositions.get(key) ?? [];
      list.push(token.index);
      this.phoneticKeyPositions.set(key, list);
    }

    // Section-local high-fidelity anchors (§14.3, §14.4). Built after
    // `sectionByToken`, so the section a token belongs to is an O(1) lookup;
    // the same two-pass gate, but counted per section rather than per document,
    // because "section-local" is the whole point of this index.
    const fidelityDraft = new Map<string, number[]>();
    for (const token of tokens) {
      if ((token.flags & TOKEN_FLAG.punctuation) !== 0) continue;
      if (!isFidelityToken(token)) continue;
      const sectionIndex = this.sectionByToken[token.index] ?? -1;
      const key = sectionFidelityKey(sectionIndex, token.normalized);
      const list = fidelityDraft.get(key) ?? [];
      list.push(token.index);
      fidelityDraft.set(key, list);
    }
    for (const [key, positions] of fidelityDraft) {
      if (positions.length > SECTION_FIDELITY_MAX_OCCURRENCES) continue;
      this.sectionFidelityPositions.set(key, positions);
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
   * How many places in the script the *most distinctive anchor inside a matched
   * span* also appears (§23.1, §23.2).
   *
   * `scriptPositions` are the absolute script token indexes an alignment
   * actually matched — the evidence, not the destination. The anchors are the
   * 3-grams and 2-grams formed from *consecutive* matched content tokens, plus
   * the matched content tokens themselves; the answer is the smallest
   * occurrence count among them. So a span carrying one phrase unique to the
   * script answers 1 however ordinary the rest of its words are, and a span
   * every phrase of which appears in a refrain answers 2 however long and
   * however confidently matched it is.
   *
   * Phrases can only ever be at least as distinctive as their own words
   * (`occurrences("a b") <= min(freq(a), freq(b))`), so including single tokens
   * changes the answer in exactly one case: an isolated matched content word
   * with no matched neighbour. That is deliberate — a unique word is real
   * evidence, and refusing to see it is how a distinctiveness rule turns into a
   * freeze.
   *
   * `Number.POSITIVE_INFINITY` when the span matched no content at all: there
   * is no anchor, so there is no distinctiveness to report.
   */
  anchorOccurrences(scriptPositions: readonly number[]): number {
    const ordinals: number[] = [];
    for (const position of scriptPositions) {
      if (position < 0 || position >= this.tokenCount) continue;
      const ordinal = this.contentOrdinal[position] ?? -1;
      if (ordinal >= 0) ordinals.push(ordinal);
    }
    if (ordinals.length === 0) return Number.POSITIVE_INFINITY;
    ordinals.sort((a, b) => a - b);
    const unique = ordinals.filter((value, i) => value !== ordinals[i - 1]);

    let fewest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < unique.length; i++) {
      const start = unique[i];
      if (start === undefined) continue;
      const word = this.contentNormalized[start];
      if (word !== undefined) {
        fewest = Math.min(fewest, this.tokenFrequency.get(word) ?? 1);
      }
      for (let size = 2; size <= 3 && i + size - 1 < unique.length; size++) {
        if (unique[i + size - 1] !== start + size - 1) break;
        const key = this.contentNormalized.slice(start, start + size).join(' ');
        fewest = Math.min(fewest, this.phraseOccurrences(key));
      }
    }
    return fewest;
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

  /**
   * Positions of a high-fidelity token *inside the section owning `at`*
   * (§14.4). Empty outside that section by construction: the key carries the
   * section, so a match cannot leak across one.
   */
  sectionFidelityPositionsNear(at: number, normalized: string): readonly number[] {
    if (normalized.length === 0) return EMPTY_POSITIONS;
    const sectionIndex = this.sectionByToken[this.clampTokenIndex(at)] ?? -1;
    return this.sectionFidelityPositions.get(sectionFidelityKey(sectionIndex, normalized))
      ?? EMPTY_POSITIONS;
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
