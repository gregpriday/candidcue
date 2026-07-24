/**
 * Live coaching engine (companion §43–§46, Appendix A.5, Appendix B.7).
 *
 * Coaching is subordinate to reading. Two hard rules shape this module:
 *
 * * **No model-generated copy ever reaches the stage.** Luna returns a tip
 *   *code*; this module maps it to fixed authored copy from
 *   {@link TIP_CATALOGUE}, optionally interpolating one safely escaped script
 *   token supplied by the local engine (§39.1, §89).
 * * **At most one tip is visible.** A new tip replaces a visible one only for
 *   a strictly higher-priority safety/fidelity issue; tips never stack (§44.3).
 */
import type { SmoothFollowProfile } from '../contracts/smooth-follow';
import type { AnyTipCode, CoachTip, CoachTipCandidate, CoachTipCategory } from './types';

/** Companion §45. Fidelity mode changes thresholds, not navigation. */
export type FidelityMode = 'conversational' | 'balanced' | 'exact';

interface TipDefinition {
  category: CoachTipCategory;
  /** 1 = most urgent … 6 = least (companion §46). */
  priority: number;
  /** Fixed authored copy. `{token}` is the only interpolation point. */
  template: string;
  /** Whether this tip may appear on the stage at all (§43.1 motion status). */
  stageEligible: boolean;
  /** §44.3 minimum display time, 1.5–2.5 s by length. */
  displayMs: number;
}

/**
 * The complete authored tip catalogue. Copy follows §44.4: short, factual,
 * never judgmental, never a confidence number or a transcript diff.
 */
export const TIP_CATALOGUE: Record<AnyTipCode, TipDefinition> = {
  // 1 — microphone failure that threatens the session.
  microphone_clipping: {
    category: 'delivery',
    priority: 1,
    template: 'Microphone is clipping',
    stageEligible: true,
    displayMs: 2_500,
  },
  microphone_no_signal: {
    category: 'delivery',
    priority: 1,
    template: 'No microphone signal',
    stageEligible: true,
    displayMs: 2_500,
  },
  // 2 — critical number or negation change.
  number_changed: {
    category: 'fidelity',
    priority: 2,
    template: 'Number changed: “{token}”',
    stageEligible: true,
    displayMs: 2_200,
  },
  critical_word_changed: {
    category: 'fidelity',
    priority: 2,
    template: 'You may have skipped “{token}”',
    stageEligible: true,
    displayMs: 2_200,
  },
  // 3 — important proper noun change.
  name_changed: {
    category: 'fidelity',
    priority: 3,
    template: 'Name sounded different: “{token}”',
    stageEligible: true,
    displayMs: 2_200,
  },
  // 4 — meaningful omission.
  meaningful_omission: {
    category: 'fidelity',
    priority: 4,
    template: 'A clause may have been skipped',
    stageEligible: true,
    displayMs: 2_000,
  },
  restart_detected: {
    category: 'fidelity',
    priority: 4,
    template: 'Previous sentence restarted',
    stageEligible: true,
    displayMs: 1_800,
  },
  // 5 — pace guidance.
  pace_too_fast: {
    category: 'delivery',
    priority: 5,
    template: 'Pace is running fast',
    stageEligible: true,
    displayMs: 1_800,
  },
  pace_too_slow: {
    category: 'delivery',
    priority: 5,
    template: 'Pace is running slow',
    stageEligible: true,
    displayMs: 1_800,
  },
  // 6 — low-value status. §43.1: control UI only; the stage never narrates.
  slowing_to_keep_place: {
    category: 'status',
    priority: 6,
    template: 'Slowing to keep your place',
    stageEligible: false,
    displayMs: 1_600,
  },
  finding_your_place: {
    category: 'status',
    priority: 6,
    template: 'Finding your place…',
    stageEligible: false,
    displayMs: 1_600,
  },
  moved_back: {
    category: 'status',
    priority: 6,
    template: 'Back to the previous sentence',
    stageEligible: false,
    displayMs: 1_600,
  },
};

/**
 * §45. Confidence multipliers and category filters per fidelity mode. Exact is
 * stricter about *reporting*, never about navigation.
 */
interface FidelityPolicy {
  confidenceScale: number;
  /** Fidelity codes this mode is allowed to report at all. */
  allowedFidelityCodes: readonly AnyTipCode[];
}

const CRITICAL_ONLY: readonly AnyTipCode[] = ['number_changed', 'critical_word_changed', 'name_changed'];

export const FIDELITY_POLICY: Record<FidelityMode, FidelityPolicy> = {
  // §45.1: numbers, negations, names and large meaning changes only.
  conversational: { confidenceScale: 1.1, allowedFidelityCodes: CRITICAL_ONLY },
  // §45.2: plus meaningful omitted clauses and restarts.
  balanced: {
    confidenceScale: 1.0,
    allowedFidelityCodes: [...CRITICAL_ONLY, 'meaningful_omission', 'restart_detected'],
  },
  // §45.3: same catalogue, lower reporting bar — still suppresses low confidence.
  exact: {
    confidenceScale: 0.85,
    allowedFidelityCodes: [...CRITICAL_ONLY, 'meaningful_omission', 'restart_detected'],
  },
};

export interface CoachEngineDeps {
  profile: SmoothFollowProfile;
  now: () => number;
  coachingEnabled: boolean;
  /** §44.3: stage coaching may be off while control coaching stays on. */
  stageCoachingEnabled: boolean;
  fidelityMode?: FidelityMode;
  /** Current semantic epoch; a tip from an older epoch is dropped (§46). */
  currentEpoch: () => number;
  /** §44.3: no stage tip while a re-anchor or command ack is on screen. */
  stageBusy?: () => boolean;
  onPublishControl?: (tip: CoachTip) => void;
  onPublishStage?: (tip: CoachTip | null) => void;
  /** §44.3: dedupe window for the same code+span. */
  duplicateWindowMs?: number;
}

export type TipRejection =
  | 'coaching_disabled'
  | 'unknown_code'
  | 'provisional_evidence'
  | 'stale_epoch'
  | 'below_confidence_threshold'
  | 'suppressed_by_fidelity_mode'
  | 'duplicate'
  | 'cooldown'
  | 'stage_busy'
  | 'lower_priority_than_visible';

export type TipOutcome =
  | { published: true; tip: CoachTip; stage: boolean }
  | { published: false; reason: TipRejection };

const DEFAULT_DUPLICATE_WINDOW_MS = 20_000;

/** Interpolate the single allowed token, escaped for display. */
export function renderTipText(code: AnyTipCode, token?: string): string {
  const definition = TIP_CATALOGUE[code];
  if (!definition.template.includes('{token}')) return definition.template;
  const safe = sanitizeToken(token ?? '');
  if (safe.length === 0) {
    // Never render an empty quotation; fall back to the untokenized phrasing.
    return definition.template.replace(/[:：]?\s*“\{token\}”/u, '').trim();
  }
  return definition.template.replace('{token}', safe);
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/gu;

/** Local script tokens only; strips control characters and hard-caps length. */
export function sanitizeToken(token: string): string {
  const stripped = token.replace(CONTROL_CHARS, '').trim();
  return stripped.length <= 48 ? stripped : `${stripped.slice(0, 47)}\u2026`;
}

/**
 * Appendix B.7 `maybePublishTip`, with the §46 arbitration rules made explicit
 * so each rejection is individually testable.
 */
export class CoachEngine {
  private visible: CoachTip | null = null;
  private lastStagePublishMs: number | null = null;
  private lastControlPublishMs: number | null = null;
  private readonly recent: Array<{ key: string; atMs: number }> = [];
  private counter = 0;

  constructor(private readonly deps: CoachEngineDeps) {}

  getVisibleTip(): CoachTip | null {
    return this.visible;
  }

  /** Expire the visible tip once its display window has elapsed (§44.3). */
  tick(): CoachTip | null {
    if (this.visible === null) return null;
    if (this.deps.now() >= this.visible.expiresAtMs) {
      this.visible = null;
      this.deps.onPublishStage?.(null);
    }
    return this.visible;
  }

  /** Drop everything on an epoch change or session reset (§46 expiry). */
  reset(): void {
    this.visible = null;
    this.recent.length = 0;
    this.lastStagePublishMs = null;
    this.lastControlPublishMs = null;
    this.deps.onPublishStage?.(null);
  }

  consider(candidate: CoachTipCandidate): TipOutcome {
    const deps = this.deps;
    if (!deps.coachingEnabled) return reject('coaching_disabled');

    const definition = TIP_CATALOGUE[candidate.code];
    if (definition === undefined) return reject('unknown_code');

    // A.5 / §44.3: a provisional-only observation can never produce a tip.
    if (!candidate.finalEvidence) return reject('provisional_evidence');
    if (candidate.semanticEpoch !== deps.currentEpoch()) return reject('stale_epoch');

    const fidelity = FIDELITY_POLICY[deps.fidelityMode ?? 'balanced'];
    if (
      definition.category === 'fidelity' &&
      !fidelity.allowedFidelityCodes.includes(candidate.code)
    ) {
      return reject('suppressed_by_fidelity_mode');
    }

    const threshold = this.thresholdFor(candidate.code, fidelity.confidenceScale);
    if (!(candidate.confidence >= threshold)) return reject('below_confidence_threshold');

    const now = deps.now();
    const key = `${candidate.code}:${candidate.spanId ?? ''}:${candidate.semanticEpoch}`;
    const window = deps.duplicateWindowMs ?? DEFAULT_DUPLICATE_WINDOW_MS;
    this.pruneRecent(now, window);
    if (this.recent.some((entry) => entry.key === key)) return reject('duplicate');

    const stageEligible = definition.stageEligible && deps.stageCoachingEnabled;

    // §46: replace a visible tip only for a strictly higher priority issue.
    if (this.visible !== null && now < this.visible.expiresAtMs) {
      if (definition.priority >= TIP_CATALOGUE[this.visible.code].priority) {
        return reject('lower_priority_than_visible');
      }
    }

    // §44.3 cooldown: maximum one new stage tip per stage cooldown window.
    const controlCooldown = deps.profile.coaching.controlCooldownMs;
    if (
      this.lastControlPublishMs !== null &&
      now - this.lastControlPublishMs < controlCooldown &&
      definition.priority > 1
    ) {
      return reject('cooldown');
    }

    let stage = stageEligible;
    if (stage) {
      if (deps.stageBusy?.() === true) {
        stage = false; // still worth publishing to control (§43.1)
      } else if (
        this.lastStagePublishMs !== null &&
        now - this.lastStagePublishMs < deps.profile.coaching.stageCooldownMs &&
        definition.priority > 1
      ) {
        stage = false;
      }
    }
    this.counter += 1;
    const tip: CoachTip = {
      id: `tip_${this.counter}`,
      code: candidate.code,
      category: definition.category,
      priority: definition.priority,
      text: renderTipText(candidate.code, candidate.token),
      confidence: candidate.confidence,
      semanticEpoch: candidate.semanticEpoch,
      transcriptRevision: candidate.transcriptRevision,
      spanId: candidate.spanId,
      publishedAtMs: now,
      expiresAtMs: now + definition.displayMs,
      displayMs: definition.displayMs,
      disposition: stage ? 'stage_eligible' : 'control_only',
    };

    this.recent.push({ key, atMs: now });
    this.lastControlPublishMs = now;
    deps.onPublishControl?.(tip);
    if (stage) {
      this.visible = tip;
      this.lastStagePublishMs = now;
      deps.onPublishStage?.(tip);
    }
    return { published: true, tip, stage };
  }

  /**
   * §44.3 / §89: critical number and negation tips require high confidence.
   * `profile.coaching.minimumConfidence` is the floor; safety tips are local
   * and deterministic, so they bypass the semantic threshold.
   */
  private thresholdFor(code: AnyTipCode, scale: number): number {
    const definition = TIP_CATALOGUE[code];
    const base = this.deps.profile.coaching.minimumConfidence;
    if (definition.priority === 1) return 0; // local mic evidence, not semantic
    const byPriority = definition.priority === 2 ? base + 0.05 : base;
    return Math.min(0.99, Math.max(0, byPriority * scale));
  }

  private pruneRecent(now: number, windowMs: number): void {
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const entry = this.recent[i];
      if (entry !== undefined && now - entry.atMs > windowMs) this.recent.splice(i, 1);
    }
  }
}

function reject(reason: TipRejection): TipOutcome {
  return { published: false, reason };
}
