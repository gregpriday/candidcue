/**
 * SemanticFrameReceiver accept/reject matrix (companion §26.1).
 */
import { describe, it, expect } from 'vitest';
import type { SemanticMotionFrame } from '../../../src/shared/contracts';
import { createSemanticFrameReceiver } from '../../../src/stage/motion';

function frame(overrides: Partial<SemanticMotionFrame> = {}): SemanticMotionFrame {
  return {
    sessionId: 'session-a',
    sessionGeneration: 3,
    scriptCompileHash: 'hash-a',
    layoutGeneration: 7,
    revision: 10,
    epoch: 2,
    sessionTimeMs: 1000,
    estimatedUnit: 120,
    committedUnit: 118,
    velocityUnitsPerSecond: 3.2,
    accelerationUnitsPerSecond2: 0,
    positionVariance: 0.4,
    confidence: 0.9,
    sectionId: 'section:0',
    tokenIndex: 120,
    sentenceId: 's1',
    blockId: 'b1',
    state: 'following',
    behavior: 'normal',
    finalEvidence: true,
    motionProfileId: 'default-v1',
    ...overrides,
  };
}

function receiver() {
  return createSemanticFrameReceiver({
    gate: {
      sessionId: 'session-a',
      sessionGeneration: 3,
      scriptCompileHash: 'hash-a',
      layoutGeneration: 7,
    },
    layoutGraceMs: 500,
  });
}

describe('frame gating (§26.1)', () => {
  it('accepts a matching frame and caches it', () => {
    const r = receiver();
    expect(r.accept(frame(), 0).accepted).toBe(true);
    expect(r.current?.revision).toBe(10);
    expect(r.stats.accepted).toBe(1);
  });

  it.each([
    ['session', { sessionId: 'other' }],
    ['session_generation', { sessionGeneration: 4 }],
    ['script_hash', { scriptCompileHash: 'hash-b' }],
    ['layout_generation', { layoutGeneration: 8 }],
  ] as const)('rejects a %s mismatch', (reason, overrides) => {
    const r = receiver();
    const outcome = r.accept(frame(overrides), 0);
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe(reason);
    expect(r.current).toBeNull();
    expect(r.stats.byReason[reason]).toBe(1);
  });

  it('rejects malformed payloads without throwing', () => {
    const r = receiver();
    expect(r.accept({} as SemanticMotionFrame, 0).reason).toBe('malformed');
    expect(r.accept(frame({ estimatedUnit: Number.NaN }), 0).reason).toBe('malformed');
  });

  it('enforces revision monotonicity inside one epoch', () => {
    const r = receiver();
    expect(r.accept(frame({ revision: 10 }), 0).accepted).toBe(true);
    expect(r.accept(frame({ revision: 10 }), 1).reason).toBe('revision');
    expect(r.accept(frame({ revision: 9 }), 2).reason).toBe('revision');
    expect(r.accept(frame({ revision: 11 }), 3).accepted).toBe(true);
    expect(r.current?.revision).toBe(11);
  });

  it('lets a newer epoch supersede revision history, and drops an older one', () => {
    const r = receiver();
    r.accept(frame({ revision: 500, epoch: 2 }), 0);
    // A command/manual navigation restarts revisions under a new epoch.
    expect(r.accept(frame({ revision: 1, epoch: 3 }), 1).accepted).toBe(true);
    expect(r.accept(frame({ revision: 900, epoch: 2 }), 2).reason).toBe('epoch');
    expect(r.current?.epoch).toBe(3);
  });

  it('skips the script hash check when either side does not assert one', () => {
    const r = createSemanticFrameReceiver({
      gate: {
        sessionId: 'session-a',
        sessionGeneration: 3,
        scriptCompileHash: '',
        layoutGeneration: 7,
      },
    });
    expect(r.accept(frame({ scriptCompileHash: 'anything' }), 0).accepted).toBe(true);
  });
});

describe('layout generation handling (§33)', () => {
  it('rejects stale-layout frames during the grace window, then tolerates them', () => {
    const r = receiver();
    r.setGate({ layoutGeneration: 8 }, 1000);

    const stale = frame({ layoutGeneration: 7, revision: 20 });
    expect(r.accept(stale, 1100).reason).toBe('layout_generation');
    // Past the grace window the semantic content is still usable: holding the
    // stage indefinitely is worse than following a layout-independent unit.
    const accepted = r.accept(frame({ layoutGeneration: 7, revision: 21 }), 2000);
    expect(accepted.accepted).toBe(true);
    expect(accepted.tolerated).toBe('layout_generation');
    expect(r.stats.toleratedStaleLayout).toBe(1);
  });

  it('never accepts a frame from a layout generation we have not built yet', () => {
    const r = receiver();
    expect(r.accept(frame({ layoutGeneration: 99 }), 99999).reason).toBe('layout_generation');
  });

  it('reset() clears the cached frame and revision baseline', () => {
    const r = receiver();
    r.accept(frame({ revision: 40 }), 0);
    r.reset();
    expect(r.current).toBeNull();
    expect(r.accept(frame({ revision: 1 }), 1).accepted).toBe(true);
  });
});
