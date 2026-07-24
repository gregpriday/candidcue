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
  const exactToken: Record<string, number[]> = {};
  const phonetic: Record<string, number[]> = {};
  const ngram2: Record<string, number[]> = {};
  const ngram3: Record<string, number[]> = {};
  const ngram4: Record<string, number[]> = {};

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

  const rareToken: Record<string, number[]> = {};
  for (const [normalized, positions] of Object.entries(exactToken)) {
    if (
      positions.length <= RARE_MAX_FREQUENCY &&
      !isStopword(normalized) &&
      normalized.length >= 3
    ) {
      rareToken[normalized] = positions;
    }
  }

  const headingAndTake: Record<string, string[]> = {};
  for (const target of targets) {
    if (target.type === 'heading' || target.type === 'take') {
      pushId(headingAndTake, target.normalizedLabel, target.id);
    }
  }

  const sentenceText: Record<string, string[]> = {};
  for (const sentence of sentences) {
    if (sentence.normalizedText) pushId(sentenceText, sentence.normalizedText, sentence.id);
  }

  // Paragraph opening phrases: first up-to-4 spoken tokens of each spoken
  // block that starts a paragraph-like unit.
  const paragraphOpening: Record<string, number[]> = {};
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
    ngram2,
    ngram3,
    ngram4,
    phonetic,
    headingAndTake,
    sentenceText,
    paragraphOpening,
  };
}
