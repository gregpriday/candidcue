/**
 * The filler lexicon (§15.1–§15.3, §15.6).
 *
 * Three separate vocabularies, kept separate on purpose (§2.4):
 *
 * 1. **Strict vocalized** (§15.1) — the fixed allowlist. This is the *only*
 *    vocabulary whose members may ever be quoted back to the presenter
 *    (`FillerEvent.displayForm`, §25.3), so it is a hand-written closed set,
 *    not a heuristic and not user-extensible. A user's custom phrase is
 *    countable but never quotable.
 * 2. **Contextual** (§15.2) — candidate discourse markers. Membership here
 *    means "may be a filler in some contexts", never "is a filler". The
 *    classifier decides.
 * 3. **Openers** (§15.3) — sentence/clause openers tracked as a *session
 *    pattern*. `and`, `but` and `now` appear only here: they are not in the
 *    contextual vocabulary at all, so no code path can turn a single "and"
 *    into a filler event. That is §2.4 enforced structurally rather than by
 *    threshold.
 */

/** A strict vocalized filler and the exact text safe to show the presenter. */
export interface StrictFillerEntry {
  /** Canonical normalized form used for counting and cooldowns. */
  form: string;
  /** Normalized spellings that map onto this form. */
  variants: readonly string[];
  /** The only string ever rendered for this form (§25.3). */
  displayForm: string;
  /**
   * False for `hmm` / `mm` / `ah`, which §15.1 qualifies as fillers only when
   * used to hold the floor or hesitate. These require hesitation evidence
   * before they may be confirmed; `um` / `uh` / `er` / `erm` do not.
   */
  unconditional: boolean;
}

const STRICT_ENTRIES: readonly StrictFillerEntry[] = [
  { form: 'um', variants: ['um', 'umm', 'ummm', 'uhm', 'uhmm'], displayForm: 'um', unconditional: true },
  { form: 'uh', variants: ['uh', 'uhh', 'uhhh'], displayForm: 'uh', unconditional: true },
  { form: 'er', variants: ['er', 'err', 'errr'], displayForm: 'er', unconditional: true },
  { form: 'erm', variants: ['erm', 'ermm'], displayForm: 'erm', unconditional: true },
  { form: 'hmm', variants: ['hmm', 'hmmm', 'hm'], displayForm: 'hmm', unconditional: false },
  { form: 'mm', variants: ['mm', 'mmm'], displayForm: 'mm', unconditional: false },
  { form: 'ah', variants: ['ah', 'ahh', 'ahhh'], displayForm: 'ah', unconditional: false },
];

/** §15.2. Candidate contextual fillers; every one of these needs context. */
const CONTEXTUAL_PHRASES: readonly string[] = [
  'you know',
  'i mean',
  'kind of',
  'sort of',
  'like',
  'basically',
  'actually',
  'literally',
  'right',
  'okay',
  'well',
  'so',
];

/**
 * §15.3. Sentence/clause openers. Overlaps with the contextual list on
 * purpose: `so` can be both a hesitation insert and a repetitive opener, and
 * they are different findings with different thresholds and different bands.
 */
const OPENER_FORMS: readonly string[] = ['and', 'so', 'but', 'basically', 'now', 'okay', 'right'];

export interface FillerLexiconOptions {
  /** §15.6. Extra countable phrases. Never quotable — see `displayFormFor`. */
  additionalContextualPhrases?: readonly string[];
  /** §15.6. Built-in contextual forms the user switched off. */
  disabledContextualForms?: readonly string[];
  /** §15.6. Words the user declared part of their style; never counted. */
  intentionalStyleWords?: readonly string[];
  /** §15.6. Strict-only detection: contextual and opener layers are inert. */
  strictOnly?: boolean;
  /** §15.6. Whether repeated openers are tracked at all. Default true. */
  countRepeatedOpeners?: boolean;
}

export interface StrictMatch {
  entry: StrictFillerEntry;
}

export interface ContextualMatch {
  /** Canonical multi-word form, e.g. `you know`. */
  form: string;
  /** Number of tokens consumed. */
  length: number;
  /** True for a user-supplied phrase (§15.6): countable, never quotable. */
  custom: boolean;
}

export class FillerLexicon {
  private readonly strictByVariant = new Map<string, StrictFillerEntry>();
  private readonly contextual: Array<{ tokens: string[]; form: string; custom: boolean }> = [];
  private readonly openers: Set<string>;
  private readonly styleWords: Set<string>;
  readonly strictOnly: boolean;
  readonly countRepeatedOpeners: boolean;

  constructor(options: FillerLexiconOptions = {}) {
    for (const entry of STRICT_ENTRIES) {
      for (const variant of entry.variants) this.strictByVariant.set(variant, entry);
    }

    const disabled = new Set((options.disabledContextualForms ?? []).map((form) => form.toLowerCase()));
    this.styleWords = new Set((options.intentionalStyleWords ?? []).map((word) => word.toLowerCase()));
    this.strictOnly = options.strictOnly === true;
    this.countRepeatedOpeners = options.countRepeatedOpeners !== false;

    for (const phrase of CONTEXTUAL_PHRASES) {
      if (disabled.has(phrase)) continue;
      this.contextual.push({ tokens: phrase.split(' '), form: phrase, custom: false });
    }
    for (const phrase of options.additionalContextualPhrases ?? []) {
      const form = phrase.trim().toLowerCase();
      if (form.length === 0 || disabled.has(form)) continue;
      this.contextual.push({ tokens: form.split(/\s+/), form, custom: true });
    }
    // Longest first so `kind of` wins over a hypothetical `kind`.
    this.contextual.sort((a, b) => b.tokens.length - a.tokens.length);

    this.openers = new Set(OPENER_FORMS);
  }

  /** §15.1. A strict vocalized filler, or `null`. */
  matchStrict(normalizedToken: string): StrictFillerEntry | null {
    if (this.styleWords.has(normalizedToken)) return null;
    return this.strictByVariant.get(normalizedToken) ?? null;
  }

  /** §15.2. Longest contextual phrase starting at `index`, or `null`. */
  matchContextualAt(tokens: readonly string[], index: number): ContextualMatch | null {
    if (this.strictOnly) return null;
    for (const phrase of this.contextual) {
      if (index + phrase.tokens.length > tokens.length) continue;
      let matched = true;
      for (let i = 0; i < phrase.tokens.length; i++) {
        if (tokens[index + i] !== phrase.tokens[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      if (this.styleWords.has(phrase.form)) return null;
      return { form: phrase.form, length: phrase.tokens.length, custom: phrase.custom };
    }
    return null;
  }

  /** §15.3. True when the token is tracked as a sentence opener. */
  isOpener(normalizedToken: string): boolean {
    if (this.strictOnly || !this.countRepeatedOpeners) return false;
    if (this.styleWords.has(normalizedToken)) return false;
    return this.openers.has(normalizedToken);
  }

  /** §15.6. A form the user declared part of their style; never counted. */
  isStyleWord(form: string): boolean {
    return this.styleWords.has(form);
  }

  /**
   * §25.3. The text safe to interpolate into `Pause instead of "{filler}"`.
   *
   * Returns `null` for everything that is not a built-in strict form —
   * including user-added phrases and every contextual marker — because the
   * quoting rule is about a *fixed allowlist*, not about provenance.
   */
  displayFormFor(normalizedForm: string): string | null {
    return this.strictByVariant.get(normalizedForm)?.displayForm ?? null;
  }

  /** All strict canonical forms. Used by review aggregation and tests. */
  strictForms(): readonly string[] {
    return STRICT_ENTRIES.map((entry) => entry.form);
  }
}

export function createFillerLexicon(options: FillerLexiconOptions = {}): FillerLexicon {
  return new FillerLexicon(options);
}
