/**
 * Candidate-generation search indexes (spec §25.6). All maps are plain
 * JSON-serializable records; they generate candidates only and are never
 * the final alignment score. Every build is a single linear pass.
 */
import type {
  NavigationTarget,
  SentenceUnit,
  SerializedSearchIndexes,
  SpokenToken,
  CompiledBlock,
} from '../contracts';
import { isStopword } from './stopwords';
import { phoneticKey } from './phonetic';

const RARE_MAX_FREQUENCY = 2;

/**
 * An alias only earns a place in the inverted index if it could plausibly be
 * the *distinctive* part of an utterance. Two rules, both cheap:
 *
 *   - the key must contain at least one non-stopword word of >= 3 characters,
 *     so `&` -> "and" and `no` -> "number" do not turn every occurrence of a
 *     function word into a retrieval anchor;
 *   - the key must not already be a frequent token of this script. If the
 *     script says "minute" thirty times, `min` -> "minute" adds nothing the
 *     exact-token index does not already have, and it would let one common
 *     word nominate spans all over the document (§23.2).
 */
const ALIAS_MIN_WORD_LENGTH = 3;
const ALIAS_MAX_OWN_FREQUENCY = 2;

function aliasIsDistinctive(key: string, frequency: ReadonlyMap<string, number>): boolean {
  if ((frequency.get(key) ?? 0) > ALIAS_MAX_OWN_FREQUENCY) return false;
  for (const word of key.split(' ')) {
    if (word.length >= ALIAS_MIN_WORD_LENGTH && !isStopword(word)) return true;
  }
  return false;
}

/**
 * Index records are keyed by arbitrary user text, so they MUST NOT inherit
 * from Object.prototype: a script containing the word "constructor" would
 * otherwise make `record[key] ??= []` see the inherited constructor function
 * (truthy) and skip the assignment, then throw on `.push`. Null-prototype
 * objects have no inherited keys, serialize identically over JSON and
 * structuredClone, and keep `record[key]` a plain lookup.
 */
function emptyIndex<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function push(record: Record<string, number[]>, key: string, value: number): void {
  (record[key] ??= []).push(value);
}

function pushId(record: Record<string, string[]>, key: string, value: string): void {
  (record[key] ??= []).push(value);
}

export function buildSearchIndexes(
  tokens: SpokenToken[],
  sentences: SentenceUnit[],
  blocks: CompiledBlock[],
  targets: NavigationTarget[],
): SerializedSearchIndexes {
  const exactToken = emptyIndex<number[]>();
  const phonetic = emptyIndex<number[]>();
  const ngram2 = emptyIndex<number[]>();
  const ngram3 = emptyIndex<number[]>();
  const ngram4 = emptyIndex<number[]>();

  const frequency = new Map<string, number>();
  for (const token of tokens) {
    frequency.set(token.normalized, (frequency.get(token.normalized) ?? 0) + 1);
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    push(exactToken, token.normalized, i);
    if (!isStopword(token.normalized) && token.normalized.length >= 3) {
      const key = phoneticKey(token.normalized);
      if (key) push(phonetic, key, i);
    }
    if (i + 1 < tokens.length) {
      const g2 = `${token.normalized} ${tokens[i + 1]!.normalized}`;
      push(ngram2, g2, i);
      if (i + 2 < tokens.length) {
        const g3 = `${g2} ${tokens[i + 2]!.normalized}`;
        push(ngram3, g3, i);
        if (i + 3 < tokens.length) {
          push(ngram4, `${g3} ${tokens[i + 3]!.normalized}`, i);
        }
      }
    }
  }

  const rareToken = emptyIndex<number[]>();
  for (const [normalized, positions] of Object.entries(exactToken)) {
    if (
      positions.length <= RARE_MAX_FREQUENCY &&
      !isStopword(normalized) &&
      normalized.length >= 3
    ) {
      rareToken[normalized] = positions;
    }
  }

  // §14.4: the inverted index covers aliases as well as normalized tokens.
  // Same single pass, one entry per (alias, position); alias counts per token
  // are tiny and bounded by `aliasesForToken`, so this stays linear.
  const aliasToken = emptyIndex<number[]>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isStopword(token.normalized)) continue;
    for (const alias of token.aliases) {
      if (!alias || alias === token.normalized) continue;
      if (!aliasIsDistinctive(alias, frequency)) continue;
      push(aliasToken, alias, i);
    }
  }

  const headingAndTake = emptyIndex<string[]>();
  for (const target of targets) {
    if (target.type === 'heading' || target.type === 'take') {
      pushId(headingAndTake, target.normalizedLabel, target.id);
    }
  }

  const sentenceText = emptyIndex<string[]>();
  for (const sentence of sentences) {
    if (sentence.normalizedText) pushId(sentenceText, sentence.normalizedText, sentence.id);
  }

  // Paragraph opening phrases: first up-to-4 spoken tokens of each spoken
  // block that starts a paragraph-like unit.
  const paragraphOpening = emptyIndex<number[]>();
  for (const block of blocks) {
    if (!block.spoken || block.startTokenIndex === undefined || block.endTokenIndex === undefined) {
      continue;
    }
    if (block.kind !== 'paragraph' && block.kind !== 'list_item' && block.kind !== 'blockquote') {
      continue;
    }
    const count = Math.min(4, block.endTokenIndex - block.startTokenIndex + 1);
    if (count < 1) continue;
    const words: string[] = [];
    for (let i = 0; i < count; i++) {
      words.push(tokens[block.startTokenIndex + i]!.normalized);
    }
    push(paragraphOpening, words.join(' '), block.startTokenIndex);
  }

  return {
    exactToken,
    rareToken,
    aliasToken,
    ngram2,
    ngram3,
    ngram4,
    phonetic,
    headingAndTake,
    sentenceText,
    paragraphOpening,
  };
}
