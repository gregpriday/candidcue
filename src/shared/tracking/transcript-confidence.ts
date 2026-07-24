/**
 * Per-token ASR confidence from provider log probabilities (spec §30.5, §60).
 *
 * `requestLogprobs: true` is set on every realtime session, the values are
 * normalized at the transport boundary (`realtime/eventAdapter.ts`) and carried
 * on the `completed` transcript event — so the app is already paying OpenAI for
 * this signal. This module is the last step: turning the provider's *subword*
 * log probabilities into a confidence per *normalized word*, which is the unit
 * every consumer downstream actually holds (`LedgerToken`).
 *
 * Two things make that a real mapping rather than a zip:
 *
 *  - the provider's pieces are not words. `"CandidCue is following my voice."`
 *    comes back as `Candid | Cue | ␣is | ␣following | ␣my | ␣voice | .` — seven
 *    pieces for five words, with the word boundary carried by a LEADING space
 *    and one piece that is pure punctuation and becomes no word at all;
 *  - `normalizeText` is not length-preserving. It expands `%` to ` percent `,
 *    `&` to ` and `, splits hyphenated words, and drops punctuation, so
 *    character offsets into the raw transcript do not survive into the token
 *    list.
 *
 * So the pieces are grouped back into raw whitespace-delimited words first, and
 * each group is normalized on its own. The result is then checked against the
 * authoritative tokenization of the whole item. On ANY disagreement the answer
 * is `undefined` — no confidences at all — because a confidence attached to the
 * wrong word is worse than no confidence: it silently moves a threshold on
 * evidence about some other part of the sentence.
 */
import type { TokenLogprob } from '../contracts/tracking';
import { tokenizeNormalized } from './normalize';

/** A piece that carries lexical content, as opposed to pure punctuation. */
const LEXICAL = /[\p{L}\p{N}]/u;

/**
 * Confidence per normalized token of `text`, or `undefined` when the provider's
 * pieces cannot be reconciled with it.
 *
 * The returned array is always exactly `tokenizeNormalized(text).length` long,
 * so callers can zip it positionally without a second length check.
 */
export function tokenConfidencesFromLogprobs(
  text: string,
  logprobs: readonly TokenLogprob[] | undefined,
): number[] | undefined {
  if (!logprobs || logprobs.length === 0) return undefined;

  // 1. Regroup subword pieces into raw words. A piece opens a new word when it
  //    begins with whitespace; a piece containing interior whitespace closes
  //    one and opens the next. Providers vary on which of those they emit, and
  //    both shapes have to land in the same place.
  const words: Array<{ raw: string; lexical: number[]; all: number[] }> = [];
  let current: { raw: string; lexical: number[]; all: number[] } | null = null;

  for (const piece of logprobs) {
    if (typeof piece.token !== 'string' || !Number.isFinite(piece.logprob)) return undefined;
    const segments = piece.token.split(/\s+/);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] ?? '';
      // Every boundary between segments of this piece is a word break, and a
      // leading empty segment means the piece itself began with whitespace.
      if (i > 0 || segment === '') {
        if (current !== null && current.raw.length > 0) words.push(current);
        current = null;
      }
      if (segment === '') continue;
      if (current === null) current = { raw: '', lexical: [], all: [] };
      current.raw += segment;
      current.all.push(piece.logprob);
      // A trailing `.` or `,` arrives glued to the word it follows, and the
      // model's certainty about *punctuation* is not certainty about the word.
      // Kept in `raw` (it is part of the surface form and must reconstruct) but
      // excluded from the average, so `voice` + `.` is as certain as `voice`.
      if (LEXICAL.test(segment)) current.lexical.push(piece.logprob);
    }
  }
  if (current !== null && current.raw.length > 0) words.push(current);
  if (words.length === 0) return undefined;

  // 2. Normalize each raw word on its own. One raw word may produce no tokens
  //    (bare punctuation) or several (`forty-two`, `50%`).
  const expected = tokenizeNormalized(text);
  const produced: string[] = [];
  const confidences: number[] = [];
  for (const word of words) {
    const tokens = tokenizeNormalized(word.raw);
    if (tokens.length === 0) continue;
    // Geometric mean of the piece probabilities: a two-piece word is not less
    // certain than a one-piece word merely for having been split by the
    // tokenizer, which is what the joint probability `exp(sum)` would say.
    const source = word.lexical.length > 0 ? word.lexical : word.all;
    const meanLogprob = source.reduce((a, b) => a + b, 0) / source.length;
    const confidence = clamp01(Math.exp(meanLogprob));
    for (const token of tokens) {
      produced.push(token);
      confidences.push(confidence);
    }
  }

  // 3. Reconcile. The item's own tokenization is authoritative; if the pieces
  //    do not rebuild it exactly, this transcript is not one we can attribute.
  if (produced.length !== expected.length) return undefined;
  for (let i = 0; i < produced.length; i++) {
    if (produced[i] !== expected[i]) return undefined;
  }
  return confidences;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}
