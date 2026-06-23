import type { InterviewerActionType, QuestionValidation, QuestionViolation } from '@shared/domain';
import { INTERNAL_TERMS, RUNTIME_DEFAULTS } from '@shared/constants/runtime-defaults';
import { estimateSpeechMs, lexicalSimilarity, normalizeWhitespace, wordCount } from '@shared/utils';

/** Input to {@link validateQuestion} (spec §16.14). */
export interface QuestionValidationInput {
  spokenText: string;
  action: InterviewerActionType;
  targetCoverageItemIds: string[];
  validCoverageIds: string[];
  recentQuestions: string[];
  maxWords?: number;
  wordsPerSecond?: number;
}

/** Markdown markup characters/sequences that must never reach the user. */
const MARKDOWN_PATTERN = /(\*|#|`|_|\[[^\]]*\]|\]\()/;

/** Parenthetical/bracketed stage directions, e.g. "(smiles)" or "[laughs]". */
const STAGE_DIRECTION_PATTERN = /\([^)]*\)|\[[^\]]*\]/;

/** Number of trailing recent questions compared for near-duplicates. */
const RECENT_QUESTION_WINDOW = 5;

/** Similarity threshold above which a question is treated as a repeat. */
const REPEAT_SIMILARITY_THRESHOLD = 0.8;

/**
 * Validate a generated interviewer question against the structural and content
 * guarantees the spec requires (spec §16.14). Pure and deterministic.
 *
 * For action `'complete'`, an empty `spokenText` is valid (a silent close).
 */
export function validateQuestion(input: QuestionValidationInput): QuestionValidation {
  const maxWords = input.maxWords ?? RUNTIME_DEFAULTS.maxQuestionWords;
  const wordsPerSecond = input.wordsPerSecond ?? RUNTIME_DEFAULTS.defaultWordsPerSecond;

  const text = normalizeWhitespace(input.spokenText);
  const words = wordCount(text);
  const violations: QuestionViolation[] = [];

  const isEmpty = text.length === 0;

  // Empty text is a violation only when the interviewer is asking.
  if (input.action === 'ask' && isEmpty) {
    violations.push('empty');
  }

  // Length budget.
  if (words > maxWords) {
    violations.push('too_many_words');
  }

  // Exactly one question mark is allowed; more than one is a violation.
  const questionMarkCount = (text.match(/\?/g) ?? []).length;
  if (questionMarkCount > 1) {
    violations.push('multiple_question_marks');
  }

  // An "ask" must end in a question mark (only meaningful for non-empty text).
  if (input.action === 'ask' && !isEmpty && !text.trimEnd().endsWith('?')) {
    violations.push('no_question_when_action_ask');
  }

  // Markdown markup and stage directions are never spoken aloud.
  if (!isEmpty && MARKDOWN_PATTERN.test(text)) {
    violations.push('markdown');
  }
  if (!isEmpty && STAGE_DIRECTION_PATTERN.test(text)) {
    violations.push('contains_stage_direction');
  }

  // Internal system vocabulary must not leak to the user. Match whole phrases
  // only (case-insensitive) so ordinary words like "AI" or "transcript" pass.
  if (!isEmpty && mentionsInternalTerm(text)) {
    violations.push('mentions_internal_system');
  }

  // Near-duplicate of a recently asked question.
  if (!isEmpty && repeatsRecentQuestion(text, input.recentQuestions)) {
    violations.push('repeats_recent_question');
  }

  // Every targeted coverage id must exist in the plan.
  if (hasInvalidCoverageId(input.targetCoverageItemIds, input.validCoverageIds)) {
    violations.push('invalid_coverage_id');
  }

  return {
    valid: violations.length === 0,
    wordCount: words,
    estimatedDurationMs: estimateSpeechMs(words, wordsPerSecond),
    violations,
  };
}

/** True when the text contains any INTERNAL_TERMS phrase (case-insensitive). */
function mentionsInternalTerm(text: string): boolean {
  const haystack = text.toLowerCase();
  return INTERNAL_TERMS.some((term) => haystack.includes(term.toLowerCase()));
}

/** True when the text is too similar to any of the last few recent questions. */
function repeatsRecentQuestion(text: string, recentQuestions: string[]): boolean {
  const recent = recentQuestions.slice(-RECENT_QUESTION_WINDOW);
  return recent.some((prior) => lexicalSimilarity(text, prior) > REPEAT_SIMILARITY_THRESHOLD);
}

/** True when any targeted coverage id is absent from the valid set. */
function hasInvalidCoverageId(targetIds: string[], validIds: string[]): boolean {
  if (targetIds.length === 0) return false;
  const valid = new Set(validIds);
  return targetIds.some((id) => !valid.has(id));
}

/**
 * Deterministic repair of an over-long or malformed question (spec §16.15).
 *
 * Strategy: drop a leading acknowledgment clause, keep the final question
 * sentence, then truncate at a clause boundary so the word count fits within
 * `maxWords`. Guarantees exactly one trailing '?'.
 */
export function deterministicRepair(spokenText: string, maxWords?: number): string {
  const limit = maxWords ?? RUNTIME_DEFAULTS.maxQuestionWords;
  const text = normalizeWhitespace(spokenText);
  if (text.length === 0) return '';

  // Strip markup and stage directions before reshaping.
  let working = text.replace(STAGE_DIRECTION_PATTERN, ' ').replace(/[*#`_]/g, ' ');
  working = normalizeWhitespace(working);

  // Keep the final question: split into sentences and prefer the last one that
  // looks like a question. This drops leading acknowledgments such as
  // "Got it." or "That makes sense."
  const sentence = lastQuestionSentence(working) ?? working;

  // Collapse multiple question marks down to the structure of a single ask.
  let candidate = normalizeWhitespace(sentence.replace(/\?/g, ' ').trim());

  // Truncate at a clause boundary so the word count fits the budget.
  candidate = truncateToClause(candidate, limit);

  // Ensure exactly one trailing '?'.
  candidate = candidate.replace(/[?!.\s]+$/, '');
  return candidate.length === 0 ? '' : `${candidate}?`;
}

/**
 * Return the last sentence that ends with '?', or the last sentence overall if
 * none is a question. Sentences split on '.', '!', '?' boundaries.
 */
function lastQuestionSentence(text: string): string | null {
  const matches = text.match(/[^.!?]+[.!?]?/g);
  if (!matches) return null;
  const sentences = matches.map((s) => s.trim()).filter((s) => s.length > 0);
  if (sentences.length === 0) return null;

  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i];
    if (s !== undefined && s.includes('?')) return s;
  }
  return sentences[sentences.length - 1] ?? null;
}

/**
 * Truncate `text` to at most `limit` words, preferring a clause boundary
 * (comma, semicolon, dash) at or before the limit so the result reads cleanly.
 */
function truncateToClause(text: string, limit: number): string {
  const words = normalizeWhitespace(text).split(' ').filter((w) => w.length > 0);
  if (words.length <= limit) return words.join(' ');

  const head = words.slice(0, limit).join(' ');

  // Prefer cutting at the last clause boundary within the budget.
  const boundary = Math.max(
    head.lastIndexOf(','),
    head.lastIndexOf(';'),
    head.lastIndexOf(' - '),
    head.lastIndexOf('—'),
  );
  if (boundary > 0) {
    return normalizeWhitespace(head.slice(0, boundary));
  }
  return normalizeWhitespace(head).replace(/[,;-]+$/, '');
}
