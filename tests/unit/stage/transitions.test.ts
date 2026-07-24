/**
 * StageTransitionController (companion §53, §26.3).
 */
import { describe, it, expect } from 'vitest';
import type { StageTransitionDirective } from '../../../src/shared/contracts';
import { createStageTransitionController } from '../../../src/stage/motion';

function directive(overrides: Partial<StageTransitionDirective> = {}): StageTransitionDirective {
  return {
    id: 'd1',
    type: 'catch_up',
    authority: 'ordinary',
    fromUnit: 100,
    toUnit: 140,
    destinationTokenIndex: 140,
    issuedAtMs: 1000,
    expiresAtMs: 3000,
    semanticEpoch: 2,
    reason: 'large_forward_skip',
    ...overrides,
  };
}

describe('directive lifecycle (§53)', () => {
  it('applies a directive exactly once per id, however many frames carry it', () => {
    const c = createStageTransitionController();
    expect(c.submit(directive(), 1000).accepted).toBe(true);
    for (let i = 0; i < 20; i++) {
      const outcome = c.submit(directive(), 1000 + i);
      expect(outcome.accepted).toBe(false);
      if (!outcome.accepted) expect(outcome.reason).toBe('duplicate');
    }
    expect(c.active?.directive.id).toBe('d1');
  });

  it('ignores `none` and already-expired directives', () => {
    const c = createStageTransitionController();
    const none = c.submit(directive({ type: 'none' }), 1000);
    expect(none.accepted).toBe(false);
    const expired = c.submit(directive({ id: 'd2', expiresAtMs: 900 }), 1000);
    expect(expired.accepted).toBe(false);
    if (!expired.accepted) expect(expired.reason).toBe('expired');
  });

  it('keeps only one active transition and honours authority', () => {
    const c = createStageTransitionController();
    c.submit(directive({ id: 'cmd', authority: 'command' }), 1000);
    const ordinary = c.submit(directive({ id: 'ord', authority: 'ordinary' }), 1010);
    expect(ordinary.accepted).toBe(false);
    if (!ordinary.accepted) expect(ordinary.reason).toBe('authority');
    // Manual outranks command.
    expect(c.submit(directive({ id: 'man', authority: 'manual' }), 1020).accepted).toBe(true);
    expect(c.active?.directive.id).toBe('man');
  });

  it('drops directives from a superseded epoch', () => {
    const c = createStageTransitionController();
    c.submit(directive({ id: 'new', semanticEpoch: 5 }), 1000);
    c.complete('new');
    const late = c.submit(directive({ id: 'late', semanticEpoch: 4 }), 1010);
    expect(late.accepted).toBe(false);
    if (!late.accepted) expect(late.reason).toBe('stale_epoch');
  });

  it('expires the active transition at its deadline', () => {
    const c = createStageTransitionController();
    c.submit(directive({ expiresAtMs: 2000 }), 1000);
    c.update(1999);
    expect(c.active).not.toBeNull();
    c.update(2000);
    expect(c.active).toBeNull();
  });
});

describe('plant-state authority (§26.3)', () => {
  it('grants an overwrite token exactly once for a reanchor', () => {
    const c = createStageTransitionController();
    c.submit(directive({ id: 'r1', type: 'reanchor', reason: 'distant_retake' }), 1000);
    expect(c.consumePlantOverwrite()?.id).toBe('r1');
    expect(c.consumePlantOverwrite()).toBeNull();
  });

  it('grants one for a reset too', () => {
    const c = createStageTransitionController();
    c.submit(directive({ id: 'r2', type: 'reset', reason: 'session_reset' }), 1000);
    expect(c.consumePlantOverwrite()?.type).toBe('reset');
  });

  it('never grants one for settle, catch_up, or rewind', () => {
    for (const type of ['settle', 'catch_up', 'rewind'] as const) {
      const c = createStageTransitionController();
      c.submit(directive({ id: type, type }), 1000);
      expect(c.consumePlantOverwrite()).toBeNull();
    }
  });

  it('forgets old ids beyond the history window so it cannot grow unbounded', () => {
    const c = createStageTransitionController({ historySize: 4 });
    for (let i = 0; i < 10; i++) {
      c.submit(directive({ id: `d${i}`, semanticEpoch: 2 }), 1000 + i);
      c.complete(`d${i}`);
    }
    expect(c.seenIds).toBeLessThanOrEqual(4);
  });
});
