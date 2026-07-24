/**
 * Unit lexicon for the critical-term comparator (§19.2, §25.5 `CRITICAL_UNIT`).
 *
 * Two rules keep this honest:
 *
 * 1. **Every unit belongs to a dimension, and a unit mismatch is only ever
 *    reported within one dimension.** "milliseconds" read as "seconds" is a
 *    real, material error. "milliseconds" read as "kilograms" is not a unit
 *    error, it is a collapse of the alignment — and reporting it as a unit
 *    error would be a confident lie about what went wrong.
 * 2. **Ambiguous abbreviations are excluded, not guessed.** A bare `m` is
 *    metres, minutes, or millions depending on context we do not have; `s` is
 *    seconds or a plural. Anything whose expansion is genuinely ambiguous is
 *    simply not a unit here, which means the comparator stays silent about it.
 *    That is the correct outcome, not a gap.
 *
 * Magnitude words (`thousand`, `million`, `billion`) are intentionally *not*
 * units: they are folded into the numeric value by `numbers.ts`, so
 * "fifty million" read as "fifty billion" surfaces as a number mismatch with
 * the real values attached rather than as a vaguer unit mismatch.
 */

export type UnitDimension =
  | 'proportion'
  | 'currency'
  | 'time'
  | 'length'
  | 'mass'
  | 'data'
  | 'frequency'
  | 'power'
  | 'temperature'
  | 'angle';

export interface UnitDefinition {
  /** Canonical identity. Two surfaces with the same id are the same unit. */
  id: string;
  dimension: UnitDimension;
  /** Every accepted spoken/authored surface, normalized. */
  surfaces: readonly string[];
}

const DEFINITIONS: readonly UnitDefinition[] = [
  { id: 'percent', dimension: 'proportion', surfaces: ['percent', 'percents', 'pct'] },
  {
    id: 'percentage_point',
    dimension: 'proportion',
    surfaces: ['percentage point', 'percentage points'],
  },
  { id: 'basis_point', dimension: 'proportion', surfaces: ['basis point', 'basis points', 'bps'] },

  { id: 'dollar', dimension: 'currency', surfaces: ['dollar', 'dollars', 'usd'] },
  { id: 'euro', dimension: 'currency', surfaces: ['euro', 'euros', 'eur'] },
  { id: 'pound_sterling', dimension: 'currency', surfaces: ['sterling', 'gbp'] },
  { id: 'yen', dimension: 'currency', surfaces: ['yen', 'jpy'] },
  { id: 'cent', dimension: 'currency', surfaces: ['cent', 'cents'] },

  {
    id: 'millisecond',
    dimension: 'time',
    surfaces: ['millisecond', 'milliseconds', 'ms', 'msec', 'msecs'],
  },
  {
    id: 'microsecond',
    dimension: 'time',
    surfaces: ['microsecond', 'microseconds'],
  },
  { id: 'second', dimension: 'time', surfaces: ['second', 'seconds', 'sec', 'secs'] },
  { id: 'minute', dimension: 'time', surfaces: ['minute', 'minutes', 'mins'] },
  { id: 'hour', dimension: 'time', surfaces: ['hour', 'hours', 'hr', 'hrs'] },
  { id: 'day', dimension: 'time', surfaces: ['day', 'days'] },
  { id: 'week', dimension: 'time', surfaces: ['week', 'weeks'] },
  { id: 'month', dimension: 'time', surfaces: ['month', 'months'] },
  { id: 'quarter', dimension: 'time', surfaces: ['quarter', 'quarters'] },
  { id: 'year', dimension: 'time', surfaces: ['year', 'years', 'yr', 'yrs'] },
  { id: 'decade', dimension: 'time', surfaces: ['decade', 'decades'] },

  { id: 'millimetre', dimension: 'length', surfaces: ['millimeter', 'millimeters', 'millimetre', 'millimetres', 'mm'] },
  { id: 'centimetre', dimension: 'length', surfaces: ['centimeter', 'centimeters', 'centimetre', 'centimetres', 'cm'] },
  { id: 'metre', dimension: 'length', surfaces: ['meter', 'meters', 'metre', 'metres'] },
  { id: 'kilometre', dimension: 'length', surfaces: ['kilometer', 'kilometers', 'kilometre', 'kilometres', 'km'] },
  { id: 'inch', dimension: 'length', surfaces: ['inch', 'inches'] },
  { id: 'foot', dimension: 'length', surfaces: ['foot', 'feet', 'ft'] },
  { id: 'yard', dimension: 'length', surfaces: ['yard', 'yards'] },
  { id: 'mile', dimension: 'length', surfaces: ['mile', 'miles'] },

  { id: 'milligram', dimension: 'mass', surfaces: ['milligram', 'milligrams', 'mg'] },
  { id: 'gram', dimension: 'mass', surfaces: ['gram', 'grams'] },
  { id: 'kilogram', dimension: 'mass', surfaces: ['kilogram', 'kilograms', 'kg', 'kilo', 'kilos'] },
  { id: 'ounce', dimension: 'mass', surfaces: ['ounce', 'ounces', 'oz'] },
  { id: 'tonne', dimension: 'mass', surfaces: ['tonne', 'tonnes', 'ton', 'tons'] },

  { id: 'byte', dimension: 'data', surfaces: ['byte', 'bytes'] },
  { id: 'kilobyte', dimension: 'data', surfaces: ['kilobyte', 'kilobytes', 'kb'] },
  { id: 'megabyte', dimension: 'data', surfaces: ['megabyte', 'megabytes', 'mb'] },
  { id: 'gigabyte', dimension: 'data', surfaces: ['gigabyte', 'gigabytes', 'gb'] },
  { id: 'terabyte', dimension: 'data', surfaces: ['terabyte', 'terabytes', 'tb'] },

  { id: 'hertz', dimension: 'frequency', surfaces: ['hertz', 'hz'] },
  { id: 'kilohertz', dimension: 'frequency', surfaces: ['kilohertz', 'khz'] },
  { id: 'megahertz', dimension: 'frequency', surfaces: ['megahertz', 'mhz'] },
  { id: 'gigahertz', dimension: 'frequency', surfaces: ['gigahertz', 'ghz'] },

  { id: 'watt', dimension: 'power', surfaces: ['watt', 'watts'] },
  { id: 'kilowatt', dimension: 'power', surfaces: ['kilowatt', 'kilowatts', 'kw'] },
  { id: 'megawatt', dimension: 'power', surfaces: ['megawatt', 'megawatts', 'mw'] },

  { id: 'celsius', dimension: 'temperature', surfaces: ['celsius', 'centigrade'] },
  { id: 'fahrenheit', dimension: 'temperature', surfaces: ['fahrenheit'] },
  { id: 'kelvin', dimension: 'temperature', surfaces: ['kelvin', 'kelvins'] },

  { id: 'degree', dimension: 'angle', surfaces: ['degree', 'degrees'] },
];

/**
 * Surfaces that look like units but are excluded because their expansion is
 * ambiguous without context we do not have. Documented rather than silently
 * absent, so a future contributor does not "helpfully" add them back.
 */
export const AMBIGUOUS_UNIT_SURFACES: readonly string[] = [
  'm', // metres / minutes / millions
  's', // seconds / plural marker
  'g', // grams / gigabytes / gravity
  'b', // bytes / bits / billions
  'k', // thousands / kilometres
  'min', // minutes / minimum
  'max', // maximum, never a unit
  'pound', // mass or sterling
  'pounds',
  'lb', // written mass, spoken "pounds" — same ambiguity
  'lbs',
  'st', // stone / street / saint
  'point', // decimal marker, not a unit
];

/** Longest surface phrase in the lexicon, in words. */
const MAX_UNIT_WORDS = 2;

const BY_SURFACE = new Map<string, UnitDefinition>();
for (const definition of DEFINITIONS) {
  for (const surface of definition.surfaces) {
    BY_SURFACE.set(surface, definition);
  }
}

/** Look up a unit by a single normalized surface word or two-word phrase. */
export function unitBySurface(surface: string): UnitDefinition | undefined {
  return BY_SURFACE.get(surface);
}

export interface UnitOccurrence {
  definition: UnitDefinition;
  start: number;
  length: number;
}

/**
 * Find the unit beginning at `start`, preferring the longest phrase
 * ("percentage points" before "points"), or `undefined`.
 */
export function unitAt(words: readonly string[], start: number): UnitOccurrence | undefined {
  for (let length = MAX_UNIT_WORDS; length >= 1; length--) {
    if (start + length > words.length) continue;
    const phrase = words.slice(start, start + length).join(' ');
    const definition = BY_SURFACE.get(phrase);
    if (definition !== undefined) return { definition, start, length };
  }
  return undefined;
}

/** Every unit occurrence in a word array, left to right, non-overlapping. */
export function findUnits(words: readonly string[]): UnitOccurrence[] {
  const out: UnitOccurrence[] = [];
  let index = 0;
  while (index < words.length) {
    const occurrence = unitAt(words, index);
    if (occurrence === undefined) {
      index += 1;
      continue;
    }
    out.push(occurrence);
    index += occurrence.length;
  }
  return out;
}

/** All accepted surfaces for a unit id, as space-joined phrases. */
export function unitVariants(id: string): string[] {
  const definition = DEFINITIONS.find((candidate) => candidate.id === id);
  return definition === undefined ? [] : [...definition.surfaces];
}
