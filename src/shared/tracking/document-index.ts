/**
 * Deterministic indexes over a TrackingDocument (spec §31.3, §31.14, G.2):
 * token → sentence/block/section lookup, paragraph/sentence starts, rare
 * token positions, and n-gram positions for global reacquisition.
 */
import type { SentenceUnit } from '../contracts/compiler';
import { STOPWORDS } from './normalize';
import type { SectionSpan, SpokenToken, TrackingDocument } from './types';
import { TOKEN_FLAG } from './types';

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
