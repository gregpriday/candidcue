/**
 * Number reading and number *variant generation* (§19.2 "numbers, dates,
 * units"; §25.5).
 *
 * Two directions, and both are needed:
 *
 * 1. **Parsing** — turn a run of words into a value, so `fifteen hundred` and
 *    `1,500` are the same number. Used on the spoken side to answer "did the
 *    presenter say a *different* number here?".
 * 2. **Variant generation** — turn an authored value back into every
 *    reasonable spoken rendering (`2026` → `twenty twenty six`,
 *    `two thousand twenty six`, `two zero two six`, …). Used to answer "did the
 *    presenter say *this* number, however they chose to word it?".
 *
 * Variant generation exists because parsing alone produces false positives.
 * `twenty twenty six` parses as the two runs 20 and 26 — neither equals 2026 —
 * and a comparator relying on parsing alone would interrupt a presenter who
 * read the year perfectly. Every match path here exists to make the comparator
 * *quieter*, never louder: a value is declared a mismatch only after literal
 * variant containment, parsed-value equality, and digit concatenation have all
 * failed.
 */

const SMALL: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};

const TENS: Readonly<Record<string, number>> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

/**
 * `second` is deliberately absent. It is the one English ordinal that is also
 * a unit of time, and letting it act as a number turns a transcript's
 * "twenty second" (a mangled "twenty seconds") into the value 22 — a fabricated
 * number mismatch against an authored `20`. Authored `2nd` still matches a
 * spoken "second" because variant generation emits the word from the
 * cardinal→ordinal table below; only the *parsing* direction is restricted.
 */
const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  first: 1, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40,
  fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90,
  hundredth: 100, thousandth: 1000,
};

const SCALES: Readonly<Record<string, number>> = {
  hundred: 100,
  thousand: 1_000,
  million: 1_000_000,
  billion: 1_000_000_000,
  trillion: 1_000_000_000_000,
};

const ONES_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen',
] as const;

const TENS_WORDS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty',
  'ninety',
] as const;

const ORDINAL_OF_CARDINAL: Readonly<Record<string, string>> = {
  one: 'first', two: 'second', three: 'third', four: 'fourth', five: 'fifth',
  six: 'sixth', seven: 'seventh', eight: 'eighth', nine: 'ninth',
  ten: 'tenth', eleven: 'eleventh', twelve: 'twelfth',
  thirteen: 'thirteenth', fourteen: 'fourteenth', fifteen: 'fifteenth',
  sixteen: 'sixteenth', seventeen: 'seventeenth', eighteen: 'eighteenth',
  nineteen: 'nineteenth', twenty: 'twentieth', thirty: 'thirtieth',
  forty: 'fortieth', fifty: 'fiftieth', sixty: 'sixtieth',
  seventy: 'seventieth', eighty: 'eightieth', ninety: 'ninetieth',
  hundred: 'hundredth', thousand: 'thousandth', million: 'millionth',
};

const DIGITS = /^\d+$/;
const DECIMAL_DIGITS = /^\d+\.\d+$/;
const ORDINAL_DIGITS = /^(\d+)(?:st|nd|rd|th)$/;

/** One parsed number occupying `[start, start + length)` in a word array. */
export interface NumberRun {
  value: number;
  start: number;
  length: number;
  /** True when the surface form was ordinal (`3rd`, `third`). */
  ordinal: boolean;
}

/**
 * Value of a single word taken on its own, or `undefined`.
 *
 * Scale words (`hundred`, `million`) deliberately return `undefined` here:
 * standing alone they are a multiplier with no operand, and treating a bare
 * `million` as the value 1 000 000 would let "a million things" masquerade as
 * a numeric reading.
 */
function singleWordValue(word: string): { value: number; ordinal: boolean } | undefined {
  if (DIGITS.test(word)) return { value: Number.parseInt(word, 10), ordinal: false };
  if (DECIMAL_DIGITS.test(word)) return { value: Number.parseFloat(word), ordinal: false };
  const ordinalDigits = ORDINAL_DIGITS.exec(word);
  if (ordinalDigits?.[1] !== undefined) {
    return { value: Number.parseInt(ordinalDigits[1], 10), ordinal: true };
  }
  const small = SMALL[word];
  if (small !== undefined) return { value: small, ordinal: false };
  const tens = TENS[word];
  if (tens !== undefined) return { value: tens, ordinal: false };
  const ordinal = ORDINAL_WORDS[word];
  if (ordinal !== undefined) return { value: ordinal, ordinal: true };
  return undefined;
}

/**
 * Lowest decimal place occupied by `value` — 1 for 26, 10 for 20, 100 for 1900.
 *
 * This is what stops `twenty twenty six` collapsing into 46. A new component
 * may only be added to the accumulator when it is *smaller* than the
 * accumulator's lowest place, which is exactly the rule English numbers obey
 * ("one hundred fifty" ✓, "twenty twenty" ✗).
 */
function lowestPlace(value: number): number {
  if (!Number.isInteger(value) || value <= 0) return 1;
  let place = 1;
  while (value % (place * 10) === 0 && place * 10 <= value) place *= 10;
  return place;
}

/** True when the word could continue a number run to its left or right. */
export function extendsNumberRun(word: string): boolean {
  if (singleWordValue(word) !== undefined) return true;
  return SCALES[word] !== undefined || word === 'point';
}

/** True when the word can begin a number run. */
export function startsNumberRun(word: string): boolean {
  return singleWordValue(word) !== undefined;
}

/**
 * Parse the longest number starting at `start`, or `undefined` when the word
 * there does not begin one.
 */
export function parseNumberAt(words: readonly string[], start: number): NumberRun | undefined {
  const first = words[start];
  if (first === undefined) return undefined;
  const firstValue = singleWordValue(first);
  if (firstValue === undefined) return undefined;

  let total = 0;
  let current = firstValue.value;
  let ordinal = firstValue.ordinal;
  let index = start + 1;
  // A standalone zero never combines: "two zero two six" is a digit string,
  // not the number two. "zero point five" is the one exception.
  const zeroLead = current === 0;

  while (index < words.length) {
    const word = words[index];
    if (word === undefined) break;
    if (zeroLead && word !== 'point') break;

    const scale = SCALES[word];
    if (scale !== undefined) {
      if (scale === 100) {
        if (current === 0) break;
        current *= 100;
      } else {
        total += (current === 0 ? 1 : current) * scale;
        current = 0;
      }
      index += 1;
      continue;
    }

    if (word === 'and') {
      // "two thousand and twenty six" — only bridge when a number follows.
      const next = words[index + 1];
      if (next === undefined || singleWordValue(next) === undefined) break;
      if (total === 0 && current === 0) break;
      index += 1;
      continue;
    }

    if (word === 'point') {
      const fraction = readDecimalTail(words, index + 1);
      if (fraction === undefined) break;
      current = total + current + fraction.value;
      total = 0;
      index = index + 1 + fraction.length;
      break;
    }

    const component = singleWordValue(word);
    if (component === undefined) break;
    if (component.value === 0) break;
    if (current === 0) {
      current = component.value;
      ordinal = component.ordinal;
      index += 1;
      continue;
    }
    if (component.value >= lowestPlace(current)) break;
    current += component.value;
    ordinal = component.ordinal;
    index += 1;
  }

  return { value: total + current, start, length: index - start, ordinal };
}

/** Read `one four` after `point` into 0.14. */
function readDecimalTail(
  words: readonly string[],
  start: number,
): { value: number; length: number } | undefined {
  let digits = '';
  let index = start;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) break;
    if (DIGITS.test(word)) {
      digits += word;
      index += 1;
      continue;
    }
    const small = SMALL[word];
    if (small !== undefined && small < 10) {
      digits += String(small);
      index += 1;
      continue;
    }
    if (word === 'oh' || word === 'o') {
      digits += '0';
      index += 1;
      continue;
    }
    break;
  }
  if (digits.length === 0) return undefined;
  return { value: Number.parseFloat(`0.${digits}`), length: index - start };
}

/** Every number run in a word array, left to right, non-overlapping. */
export function findNumberRuns(words: readonly string[]): NumberRun[] {
  const runs: NumberRun[] = [];
  let index = 0;
  while (index < words.length) {
    const run = parseNumberAt(words, index);
    if (run === undefined || run.length === 0) {
      index += 1;
      continue;
    }
    runs.push(run);
    index += run.length;
  }
  return runs;
}

/**
 * Digit strings formed by concatenating *adjacent* number runs.
 *
 * This is the third and last safety net before a mismatch is declared. It
 * catches digit-by-digit readings the accumulator refuses to merge —
 * `two zero two six` → `2026`, `nineteen eighty four` → `1984` — which are
 * perfectly ordinary ways to read a year aloud.
 */
export function concatenatedDigitStrings(words: readonly string[]): Set<string> {
  const out = new Set<string>();
  const runs = findNumberRuns(words);
  for (let i = 0; i < runs.length; i++) {
    let digits = '';
    for (let j = i; j < runs.length; j++) {
      const run = runs[j];
      const previous = runs[j - 1];
      if (run === undefined) break;
      if (j > i && previous !== undefined && previous.start + previous.length !== run.start) break;
      if (!Number.isInteger(run.value)) break;
      digits += String(run.value);
      if (j > i) out.add(digits);
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Variant generation
 * ------------------------------------------------------------------------- */

/** English words for a non-negative integer, no "and". */
export function integerToWords(value: number): string {
  if (!Number.isInteger(value) || value < 0) return '';
  if (value < 20) return ONES_WORDS[value] ?? '';
  if (value < 100) {
    const tens = TENS_WORDS[Math.floor(value / 10)] ?? '';
    const rest = value % 10;
    return rest === 0 ? tens : `${tens} ${ONES_WORDS[rest]}`;
  }
  if (value < 1000) {
    const head = `${ONES_WORDS[Math.floor(value / 100)]} hundred`;
    const rest = value % 100;
    return rest === 0 ? head : `${head} ${integerToWords(rest)}`;
  }
  const scales: Array<[number, string]> = [
    [1_000_000_000_000, 'trillion'],
    [1_000_000_000, 'billion'],
    [1_000_000, 'million'],
    [1_000, 'thousand'],
  ];
  for (const [scale, name] of scales) {
    if (value >= scale) {
      const head = `${integerToWords(Math.floor(value / scale))} ${name}`;
      const rest = value % scale;
      return rest === 0 ? head : `${head} ${integerToWords(rest)}`;
    }
  }
  return String(value);
}

/**
 * Wordings that insert the British "and" before the trailing chunk —
 * "one hundred and fifty", "one thousand and five hundred". Both the
 * sub-hundred and the sub-thousand split are produced because speakers use
 * both.
 */
function integerToWordsWithAnd(value: number): string[] {
  if (!Number.isInteger(value) || value < 100) return [];
  const out: string[] = [];
  for (const modulus of [100, 1000]) {
    if (value < modulus) continue;
    const rest = value % modulus;
    if (rest === 0) continue;
    const headWords = integerToWords(value - rest);
    if (headWords.length === 0) continue;
    out.push(`${headWords} and ${integerToWords(rest)}`);
  }
  return out;
}

/** Ordinal wording for a value: 21 → "twenty first". */
function integerToOrdinalWords(value: number): string {
  const cardinal = integerToWords(value);
  if (cardinal.length === 0) return '';
  const parts = cardinal.split(' ');
  const last = parts[parts.length - 1];
  if (last === undefined) return '';
  const ordinal = ORDINAL_OF_CARDINAL[last];
  if (ordinal === undefined) return '';
  parts[parts.length - 1] = ordinal;
  return parts.join(' ');
}

function digitByDigit(value: number, zeroWord: 'zero' | 'oh'): string {
  return String(value)
    .split('')
    .map((digit) => (digit === '0' ? zeroWord : ONES_WORDS[Number(digit)] ?? digit))
    .join(' ');
}

export interface NumberVariantOptions {
  /** True when the authored form was ordinal, so ordinal wordings are added. */
  ordinal?: boolean;
  /**
   * The authored words exactly as normalized. Always accepted as a variant —
   * whatever else this module fails to imagine, reading the script verbatim is
   * by definition correct.
   */
  literalWords?: readonly string[];
}

/**
 * Every reasonable spoken rendering of `value`, as space-joined normalized
 * word strings.
 *
 * Over-generating here is cheap and safe: an extra variant can only ever cause
 * the comparator to stay silent. Under-generating is what produces a false
 * alarm, so anything plausible is included.
 */
export function numberVariants(value: number, options: NumberVariantOptions = {}): string[] {
  const variants = new Set<string>();
  const add = (variant: string): void => {
    const trimmed = variant.trim().replace(/\s+/g, ' ');
    if (trimmed.length > 0) variants.add(trimmed);
  };

  if (options.literalWords !== undefined && options.literalWords.length > 0) {
    add(options.literalWords.join(' '));
  }
  if (!Number.isFinite(value)) return [...variants];

  if (!Number.isInteger(value)) {
    add(String(value));
    const [intPart = '0', fracPart = ''] = String(value).split('.');
    const intWords = integerToWords(Number.parseInt(intPart, 10));
    const fracWords = fracPart
      .split('')
      .map((digit) => (digit === '0' ? 'zero' : ONES_WORDS[Number(digit)] ?? digit))
      .join(' ');
    if (intWords.length > 0 && fracWords.length > 0) {
      add(`${intWords} point ${fracWords}`);
      add(`${intPart} point ${fracWords}`);
    }
    // A half is spoken as a half at least as often as "point five".
    if (Math.abs(value - Math.floor(value) - 0.5) < 1e-9) {
      const whole = Math.floor(value);
      add(`${integerToWords(whole)} and a half`);
      if (whole === 0) add('a half');
    }
    // No scale expansion here on purpose. A scale word in the script
    // ("1.5 million") is folded into the value by the parser before this is
    // called, so a decimal that reaches this branch is a bare decimal —
    // inventing "fifteen hundred thousand" for an authored "1.5" would let a
    // genuinely wrong reading pass as correct.
    return [...variants];
  }

  if (value < 0) {
    for (const positive of numberVariants(-value)) {
      add(`minus ${positive}`);
      add(`negative ${positive}`);
    }
    return [...variants];
  }

  add(String(value));
  add(integerToWords(value));
  for (const withAnd of integerToWordsWithAnd(value)) add(withAnd);

  if (options.ordinal === true) {
    add(integerToOrdinalWords(value));
    add(`${value}${ordinalSuffix(value)}`);
  }

  if (value === 100) add('a hundred');
  if (value === 1000) add('a thousand');
  if (value === 1_000_000) add('a million');
  if (value === 1_000_000_000) add('a billion');

  // "fifteen hundred" for 1500, "twenty three hundred" for 2300.
  if (value >= 1000 && value < 10_000 && value % 100 === 0) {
    add(`${integerToWords(value / 100)} hundred`);
  }
  // Year pairs: 2026 → "twenty twenty six", 2006 → "twenty oh six".
  if (value >= 1000 && value <= 9999 && value % 100 !== 0) {
    const high = Math.floor(value / 100);
    const low = value % 100;
    add(`${integerToWords(high)} ${integerToWords(low)}`);
    if (low < 10) {
      add(`${integerToWords(high)} oh ${integerToWords(low)}`);
      add(`${integerToWords(high)} o ${integerToWords(low)}`);
    }
  }
  // Digit strings: phone numbers, codes, and years read out digit by digit.
  const digitCount = String(value).length;
  if (digitCount >= 2 && digitCount <= 8) {
    add(digitByDigit(value, 'zero'));
    if (String(value).includes('0')) add(digitByDigit(value, 'oh'));
  }
  // Scaled forms: 1 500 000 → "one point five million".
  for (const [scale, name] of SCALE_NAMES) {
    if (value < scale || value % (scale / 1000) !== 0) continue;
    const quotient = value / scale;
    if (Number.isInteger(quotient)) {
      add(`${integerToWords(quotient)} ${name}`);
      add(`${quotient} ${name}`);
    } else if (Number.isInteger(quotient * 100)) {
      const text = String(quotient);
      const [intPart = '0', fracPart = ''] = text.split('.');
      const fracWords = fracPart
        .split('')
        .map((digit) => (digit === '0' ? 'zero' : ONES_WORDS[Number(digit)] ?? digit))
        .join(' ');
      add(`${integerToWords(Number.parseInt(intPart, 10))} point ${fracWords} ${name}`);
      add(`${text} ${name}`);
      if (Math.abs(quotient - Math.floor(quotient) - 0.5) < 1e-9) {
        add(`${integerToWords(Math.floor(quotient))} and a half ${name}`);
      }
    }
  }

  return [...variants];
}

const SCALE_NAMES: ReadonlyArray<[number, string]> = [
  [1_000_000_000_000, 'trillion'],
  [1_000_000_000, 'billion'],
  [1_000_000, 'million'],
  [1_000, 'thousand'],
];

function ordinalSuffix(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  switch (value % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}
