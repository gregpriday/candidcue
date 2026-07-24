/**
 * Phonetic tolerance for proper nouns (§25.5: "avoid an alert if a phonetic
 * spelling likely represents the correct name").
 *
 * A speech-to-text model handed an unfamiliar surname does not fail cleanly —
 * it produces a plausible-sounding spelling, often split across several words
 * ("Ndlovu" → "and love oo"). Comparing surfaces would flag every one of those
 * as a substituted name, which is the single easiest way to make this feature
 * hated: the presenter said the name correctly and the rail says they didn't.
 *
 * So the match is computed over *sound*, over *multi-word windows*, and with a
 * deliberately generous threshold. The asymmetry is the point: it is cheap to
 * miss a real substitution and expensive to invent one.
 */
import { editDistance, phoneticKey } from '../../tracking/normalize';

/**
 * A deliberately *coarse* consonant skeleton, used only for names.
 *
 * The alignment phonetic key in `tracking/normalize.ts` is tuned for anchoring
 * ordinary words and keeps distinctions this comparator must not care about.
 * It reduces "Siobhan" to `sbn` and "Shevaun" to `xfn` — a 0.33 similarity for
 * two spellings of the same name, which is squarely in fabricated-alert
 * territory.
 *
 * So names get their own reduction, which merges the consonant confusions that
 * actually occur between an author's spelling and a transcriber's guess:
 * sibilants (s/z/c/j/sh/ch-as-s), labials (b/p/v/f/w — this is what rescues
 * Irish `bh`), dentals (d/t/th), velars (k/g/q/ck), nasals (m/n) and liquids
 * (l/r). Vowels and `h` are dropped entirely.
 *
 * The cost of the coarseness is real and accepted: "Johnson" and "Jackson"
 * reduce close enough to be treated as the same name, so that substitution
 * goes unreported. A missed substitution is a quiet gap; a fabricated one
 * interrupts a take.
 */
export function looseNameKey(word: string): string {
  let text = word.toLowerCase().replace(/[^a-z]/g, '');
  if (text.length === 0) return '';
  text = text
    .replace(/^(kn|gn|pn|ps)/, 'n')
    .replace(/^wr/, 'r')
    .replace(/ough/g, 'o')
    .replace(/tion/g, 'sn')
    .replace(/ph/g, 'f')
    .replace(/gh/g, '')
    .replace(/th/g, 't')
    .replace(/sh/g, 's')
    .replace(/ch/g, 'k')
    .replace(/ck/g, 'k')
    .replace(/dg/g, 'j')
    .replace(/qu/g, 'k')
    .replace(/bh/g, 'v')
    .replace(/mh/g, 'v')
    .replace(/x/g, 'ks');

  let out = '';
  for (let index = 0; index < text.length; index++) {
    const letter = text.charAt(index);
    const next = text.charAt(index + 1);
    let code = '';
    switch (letter) {
      case 's': case 'z': case 'j': code = 'S'; break;
      case 'c': code = 'eiy'.includes(next) ? 'S' : 'K'; break;
      case 'g': code = 'eiy'.includes(next) ? 'S' : 'K'; break;
      case 'b': case 'p': case 'v': case 'f': case 'w': code = 'P'; break;
      case 'd': case 't': code = 'T'; break;
      case 'k': case 'q': code = 'K'; break;
      case 'm': case 'n': code = 'N'; break;
      case 'l': case 'r': code = 'L'; break;
      default: code = '';
    }
    if (code.length > 0 && !out.endsWith(code)) out += code;
  }
  return out;
}

/** Longest spoken window, in words, considered as one rendering of a name. */
const MAX_RENDERING_WORDS = 4;

/**
 * Similarity at or above which a spoken window counts as the authored name.
 *
 * Calibrated toward silence. 0.55 accepts renderings that share most of their
 * consonant skeleton with the authored name and rejects ones that share
 * roughly half or less.
 */
export const NAME_MATCH_THRESHOLD = 0.55;

/**
 * Similarity below which a *mismatch* may be reported. The gap between this
 * and {@link NAME_MATCH_THRESHOLD} is an explicit no-man's-land: renderings
 * that are neither clearly the name nor clearly something else produce no
 * candidate at all, because we genuinely do not know.
 */
export const NAME_MISMATCH_THRESHOLD = 0.35;

export interface NameRendering {
  /** Best similarity found in the window, 0–1. */
  similarity: number;
  /** Word index in the window where the best rendering starts, or -1. */
  start: number;
  /** Length in words of the best rendering, or 0. */
  length: number;
}

function lettersOf(words: readonly string[]): string {
  return words.join('').toLowerCase().replace(/[^a-z]/g, '');
}

function similarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  const span = Math.max(a.length, b.length);
  const distance = editDistance(a, b, span);
  return Math.max(0, 1 - distance / span);
}

/**
 * Best rendering of `nameWords` found anywhere in `windowWords`.
 *
 * Similarity is the **best** of three views — raw letters, the alignment
 * phonetic key, and the coarse name key — because a transcriber may land close
 * on any one of them and miss on the others. Taking the maximum is what makes
 * this forgiving; taking an average would reintroduce exactly the false alarms
 * the coarse key exists to prevent.
 */
export function findNameRendering(
  nameWords: readonly string[],
  windowWords: readonly string[],
): NameRendering {
  const targetLetters = lettersOf(nameWords);
  const targetKey = phoneticKey(targetLetters);
  const targetLoose = looseNameKey(targetLetters);
  let best: NameRendering = { similarity: 0, start: -1, length: 0 };
  if (targetLetters.length === 0 || windowWords.length === 0) return best;

  const maxLength = Math.min(MAX_RENDERING_WORDS, Math.max(nameWords.length + 2, 2));
  for (let start = 0; start < windowWords.length; start++) {
    for (let length = 1; length <= maxLength && start + length <= windowWords.length; length++) {
      const sliceLetters = lettersOf(windowWords.slice(start, start + length));
      if (sliceLetters.length === 0) continue;
      const score = Math.max(
        similarity(targetLetters, sliceLetters),
        similarity(targetKey, phoneticKey(sliceLetters)),
        similarity(targetLoose, looseNameKey(sliceLetters)),
      );
      if (score > best.similarity) best = { similarity: score, start, length };
    }
  }
  return best;
}

/**
 * Shortest authored name for which a *mismatch* may be claimed.
 *
 * Below this the coarse key collapses to one or two symbols and unrelated
 * short names collide constantly in both directions, so neither a match nor a
 * mismatch means anything.
 */
export const MIN_MISMATCH_NAME_LETTERS = 5;

/** True when the authored name is long enough for a mismatch to be claimed. */
export function nameIsLongEnoughToJudge(nameWords: readonly string[]): boolean {
  const letters = lettersOf(nameWords);
  return letters.length >= MIN_MISMATCH_NAME_LETTERS && looseNameKey(letters).length >= 3;
}

/** True when the window plausibly contains the authored name. */
export function nameIsPresent(
  nameWords: readonly string[],
  windowWords: readonly string[],
): boolean {
  return findNameRendering(nameWords, windowWords).similarity >= NAME_MATCH_THRESHOLD;
}
