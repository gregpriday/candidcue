/**
 * §25. The deterministic tip catalog.
 *
 * Luna never writes stage copy. It returns a *code*; this module owns the
 * authored text for every {@link CoachTipCode}, the §25.2–§25.4 cooldowns, the
 * display window, and the priority band each code belongs to.
 *
 * Two safety rules are enforced structurally here:
 *
 * 1. **No model text may be interpolated.** The only substitutions are
 *    `{filler}` — restricted to {@link STRICT_FILLER_ALLOWLIST} (§25.3) — and
 *    `{term}`, which must be authored script text supplied by the local layer
 *    and is escaped and length-limited (§25.5). Anything else falls back to a
 *    copy variant with no substitution at all.
 * 2. **Copy is addressed by key, never by literal.** {@link resolveTipCopy}
 *    returns a `textKey` plus safe interpolations; `text` is included only so
 *    the app has a default English string to register in its catalog. Nothing
 *    downstream ever passes a string through from a response.
 */
import type {
  CoachCandidateType,
  CoachPriorityBand,
  CoachTipCode,
  CoachTipSeverity,
  DeliveryStyle,
} from '../../contracts/coaching';
import { COACH_PRIORITY_BANDS } from '../../contracts/coaching';

/* ---------------------------------------------------------------------------
 * Safe interpolation (§25.3, §25.5)
 * ------------------------------------------------------------------------- */

/**
 * §25.3 / §15. The only forms that may ever be quoted back to the presenter.
 * These are strict vocalized fillers; contextual words ("like", "so", "and")
 * are deliberately absent because §2.4 forbids quoting them as fillers.
 */
export const STRICT_FILLER_ALLOWLIST: readonly string[] = [
  'um',
  'uh',
  'uhm',
  'umm',
  'erm',
  'er',
  'ah',
  'ahh',
  'eh',
  'mm',
  'mmm',
  'hmm',
  'em',
];

const ALLOWLIST_SET = new Set(STRICT_FILLER_ALLOWLIST);

/** Maximum authored term length quoted under §25.5, in characters. */
export const MAX_AUTHORED_TERM_CHARS = 48;

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/gu;
/** Characters that could be read as markup by any renderer downstream. */
const MARKUP_CHARS = /[<>]/gu;

/**
 * §25.3. Returns the allowlisted display form, or `null` when the value is not
 * on the fixed lexicon. A `null` return is what forces the `USE_SILENT_PAUSE`
 * fallback in Appendix A.3 — never a quoted unknown string.
 */
export function safeFillerForm(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .toLowerCase()
    .replace(CONTROL_CHARS, '')
    .replace(/[^\p{L}]/gu, '')
    .trim();
  if (normalized.length === 0) return null;
  return ALLOWLIST_SET.has(normalized) ? normalized : null;
}

/**
 * §25.5. Escape and length-limit authored script text before quoting it.
 * Returns `null` when nothing usable remains, which selects the unquoted copy
 * variant rather than rendering an empty quotation.
 */
export function safeAuthoredTerm(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(CONTROL_CHARS, ' ')
    .replace(MARKUP_CHARS, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length <= MAX_AUTHORED_TERM_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_AUTHORED_TERM_CHARS - 1).trimEnd()}…`;
}

/* ---------------------------------------------------------------------------
 * Definitions
 * ------------------------------------------------------------------------- */

/** Which substitution a copy variant expects. `none` takes no input at all. */
export type TipInterpolationKind = 'none' | 'filler' | 'term';

export interface TipCopyVariant {
  /** Localization key. The stage resolves this, never the literal below. */
  textKey: string;
  /** Default English copy (§25, Appendix A.3). 2–7 words per §9.2. */
  text: string;
  interpolation: TipInterpolationKind;
}

export interface CoachTipDefinition {
  code: CoachTipCode;
  band: CoachPriorityBand;
  severity: CoachTipSeverity;
  /**
   * §26.2 "ordinary tips". System-critical and meaning-critical tips are not
   * ordinary: they bypass the global gap and the per-minute cap and follow
   * their own conservative per-code cooldown (§25.1, §44.3).
   */
  ordinary: boolean;
  primary: TipCopyVariant;
  /** §25.2 style variant, or the unquoted form for critical codes (§25.5). */
  alternate: TipCopyVariant | null;
  /** §25.2–§25.4 minimum cooldown for this exact code, ms. */
  cooldownMs: number;
  /** §26.2 style category; tips sharing a key share the category cooldown. */
  cooldownKey: string;
  minimumDisplayMs: number;
  maximumDisplayMs: number;
  /** §26.1 actionability factor, 0–1. Prospective advice scores higher. */
  actionability: number;
  /** §26.1 persistence factor denominator, ms. `0` means persistence is n/a. */
  requiredPersistenceMs: number;
  /** §23.1 per-code confidence floor for a Luna decision. */
  lunaConfidenceFloor: number;
  /** Local candidate confidence floor before the tip is even considered. */
  localConfidenceFloor: number;
  /** §25.4 / §25.6: some codes ship disabled. */
  enabledByDefault: boolean;
  /** §25.3: "normally Studio mode or review". */
  studioOnly: boolean;
  /**
   * §26.3 exemption. `true` for codes that state a *fact* rather than offer
   * advice — hardware faults (§25.1) and critical fidelity discrepancies
   * (§25.5). They may be shown again with identical copy once their own §25
   * cooldown has elapsed and a new evidence cluster exists, and they are not
   * subject to the per-take showing budget.
   *
   * §26.3's "do not repeat identical copy at the same severity" was written for
   * style coaching, where the second identical nudge is nagging. Applied to a
   * microphone alert it means a presenter is told once that their mic is
   * clipping and then never again for the rest of the take, which is the
   * opposite of what §25.1's fifteen-second cooldown is for.
   */
  repeatsOnCooldown: boolean;
  /**
   * §25.5 / §20.1. `true` when the local layer may *propose* this code but may
   * never display it on its own: only a `luna_validated` proposal is admitted.
   *
   * Exactly one code needs this, and it is the one that was deadlocked between
   * two individually-correct rules. `fidelity/comparator.ts` refuses to produce
   * `material_meaning_change` because materiality is a semantic judgement
   * reserved to Luna (§25.5); the observer refuses any Luna code not permitted
   * by the local candidate types (§23.1). Composed, the code, its
   * `LunaCoachTipCode`, this catalog entry and the
   * `MATERIAL_DIFFERENCE_CONFIRMED` reason code were all unreachable.
   *
   * The resolution is a candidate that asserts "this span was not delivered as
   * written, and that is worth judging" — a purely lexical observation the
   * local layer *can* make honestly — with the materiality verdict left to
   * Luna, and this flag making "left to Luna" structural rather than a
   * convention a future caller could forget.
   */
  requiresLunaValidation: boolean;
  /**
   * `null` when Luna may never select this code — the system codes are local
   * acoustic facts Luna cannot observe (§21 authority boundaries), so they are
   * absent from `LunaCoachTipCode` and rejected if they somehow arrive.
   */
  lunaSelectable: boolean;
}

const SYSTEM_DISPLAY = { minimumDisplayMs: 2_000, maximumDisplayMs: 20_000 } as const;
const ORDINARY_DISPLAY = { minimumDisplayMs: 2_500, maximumDisplayMs: 4_500 } as const;

function systemTip(
  code: CoachTipCode,
  text: string,
  cooldownMs: number,
  overrides: Partial<CoachTipDefinition> = {},
): CoachTipDefinition {
  return {
    code,
    band: 'system_critical',
    severity: 'critical',
    ordinary: false,
    primary: { textKey: `coach.tip.${code}`, text, interpolation: 'none' },
    alternate: null,
    cooldownMs,
    cooldownKey: 'system',
    ...SYSTEM_DISPLAY,
    actionability: 1,
    requiredPersistenceMs: 0,
    lunaConfidenceFloor: 1.01, // unreachable: Luna may not select system codes
    localConfidenceFloor: 0, // local acoustic evidence, not a semantic guess
    enabledByDefault: true,
    studioOnly: false,
    lunaSelectable: false,
    // §25.1: these recur, and the presenter needs to be told each time.
    repeatsOnCooldown: true,
    requiresLunaValidation: false,
    ...overrides,
  };
}

function criticalTip(
  code: CoachTipCode,
  quoted: string,
  plain: string,
  overrides: Partial<CoachTipDefinition> = {},
): CoachTipDefinition {
  return {
    code,
    band: 'fidelity_critical',
    severity: 'critical',
    ordinary: false,
    primary: { textKey: `coach.tip.${code}.quoted`, text: quoted, interpolation: 'term' },
    alternate: { textKey: `coach.tip.${code}.plain`, text: plain, interpolation: 'none' },
    // §44.3: meaning-critical alerts follow their own conservative rules.
    cooldownMs: 20_000,
    cooldownKey: `critical:${code}`,
    minimumDisplayMs: 2_500,
    maximumDisplayMs: 5_000,
    actionability: 1,
    requiredPersistenceMs: 0,
    // §25.5: only after final, highly stable evidence.
    lunaConfidenceFloor: 0.85,
    localConfidenceFloor: 0.7,
    enabledByDefault: true,
    studioOnly: false,
    lunaSelectable: true,
    // §25.5: two different misread numbers are two different facts.
    repeatsOnCooldown: true,
    requiresLunaValidation: false,
    ...overrides,
  };
}

/**
 * The complete authored catalog. Every {@link CoachTipCode} appears exactly
 * once; `Record` makes a missing code a compile error.
 */
export const COACH_TIP_CATALOG: Record<CoachTipCode, CoachTipDefinition> = {
  // ---- §25.1 system and microphone ----------------------------------------
  MIC_CLIPPING: systemTip('MIC_CLIPPING', 'Mic is clipping', 15_000, {
    // "persists until clear for 2 seconds" — the mic analyzer cancels it.
    maximumDisplayMs: 30_000,
  }),
  MIC_LEVEL_LOW: systemTip('MIC_LEVEL_LOW', 'Move a little closer to the mic', 30_000, {
    // §25.1: 4 seconds, then cooldown.
    minimumDisplayMs: 2_500,
    maximumDisplayMs: 4_000,
    severity: 'important',
  }),
  NOISE_HIGH: systemTip('NOISE_HIGH', 'Background noise is rising', 30_000, {
    minimumDisplayMs: 2_500,
    maximumDisplayMs: 4_000,
    severity: 'important',
  }),
  TRANSCRIPTION_DEGRADED: systemTip(
    'TRANSCRIPTION_DEGRADED',
    'Transcription is struggling',
    45_000,
    { severity: 'important' },
  ),
  MIC_DISCONNECTED: systemTip('MIC_DISCONNECTED', 'Microphone disconnected', 10_000, {
    maximumDisplayMs: 60_000,
  }),

  // ---- §25.2 pace ---------------------------------------------------------
  PACE_EASE_BACK: {
    code: 'PACE_EASE_BACK',
    band: 'delivery_pressure',
    severity: 'gentle',
    ordinary: true,
    primary: { textKey: 'coach.tip.PACE_EASE_BACK', text: 'Ease back slightly', interpolation: 'none' },
    alternate: {
      textKey: 'coach.tip.PACE_EASE_BACK.alt',
      text: 'Give the words more room',
      interpolation: 'none',
    },
    cooldownMs: 25_000,
    cooldownKey: 'pace',
    ...ORDINARY_DISPLAY,
    actionability: 1,
    // §21: never a pace tip for one short sentence.
    requiredPersistenceMs: 6_000,
    lunaConfidenceFloor: 0.6,
    localConfidenceFloor: 0.5,
    enabledByDefault: true,
    studioOnly: false,
    repeatsOnCooldown: false,
    requiresLunaValidation: false,
    lunaSelectable: true,
  },
  PACE_LIFT_SLIGHTLY: {
    code: 'PACE_LIFT_SLIGHTLY',
    band: 'delivery_pressure',
    severity: 'gentle',
    ordinary: true,
    primary: {
      textKey: 'coach.tip.PACE_LIFT_SLIGHTLY',
      text: 'Bring the pace up a touch',
      interpolation: 'none',
    },
    alternate: {
      textKey: 'coach.tip.PACE_LIFT_SLIGHTLY.alt',
      text: 'Keep the thought moving',
      interpolation: 'none',
    },
    cooldownMs: 30_000,
    cooldownKey: 'pace',
    ...ORDINARY_DISPLAY,
    actionability: 1,
    requiredPersistenceMs: 6_000,
    lunaConfidenceFloor: 0.6,
    localConfidenceFloor: 0.5,
    enabledByDefault: true,
    studioOnly: false,
    repeatsOnCooldown: false,
    requiresLunaValidation: false,
    lunaSelectable: true,
  },
  TERMINAL_RUSH: {
    code: 'TERMINAL_RUSH',
    band: 'delivery_pressure',
    severity: 'gentle',
    ordinary: true,
    primary: {
      textKey: 'coach.tip.TERMINAL_RUSH',
      text: 'Don’t rush the ending',
      interpolation: 'none',
    },
    alternate: {
      textKey: 'coach.tip.TERMINAL_RUSH.alt',
      text: 'Let the ending land',
      interpolation: 'none',
    },
    cooldownMs: 30_000,
    cooldownKey: 'pace',
    ...ORDINARY_DISPLAY,
    actionability: 1,
    requiredPersistenceMs: 0,
    lunaConfidenceFloor: 0.65,
    localConfidenceFloor: 0.5,
    enabledByDefault: true,
    studioOnly: false,
    repeatsOnCooldown: false,
    requiresLunaValidation: false,
    lunaSelectable: true,
  },

  // ---- §25.3 filler and disfluency ---------------------------------------
  USE_SILENT_PAUSE: {
    code: 'USE_SILENT_PAUSE',
    band: 'delivery_pressure',
    severity: 'gentle',
    ordinary: true,
    primary: {
      textKey: 'coach.tip.USE_SILENT_PAUSE',
      text: 'Use a silent pause',
      interpolation: 'none',
    },
    // §26.3: the second showing must not be the same sentence again. Without a
    // second wording this was a once-per-take tip, which is not what §25.3's
    // thirty-second cooldown describes.
    alternate: {
      textKey: 'coach.tip.USE_SILENT_PAUSE.alt',
      text: 'Let the gap sit',
      interpolation: 'none',
    },
    cooldownMs: 30_000,
    cooldownKey: 'filler',
    ...ORDINARY_DISPLAY,
    actionability: 1,
    requiredPersistenceMs: 0,
    lunaConfidenceFloor: 0.6,
    localConfidenceFloor: 0.5,
    enabledByDefault: true,
    studioOnly: false,
    repeatsOnCooldown: false,
    requiresLunaValidation: false,
    lunaSelectable: true,
  },
  REPEATED_FILLER: {
    code: 'REPEATED_FILLER',
    band: 'delivery_pressure',
    severity: 'gentle',
    ordinary: true,
    primary: {
      textKey: 'coach.tip.REPEATED_FILLER',
      text: 'Pause instead of “{filler}”',
      interpolation: 'filler',
    },
    // A.3: without an allowlisted filler the copy degrades to the generic tip;
    // `resolveTipCopy` switches the CODE, so the variant below is never a
    // *quoted* fallback — it is the §26.3 second wording, which deliberately
    // drops the quotation rather than repeating "Pause instead of “um”" twice.
    alternate: {
      textKey: 'coach.tip.REPEATED_FILLER.alt',
      text: 'Try a pause there instead',
      interpolation: 'none',
    },
    cooldownMs: 30_000,
    cooldownKey: 'filler',
    ...ORDINARY_DISPLAY,
    actionability: 1,
    requiredPersistenceMs: 0,
    lunaConfidenceFloor: 0.7,
    localConfidenceFloor: 0.6,
    enabledByDefault: true,
    studioOnly: false,
    repeatsOnCooldown: false,
    requiresLunaValidation: false,
    lunaSelectable: true,
  },
  REPETITIVE_OPENER: {
    code: 'REPETITIVE_OPENER',
    band: 'style',
    severity: 'gentle',
    ordinary: true,
    primary: {
      textKey: 'coach.tip.REPETITIVE_OPENER',
      text: 'Vary the sentence openings',
      interpolation: 'none',
    },
    alternate: {
      textKey: 'coach.tip.REPETITIVE_OPENER.alt',
      text: 'Try a different opening',
      interpolation: 'none',
    },
    cooldownMs: 45_000,
    cooldownKey: 'style',
    ...ORDINARY_DISPLAY,
    // Retrospective pattern rather than a next-breath adjustment.
    actionability: 0.6,
    requiredPersistenceMs: 0,
    lunaConfidenceFloor: 0.7,
    localConfidenceFloor: 0.6,
    enabledByDefault: true,
    studioOnly: true,
    repeatsOnCooldown: false,
    requiresLunaValidation: false,
    lunaSelectable: true,
  },
  TAKE_SENTENCE_FROM_TOP: {
    code: 'TAKE_SENTENCE_FROM_TOP',
    band: 'progress_blocked',
    severity: 'important',
    ordinary: true,
    primary: {
      textKey: 'coach.tip.TAKE_SENTENCE_FROM_TOP',
      text: 'Take the sentence from the top',
      interpolation: 'none',
    },
    alternate: {
      textKey: 'coach.tip.TAKE_SENTENCE_FROM_TOP.alt',
      text: 'Reset and run the line again',
      interpolation: 'none',
    },
    cooldownMs: 45_000,
    cooldownKey: 'progress',
    ...ORDINARY_DISPLAY,
    actionability: 1,
    requiredPersistenceMs: 0,
    lunaConfidenceFloor: 0.75,
    localConfidenceFloor: 0.6,
    enabledByDefault: true,
    studioOnly: false,
    repeatsOnCooldown: false,
    requiresLunaValidation: false,
    lunaSelectable: true,
  },

  // ---- §25.4 cadence and variety -----------------------------------------
  LET_BOUNDARY_BREATHE: {
    code: 'LET_BOUNDARY_BREATHE',
    band: 'cadence',
    severity: 'gentle',
    ordinary: true,
    primary: {
      textKey: 'coach.tip.LET_BOUNDARY_BREATHE',
      text: 'Let the next full stop breathe',
      interpolation: 'none',
    },
    // Appendix A.3 wording, kept as the style variant.
    alternate: {
      textKey: 'coach.tip.LET_BOUNDARY_BREATHE.alt',
      text: 'Let the sentence land',
      interpolation: 'none',
    },
    cooldownMs: 35_000,
    cooldownKey: 'cadence',
    ...ORDINARY_DISPLAY,
    actionability: 1,
    requiredPersistenceMs: 4_000,
    lunaConfidenceFloor: 0.6,
    localConfidenceFloor: 0.5,
    enabledByDefault: true,
    studioOnly: false,
    repeatsOnCooldown: false,
    requiresLunaValidation: false,
    lunaSelectable: true,
  },
  KEEP_SENTENCE_FLOWING: {
    code: 'KEEP_SENTENCE_FLOWING',
    band: 'cadence',
    severity: 'gentle',
    ordinary: true,
    primary: {
      textKey: 'coach.tip.KEEP_SENTENCE_FLOWING',
      text: 'Keep this sentence flowing',
      interpolation: 'none',
    },
    alternate: {
      textKey: 'coach.tip.KEEP_SENTENCE_FLOWING.alt',
      text: 'Keep the sentence flowing',
      interpolation: 'none',
    },
    cooldownMs: 35_000,
    cooldownKey: 'cadence',
    ...ORDINARY_DISPLAY,
    actionability: 1,
    requiredPersistenceMs: 4_000,
    lunaConfidenceFloor: 0.6,
    localConfidenceFloor: 0.5,
    enabledByDefault: true,
    studioOnly: false,
    repeatsOnCooldown: false,
    requiresLunaValidation: false,
    lunaSelectable: true,
  },
  LIFT_KEY_WORDS: {
    code: 'LIFT_KEY_WORDS',
    band: 'variety',
    severity: 'gentle',
    ordinary: true,
    primary: { textKey: 'coach.tip.LIFT_KEY_WORDS', text: 'Lift the key words', interpolation: 'none' },
    alternate: {
      textKey: 'coach.tip.LIFT_KEY_WORDS.alt',
      text: 'Colour the important words',
      interpolation: 'none',
    },
    cooldownMs: 45_000,
    cooldownKey: 'variety',
    ...ORDINARY_DISPLAY,
    actionability: 1,
    // §17: variety needs a long observation window before it means anything.
    requiredPersistenceMs: 12_000,
    lunaConfidenceFloor: 0.6,
    localConfidenceFloor: 0.5,
    enabledByDefault: true,
    studioOnly: false,
    repeatsOnCooldown: false,
    requiresLunaValidation: false,
    lunaSelectable: true,
  },
  SETTLE_DELIVERY: {
    code: 'SETTLE_DELIVERY',
    band: 'variety',
    severity: 'gentle',
    ordinary: true,
    primary: {
      textKey: 'coach.tip.SETTLE_DELIVERY',
      text: 'Settle the delivery slightly',
      interpolation: 'none',
    },
    alternate: null,
    cooldownMs: 60_000,
    cooldownKey: 'variety',
    ...ORDINARY_DISPLAY,
    actionability: 1,
    requiredPersistenceMs: 12_000,
    lunaConfidenceFloor: 0.7,
    localConfidenceFloor: 0.6,
    // §25.4: disabled by default.
    enabledByDefault: false,
    studioOnly: false,
    repeatsOnCooldown: false,
    requiresLunaValidation: false,
    lunaSelectable: true,
  },

  // ---- §25.5 critical script fidelity ------------------------------------
  CRITICAL_NUMBER: criticalTip('CRITICAL_NUMBER', 'Script says “{term}”', 'Check that number'),
  CRITICAL_NAME: criticalTip('CRITICAL_NAME', 'Name in script: “{term}”', 'Check that name'),
  CRITICAL_UNIT: criticalTip('CRITICAL_UNIT', 'Unit in script: “{term}”', 'Check that unit'),
  CRITICAL_NEGATION: criticalTip(
    'CRITICAL_NEGATION',
    'Script says “{term}”',
    'Check the meaning',
  ),
  /**
   * §25.5. The one code the local layer may propose but never show.
   *
   * `localConfidenceFloor` is low on purpose and is not a weakening: for every
   * other critical code it measures how sure the *comparator* is that a term
   * was misread, which is the thing that authorizes the alert. Here the local
   * claim is only "this was not delivered as written", and it is Luna's
   * `lunaConfidenceFloor` of 0.85 — plus `requiresLunaValidation` — that
   * decides whether anything is shown.
   */
  MATERIAL_MEANING_CHANGE: criticalTip(
    'MATERIAL_MEANING_CHANGE',
    'Script says “{term}”',
    'Check that phrase',
    { localConfidenceFloor: 0.35, requiresLunaValidation: true },
  ),

  // ---- §25.6 positive reinforcement (disabled by default) ----------------
  POSITIVE_PACE: {
    code: 'POSITIVE_PACE',
    band: 'positive',
    severity: 'status',
    ordinary: true,
    primary: { textKey: 'coach.tip.POSITIVE_PACE', text: 'Good pace', interpolation: 'none' },
    alternate: null,
    // §25.6: once per minute.
    cooldownMs: 60_000,
    cooldownKey: 'positive',
    minimumDisplayMs: 2_000,
    maximumDisplayMs: 3_000,
    actionability: 0.4,
    requiredPersistenceMs: 20_000,
    lunaConfidenceFloor: 1.01, // not in LunaCoachTipCode
    localConfidenceFloor: 0.7,
    enabledByDefault: false,
    studioOnly: false,
    repeatsOnCooldown: false,
    requiresLunaValidation: false,
    lunaSelectable: false,
  },
  POSITIVE_FILLER_STREAK: {
    code: 'POSITIVE_FILLER_STREAK',
    band: 'positive',
    severity: 'status',
    ordinary: true,
    primary: {
      textKey: 'coach.tip.POSITIVE_FILLER_STREAK',
      text: 'Clean, unhurried phrasing',
      interpolation: 'none',
    },
    alternate: null,
    cooldownMs: 90_000,
    cooldownKey: 'positive',
    minimumDisplayMs: 2_000,
    maximumDisplayMs: 3_000,
    actionability: 0.4,
    requiredPersistenceMs: 0,
    lunaConfidenceFloor: 1.01,
    localConfidenceFloor: 0.7,
    enabledByDefault: false,
    studioOnly: false,
    repeatsOnCooldown: false,
    requiresLunaValidation: false,
    lunaSelectable: false,
  },
  POSITIVE_VARIETY: {
    code: 'POSITIVE_VARIETY',
    band: 'positive',
    severity: 'status',
    ordinary: true,
    primary: {
      textKey: 'coach.tip.POSITIVE_VARIETY',
      text: 'Nice vocal balance',
      interpolation: 'none',
    },
    alternate: null,
    cooldownMs: 60_000,
    cooldownKey: 'positive',
    minimumDisplayMs: 2_000,
    maximumDisplayMs: 3_000,
    actionability: 0.4,
    requiredPersistenceMs: 20_000,
    lunaConfidenceFloor: 1.01,
    localConfidenceFloor: 0.7,
    enabledByDefault: false,
    studioOnly: false,
    repeatsOnCooldown: false,
    requiresLunaValidation: false,
    lunaSelectable: false,
  },
};

/** Band floor for a code, from the contract's {@link COACH_PRIORITY_BANDS}. */
export function bandFloorFor(code: CoachTipCode): number {
  return COACH_PRIORITY_BANDS[COACH_TIP_CATALOG[code].band];
}

/* ---------------------------------------------------------------------------
 * Candidate type ⇄ tip code (§23.1 "not allowed by local candidate types")
 * ------------------------------------------------------------------------- */

/**
 * §24 → §25. The single mapping from what the local analyzers may propose to
 * what may be shown. A code with no candidate type behind it is unreachable,
 * which is exactly how the response validator rejects a Luna code the local
 * layer never offered evidence for.
 *
 * The mapping is now *onto* {@link CoachTipCode}: every authored code has a
 * candidate type behind it. `MIC_DISCONNECTED` and `POSITIVE_VARIETY`
 * previously had none, which meant §25.1's critical persistent alert and
 * §25.6's variety copy were authored, catalogued, priced into a priority band
 * — and unreachable. Routing around authored copy is not a fix; the missing
 * candidate types were added to §24's set instead.
 */
export const CANDIDATE_TIP_CODE: Record<CoachCandidateType, CoachTipCode> = {
  system_mic_clipping: 'MIC_CLIPPING',
  system_mic_low: 'MIC_LEVEL_LOW',
  system_noise_high: 'NOISE_HIGH',
  system_transcription_degraded: 'TRANSCRIPTION_DEGRADED',
  system_mic_disconnected: 'MIC_DISCONNECTED',
  critical_number_mismatch: 'CRITICAL_NUMBER',
  critical_name_mismatch: 'CRITICAL_NAME',
  critical_unit_mismatch: 'CRITICAL_UNIT',
  critical_negation_mismatch: 'CRITICAL_NEGATION',
  material_meaning_change: 'MATERIAL_MEANING_CHANGE',
  pace_too_fast: 'PACE_EASE_BACK',
  pace_too_slow: 'PACE_LIFT_SLIGHTLY',
  terminal_rush: 'TERMINAL_RUSH',
  filler_cluster: 'USE_SILENT_PAUSE',
  repeated_filler: 'REPEATED_FILLER',
  contextual_filler: 'USE_SILENT_PAUSE',
  run_on_delivery: 'LET_BOUNDARY_BREATHE',
  choppy_delivery: 'KEEP_SENTENCE_FLOWING',
  low_variety: 'LIFT_KEY_WORDS',
  high_variety: 'SETTLE_DELIVERY',
  repetitive_opener: 'REPETITIVE_OPENER',
  repeated_stumble: 'TAKE_SENTENCE_FROM_TOP',
  positive_pace: 'POSITIVE_PACE',
  positive_filler_streak: 'POSITIVE_FILLER_STREAK',
  positive_variety: 'POSITIVE_VARIETY',
};

/**
 * §23.1. The codes a set of local candidates makes admissible. A Luna decision
 * naming anything outside this set is rejected — the model may classify local
 * evidence, never introduce an issue of its own (§20.1).
 *
 * `REPEATED_FILLER` additionally admits `USE_SILENT_PAUSE`, because A.3 allows
 * the generic tip whenever the quoted form is unsafe.
 */
export function permittedCodesFor(types: readonly CoachCandidateType[]): Set<CoachTipCode> {
  const permitted = new Set<CoachTipCode>();
  for (const type of types) {
    const code = CANDIDATE_TIP_CODE[type];
    if (code === undefined) continue;
    permitted.add(code);
    if (code === 'REPEATED_FILLER') permitted.add('USE_SILENT_PAUSE');
  }
  return permitted;
}

/* ---------------------------------------------------------------------------
 * Copy resolution
 * ------------------------------------------------------------------------- */

/** §25.2: variants are selected by style profile, never generated. */
const ALTERNATE_COPY_STYLES: readonly DeliveryStyle[] = ['calm', 'broadcast'];

export interface TipCopyInput {
  /** Raw filler form from the local detector; validated against the allowlist. */
  filler?: string | null;
  /** Authored script text from the local layer; escaped and length-limited. */
  authoredTerm?: string | null;
  deliveryStyle?: DeliveryStyle;
}

export interface ResolvedTipCopy {
  /** May differ from the requested code when the quoted form was unsafe. */
  code: CoachTipCode;
  textKey: string;
  interpolations: Record<string, string>;
}

/**
 * Resolve the authored copy for a code. **The only values that can end up in
 * `interpolations` are an allowlisted filler or escaped authored script text.**
 * Every other path returns an empty record.
 */
export function resolveTipCopy(code: CoachTipCode, input: TipCopyInput = {}): ResolvedTipCopy {
  const definition = COACH_TIP_CATALOG[code];

  if (definition.primary.interpolation === 'filler') {
    const filler = safeFillerForm(input.filler);
    if (filler === null) {
      // A.3: "Otherwise use `Use a silent pause`". Never quote an unknown form.
      return resolveTipCopy('USE_SILENT_PAUSE', { ...input, filler: null });
    }
    return { code, textKey: definition.primary.textKey, interpolations: { filler } };
  }

  if (definition.primary.interpolation === 'term') {
    const term = safeAuthoredTerm(input.authoredTerm);
    if (term === null) {
      const plain = definition.alternate;
      // Every `term` code authors a plain variant; the fallback is a hard
      // requirement, not an optional nicety.
      if (plain === null) throw new Error(`tip ${code} has no unquoted variant`);
      return { code, textKey: plain.textKey, interpolations: {} };
    }
    return { code, textKey: definition.primary.textKey, interpolations: { term } };
  }

  const useAlternate =
    definition.alternate !== null &&
    input.deliveryStyle !== undefined &&
    ALTERNATE_COPY_STYLES.includes(input.deliveryStyle);
  const variant = useAlternate && definition.alternate !== null ? definition.alternate : definition.primary;
  return { code, textKey: variant.textKey, interpolations: {} };
}

/**
 * §26.3. The differently worded second showing. Returns `null` when the code
 * has no second wording, which means the pattern stays in telemetry and the
 * post-take report only.
 */
export function escalatedTipCopy(code: CoachTipCode): ResolvedTipCopy | null {
  const definition = COACH_TIP_CATALOG[code];
  if (definition.alternate === null) return null;
  if (definition.alternate.interpolation !== 'none') return null;
  return { code, textKey: definition.alternate.textKey, interpolations: {} };
}

/**
 * Default English copy for a resolved key, with substitutions applied. The app
 * uses its own localized catalog; this exists so tests and the default locale
 * share one source of truth.
 */
export function renderTipText(resolved: ResolvedTipCopy): string {
  const definition = COACH_TIP_CATALOG[resolved.code];
  const variant =
    definition.alternate !== null && definition.alternate.textKey === resolved.textKey
      ? definition.alternate
      : definition.primary;
  let text = variant.text;
  for (const [name, value] of Object.entries(resolved.interpolations)) {
    text = text.replace(`{${name}}`, value);
  }
  return text;
}
