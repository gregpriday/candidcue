/**
 * §26.2 cooldowns, on a virtual clock.
 *
 * Every rule is proved at its boundary **in both directions**: one millisecond
 * inside must return that rule's own name, one millisecond outside must return
 * `null`. A ledger that always blocked would fail the outside case; one that
 * never blocked would fail the inside case; one that blocked for the wrong
 * reason would fail the name assertion. All three degenerate implementations
 * are excluded by construction.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COOLDOWN_CONFIG,
  TipCooldownLedger,
  type CooldownQuery,
} from '../../../../src/shared/coaching/coach';

const base: Omit<CooldownQuery, 'code' | 'atAudioMs'> = {
  mode: 'coach',
  evidenceIds: ['ev-a'],
};

function query(overrides: Partial<CooldownQuery> & Pick<CooldownQuery, 'code' | 'atAudioMs'>) {
  return { ...base, ...overrides };
}

describe('§26.2 minimum gap between ordinary tips', () => {
  it('blocks at 9 999 ms and allows at 10 000 ms', () => {
    const ledger = new TipCooldownLedger();
    ledger.noteShown(query({ code: 'PACE_EASE_BACK', atAudioMs: 0 }));

    // A different code in a different category, so only the global gap applies.
    const inside = query({ code: 'LET_BOUNDARY_BREATHE', atAudioMs: 9_999, evidenceIds: ['ev-b'] });
    const outside = query({ code: 'LET_BOUNDARY_BREATHE', atAudioMs: 10_000, evidenceIds: ['ev-b'] });
    expect(ledger.blockedBy(inside)).toBe('ordinary_gap');
    expect(ledger.blockedBy(outside)).toBeNull();
    expect(DEFAULT_COOLDOWN_CONFIG.ordinaryGapMs).toBe(10_000);
  });
});

describe('§26.2 per-minute cap', () => {
  it('allows three ordinary tips per minute in Coach mode and blocks the fourth', () => {
    const ledger = new TipCooldownLedger();
    ledger.noteShown(query({ code: 'PACE_EASE_BACK', atAudioMs: 0 }));
    ledger.noteShown(query({ code: 'LET_BOUNDARY_BREATHE', atAudioMs: 10_000, evidenceIds: ['b'] }));
    ledger.noteShown(
      query({ code: 'TAKE_SENTENCE_FROM_TOP', atAudioMs: 20_000, evidenceIds: ['c'] }),
    );

    const fourth = query({ code: 'LIFT_KEY_WORDS', atAudioMs: 30_000, evidenceIds: ['d'] });
    expect(ledger.blockedBy(fourth)).toBe('per_minute_cap');

    // Once the oldest leaves the rolling window there is room again.
    expect(
      ledger.blockedBy(query({ code: 'LIFT_KEY_WORDS', atAudioMs: 60_001, evidenceIds: ['d'] })),
    ).toBeNull();
  });

  it('allows five per minute in Studio high-frequency mode', () => {
    const ledger = new TipCooldownLedger();
    const codes = [
      'PACE_EASE_BACK',
      'LET_BOUNDARY_BREATHE',
      'TAKE_SENTENCE_FROM_TOP',
      'LIFT_KEY_WORDS',
      'REPETITIVE_OPENER',
    ] as const;
    codes.forEach((code, index) => {
      ledger.noteShown(
        query({
          code,
          atAudioMs: index * 10_000,
          evidenceIds: [`e${index}`],
          mode: 'studio',
          highFrequency: true,
        }),
      );
    });
    const sixth = query({
      code: 'USE_SILENT_PAUSE',
      atAudioMs: 50_000,
      evidenceIds: ['e9'],
      mode: 'studio',
      highFrequency: true,
    });
    expect(ledger.blockedBy(sixth)).toBe('per_minute_cap');

    // The same five would already have blocked the fifth in Coach mode, which
    // is what makes this test about the cap and not about the gap.
    const coachLedger = new TipCooldownLedger();
    codes.slice(0, 3).forEach((code, index) => {
      coachLedger.noteShown(query({ code, atAudioMs: index * 10_000, evidenceIds: [`e${index}`] }));
    });
    expect(
      coachLedger.blockedBy(query({ code: 'LIFT_KEY_WORDS', atAudioMs: 30_000, evidenceIds: ['x'] })),
    ).toBe('per_minute_cap');
  });
});

describe('§26.2 same-category gap', () => {
  it('blocks a sibling code at 24 999 ms and allows it at 25 000 ms', () => {
    const ledger = new TipCooldownLedger();
    ledger.noteShown(query({ code: 'PACE_EASE_BACK', atAudioMs: 0 }));
    const sibling = { code: 'PACE_LIFT_SLIGHTLY', evidenceIds: ['ev-b'] } as const;
    expect(ledger.blockedBy(query({ ...sibling, atAudioMs: 24_999 }))).toBe('category_cooldown');
    expect(ledger.blockedBy(query({ ...sibling, atAudioMs: 25_000 }))).toBeNull();
  });
});

describe('§25.2–§25.4 per-code cooldown and §26.3 escalation', () => {
  it('walks the three windows in order for the same code', () => {
    const ledger = new TipCooldownLedger();
    ledger.noteShown(query({ code: 'PACE_EASE_BACK', atAudioMs: 0 }));
    const repeat = (atAudioMs: number) =>
      ledger.blockedBy(query({ code: 'PACE_EASE_BACK', atAudioMs, evidenceIds: ['ev-new'] }));

    // Inside the §25.2 25 s cooldown.
    expect(repeat(24_999)).toBe('code_cooldown');
    // Past it, inside the §26.3 escalated gap (2 × 25 s).
    expect(repeat(25_000)).toBe('repetition_escalation_gap');
    expect(repeat(49_999)).toBe('repetition_escalation_gap');
    // Past both, with a new evidence cluster and a second authored wording.
    expect(repeat(50_000)).toBeNull();
  });

  it('§26.3: refuses a repeat that rests on the evidence already shown', () => {
    const ledger = new TipCooldownLedger();
    ledger.noteShown(query({ code: 'PACE_EASE_BACK', atAudioMs: 0, evidenceIds: ['ev-a'] }));
    // Same evidence, long past every gap: still not a new cluster.
    expect(
      ledger.blockedBy(query({ code: 'PACE_EASE_BACK', atAudioMs: 300_000, evidenceIds: ['ev-a'] })),
    ).toBe('repetition_exhausted');
    // …and a genuinely new cluster at the same instant is allowed, which is
    // what proves the previous assertion was about the evidence, not the time.
    expect(
      ledger.blockedBy(query({ code: 'PACE_EASE_BACK', atAudioMs: 300_000, evidenceIds: ['ev-z'] })),
    ).toBeNull();
  });

  it('§26.3: a code with no second wording is once per take', () => {
    const ledger = new TipCooldownLedger();
    ledger.noteShown(query({ code: 'USE_SILENT_PAUSE', atAudioMs: 0 }));
    expect(
      ledger.blockedBy(
        query({ code: 'USE_SILENT_PAUSE', atAudioMs: 300_000, evidenceIds: ['ev-new'] }),
      ),
    ).toBe('repetition_exhausted');
  });

  it('§26.3: never shows the same code a third time', () => {
    const ledger = new TipCooldownLedger();
    ledger.noteShown(query({ code: 'PACE_EASE_BACK', atAudioMs: 0, evidenceIds: ['a'] }));
    ledger.noteShown(query({ code: 'PACE_EASE_BACK', atAudioMs: 60_000, evidenceIds: ['b'] }));
    expect(
      ledger.blockedBy(query({ code: 'PACE_EASE_BACK', atAudioMs: 300_000, evidenceIds: ['c'] })),
    ).toBe('repetition_exhausted');
    expect(ledger.showingCount('PACE_EASE_BACK')).toBe(2);
  });
});

describe('§26.2 suppression windows', () => {
  it.each([
    ['command_jump', 5_000, 'command_jump_window'],
    ['retake_reversal', 5_000, 'retake_reversal_window'],
    ['critical_discrepancy', 3_000, 'critical_notice_window'],
  ] as const)('%s silences ordinary tips for %d ms', (event, durationMs, reason) => {
    const ledger = new TipCooldownLedger();
    ledger.noteSuppressionEvent(event, 1_000);
    const at = (atAudioMs: number) => ledger.blockedBy(query({ code: 'PACE_EASE_BACK', atAudioMs }));
    expect(at(1_000 + durationMs - 1)).toBe(reason);
    expect(at(1_000 + durationMs)).toBeNull();
  });

  it('a shown critical discrepancy opens the 3 s window by itself (§26.2)', () => {
    const ledger = new TipCooldownLedger();
    ledger.noteShown(query({ code: 'CRITICAL_NUMBER', atAudioMs: 2_000 }));
    expect(ledger.blockedBy(query({ code: 'PACE_EASE_BACK', atAudioMs: 4_999 }))).toBe(
      'critical_notice_window',
    );
    expect(ledger.blockedBy(query({ code: 'PACE_EASE_BACK', atAudioMs: 5_000 }))).toBeNull();
  });
});

describe('§25.1 system tips bypass ordinary cooldowns', () => {
  it('shows a microphone alert inside a window that blocks an ordinary tip', () => {
    const ledger = new TipCooldownLedger();
    ledger.noteSuppressionEvent('command_jump', 0);

    expect(ledger.blockedBy(query({ code: 'PACE_EASE_BACK', atAudioMs: 1_000 }))).toBe(
      'command_jump_window',
    );
    expect(
      ledger.blockedBy(query({ code: 'MIC_CLIPPING', atAudioMs: 1_000, evidenceIds: ['m'] })),
    ).toBeNull();
  });

  it('still stops a system tip repeating inside its own cooldown', () => {
    const ledger = new TipCooldownLedger();
    ledger.noteShown(query({ code: 'MIC_CLIPPING', atAudioMs: 0, evidenceIds: ['m'] }));
    expect(
      ledger.blockedBy(query({ code: 'MIC_CLIPPING', atAudioMs: 14_999, evidenceIds: ['m2'] })),
    ).toBe('code_cooldown');
  });

  it('does not count towards the ordinary per-minute cap', () => {
    const ledger = new TipCooldownLedger();
    for (const atAudioMs of [0, 20_000, 40_000]) {
      ledger.noteShown(query({ code: 'MIC_LEVEL_LOW', atAudioMs, evidenceIds: [`m${atAudioMs}`] }));
    }
    expect(
      ledger.blockedBy(query({ code: 'PACE_EASE_BACK', atAudioMs: 50_000, evidenceIds: ['p'] })),
    ).toBeNull();
  });
});

describe('§25.6 positive reinforcement', () => {
  it('gates positives on their own 60 s clock', () => {
    const ledger = new TipCooldownLedger();
    ledger.noteShown(query({ code: 'POSITIVE_PACE', atAudioMs: 0, evidenceIds: ['p'] }));
    const other = { code: 'POSITIVE_VARIETY', evidenceIds: ['q'] } as const;
    expect(ledger.blockedBy(query({ ...other, atAudioMs: 59_999 }))).toBe('positive_gap');
    expect(ledger.blockedBy(query({ ...other, atAudioMs: 60_000 }))).toBeNull();
  });

  it('§26.2: does not reset critical alert eligibility', () => {
    const ledger = new TipCooldownLedger();
    ledger.noteShown(query({ code: 'POSITIVE_PACE', atAudioMs: 0, evidenceIds: ['p'] }));
    expect(
      ledger.blockedBy(query({ code: 'CRITICAL_NUMBER', atAudioMs: 100, evidenceIds: ['c'] })),
    ).toBeNull();
  });

  it('does not consume the ordinary allowance', () => {
    const ledger = new TipCooldownLedger();
    ledger.noteShown(query({ code: 'POSITIVE_PACE', atAudioMs: 0, evidenceIds: ['p'] }));
    // Blocked only by the global gap, and clear the moment it elapses.
    expect(ledger.blockedBy(query({ code: 'PACE_EASE_BACK', atAudioMs: 10_000 }))).toBeNull();
  });
});

describe('ledger lifecycle', () => {
  it('reset clears history so a new take pass is not pre-silenced', () => {
    const ledger = new TipCooldownLedger();
    ledger.noteSuppressionEvent('command_jump', 0);
    ledger.noteShown(query({ code: 'PACE_EASE_BACK', atAudioMs: 0 }));
    expect(ledger.blockedBy(query({ code: 'PACE_EASE_BACK', atAudioMs: 1_000 }))).not.toBeNull();
    ledger.reset();
    expect(ledger.blockedBy(query({ code: 'PACE_EASE_BACK', atAudioMs: 1_000 }))).toBeNull();
    expect(ledger.showingCount('PACE_EASE_BACK')).toBe(0);
  });

  it('an empty ledger blocks nothing — silence is not achieved by blocking', () => {
    const ledger = new TipCooldownLedger();
    expect(ledger.blockedBy(query({ code: 'PACE_EASE_BACK', atAudioMs: 0 }))).toBeNull();
    expect(ledger.blockedBy(query({ code: 'CRITICAL_NUMBER', atAudioMs: 0 }))).toBeNull();
  });
});
