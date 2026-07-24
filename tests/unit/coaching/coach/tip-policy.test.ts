/**
 * §26 scheduling policy.
 *
 * Two habits run through this file:
 *
 * - every rejection case asserts the **specific** reason, and pairs with a
 *   control showing the same input is accepted once the one mutated field is
 *   restored;
 * - every cancellation case asserts the tip was **visible first**, so it proves
 *   a cancellation rather than an absence. (A previous review found a
 *   "cancellation" test in this repo that only ever proved schema rejection.)
 */
import { describe, expect, it } from 'vitest';
import {
  CoachTipPolicy,
  COACH_TIP_CATALOG,
  bandFloorFor,
  effectivePriority,
  scoreProposal,
  type PolicyRejection,
  type TipProposal,
} from '../../../../src/shared/coaching/coach';
import { COACH_PRIORITY_BANDS } from '../../../../src/shared/contracts/coaching';
import { EPOCH, TAKE, candidate, context, liveState } from './fixtures';

function proposal(overrides: Partial<TipProposal> = {}): TipProposal {
  return {
    candidate: candidate(overrides.candidate),
    source: 'local',
    ...overrides,
  };
}

function reasonsOf(rejected: ReadonlyArray<{ reason: PolicyRejection }>): PolicyRejection[] {
  return rejected.map((entry) => entry.reason);
}

describe('§2.6 silence is the default', () => {
  it('produces no tip when there is nothing to say', () => {
    const policy = new CoachTipPolicy();
    const outcome = policy.propose([], context());
    expect(outcome.accepted).toBeNull();
    expect(outcome.rejected).toEqual([]);
    expect(policy.getActiveTip()).toBeNull();
  });

  it('a whole take of clean delivery yields zero tips', () => {
    const policy = new CoachTipPolicy();
    let shown = 0;
    for (let t = 0; t < 120_000; t += 500) {
      policy.propose([], context({ audioTimeMs: t }));
      if (policy.tick(context({ audioTimeMs: t })) !== null) shown += 1;
    }
    expect(shown).toBe(0);
    expect(policy.getCounters().shown).toBe(0);
  });

  it('…and the same loop with one real issue does produce exactly one tip', () => {
    // The control for the test above: the harness is capable of showing a tip.
    const policy = new CoachTipPolicy();
    const outcome = policy.propose([proposal()], context({ audioTimeMs: 10_000 }));
    expect(outcome.accepted).not.toBeNull();
    expect(policy.getActiveTip()?.code).toBe('PACE_EASE_BACK');
  });
});

describe('§24 priority bands are never crossed', () => {
  it('prefers a weak critical candidate over a strong pace candidate', () => {
    const policy = new CoachTipPolicy();
    const critical = proposal({
      candidate: candidate({
        evidenceId: 'ev-crit',
        type: 'critical_number_mismatch',
        localConfidence: 0.71,
        // Old evidence: recency and confidence both work against it.
        stamp: { ...candidate().stamp, audioStartMs: 0, audioEndMs: 3_000 },
      }),
      authoredTerm: 'fifty percent',
    });
    const pace = proposal({
      candidate: candidate({ evidenceId: 'ev-pace', localConfidence: 1 }),
    });

    const outcome = policy.propose([pace, critical], context({ audioTimeMs: 10_000 }));
    expect(outcome.accepted?.code).toBe('CRITICAL_NUMBER');
    expect(reasonsOf(outcome.rejected)).toContain('not_selected');
    // And the score alone would have ranked the pace tip higher, which is what
    // makes this a band test rather than a score test.
    const paceScore = scoreProposal(pace, 'PACE_EASE_BACK', context({ audioTimeMs: 10_000 }), {
      recencyHorizonMs: 8_000,
    });
    const criticalScore = scoreProposal(
      critical,
      'CRITICAL_NUMBER',
      context({ audioTimeMs: 10_000 }),
      { recencyHorizonMs: 8_000 },
    );
    expect(criticalScore.normalized).toBeLessThan(paceScore.normalized);
  });

  it('keeps the within-band adjustment inside the band', () => {
    for (const code of ['PACE_EASE_BACK', 'LIFT_KEY_WORDS', 'CRITICAL_NAME'] as const) {
      const floor = bandFloorFor(code);
      expect(effectivePriority(code, 0)).toBe(floor);
      expect(effectivePriority(code, 1)).toBe(floor + 9);
      expect(effectivePriority(code, 0.5)).toBeGreaterThan(floor);
      // Nine is less than the smallest gap between adjacent bands.
      const floors = Object.values(COACH_PRIORITY_BANDS).sort((a, b) => a - b);
      const gaps = floors.slice(1).map((value, index) => value - (floors[index] ?? 0));
      expect(Math.min(...gaps)).toBeGreaterThan(9);
    }
  });

  it('orders within a band by the §26.1 score', () => {
    const policy = new CoachTipPolicy();
    const fresh = proposal({
      candidate: candidate({
        evidenceId: 'fresh',
        type: 'terminal_rush',
        localConfidence: 0.95,
        stamp: { ...candidate().stamp, audioStartMs: 9_000, audioEndMs: 9_900 },
      }),
    });
    const stale = proposal({
      candidate: candidate({
        evidenceId: 'stale',
        type: 'filler_cluster',
        localConfidence: 0.55,
        stamp: { ...candidate().stamp, audioStartMs: 1_000, audioEndMs: 3_000 },
      }),
    });
    expect(bandFloorFor('TERMINAL_RUSH')).toBe(bandFloorFor('USE_SILENT_PAUSE'));
    const outcome = policy.propose([stale, fresh], context({ audioTimeMs: 10_000 }));
    expect(outcome.accepted?.code).toBe('TERMINAL_RUSH');
  });
});

describe('§26.1 score factors', () => {
  const ctx = context({ audioTimeMs: 10_000 });

  it('clamps every factor except the priority weight to [0, 1]', () => {
    const breakdown = scoreProposal(proposal(), 'PACE_EASE_BACK', ctx, { recencyHorizonMs: 8_000 });
    for (const factor of [
      breakdown.confidence,
      breakdown.actionability,
      breakdown.recency,
      breakdown.persistence,
      breakdown.safeMomentFactor,
      breakdown.userPreferenceFactor,
    ]) {
      expect(factor).toBeGreaterThanOrEqual(0);
      expect(factor).toBeLessThanOrEqual(1);
    }
    expect(breakdown.priorityWeight).toBe(COACH_PRIORITY_BANDS.delivery_pressure);
    expect(breakdown.score).toBeLessThanOrEqual(breakdown.priorityWeight);
  });

  it('discounts an unsafe moment and a low tip-frequency preference', () => {
    const safe = scoreProposal(proposal(), 'PACE_EASE_BACK', ctx, { recencyHorizonMs: 8_000 });
    const unsafe = scoreProposal(proposal(), 'PACE_EASE_BACK', context({ safeMoment: false }), {
      recencyHorizonMs: 8_000,
    });
    expect(unsafe.safeMomentFactor).toBeLessThan(safe.safeMomentFactor);

    const quiet = scoreProposal(
      proposal(),
      'PACE_EASE_BACK',
      context({ audioTimeMs: 10_000, liveTipFrequency: 'low' }),
      { recencyHorizonMs: 8_000 },
    );
    expect(quiet.score).toBeLessThan(safe.score);
  });

  it('takes the lower of local and Luna confidence', () => {
    const breakdown = scoreProposal(
      proposal({ source: 'luna_validated', lunaConfidence: 0.4 }),
      'PACE_EASE_BACK',
      ctx,
      { recencyHorizonMs: 8_000 },
    );
    expect(breakdown.confidence).toBe(0.4);
  });

  it('scales persistence against the code requirement (§21: not one sentence)', () => {
    const brief = proposal({
      candidate: candidate({ stamp: { ...candidate().stamp, audioStartMs: 9_000, audioEndMs: 9_900 } }),
    });
    const sustained = proposal({ persistenceMs: 20_000 });
    const briefScore = scoreProposal(brief, 'PACE_EASE_BACK', ctx, { recencyHorizonMs: 8_000 });
    const sustainedScore = scoreProposal(sustained, 'PACE_EASE_BACK', ctx, {
      recencyHorizonMs: 8_000,
    });
    expect(briefScore.persistence).toBeLessThan(1);
    expect(sustainedScore.persistence).toBe(1);
    expect(COACH_TIP_CATALOG.PACE_EASE_BACK.requiredPersistenceMs).toBe(6_000);
  });
});

describe('per-proposal admission', () => {
  const at = context({ audioTimeMs: 10_000 });

  function rejectionFor(
    override: Partial<TipProposal>,
    ctx = at,
  ): PolicyRejection | undefined {
    const policy = new CoachTipPolicy();
    // Control: the unmutated proposal is accepted by this same policy.
    expect(new CoachTipPolicy().propose([proposal()], at).accepted).not.toBeNull();
    return policy.propose([proposal(override)], ctx).rejected[0]?.reason;
  }

  it('refuses a candidate built only on provisional evidence', () => {
    expect(rejectionFor({ candidate: candidate({ finalEvidence: false }) })).toBe(
      'provisional_evidence',
    );
  });

  it('refuses evidence from another tracking epoch', () => {
    expect(
      rejectionFor({
        candidate: candidate({ stamp: { ...candidate().stamp, trackingEpoch: EPOCH + 1 } }),
      }),
    ).toBe('stale_epoch');
  });

  it('refuses evidence from another take pass', () => {
    expect(
      rejectionFor({
        candidate: candidate({ stamp: { ...candidate().stamp, takePassId: `${TAKE}-old` } }),
      }),
    ).toBe('stale_take_pass');
  });

  it('refuses a candidate below the code confidence floor, at the boundary', () => {
    const floor = COACH_TIP_CATALOG.PACE_EASE_BACK.localConfidenceFloor;
    expect(rejectionFor({ candidate: candidate({ localConfidence: floor - 0.01 }) })).toBe(
      'below_local_confidence_floor',
    );
    expect(
      new CoachTipPolicy().propose([proposal({ candidate: candidate({ localConfidence: floor }) })], at)
        .accepted,
    ).not.toBeNull();
  });

  it.each([
    ['a command is active', { commandActive: true }],
    ['a retake is settling', { retakeState: 'settling' as const }],
    ['tracking is reacquiring', { reacquiring: true }],
    ['the microphone is unhealthy', { microphoneHealthy: false }],
    ['alignment confidence has collapsed', { alignmentConfidence: 0.1 }],
  ])('refuses an ordinary tip while %s', (_label, patch) => {
    expect(rejectionFor({}, context({ audioTimeMs: 10_000, state: liveState(patch) }))).toBe(
      'suppressed_by_state',
    );
  });

  it('still shows a microphone alert when the microphone is unhealthy', () => {
    const policy = new CoachTipPolicy();
    const mic = proposal({
      candidate: candidate({ evidenceId: 'ev-mic', type: 'system_mic_clipping', localConfidence: 1 }),
    });
    const outcome = policy.propose(
      [mic],
      context({ audioTimeMs: 10_000, state: liveState({ microphoneHealthy: false }) }),
    );
    expect(outcome.accepted?.code).toBe('MIC_CLIPPING');
  });
});

describe('§6 mode gating', () => {
  it.each(['off', 'review_only'] as const)('shows nothing on the rail in %s mode', (mode) => {
    const policy = new CoachTipPolicy();
    const outcome = policy.propose(
      [proposal({ candidate: candidate({ type: 'system_mic_clipping', localConfidence: 1 }) })],
      context({ audioTimeMs: 10_000, mode }),
    );
    expect(outcome.accepted).toBeNull();
    expect(reasonsOf(outcome.rejected)).toEqual(['mode_disabled']);
  });

  it('§6.2 minimal: critical only', () => {
    const ctx = context({ audioTimeMs: 10_000, mode: 'minimal' });
    const paceOutcome = new CoachTipPolicy().propose([proposal()], ctx);
    expect(reasonsOf(paceOutcome.rejected)).toEqual(['mode_disabled']);

    const criticalOutcome = new CoachTipPolicy().propose(
      [
        proposal({
          candidate: candidate({ type: 'critical_unit_mismatch', localConfidence: 0.9 }),
          authoredTerm: 'milliseconds',
        }),
      ],
      ctx,
    );
    expect(criticalOutcome.accepted?.code).toBe('CRITICAL_UNIT');
  });

  it('§25.3 keeps REPETITIVE_OPENER for Studio', () => {
    const opener = proposal({
      candidate: candidate({ type: 'repetitive_opener', localConfidence: 0.9 }),
    });
    expect(
      new CoachTipPolicy().propose([opener], context({ audioTimeMs: 10_000 })).rejected[0]?.reason,
    ).toBe('studio_only');
    expect(
      new CoachTipPolicy().propose([opener], context({ audioTimeMs: 10_000, mode: 'studio' }))
        .accepted?.code,
    ).toBe('REPETITIVE_OPENER');
  });

  it('honours the live-tips module switch without silencing system alerts', () => {
    const ctx = context({ audioTimeMs: 10_000, liveTipsEnabled: false });
    expect(new CoachTipPolicy().propose([proposal()], ctx).rejected[0]?.reason).toBe(
      'live_tips_disabled',
    );
    const mic = proposal({
      candidate: candidate({ type: 'system_mic_clipping', localConfidence: 1 }),
    });
    expect(new CoachTipPolicy().propose([mic], ctx).accepted?.code).toBe('MIC_CLIPPING');
  });

  it('§25.4/§25.6: off-by-default codes need an explicit override', () => {
    const settle = proposal({
      candidate: candidate({ type: 'high_variety', localConfidence: 0.9 }),
      persistenceMs: 20_000,
    });
    const ctx = context({ audioTimeMs: 10_000 });
    expect(new CoachTipPolicy().propose([settle], ctx).rejected[0]?.reason).toBe('code_disabled');
    expect(
      new CoachTipPolicy().propose(
        [settle],
        context({ audioTimeMs: 10_000, enabledCodeOverrides: { SETTLE_DELIVERY: true } }),
      ).accepted?.code,
    ).toBe('SETTLE_DELIVERY');

    const positive = proposal({
      candidate: candidate({ type: 'positive_pace', localConfidence: 0.9 }),
      persistenceMs: 30_000,
    });
    expect(new CoachTipPolicy().propose([positive], ctx).rejected[0]?.reason).toBe(
      'positive_disabled',
    );
    expect(
      new CoachTipPolicy().propose(
        [positive],
        context({ audioTimeMs: 10_000, positiveReinforcementEnabled: true }),
      ).accepted?.code,
    ).toBe('POSITIVE_PACE');
  });
});

describe('§9.4 safe display opportunity', () => {
  it('queues a tip until a safe moment arrives', () => {
    const policy = new CoachTipPolicy();
    const outcome = policy.propose([proposal()], context({ audioTimeMs: 10_000, safeMoment: false }));
    expect(outcome.accepted).not.toBeNull();
    expect(outcome.displayed).toBe(false);
    expect(policy.getActiveTip()).toBeNull();
    expect(policy.getPendingTip()).not.toBeNull();

    // Still unsafe one second later: still queued.
    expect(policy.tick(context({ audioTimeMs: 11_000, safeMoment: false }))).toBeNull();
    // A boundary arrives inside the window: shown.
    expect(policy.tick(context({ audioTimeMs: 12_000 }))?.code).toBe('PACE_EASE_BACK');
    expect(policy.getPendingTip()).toBeNull();
  });

  it('discards a tip that waits more than three seconds, unshown', () => {
    const policy = new CoachTipPolicy();
    policy.propose([proposal()], context({ audioTimeMs: 10_000, safeMoment: false }));
    // 13 000 is the expiry; one millisecond past it the tip is dropped.
    expect(policy.tick(context({ audioTimeMs: 13_001 }))).toBeNull();
    expect(policy.getPendingTip()).toBeNull();
    expect(policy.getActiveTip()).toBeNull();
    expect(policy.getCounters().shown).toBe(0);
  });

  it('retires a shown tip after its maximum display time', () => {
    const policy = new CoachTipPolicy();
    policy.propose([proposal()], context({ audioTimeMs: 10_000 }));
    const max = COACH_TIP_CATALOG.PACE_EASE_BACK.maximumDisplayMs;
    expect(policy.tick(context({ audioTimeMs: 10_000 + max - 1 }))).not.toBeNull();
    expect(policy.tick(context({ audioTimeMs: 10_000 + max }))).toBeNull();
  });
});

describe('§9.1 one tip at a time', () => {
  it('refuses a same-band replacement while one is visible', () => {
    // Two critical tips: they bypass the ordinary gap, so the only thing that
    // can block the second is the one-tip rule itself.
    const policy = new CoachTipPolicy();
    const first = policy.propose(
      [
        proposal({
          candidate: candidate({ type: 'critical_number_mismatch', localConfidence: 0.9 }),
          authoredTerm: 'fifty percent',
        }),
      ],
      context({ audioTimeMs: 10_000 }),
    );
    expect(first.accepted?.code).toBe('CRITICAL_NUMBER');

    const second = policy.propose(
      [
        proposal({
          candidate: candidate({
            evidenceId: 'ev-2',
            type: 'critical_unit_mismatch',
            localConfidence: 0.9,
          }),
          authoredTerm: 'milliseconds',
        }),
      ],
      context({ audioTimeMs: 10_500 }),
    );
    expect(second.accepted).toBeNull();
    expect(reasonsOf(second.rejected)).toContain('lower_priority_than_visible');
    expect(policy.getActiveTip()?.code).toBe('CRITICAL_NUMBER');
  });

  it('lets a system alert take the screen from a critical tip', () => {
    const policy = new CoachTipPolicy();
    policy.propose(
      [
        proposal({
          candidate: candidate({ type: 'critical_number_mismatch', localConfidence: 0.9 }),
          authoredTerm: 'fifty percent',
        }),
      ],
      context({ audioTimeMs: 10_000 }),
    );
    const mic = policy.propose(
      [
        proposal({
          candidate: candidate({ evidenceId: 'ev-mic', type: 'system_mic_clipping', localConfidence: 1 }),
        }),
      ],
      context({ audioTimeMs: 10_500 }),
    );
    expect(mic.accepted?.code).toBe('MIC_CLIPPING');
    expect(policy.getActiveTip()?.code).toBe('MIC_CLIPPING');
  });

  it('lets a higher band take the screen immediately', () => {
    const policy = new CoachTipPolicy();
    policy.propose([proposal()], context({ audioTimeMs: 10_000 }));
    expect(policy.getActiveTip()?.code).toBe('PACE_EASE_BACK');
    const critical = policy.propose(
      [
        proposal({
          candidate: candidate({
            evidenceId: 'ev-crit',
            type: 'critical_negation_mismatch',
            localConfidence: 0.9,
          }),
          authoredTerm: 'not available',
        }),
      ],
      context({ audioTimeMs: 10_500 }),
    );
    expect(critical.accepted?.code).toBe('CRITICAL_NEGATION');
    expect(policy.getActiveTip()?.code).toBe('CRITICAL_NEGATION');
  });
});

describe('§26.2 cooldowns applied through the policy', () => {
  it('blocks a second ordinary tip inside the global gap', () => {
    const policy = new CoachTipPolicy();
    policy.propose([proposal()], context({ audioTimeMs: 10_000 }));
    policy.tick(context({ audioTimeMs: 15_000 })); // let the first retire
    const second = policy.propose(
      [proposal({ candidate: candidate({ evidenceId: 'ev-2', type: 'run_on_delivery' }) })],
      context({ audioTimeMs: 15_000 }),
    );
    expect(reasonsOf(second.rejected)).toEqual(['ordinary_gap']);

    const later = policy.propose(
      [proposal({ candidate: candidate({ evidenceId: 'ev-3', type: 'run_on_delivery' }) })],
      context({ audioTimeMs: 20_000 }),
    );
    expect(later.accepted?.code).toBe('LET_BOUNDARY_BREATHE');
  });

  it('opens the §26.2 command-jump window through the policy', () => {
    const policy = new CoachTipPolicy();
    policy.noteSuppressionEvent('command_jump', 9_000);
    expect(
      policy.propose([proposal()], context({ audioTimeMs: 13_999 })).rejected[0]?.reason,
    ).toBe('command_jump_window');
    expect(policy.propose([proposal()], context({ audioTimeMs: 14_000 })).accepted).not.toBeNull();
  });
});

describe('§26.5 cancellation', () => {
  function withVisibleTip() {
    const policy = new CoachTipPolicy();
    const outcome = policy.propose([proposal()], context({ audioTimeMs: 10_000 }));
    // The precondition every case below depends on.
    expect(outcome.displayed).toBe(true);
    expect(policy.getActiveTip()).not.toBeNull();
    return policy;
  }

  it('cancels when the tip’s own evidence is revised away', () => {
    const policy = withVisibleTip();
    // Another id does not touch it…
    expect(policy.cancel('evidence_revised', { evidenceId: 'ev-other' })).toEqual([]);
    expect(policy.getActiveTip()).not.toBeNull();
    // …its own id does.
    const cancelled = policy.cancel('evidence_revised', { evidenceId: 'ev-1' });
    expect(cancelled).toHaveLength(1);
    expect(policy.getActiveTip()).toBeNull();
  });

  it.each(['self_correction', 'command_started', 'retake_started', 'critical_notice'] as const)(
    'cancels an ordinary tip on %s',
    (reason) => {
      const policy = withVisibleTip();
      expect(policy.cancel(reason)).toHaveLength(1);
      expect(policy.getActiveTip()).toBeNull();
    },
  );

  it('does not cancel a system alert for an ordinary-tip reason', () => {
    const policy = new CoachTipPolicy();
    policy.propose(
      [proposal({ candidate: candidate({ type: 'system_mic_clipping', localConfidence: 1 }) })],
      context({ audioTimeMs: 10_000 }),
    );
    expect(policy.getActiveTip()?.code).toBe('MIC_CLIPPING');
    expect(policy.cancel('critical_notice')).toEqual([]);
    expect(policy.getActiveTip()?.code).toBe('MIC_CLIPPING');
    // …but the take ending does cancel it.
    expect(policy.cancel('take_ended')).toHaveLength(1);
    expect(policy.getActiveTip()).toBeNull();
  });

  it('cancels when the active span leaves the tip’s scope', () => {
    const policy = withVisibleTip();
    // Same span: untouched.
    expect(policy.cancel('span_out_of_scope', { activeSpanId: 'span-3' })).toEqual([]);
    expect(policy.getActiveTip()).not.toBeNull();
    expect(policy.cancel('span_out_of_scope', { activeSpanId: 'span-9' })).toHaveLength(1);
    expect(policy.getActiveTip()).toBeNull();
  });

  it('cancels on the next tick when the presenter moves to another span', () => {
    const policy = withVisibleTip();
    // Same span: the tick leaves it up.
    expect(policy.tick(context({ audioTimeMs: 10_500 }))).not.toBeNull();
    // Moved on: gone without the caller having to ask.
    expect(policy.tick(context({ audioTimeMs: 11_000, activeScriptSpanId: 'span-8' }))).toBeNull();
    expect(policy.getActiveTip()).toBeNull();
  });

  it('leaves an unanchored tip alone on a span change', () => {
    const policy = new CoachTipPolicy();
    policy.propose(
      [proposal({ candidate: candidate({ scriptSpanId: null }) })],
      context({ audioTimeMs: 10_000 }),
    );
    expect(policy.getActiveTip()).not.toBeNull();
    expect(policy.cancel('span_out_of_scope', { activeSpanId: 'span-9' })).toEqual([]);
    expect(policy.getActiveTip()).not.toBeNull();
  });

  it.each(['coaching_disabled', 'take_ended'] as const)('cancels everything on %s', (reason) => {
    const policy = withVisibleTip();
    expect(policy.cancel(reason)).toHaveLength(1);
    expect(policy.getActiveTip()).toBeNull();
  });

  it('cancels a queued tip as well as a visible one', () => {
    const policy = new CoachTipPolicy();
    policy.propose([proposal()], context({ audioTimeMs: 10_000, safeMoment: false }));
    expect(policy.getPendingTip()).not.toBeNull();
    expect(policy.cancel('retake_started')).toHaveLength(1);
    expect(policy.getPendingTip()).toBeNull();
    // …and it does not later appear at the next safe moment.
    expect(policy.tick(context({ audioTimeMs: 11_000 }))).toBeNull();
  });

  it('turning coaching off clears the rail and admits nothing further', () => {
    const policy = withVisibleTip();
    const outcome = policy.propose(
      [proposal({ candidate: candidate({ evidenceId: 'ev-2' }) })],
      context({ audioTimeMs: 30_000, coachingEnabled: false }),
    );
    expect(policy.getActiveTip()).toBeNull();
    expect(reasonsOf(outcome.rejected)).toEqual(['coaching_disabled']);
  });
});

describe('the copy boundary at the policy', () => {
  it('emits a text key and only allowlisted interpolations', () => {
    const policy = new CoachTipPolicy();
    const tip = policy.propose(
      [
        proposal({
          candidate: candidate({
            type: 'repeated_filler',
            localConfidence: 0.9,
            // Prose in the fragments is used for classification only (§22).
            spokenFragment: 'um, so I think what I mean is we should really ship this',
            authoredFragment: 'we should ship this',
          }),
          filler: 'um',
        }),
      ],
      context({ audioTimeMs: 10_000 }),
    ).accepted;

    expect(tip?.textKey).toBe('coach.tip.REPEATED_FILLER');
    expect(tip?.interpolations).toEqual({ filler: 'um' });
    expect(JSON.stringify(tip)).not.toContain('I think what I mean');
  });

  it('never quotes a form outside the §25.3 allowlist', () => {
    const policy = new CoachTipPolicy();
    const tip = policy.propose(
      [
        proposal({
          candidate: candidate({ type: 'repeated_filler', localConfidence: 0.9 }),
          filler: 'you know what I mean',
        }),
      ],
      context({ audioTimeMs: 10_000 }),
    ).accepted;

    expect(tip?.code).toBe('USE_SILENT_PAUSE');
    expect(tip?.interpolations).toEqual({});
    expect(JSON.stringify(tip)).not.toContain('you know');
  });

  it('carries no navigation, scroll, cursor or section field (§2.1)', () => {
    const policy = new CoachTipPolicy();
    const tip = policy.propose([proposal()], context({ audioTimeMs: 10_000 })).accepted;
    expect(tip).not.toBeNull();
    for (const forbidden of [
      'scroll',
      'offset',
      'cursor',
      'unitIndex',
      'sectionId',
      'position',
      'navigate',
      'jump',
      'velocity',
    ]) {
      expect(Object.keys(tip ?? {})).not.toContain(forbidden);
    }
  });

  /* -------------------------------------------------------------------------
   * §37 accounting
   * ---------------------------------------------------------------------- */

  /**
   * `tipsShown / tipsProposed` is the ratio the contract advertises as the one
   * that tells you the rail is too chatty, and `tipsSuppressed` used to include
   * the ranking losers — added on the *success* path, so a window where one tip
   * beat two others recorded three suppressions and one showing. The two
   * diagnoses are opposites: "the rail refuses most of what it finds" and "the
   * rail found more than it could fit".
   */
  it('§37: counts ranking losers apart from rule-based suppression', () => {
    const policy = new CoachTipPolicy();
    const outcome = policy.propose(
      [
        proposal({ candidate: candidate({ evidenceId: 'a', type: 'critical_number_mismatch' }) }),
        proposal({ candidate: candidate({ evidenceId: 'b', type: 'pace_too_fast' }) }),
        proposal({ candidate: candidate({ evidenceId: 'c', type: 'low_variety' }) }),
      ],
      context({ audioTimeMs: 10_000 }),
    );
    expect(outcome.displayed).toBe(true);
    expect(outcome.rejected.map((r) => r.reason)).toEqual(['not_selected', 'not_selected']);

    const counters = policy.getCounters();
    expect(counters).toEqual({ proposed: 3, shown: 1, suppressed: 0, notSelected: 2 });
  });

  it('§37: counts a proposal a rule refused as suppressed', () => {
    const policy = new CoachTipPolicy();
    policy.propose(
      [proposal({ candidate: candidate({ localConfidence: 0.1 }) })],
      context({ audioTimeMs: 10_000 }),
    );
    expect(policy.getCounters()).toEqual({
      proposed: 1,
      shown: 0,
      suppressed: 1,
      notSelected: 0,
    });
  });

  it('§37: the master switch counts what it refused', () => {
    const policy = new CoachTipPolicy();
    policy.propose([proposal(), proposal()], context({ audioTimeMs: 10_000, coachingEnabled: false }));
    // This branch used to bump `proposed` and return without touching
    // `suppressed`, so the two silently stopped agreeing.
    expect(policy.getCounters()).toEqual({
      proposed: 2,
      shown: 0,
      suppressed: 2,
      notSelected: 0,
    });
  });
});
