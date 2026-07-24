/**
 * §26 tip scheduling policy — the local, deterministic display authority.
 *
 * Everything the presenter ever sees on the rail passes through here. Luna can
 * classify a candidate and it can veto one by staying silent, but it cannot
 * schedule, order, phrase, or extend a tip: this module reads a code plus a
 * confidence and does the rest from the authored catalog and the cooldown
 * ledger.
 *
 * §2.1 is structural: nothing in this file imports, references, or returns a
 * scroll offset, cursor index, unit id, section id, or motion directive. The
 * only output is a {@link CoachRailTip}, whose shape makes that impossible.
 *
 * §2.6 is the default: with no proposals — or with every proposal blocked —
 * `activeTip` stays `null`. Silence is the expected outcome of most windows.
 */
import type {
  CoachCandidate,
  CoachRailMode,
  CoachRailTip,
  CoachTipCode,
  DeliveryStyle,
  LunaCoachDecision,
} from '../../contracts/coaching';
import { isEvidenceCurrent } from '../../contracts/coaching';
import {
  TipCooldownLedger,
  type CooldownConfig,
  type CooldownRejection,
  type SuppressionEvent,
} from './cooldowns';
import {
  CANDIDATE_TIP_CODE,
  COACH_TIP_CATALOG,
  bandFloorFor,
  escalatedTipCopy,
  resolveTipCopy,
  type ResolvedTipCopy,
} from './tip-catalog';

/* ---------------------------------------------------------------------------
 * Inputs
 * ------------------------------------------------------------------------- */

/** §22 state block, as the policy reads it. Mirrors `LunaCoachRequest.state`. */
export interface CoachLiveState {
  alignmentConfidence: number;
  commandActive: boolean;
  retakeState: 'none' | 'pending' | 'reversing' | 'settling';
  reacquiring: boolean;
  microphoneHealthy: boolean;
}

export interface CoachPolicyContext {
  /** Monotonic audio clock (§5.4). The only clock this module knows. */
  audioTimeMs: number;
  mode: CoachRailMode;
  trackingEpoch: number;
  takePassId: string;
  deliveryStyle: DeliveryStyle;
  liveTipFrequency: 'low' | 'normal' | 'high';
  /** Master switch. `false` cancels everything and admits nothing (§26.5). */
  coachingEnabled: boolean;
  /** §30 `modules.liveTips`. Telemetry keeps running when this is off. */
  liveTipsEnabled: boolean;
  /** §25.6. Off by default. */
  positiveReinforcementEnabled: boolean;
  /** §6.4 Studio high-frequency profile. */
  highFrequency?: boolean;
  state: CoachLiveState;
  /** §9.4. True at a sentence boundary, a natural pause, or settled motion. */
  safeMoment: boolean;
  /** §26.5. The span the presenter is on; a tip whose scope left it is cancelled. */
  activeScriptSpanId: string | null;
  /**
   * §30 custom mode. Per-code enable/disable, overriding the catalog's
   * `enabledByDefault`. This is how `SETTLE_DELIVERY` (§25.4, off by default)
   * and the positive codes (§25.6) are turned on without editing the catalog.
   */
  enabledCodeOverrides?: Partial<Record<CoachTipCode, boolean>>;
}

/** One candidate offered for display, with the local layer's safe extras. */
export interface TipProposal {
  candidate: CoachCandidate;
  source: 'local' | 'luna_validated';
  /** §23 confidence, present only for `luna_validated`. */
  lunaConfidence?: number;
  /** Raw detected filler form; re-checked against the §25.3 allowlist here. */
  filler?: string | null;
  /** Authored script text for the §25.5 quoted variant. */
  authoredTerm?: string | null;
  /** §26.1 persistence input, ms. Defaults to the evidence span length. */
  persistenceMs?: number;
  /**
   * Script **token** the tip anchors to, for gutter marks and quoting. Never
   * used for scope comparison — see {@link CoachCandidate.scriptSpanId}.
   */
  scriptAnchorTokenId?: string | null;
  /**
   * §23. Luna's own scope for this decision, when the proposal came back from
   * the observer. `session_pattern` and `none` describe something that is not
   * anchored to the span the presenter happens to be on, so §26.5's
   * out-of-scope cancellation must not apply to them.
   */
  lunaScope?: LunaCoachDecision['scope'];
}

export type PolicyRejection =
  | 'coaching_disabled'
  | 'mode_disabled'
  | 'live_tips_disabled'
  | 'code_disabled'
  | 'studio_only'
  | 'positive_disabled'
  | 'provisional_evidence'
  | 'requires_semantic_validation'
  | 'stale_epoch'
  | 'stale_take_pass'
  | 'below_local_confidence_floor'
  | 'suppressed_by_state'
  | 'lower_priority_than_visible'
  | 'not_selected'
  | CooldownRejection;

export interface RejectedProposal {
  evidenceId: string;
  code: CoachTipCode;
  reason: PolicyRejection;
}

export interface ProposalOutcome {
  /** The tip now visible or queued, or `null` — §2.6's usual answer. */
  accepted: CoachRailTip | null;
  /** Whether `accepted` is on screen, or waiting for a safe moment (§9.4). */
  displayed: boolean;
  rejected: RejectedProposal[];
}

/** §26.5. */
export type CancellationReason =
  | 'evidence_revised'
  | 'self_correction'
  | 'command_started'
  | 'retake_started'
  | 'critical_notice'
  | 'span_out_of_scope'
  | 'coaching_disabled'
  | 'take_ended';

export interface PolicyConfig extends Partial<CooldownConfig> {
  /** §9.4: how long a candidate may wait for a safe opportunity, ms. */
  safeMomentWaitMs?: number;
  /** §26.1 recency horizon, ms. Evidence older than this scores 0 for recency. */
  recencyHorizonMs?: number;
  /** §21: below this alignment confidence, ordinary coaching is suppressed. */
  minimumAlignmentConfidence?: number;
}

const DEFAULT_SAFE_MOMENT_WAIT_MS = 3_000;
const DEFAULT_RECENCY_HORIZON_MS = 8_000;
const DEFAULT_MIN_ALIGNMENT_CONFIDENCE = 0.4;

/** §26.1 user preference factor by `liveTipFrequency`. */
const PREFERENCE_FACTOR: Record<'low' | 'normal' | 'high', number> = {
  low: 0.6,
  normal: 1,
  high: 1,
};

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * §26.5. The span a tip's scope is measured against, or `null` when it has no
 * span scope to leave.
 *
 * Luna's own `scope` wins when it is present, because the model is the one
 * that judged whether the issue is about this phrase or about the session. A
 * `session_pattern` verdict — a repetitive opener, a filler habit — is not
 * invalidated by walking into the next sentence.
 */
function scopeSpanIdFor(proposal: TipProposal): string | null {
  if (proposal.lunaScope === 'session_pattern' || proposal.lunaScope === 'none') return null;
  return proposal.candidate.scriptSpanId;
}

/* ---------------------------------------------------------------------------
 * Scoring (§26.1)
 * ------------------------------------------------------------------------- */

export interface ScoreBreakdown {
  priorityWeight: number;
  confidence: number;
  actionability: number;
  recency: number;
  persistence: number;
  safeMomentFactor: number;
  userPreferenceFactor: number;
  score: number;
  /** `score / priorityWeight`, i.e. the within-band position in `[0, 1]`. */
  normalized: number;
}

/**
 * §26.1. Every factor except the priority weight is clamped to `[0, 1]`, so
 * `score` can never exceed the band floor — which is what makes the
 * "adjust within a band, never across" rule provable rather than hoped for.
 */
export function scoreProposal(
  proposal: TipProposal,
  code: CoachTipCode,
  context: CoachPolicyContext,
  config: Required<Pick<PolicyConfig, 'recencyHorizonMs'>>,
): ScoreBreakdown {
  const definition = COACH_TIP_CATALOG[code];
  const priorityWeight = bandFloorFor(code);

  const local = clamp01(proposal.candidate.localConfidence);
  const confidence =
    proposal.lunaConfidence === undefined ? local : Math.min(local, clamp01(proposal.lunaConfidence));

  const age = context.audioTimeMs - proposal.candidate.stamp.audioEndMs;
  const recency = clamp01(1 - age / config.recencyHorizonMs);

  const spanMs = proposal.candidate.stamp.audioEndMs - proposal.candidate.stamp.audioStartMs;
  const persistenceMs = proposal.persistenceMs ?? spanMs;
  const persistence =
    definition.requiredPersistenceMs === 0
      ? 1
      : clamp01(persistenceMs / definition.requiredPersistenceMs);

  const safeMomentFactor = context.safeMoment ? 1 : 0.5;
  const userPreferenceFactor = PREFERENCE_FACTOR[context.liveTipFrequency];
  const actionability = clamp01(definition.actionability);

  const normalized =
    confidence * actionability * recency * persistence * safeMomentFactor * userPreferenceFactor;
  return {
    priorityWeight,
    confidence,
    actionability,
    recency,
    persistence,
    safeMomentFactor,
    userPreferenceFactor,
    score: priorityWeight * normalized,
    normalized,
  };
}

/**
 * §24. The effective priority written onto the tip. Bands are at least ten
 * apart, and the within-band adjustment is capped at nine, so a tip can never
 * be reordered past a neighbouring band by its score.
 */
export function effectivePriority(code: CoachTipCode, normalized: number): number {
  return bandFloorFor(code) + Math.round(9 * clamp01(normalized));
}

/* ---------------------------------------------------------------------------
 * State-based suppression (§21, §23.1)
 * ------------------------------------------------------------------------- */

/**
 * §21: "Do not select ordinary coaching during a command, retake,
 * reacquisition, low alignment confidence, or microphone failure."
 *
 * System tips are exempt from the microphone-failure clause for the obvious
 * reason that they *are* the microphone failure; nothing is exempt from a
 * command or a retake, because the presenter's attention is elsewhere.
 */
export function isSuppressedByState(
  code: CoachTipCode,
  context: Pick<CoachPolicyContext, 'state'>,
  minimumAlignmentConfidence: number,
): boolean {
  const definition = COACH_TIP_CATALOG[code];
  const state = context.state;
  if (state.commandActive) return true;
  if (state.retakeState !== 'none') return true;

  if (definition.band === 'system_critical') return false;
  if (state.reacquiring) return true;
  if (!state.microphoneHealthy) return true;

  // §25.5: a critical discrepancy still needs a trustworthy alignment.
  if (state.alignmentConfidence < minimumAlignmentConfidence) return true;
  return false;
}

/** §6. Which bands a rail mode admits at all. */
function modeAdmits(mode: CoachRailMode, code: CoachTipCode): boolean {
  const band = COACH_TIP_CATALOG[code].band;
  switch (mode) {
    case 'off':
    case 'review_only':
      // §6.1/§6.5: critical failures use the app's system-notice mechanism,
      // not the rail, so the rail admits nothing at all.
      return false;
    case 'minimal':
      // §6.2: critical microphone and critical fidelity only.
      return band === 'system_critical' || band === 'fidelity_critical';
    case 'coach':
    case 'studio':
    case 'custom':
      return true;
  }
}

/* ---------------------------------------------------------------------------
 * The policy
 * ------------------------------------------------------------------------- */

interface PendingTip {
  tip: CoachRailTip;
  /** Evidence ids used for the §26.3 cluster test when it is actually shown. */
  evidenceIds: readonly string[];
  /**
   * §26.5. The authored **span** whose scope the tip lives in, or `null` for a
   * tip that is not scoped to one.
   *
   * Held here rather than on {@link CoachRailTip} because the stage has no use
   * for it: the span is a policy concern, and putting a script span id on the
   * payload that crosses to the stage would edge against Rule 1. Kept as a
   * span — never a token — because comparing a token id against the active
   * span id is a comparison that can only ever be false, which is how a
   * priority-90 critical alert used to survive exactly one tick.
   */
  scopeSpanId: string | null;
  /**
   * §26.5. Ids of the underlying evidence records the candidate aggregated, so
   * a demoted event can cancel the tip that rests on it.
   */
  contributingEventIds: readonly string[];
  highFrequency: boolean;
  mode: CoachRailMode;
}

/**
 * One instance per session. `reset()` on a new take pass; the ledger is
 * per-performance.
 */
export class CoachTipPolicy {
  private readonly ledger: TipCooldownLedger;
  private readonly safeMomentWaitMs: number;
  private readonly recencyHorizonMs: number;
  private readonly minimumAlignmentConfidence: number;

  private visible: PendingTip | null = null;
  private visibleSinceMs: number | null = null;
  private pending: PendingTip | null = null;
  private counter = 0;

  /**
   * §37 diagnostics. Proposed / shown / suppressed / not selected.
   *
   * `suppressed` counts proposals a *rule* refused: a cooldown, a mode, a
   * confidence floor, a state suppression. `notSelected` counts proposals that
   * lost a ranking to a better one in the same window. Keeping them apart is
   * the whole value of the pair — "the rail is too chatty" and "the rail had
   * more to say than it could fit" are opposite diagnoses.
   */
  private proposedCount = 0;
  private shownCount = 0;
  private suppressedCount = 0;
  private notSelectedCount = 0;

  constructor(config: PolicyConfig = {}) {
    const { safeMomentWaitMs, recencyHorizonMs, minimumAlignmentConfidence, ...cooldown } = config;
    this.ledger = new TipCooldownLedger(cooldown);
    this.safeMomentWaitMs = safeMomentWaitMs ?? DEFAULT_SAFE_MOMENT_WAIT_MS;
    this.recencyHorizonMs = recencyHorizonMs ?? DEFAULT_RECENCY_HORIZON_MS;
    this.minimumAlignmentConfidence =
      minimumAlignmentConfidence ?? DEFAULT_MIN_ALIGNMENT_CONFIDENCE;
  }

  getActiveTip(): CoachRailTip | null {
    return this.visible?.tip ?? null;
  }

  getPendingTip(): CoachRailTip | null {
    return this.pending?.tip ?? null;
  }

  getCounters(): {
    proposed: number;
    shown: number;
    suppressed: number;
    notSelected: number;
  } {
    return {
      proposed: this.proposedCount,
      shown: this.shownCount,
      suppressed: this.suppressedCount,
      notSelected: this.notSelectedCount,
    };
  }

  /** New take pass, or session reset: nothing carries over. */
  reset(): void {
    this.ledger.reset();
    this.visible = null;
    this.visibleSinceMs = null;
    this.pending = null;
  }

  /** §37. Zero the counters — a new session, not a new take pass. */
  resetCounters(): void {
    this.proposedCount = 0;
    this.shownCount = 0;
    this.suppressedCount = 0;
    this.notSelectedCount = 0;
  }

  /** §26.2. Report an event that opens a suppression window. */
  noteSuppressionEvent(event: SuppressionEvent, atAudioMs: number): void {
    this.ledger.noteSuppressionEvent(event, atAudioMs);
  }

  /**
   * §26.5. Cancel the queued and/or visible tip. Cancellation is immediate and
   * deliberately ignores `minimumDisplayMs`: a tip whose evidence has been
   * revised away is worse than no tip, however briefly it has been up.
   *
   * `evidenceId` scopes `evidence_revised`; `activeSpanId` scopes
   * `span_out_of_scope`. Both are ignored by the other reasons.
   */
  cancel(
    reason: CancellationReason,
    options: { evidenceId?: string; activeSpanId?: string | null } = {},
  ): CoachRailTip[] {
    const cancelled: CoachRailTip[] = [];
    for (const slot of ['pending', 'visible'] as const) {
      const held = slot === 'pending' ? this.pending : this.visible;
      if (held === null) continue;
      if (!this.cancellationApplies(held, reason, options)) continue;
      cancelled.push(held.tip);
      if (slot === 'pending') {
        this.pending = null;
      } else {
        this.visible = null;
        this.visibleSinceMs = null;
      }
    }
    return cancelled;
  }

  private cancellationApplies(
    held: PendingTip,
    reason: CancellationReason,
    options: { evidenceId?: string; activeSpanId?: string | null },
  ): boolean {
    const definition = COACH_TIP_CATALOG[held.tip.code];
    switch (reason) {
      case 'evidence_revised':
        // Only the tip resting on that evidence — either the candidate itself
        // or one of the underlying records it aggregated. The disfluency lane
        // demotes by `FillerEvent.eventId`, which is not the candidate's
        // `evidenceId`, so without the second test §26.5 was unreachable from
        // the only producer that has demotions.
        if (options.evidenceId === undefined) return false;
        return (
          held.tip.evidenceIds.includes(options.evidenceId) ||
          held.contributingEventIds.includes(options.evidenceId)
        );
      case 'critical_notice':
        // §26.5: a critical notice cancels ordinary tips. It does not cancel
        // itself, and it does not cancel a system alert about the microphone.
        return definition.ordinary;
      case 'self_correction':
      case 'command_started':
      case 'retake_started':
        return definition.ordinary;
      case 'span_out_of_scope': {
        // A hardware fault and a misread number are not scoped to a span: the
        // microphone is still clipping wherever the presenter has got to, and
        // the number was still wrong. §26.5's scope rule is about advice that
        // stops applying once the moment passes, and these two bands are
        // neither advice nor momentary. Left in, a `fidelity_critical` alert —
        // which `fidelity/comparator.ts` can only emit *after* the presenter
        // has demonstrably moved on — died on the first tick after it appeared.
        if (definition.band === 'fidelity_critical' || definition.band === 'system_critical') {
          return false;
        }
        // §26.5: only when the tip actually had a scope to leave. Span against
        // span; a token id in this comparison never matches anything.
        if (held.scopeSpanId === null) return false;
        return held.scopeSpanId !== options.activeSpanId;
      }
      case 'coaching_disabled':
      case 'take_ended':
        return true;
    }
  }

  /**
   * §26. Offer candidates. Returns the one tip that wins, if any.
   *
   * Ordering is lexicographic — band floor first, §26.1 score second — because
   * the multiplicative score alone could pull a `delivery_pressure` candidate
   * below a `cadence` one, which §24 forbids.
   */
  propose(proposals: readonly TipProposal[], context: CoachPolicyContext): ProposalOutcome {
    this.proposedCount += proposals.length;
    const rejected: RejectedProposal[] = [];

    if (!context.coachingEnabled) {
      this.cancel('coaching_disabled');
      for (const proposal of proposals) {
        rejected.push(this.reject(proposal, 'coaching_disabled'));
      }
      // §37: these were proposed and not shown. The early return used to skip
      // the counter entirely, so turning coaching off silently pushed
      // `proposed` and `suppressed` out of agreement.
      this.suppressedCount += rejected.length;
      return { accepted: null, displayed: false, rejected };
    }

    interface Ranked {
      proposal: TipProposal;
      code: CoachTipCode;
      copy: ResolvedTipCopy;
      breakdown: ScoreBreakdown;
    }
    const ranked: Ranked[] = [];

    for (const proposal of proposals) {
      const admitted = this.admit(proposal, context);
      if (admitted.reason !== null) {
        rejected.push({
          evidenceId: proposal.candidate.evidenceId,
          code: admitted.code,
          reason: admitted.reason,
        });
        continue;
      }
      const breakdown = scoreProposal(proposal, admitted.code, context, {
        recencyHorizonMs: this.recencyHorizonMs,
      });
      ranked.push({ proposal, code: admitted.code, copy: admitted.copy, breakdown });
    }

    ranked.sort((a, b) => {
      const bandDelta = b.breakdown.priorityWeight - a.breakdown.priorityWeight;
      if (bandDelta !== 0) return bandDelta;
      return b.breakdown.score - a.breakdown.score;
    });

    // §37: everything rejected before ranking was *suppressed* — a gate said
    // no. Counted here, once, rather than at each `return` below, where it used
    // to be added on the success path and where the ranking losers appended
    // afterwards were swept in with it. `not_selected` is not suppression: the
    // issue was real and something more important was shown instead, and
    // counting it as suppression is what would have made the contract's
    // "rail too chatty" ratio wrong from the first take.
    this.suppressedCount += rejected.length;

    const winner = ranked[0];
    if (winner === undefined) {
      return { accepted: null, displayed: false, rejected };
    }
    for (const loser of ranked.slice(1)) {
      rejected.push({
        evidenceId: loser.proposal.candidate.evidenceId,
        code: loser.code,
        reason: 'not_selected',
      });
      this.notSelectedCount += 1;
    }

    // §9.1: one tip. A new tip may take the screen only for a strictly higher
    // band before the minimum display has elapsed, or a strictly higher
    // priority after it.
    if (this.visible !== null) {
      const shownFor = context.audioTimeMs - (this.visibleSinceMs ?? context.audioTimeMs);
      const current = this.visible.tip;
      const higherBand = bandFloorFor(winner.code) > bandFloorFor(current.code);
      const higherPriority =
        effectivePriority(winner.code, winner.breakdown.normalized) > current.priority;
      const allowed = higherBand || (shownFor >= current.minimumDisplayMs && higherPriority);
      if (!allowed) {
        rejected.push({
          evidenceId: winner.proposal.candidate.evidenceId,
          code: winner.code,
          reason: 'lower_priority_than_visible',
        });
        this.suppressedCount += 1;
        return { accepted: null, displayed: false, rejected };
      }
    }

    const tip = this.buildTip(winner.proposal, winner.code, winner.copy, winner.breakdown, context);
    const held: PendingTip = {
      tip,
      evidenceIds: tip.evidenceIds,
      scopeSpanId: scopeSpanIdFor(winner.proposal),
      contributingEventIds: [...winner.proposal.candidate.contributingEventIds],
      highFrequency: context.highFrequency === true,
      mode: context.mode,
    };

    if (context.safeMoment) {
      this.show(held, context.audioTimeMs);
      return { accepted: tip, displayed: true, rejected };
    }
    // §9.4: wait up to three seconds for a safe opportunity.
    this.pending = held;
    return { accepted: tip, displayed: false, rejected };
  }

  /**
   * Advance the display clock. Shows a pending tip at the next safe moment,
   * drops it when its window closes unshown, and retires a visible tip once
   * `maximumDisplayMs` has elapsed.
   */
  tick(context: CoachPolicyContext): CoachRailTip | null {
    const now = context.audioTimeMs;

    if (!context.coachingEnabled) {
      this.cancel('coaching_disabled');
      return null;
    }

    // §26.5: the active span moved outside the tip's scope. Done here rather
    // than left to the caller, so the rule cannot be forgotten at one of
    // several call sites — which is how a cancellation rule quietly stops
    // firing while its unit test keeps passing.
    this.cancel('span_out_of_scope', { activeSpanId: context.activeScriptSpanId });

    if (this.visible !== null && this.visibleSinceMs !== null) {
      if (now - this.visibleSinceMs >= this.visible.tip.maximumDisplayMs) {
        this.visible = null;
        this.visibleSinceMs = null;
      }
    }

    const pending = this.pending;
    if (pending !== null) {
      if (now > pending.tip.expiresAudioTimeMs) {
        // §9.4: became stale waiting for a safe moment; discarded unshown.
        this.pending = null;
      } else if (
        context.safeMoment &&
        now >= pending.tip.earliestDisplayMs &&
        this.visible === null
      ) {
        // Re-check the cooldowns: the tip may have waited across a window that
        // opened while it sat in the queue.
        const blocked = this.ledger.blockedBy({
          code: pending.tip.code,
          atAudioMs: now,
          mode: pending.mode,
          evidenceIds: pending.evidenceIds,
          highFrequency: pending.highFrequency,
        });
        if (blocked !== null) {
          this.pending = null;
        } else if (isSuppressedByState(pending.tip.code, context, this.minimumAlignmentConfidence)) {
          this.pending = null;
        } else {
          this.show(pending, now);
          this.pending = null;
        }
      }
    }

    return this.visible?.tip ?? null;
  }

  private show(held: PendingTip, nowMs: number): void {
    this.visible = held;
    this.visibleSinceMs = nowMs;
    this.pending = null;
    this.shownCount += 1;
    this.ledger.noteShown({
      code: held.tip.code,
      atAudioMs: nowMs,
      mode: held.mode,
      evidenceIds: held.evidenceIds,
      highFrequency: held.highFrequency,
    });
  }

  /** All the per-proposal gates, in a fixed and individually reachable order. */
  private admit(
    proposal: TipProposal,
    context: CoachPolicyContext,
  ): { code: CoachTipCode; copy: ResolvedTipCopy; reason: PolicyRejection | null } {
    const mapped = CANDIDATE_TIP_CODE[proposal.candidate.type];
    const copy = resolveTipCopy(mapped, {
      filler: proposal.filler ?? null,
      authoredTerm: proposal.authoredTerm ?? null,
      deliveryStyle: context.deliveryStyle,
    });
    const code = copy.code;
    const definition = COACH_TIP_CATALOG[code];
    const fail = (reason: PolicyRejection) => ({ code, copy, reason });

    if (!modeAdmits(context.mode, code)) return fail('mode_disabled');
    if (definition.ordinary && !context.liveTipsEnabled) return fail('live_tips_disabled');
    if (definition.band === 'positive' && !context.positiveReinforcementEnabled) {
      return fail('positive_disabled');
    }
    // §25.4: `SETTLE_DELIVERY` ships off and only a settings override enables it.
    const override = context.enabledCodeOverrides?.[code];
    const enabled = override ?? definition.enabledByDefault;
    if (!enabled && definition.band !== 'positive') return fail('code_disabled');
    if (definition.studioOnly && context.mode !== 'studio') return fail('studio_only');

    // §22/§27: a provisional tail is routinely revised away.
    if (!proposal.candidate.finalEvidence) return fail('provisional_evidence');

    // §25.5 / §20.1: the local layer may propose a materiality question but may
    // never answer one. Structural, so no caller can forget it.
    if (definition.requiresLunaValidation && proposal.source !== 'luna_validated') {
      return fail('requires_semantic_validation');
    }

    if (proposal.candidate.stamp.trackingEpoch !== context.trackingEpoch) return fail('stale_epoch');
    if (proposal.candidate.stamp.takePassId !== context.takePassId) return fail('stale_take_pass');

    if (proposal.candidate.localConfidence < definition.localConfidenceFloor) {
      return fail('below_local_confidence_floor');
    }
    if (isSuppressedByState(code, context, this.minimumAlignmentConfidence)) {
      return fail('suppressed_by_state');
    }

    const blocked = this.ledger.blockedBy({
      code,
      atAudioMs: context.audioTimeMs,
      mode: context.mode,
      evidenceIds: [proposal.candidate.evidenceId],
      highFrequency: context.highFrequency === true,
    });
    if (blocked !== null) return fail(blocked);

    return { code, copy, reason: null };
  }

  private buildTip(
    proposal: TipProposal,
    code: CoachTipCode,
    copy: ResolvedTipCopy,
    breakdown: ScoreBreakdown,
    context: CoachPolicyContext,
  ): CoachRailTip {
    const definition = COACH_TIP_CATALOG[code];
    // §26.3: a repeat uses the second wording, never the same copy again.
    const repeat = this.ledger.showingCount(code) > 0;
    const resolved = repeat ? (escalatedTipCopy(code) ?? copy) : copy;
    this.counter += 1;
    const now = context.audioTimeMs;
    return {
      tipId: `coachtip_${context.takePassId}_${this.counter}`,
      code,
      textKey: resolved.textKey,
      interpolations: { ...resolved.interpolations },
      severity: definition.severity,
      priority: effectivePriority(code, breakdown.normalized),
      createdAudioTimeMs: now,
      evidenceStartMs: proposal.candidate.stamp.audioStartMs,
      evidenceEndMs: proposal.candidate.stamp.audioEndMs,
      earliestDisplayMs: now,
      expiresAudioTimeMs: now + this.safeMomentWaitMs,
      minimumDisplayMs: definition.minimumDisplayMs,
      maximumDisplayMs: definition.maximumDisplayMs,
      cooldownKey: definition.cooldownKey,
      trackingEpoch: context.trackingEpoch,
      takePassId: context.takePassId,
      // Token to token. This used to fall back to `candidate.scriptSpanId`,
      // mixing the two namespaces on the payload that reaches the stage.
      scriptAnchorTokenId: proposal.scriptAnchorTokenId ?? proposal.candidate.scriptAnchorTokenId,
      evidenceIds: [proposal.candidate.evidenceId],
      source: proposal.source,
    };
  }

  private reject(proposal: TipProposal, reason: PolicyRejection): RejectedProposal {
    return {
      evidenceId: proposal.candidate.evidenceId,
      code: CANDIDATE_TIP_CODE[proposal.candidate.type],
      reason,
    };
  }
}

/**
 * Convenience re-export so a caller can check freshness with the contract's own
 * helper rather than re-deriving it (the contract explains why that matters).
 */
export { isEvidenceCurrent };
export type { CoachCandidate };
