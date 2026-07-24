/**
 * §31.5 recommendations: at most three, from the highest-impact repeated
 * patterns in the take.
 *
 * ---------------------------------------------------------------------------
 * A MODEL MAY CHOOSE THE SENTENCE. IT MAY NEVER SUPPLY A NUMBER.
 * ---------------------------------------------------------------------------
 * §31.5 allows Luna to "help select and phrase" a recommendation while
 * "factual counts and measurements remain local and must be inserted from
 * validated data". That is enforced structurally here, not by prompt
 * discipline:
 *
 * - Copy exists only as authored templates on a locally-built
 *   {@link RecommendationCandidate}. Luna returns *identifiers* — a pattern id
 *   and a variant id — and nothing else is read from its response.
 * - Every `{placeholder}` is filled from that candidate's `facts`, which were
 *   computed by `session-summary.ts` from the recorded take.
 * - A template whose placeholder is missing from `facts` is **dropped**, not
 *   rendered with a hole. Failing closed is the only safe direction: a
 *   recommendation that shows `{fillerCount}` is embarrassing, but one that
 *   silently invents a number is a lie.
 * - Facts are length-limited and character-restricted ({@link isSafeFact}), so
 *   a future producer cannot pipe raw transcript or model text through the
 *   fact channel either.
 *
 * §26.4 also applies: the review may observe that a metric returned to target
 * after a prompt, but never that the prompt caused it. The only copy that can
 * express follow-through is {@link TIP_FOLLOW_THROUGH_TEXT}, which is written
 * to be non-causal and is the sole source of that sentence.
 */
import type { MicrophoneStatus, PaceSample, TakePassRecord } from './types';
import { formatPercent, formatRate, formatWpm } from './cards';
import type { SessionSummary } from './session-summary';

/* ---------------------------------------------------------------------------
 * Facts
 * ------------------------------------------------------------------------- */

/** Longest a substituted fact may be. Mirrors §25.3's bounded interpolations. */
export const MAX_FACT_CHARS = 64;

/**
 * Characters a fact may contain: digits, letters, spaces, and the punctuation
 * the authored formats actually produce. Deliberately excludes `<`, `>`, `{`
 * and `}` so a fact can neither open a tag nor introduce a new placeholder.
 */
const SAFE_FACT = /^[\p{L}\p{N} .,:%–—“”'’()+/-]+$/u;

export function isSafeFact(value: string): boolean {
  return value.length > 0 && value.length <= MAX_FACT_CHARS && SAFE_FACT.test(value);
}

/* ---------------------------------------------------------------------------
 * Candidates
 * ------------------------------------------------------------------------- */

export type RecommendationPatternId =
  | 'MICROPHONE_SUSTAINED_ISSUE'
  | 'CRITICAL_DISCREPANCY'
  | 'PACE_ON_TARGET_WITH_TERMINAL_RUSH'
  | 'PACE_ABOVE_TARGET'
  | 'PACE_BELOW_TARGET'
  | 'FILLER_RATE'
  | 'FILLER_DOMINANT_FORM'
  | 'RUN_ON_CADENCE'
  | 'CHOPPY_CADENCE'
  | 'VARIETY_BELOW_TARGET'
  | 'VARIETY_ABOVE_TARGET';

export interface RecommendationVariant {
  variantId: string;
  /** Authored copy. `{placeholder}` names are resolved against `facts`. */
  template: string;
}

export interface RecommendationCandidate {
  patternId: RecommendationPatternId;
  /** 0–1 local impact. Drives the default ordering; Luna may reorder within it. */
  impact: number;
  /** Validated, pre-formatted local figures. The only source of any number. */
  facts: Readonly<Record<string, string>>;
  /** Authored phrasings. The first is the default when no variant is chosen. */
  variants: readonly RecommendationVariant[];
}

export interface Recommendation {
  patternId: RecommendationPatternId;
  variantId: string;
  /** Authored template with local facts substituted. Never model text. */
  text: string;
  facts: Readonly<Record<string, string>>;
  source: 'local' | 'luna_selected';
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/**
 * Substitute `facts` into an authored template.
 *
 * Returns `null` when the template names a fact that does not exist, or when a
 * fact fails {@link isSafeFact}. Both are producer bugs and both fail closed.
 */
export function renderTemplate(
  template: string,
  facts: Readonly<Record<string, string>>,
): string | null {
  let failed = false;
  const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = facts[name];
    if (value === undefined || !isSafeFact(value)) {
      failed = true;
      return '';
    }
    return value;
  });
  return failed ? null : rendered;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** §12.7 status, as an authored noun phrase. Never derived from a model. */
const MIC_ISSUE_FACT: Record<MicrophoneStatus, string> = {
  low_level: 'a low input level',
  clipping: 'clipping',
  noisy: 'background noise',
  no_signal: 'no signal',
  disconnected: 'a disconnection',
  ok: 'a healthy signal',
  learning: 'calibration',
};

/**
 * §31.5. Derive every candidate the take supports. Each one owns its own
 * numbers; nothing downstream computes another.
 */
export function buildRecommendationCandidates(
  summary: SessionSummary,
): RecommendationCandidate[] {
  const { metrics, microphone, profile } = summary;
  const { pace, fillers, variety, cadence, fidelity } = metrics;
  const candidates: RecommendationCandidate[] = [];

  const worstMicIssue = microphone.sustainedIssues[0];
  if (worstMicIssue !== undefined) {
    candidates.push({
      patternId: 'MICROPHONE_SUSTAINED_ISSUE',
      // A bad microphone degrades every other measurement, so it outranks
      // anything about delivery.
      impact: 1,
      facts: {
        micIssue: MIC_ISSUE_FACT[worstMicIssue.status],
        micIssueSeconds: `${Math.round(worstMicIssue.totalMs / 1000)} seconds`,
      },
      variants: [
        {
          variantId: 'default',
          template:
            'Your microphone showed {micIssue} for {micIssueSeconds} of this take. Fixing that first makes every other measurement more reliable.',
        },
        {
          variantId: 'brief',
          template: 'The microphone showed {micIssue} for {micIssueSeconds}. Worth fixing first.',
        },
      ],
    });
  }

  if (fidelity.criticalDiscrepancyCount > 0) {
    candidates.push({
      patternId: 'CRITICAL_DISCREPANCY',
      impact: 0.95,
      facts: {
        criticalCount: plural(fidelity.criticalDiscrepancyCount, 'critical detail'),
      },
      variants: [
        {
          variantId: 'default',
          template:
            'The take differed from the script on {criticalCount}. They are marked in the script view.',
        },
        {
          variantId: 'brief',
          template: '{criticalCount} came out differently from the script.',
        },
      ],
    });
  }

  const inTarget = pace.insideTargetRatio.value;
  if (inTarget !== null && cadence.terminalRushCount > 0) {
    candidates.push({
      patternId: 'PACE_ON_TARGET_WITH_TERMINAL_RUSH',
      impact: clamp01(cadence.terminalRushCount / 5) * 0.9,
      facts: {
        inTargetPercent: formatPercent(inTarget),
        rushedSentences: plural(cadence.terminalRushCount, 'sentence'),
      },
      variants: [
        {
          variantId: 'default',
          template:
            'Your pace was on target for {inTargetPercent} of the take, but you rushed the ending of {rushedSentences}.',
        },
        {
          variantId: 'ending_first',
          template:
            'You rushed the ending of {rushedSentences}, though your pace sat in the target band for {inTargetPercent} of the take.',
        },
      ],
    });
  } else if (cadence.terminalRushCount > 0) {
    candidates.push({
      patternId: 'PACE_ON_TARGET_WITH_TERMINAL_RUSH',
      impact: clamp01(cadence.terminalRushCount / 5) * 0.7,
      facts: { rushedSentences: plural(cadence.terminalRushCount, 'sentence') },
      variants: [
        {
          variantId: 'no_pace_context',
          template:
            'You rushed the ending of {rushedSentences}. Holding the last few words steady lands the point.',
        },
      ],
    });
  }

  const averageWpm = pace.audibleWpm.value;
  if (averageWpm !== null && (inTarget === null || inTarget < 0.5)) {
    const facts = {
      averageWpm: formatWpm(averageWpm),
      paceTargetLow: String(profile.targetWpmLow),
      paceTargetHigh: String(profile.targetWpmHigh),
    };
    if (averageWpm > profile.targetWpmHigh) {
      candidates.push({
        patternId: 'PACE_ABOVE_TARGET',
        impact: clamp01((averageWpm - profile.targetWpmHigh) / profile.targetWpmHigh) + 0.4,
        facts,
        variants: [
          {
            variantId: 'default',
            template:
              'Your average pace was {averageWpm}, above your {paceTargetLow}–{paceTargetHigh} target band.',
          },
        ],
      });
    } else if (averageWpm < profile.targetWpmLow) {
      candidates.push({
        patternId: 'PACE_BELOW_TARGET',
        impact: clamp01((profile.targetWpmLow - averageWpm) / profile.targetWpmLow) + 0.4,
        facts,
        variants: [
          {
            variantId: 'default',
            template:
              'Your average pace was {averageWpm}, below your {paceTargetLow}–{paceTargetHigh} target band.',
          },
        ],
      });
    }
  }

  const perHundred = fillers.perHundredWords.value;
  if (fillers.confirmedCount > 0 && perHundred !== null) {
    candidates.push({
      patternId: 'FILLER_RATE',
      impact: clamp01(perHundred / 5) * 0.85,
      facts: {
        fillerCount: plural(fillers.confirmedCount, 'filler'),
        fillerRate: formatRate(perHundred),
      },
      variants: [
        {
          variantId: 'default',
          template:
            'You used {fillerCount} in this take — {fillerRate} per 100 words. A silent pause is shorter than it feels.',
        },
        {
          variantId: 'rate_first',
          template: 'Fillers ran at {fillerRate} per 100 words, {fillerCount} in all.',
        },
      ],
    });
  }

  const topForm = fillers.mostFrequent.value;
  // §25.3: only a quotable, fixed-lexicon form may be repeated back, and only
  // when it is a genuine repeated pattern rather than a one-off.
  if (topForm !== null && topForm.displayForm !== null && topForm.count >= 3) {
    candidates.push({
      patternId: 'FILLER_DOMINANT_FORM',
      impact: clamp01(topForm.count / 10) * 0.8,
      facts: {
        fillerForm: topForm.displayForm,
        fillerFormCount: plural(topForm.count, 'time'),
      },
      variants: [
        {
          variantId: 'default',
          template:
            'You used “{fillerForm}” {fillerFormCount}. Try a silent pause where it tends to appear.',
        },
        {
          variantId: 'brief',
          template: '“{fillerForm}” came up {fillerFormCount}. A pause does the same job.',
        },
      ],
    });
  }

  if (cadence.runOnCount > 0) {
    candidates.push({
      patternId: 'RUN_ON_CADENCE',
      impact: clamp01(cadence.runOnCount / 4) * 0.6,
      facts: { runOnEpisodes: plural(cadence.runOnCount, 'stretch', 'stretches') },
      variants: [
        {
          variantId: 'default',
          template:
            'You carried straight through a full stop in {runOnEpisodes}. Letting the boundary land gives the next line room.',
        },
      ],
    });
  }

  if (cadence.choppyPauseCount >= 3) {
    candidates.push({
      patternId: 'CHOPPY_CADENCE',
      impact: clamp01(cadence.choppyPauseCount / 10) * 0.6,
      facts: { choppyPauses: plural(cadence.choppyPauseCount, 'time') },
      variants: [
        {
          variantId: 'default',
          template:
            'The delivery broke mid-clause {choppyPauses}. Reading the sentence through once before the take usually settles it.',
        },
      ],
    });
  }

  const averageVariety = variety.averageLevel.value;
  if (averageVariety !== null) {
    const facts = {
      varietyLevel: String(Math.round(averageVariety)),
      varietyTargetLow: String(profile.targetVarietyLow),
      varietyTargetHigh: String(profile.targetVarietyHigh),
    };
    if (averageVariety < profile.targetVarietyLow) {
      candidates.push({
        patternId: 'VARIETY_BELOW_TARGET',
        impact:
          clamp01((profile.targetVarietyLow - averageVariety) / profile.targetVarietyLow) * 0.7,
        facts,
        variants: [
          {
            variantId: 'default',
            template:
              'Your pitch and energy variation averaged {varietyLevel} against your {varietyTargetLow}–{varietyTargetHigh} band. Mark two or three key phrases for emphasis before the next take.',
          },
        ],
      });
    } else if (averageVariety > profile.targetVarietyHigh) {
      // §2.5: more variety is not automatically better, so this is symmetric.
      candidates.push({
        patternId: 'VARIETY_ABOVE_TARGET',
        impact:
          clamp01((averageVariety - profile.targetVarietyHigh) / (100 - profile.targetVarietyHigh)) *
          0.7,
        facts,
        variants: [
          {
            variantId: 'default',
            template:
              'Your pitch and energy variation averaged {varietyLevel}, above your {varietyTargetLow}–{varietyTargetHigh} band. Settling the delivery may suit this script better.',
          },
        ],
      });
    }
  }

  return candidates;
}


/* ---------------------------------------------------------------------------
 * Selection
 * ------------------------------------------------------------------------- */

/** §31.5: "at most three primary recommendations". */
export const MAX_RECOMMENDATIONS = 3;

function toRecommendation(
  candidate: RecommendationCandidate,
  variantId: string | null,
  source: Recommendation['source'],
): Recommendation | null {
  const variant =
    (variantId === null
      ? undefined
      : candidate.variants.find((entry) => entry.variantId === variantId)) ??
    candidate.variants[0];
  if (variant === undefined) return null;
  const text = renderTemplate(variant.template, candidate.facts);
  if (text === null) return null;
  return {
    patternId: candidate.patternId,
    variantId: variant.variantId,
    text,
    facts: candidate.facts,
    source,
  };
}

/** The local ordering: impact first, then pattern id so ties are deterministic. */
export function selectRecommendations(
  candidates: readonly RecommendationCandidate[],
  max: number = MAX_RECOMMENDATIONS,
): Recommendation[] {
  return [...candidates]
    .sort((a, b) => b.impact - a.impact || a.patternId.localeCompare(b.patternId))
    .map((candidate) => toRecommendation(candidate, null, 'local'))
    .filter((entry): entry is Recommendation => entry !== null)
    .slice(0, max);
}

/* ---------------------------------------------------------------------------
 * Luna selection (§31.5, §23)
 * ------------------------------------------------------------------------- */

export type NarrationRejectionReason =
  | 'malformed_response'
  | 'unknown_pattern'
  | 'unknown_variant'
  | 'duplicate_pattern'
  | 'over_limit'
  | 'template_failed';

export interface NarrationRejection {
  patternId: string | null;
  reason: NarrationRejectionReason;
}

export interface NarrationOutcome {
  recommendations: Recommendation[];
  rejections: NarrationRejection[];
  /** True when the model's selection was unusable and the local order stood. */
  fellBackToLocal: boolean;
}

/**
 * The only shape read out of a Luna review response.
 *
 * There is deliberately no text field. Anything else the model returns —
 * prose, its own counts, a "summary" — is not read, not validated, and cannot
 * reach the presenter, because the renderer only ever sees an authored
 * template and locally computed facts.
 */
interface ParsedSelection {
  patternId: string;
  variantId: string | null;
}

function parseSelections(raw: unknown): ParsedSelection[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const selections = (raw as { selections?: unknown }).selections;
  if (!Array.isArray(selections)) return null;
  const out: ParsedSelection[] = [];
  for (const entry of selections) {
    if (typeof entry !== 'object' || entry === null) continue;
    const patternId = (entry as { pattern_id?: unknown }).pattern_id;
    if (typeof patternId !== 'string') continue;
    const variantId = (entry as { variant_id?: unknown }).variant_id;
    out.push({ patternId, variantId: typeof variantId === 'string' ? variantId : null });
  }
  return out;
}

/**
 * §31.5. Apply a Luna selection over locally-built candidates.
 *
 * Luna may pick which patterns to show, in what order, and which authored
 * phrasing to use. It cannot add a pattern, invent a variant, exceed the cap,
 * or contribute a single character of the rendered text.
 */
export function applyLunaSelection(
  candidates: readonly RecommendationCandidate[],
  raw: unknown,
  max: number = MAX_RECOMMENDATIONS,
): NarrationOutcome {
  const rejections: NarrationRejection[] = [];
  const parsed = parseSelections(raw);
  if (parsed === null) {
    rejections.push({ patternId: null, reason: 'malformed_response' });
    return {
      recommendations: selectRecommendations(candidates, max),
      rejections,
      fellBackToLocal: true,
    };
  }

  const byPattern = new Map(candidates.map((candidate) => [candidate.patternId as string, candidate]));
  const seen = new Set<string>();
  const recommendations: Recommendation[] = [];

  for (const selection of parsed) {
    const candidate = byPattern.get(selection.patternId);
    if (candidate === undefined) {
      rejections.push({ patternId: selection.patternId, reason: 'unknown_pattern' });
      continue;
    }
    if (seen.has(selection.patternId)) {
      rejections.push({ patternId: selection.patternId, reason: 'duplicate_pattern' });
      continue;
    }
    if (recommendations.length >= max) {
      rejections.push({ patternId: selection.patternId, reason: 'over_limit' });
      continue;
    }
    if (
      selection.variantId !== null &&
      !candidate.variants.some((variant) => variant.variantId === selection.variantId)
    ) {
      // A phrasing we did not author is not usable, but the pattern still is —
      // fall back to the default phrasing rather than dropping the finding.
      rejections.push({ patternId: selection.patternId, reason: 'unknown_variant' });
    }
    const built = toRecommendation(candidate, selection.variantId, 'luna_selected');
    if (built === null) {
      rejections.push({ patternId: selection.patternId, reason: 'template_failed' });
      continue;
    }
    seen.add(selection.patternId);
    recommendations.push(built);
  }

  if (recommendations.length === 0) {
    return {
      recommendations: selectRecommendations(candidates, max),
      rejections,
      fellBackToLocal: true,
    };
  }
  return { recommendations, rejections, fellBackToLocal: false };
}

/* ---------------------------------------------------------------------------
 * §26.4 tip follow-through
 * ------------------------------------------------------------------------- */

/**
 * §26.4. The single sentence the review may say about a tip and a metric. It
 * is an observation of sequence, never of cause: "returned to target shortly
 * after the prompt", never "the prompt fixed your delivery".
 */
export const TIP_FOLLOW_THROUGH_TEXT = 'Your pace returned to target shortly after the prompt.';

/** Default observation window after a tip was shown. */
export const TIP_FOLLOW_THROUGH_WINDOW_MS = 30_000;

/** Pace tips are the only ones with a metric this module can check. */
const PACE_TIP_CODES: ReadonlySet<string> = new Set(['PACE_EASE_BACK', 'PACE_LIFT_SLIGHTLY']);

export interface TipFollowThrough {
  tipId: string;
  code: string;
  shownAtMs: number;
  /** True when a measured sample inside the window fell in the target band. */
  returnedToTarget: boolean;
  /** {@link TIP_FOLLOW_THROUGH_TEXT} when observed, `null` otherwise. */
  text: string | null;
}

function samplesInWindow(
  samples: readonly PaceSample[],
  fromMs: number,
  toMs: number,
): PaceSample[] {
  return samples.filter((sample) => sample.endMs > fromMs && sample.startMs < toMs);
}

/**
 * §26.4. For each pace tip shown in a pass, report whether the measured pace
 * came back inside the band within the observation window.
 *
 * This is a sequence observation. It is not evidence the tip worked, the copy
 * does not claim it did, and nothing here scores the tip policy.
 */
export function describeTipFollowThrough(
  pass: TakePassRecord,
  targetLowWpm: number,
  targetHighWpm: number,
  windowMs: number = TIP_FOLLOW_THROUGH_WINDOW_MS,
): TipFollowThrough[] {
  const out: TipFollowThrough[] = [];
  for (const tip of pass.tipsShown) {
    if (!PACE_TIP_CODES.has(tip.code)) continue;
    const window = samplesInWindow(pass.paceSamples, tip.shownAtMs, tip.shownAtMs + windowMs);
    const returnedToTarget = window.some(
      (sample) =>
        sample.audibleWpm !== null &&
        sample.audibleWpm >= targetLowWpm &&
        sample.audibleWpm <= targetHighWpm,
    );
    out.push({
      tipId: tip.tipId,
      code: tip.code,
      shownAtMs: tip.shownAtMs,
      returnedToTarget,
      text: returnedToTarget ? TIP_FOLLOW_THROUGH_TEXT : null,
    });
  }
  return out;
}
