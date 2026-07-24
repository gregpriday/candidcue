/**
 * §26.2 cooldowns and §26.3 repetition escalation.
 *
 * Every method takes the current **audio-clock** time as a parameter (Rule 3 in
 * the contract): this module never reads a wall clock, so a virtual clock in a
 * test is the same clock the product uses, not a stand-in for it.
 *
 * The ledger answers one question — "may this code be shown right now, and if
 * not, exactly which rule blocked it" — and records what was actually shown. It
 * makes no scoring or ordering decisions; that is {@link ../tip-policy}.
 */
import type { CoachRailMode, CoachTipCode } from '../../contracts/coaching';
import { COACH_TIP_CATALOG, type CoachTipDefinition } from './tip-catalog';

/** Each value names one §26.2 rule. Tests assert the exact value. */
export type CooldownRejection =
  | 'ordinary_gap'
  | 'per_minute_cap'
  | 'code_cooldown'
  | 'category_cooldown'
  | 'command_jump_window'
  | 'retake_reversal_window'
  | 'critical_notice_window'
  | 'repetition_escalation_gap'
  | 'repetition_exhausted'
  | 'positive_gap';

/** §26.2 suppression windows opened by an event elsewhere in the app. */
export type SuppressionEvent = 'command_jump' | 'retake_reversal' | 'critical_discrepancy';

export interface CooldownConfig {
  /** §26.2: minimum ms between ordinary tips. */
  ordinaryGapMs: number;
  /** §26.2: ordinary tips per rolling minute, Coach mode. */
  maxOrdinaryPerMinuteCoach: number;
  /** §26.2: ordinary tips per rolling minute, Studio high-frequency mode. */
  maxOrdinaryPerMinuteStudio: number;
  /** §26.2: minimum ms between tips sharing a style category (25–60 s band). */
  sameCategoryGapMs: number;
  /** §26.2: ms of silence after a command jump. */
  afterCommandJumpMs: number;
  /** §26.2: ms of silence after a committed retake reversal. */
  afterRetakeReversalMs: number;
  /** §26.2: ms of silence after a critical discrepancy. */
  afterCriticalDiscrepancyMs: number;
  /** §25.6: positive reinforcement gap, ms. */
  positiveGapMs: number;
  /** §26.3: multiplier applied to a code's own cooldown for a second showing. */
  repetitionEscalationFactor: number;
  /** §26.3: how many times one code may ever be shown in a take. */
  maxShowingsPerCode: number;
  /** Rolling window the per-minute cap is measured over, ms. */
  rateWindowMs: number;
}

/** §26.2 defaults, verbatim. */
export const DEFAULT_COOLDOWN_CONFIG: CooldownConfig = {
  ordinaryGapMs: 10_000,
  maxOrdinaryPerMinuteCoach: 3,
  maxOrdinaryPerMinuteStudio: 5,
  sameCategoryGapMs: 25_000,
  afterCommandJumpMs: 5_000,
  afterRetakeReversalMs: 5_000,
  afterCriticalDiscrepancyMs: 3_000,
  positiveGapMs: 60_000,
  repetitionEscalationFactor: 2,
  maxShowingsPerCode: 2,
  rateWindowMs: 60_000,
};

/**
 * §44.3's shipped Coach-mode cadence, which is *stricter* than the §26.2 floor
 * (18 s between noncritical tips, three per rolling two minutes).
 *
 * The two sections disagree: §26.2 says ten seconds and three per minute,
 * §44.3 says eighteen seconds and three per two minutes. §26.2 is the policy
 * floor implemented by default; a product that wants the §44.3 first-run
 * defaults passes this preset instead. Neither is silently averaged.
 */
export const SPEC_44_3_COACH_CADENCE: Partial<CooldownConfig> = {
  ordinaryGapMs: 18_000,
  maxOrdinaryPerMinuteCoach: 3,
  maxOrdinaryPerMinuteStudio: 5,
  rateWindowMs: 120_000,
};

interface ShownRecord {
  code: CoachTipCode;
  cooldownKey: string;
  atMs: number;
  ordinary: boolean;
  band: string;
  evidenceIds: readonly string[];
}

export interface CooldownQuery {
  code: CoachTipCode;
  /** Audio-clock time the tip would become visible. */
  atAudioMs: number;
  mode: CoachRailMode;
  /** §26.3: the evidence cluster behind this showing. */
  evidenceIds: readonly string[];
  /** §6.4 "more frequent, but still bounded" — Studio high-frequency profile. */
  highFrequency?: boolean;
}

/**
 * The cooldown ledger for one take pass. Reset it on a new take: cooldowns are
 * per-performance, and carrying them across takes would silence the first
 * minute of every retake.
 */
export class TipCooldownLedger {
  private readonly config: CooldownConfig;
  private readonly shown: ShownRecord[] = [];
  private readonly suppressUntilMs = new Map<SuppressionEvent, number>();

  constructor(config: Partial<CooldownConfig> = {}) {
    this.config = { ...DEFAULT_COOLDOWN_CONFIG, ...config };
  }

  /** Discard all history — new take pass, or coaching re-enabled. */
  reset(): void {
    this.shown.length = 0;
    this.suppressUntilMs.clear();
  }

  /** §26.2. Open a suppression window; `atAudioMs` is when the event happened. */
  noteSuppressionEvent(event: SuppressionEvent, atAudioMs: number): void {
    const durations: Record<SuppressionEvent, number> = {
      command_jump: this.config.afterCommandJumpMs,
      retake_reversal: this.config.afterRetakeReversalMs,
      critical_discrepancy: this.config.afterCriticalDiscrepancyMs,
    };
    const until = atAudioMs + durations[event];
    const existing = this.suppressUntilMs.get(event);
    if (existing === undefined || until > existing) this.suppressUntilMs.set(event, until);
  }

  /** Record an actually-shown tip. Only shown tips consume cooldown budget. */
  noteShown(query: CooldownQuery): void {
    const definition = COACH_TIP_CATALOG[query.code];
    this.shown.push({
      code: query.code,
      cooldownKey: definition.cooldownKey,
      atMs: query.atAudioMs,
      ordinary: definition.ordinary,
      band: definition.band,
      evidenceIds: [...query.evidenceIds],
    });
    // §26.2: a critical discrepancy silences ordinary coaching afterwards.
    if (definition.band === 'fidelity_critical') {
      this.noteSuppressionEvent('critical_discrepancy', query.atAudioMs);
    }
  }

  /** How many times this code has been shown in the current take pass. */
  showingCount(code: CoachTipCode): number {
    let count = 0;
    for (const record of this.shown) if (record.code === code) count += 1;
    return count;
  }

  /**
   * The single blocking rule, or `null` when the tip may be shown.
   *
   * Rules are evaluated in a fixed order so a caller can reason about which one
   * fires; each is independently reachable by varying only its own input.
   */
  blockedBy(query: CooldownQuery): CooldownRejection | null {
    const definition = COACH_TIP_CATALOG[query.code];
    const now = query.atAudioMs;

    // Per-code cooldown and repetition escalation apply to EVERY tip, including
    // system tips: §25.1 exempts them from *ordinary* cooldowns, not from
    // repeating themselves every frame.
    const repetition = this.repetitionBlock(definition, query);
    if (repetition !== null) return repetition;

    if (definition.band === 'positive') {
      // §25.6/§8.5: positives have their own gap and never borrow the ordinary
      // allowance. They also do not reset critical eligibility (§26.2) — which
      // is true by construction, since nothing here records against critical.
      const lastPositive = this.lastAt((r) => r.band === 'positive');
      if (lastPositive !== null && now - lastPositive < this.config.positiveGapMs) {
        return 'positive_gap';
      }
      return null;
    }

    if (!definition.ordinary) return null; // §25.1/§44.3 bypass

    for (const event of ['command_jump', 'retake_reversal', 'critical_discrepancy'] as const) {
      const until = this.suppressUntilMs.get(event);
      if (until !== undefined && now < until) {
        return event === 'command_jump'
          ? 'command_jump_window'
          : event === 'retake_reversal'
            ? 'retake_reversal_window'
            : 'critical_notice_window';
      }
    }

    const lastOrdinary = this.lastAt((r) => r.ordinary);
    if (lastOrdinary !== null && now - lastOrdinary < this.config.ordinaryGapMs) {
      return 'ordinary_gap';
    }

    const cap = this.perMinuteCap(query.mode, query.highFrequency === true);
    const windowStart = now - this.config.rateWindowMs;
    let inWindow = 0;
    for (const record of this.shown) {
      if (record.ordinary && record.atMs > windowStart) inWindow += 1;
    }
    if (inWindow >= cap) return 'per_minute_cap';

    const lastCategory = this.lastAt((r) => r.ordinary && r.cooldownKey === definition.cooldownKey);
    if (lastCategory !== null && now - lastCategory < this.config.sameCategoryGapMs) {
      return 'category_cooldown';
    }

    return null;
  }

  /** §26.2 per-minute cap for a mode. Non-live modes never reach here. */
  private perMinuteCap(mode: CoachRailMode, highFrequency: boolean): number {
    if (mode === 'studio' && highFrequency) return this.config.maxOrdinaryPerMinuteStudio;
    if (mode === 'studio') return this.config.maxOrdinaryPerMinuteCoach;
    return this.config.maxOrdinaryPerMinuteCoach;
  }

  /**
   * §25.2–§25.4 per-code cooldown, then §26.3 repetition escalation.
   *
   * Three distinct rules, each reachable on its own:
   * - inside the code's own §25 cooldown → `code_cooldown`;
   * - past it but inside the escalated gap → `repetition_escalation_gap`;
   * - past both, but no second wording, no new evidence cluster, or the
   *   per-take showing budget is used up → `repetition_exhausted`.
   */
  private repetitionBlock(
    definition: CoachTipDefinition,
    query: CooldownQuery,
  ): CooldownRejection | null {
    const previous = this.shown.filter((r) => r.code === definition.code);
    const last = previous[previous.length - 1];
    if (last === undefined) return null;

    const elapsed = query.atAudioMs - last.atMs;
    // §25.2–§25.4 minimum cooldown for this exact code.
    if (elapsed < definition.cooldownMs) return 'code_cooldown';

    if (previous.length >= this.config.maxShowingsPerCode) return 'repetition_exhausted';

    // §26.3: "only after a long cooldown and a new evidence cluster".
    if (elapsed < definition.cooldownMs * this.config.repetitionEscalationFactor) {
      return 'repetition_escalation_gap';
    }
    // §26.3: "Do not repeat identical copy at the same severity." A code with
    // no second wording is therefore a once-per-take tip; the pattern still
    // reaches the presenter through telemetry and the post-take report.
    if (definition.alternate === null || definition.alternate.interpolation !== 'none') {
      return 'repetition_exhausted';
    }
    const seen = new Set<string>();
    for (const record of previous) for (const id of record.evidenceIds) seen.add(id);
    if (!query.evidenceIds.some((id) => !seen.has(id))) return 'repetition_exhausted';

    return null;
  }

  private lastAt(predicate: (record: ShownRecord) => boolean): number | null {
    for (let i = this.shown.length - 1; i >= 0; i--) {
      const record = this.shown[i];
      if (record !== undefined && predicate(record)) return record.atMs;
    }
    return null;
  }
}
