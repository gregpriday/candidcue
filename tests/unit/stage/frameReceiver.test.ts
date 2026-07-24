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

  it('skips the script hash check when the STAGE does not assert one', () => {
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

  it('rejects an incomplete hash rather than weakening the identity gate (C1)', () => {
    // The stage asserts a hash; a frame that omits one is an INCOMPLETE claim,
    // not a licence to skip the check.
    const r = receiver();
    expect(r.accept(frame({ scriptCompileHash: '' }), 0).reason).toBe('script_hash');
    expect(r.current).toBeNull();
  });
});

/**
 * C1 — the stage does not trust control.
 *
 * The motion plant is persistent for the life of the session, so ONE frame
 * carrying a non-finite value in any numeric field poisons prediction → target
 * → acceleration → velocity → position, and every later frame renders
 * `translate3d(0, NaNpx, 0)` forever. `layoutGeneration: NaN` was the live
 * example: `NaN !== gen` entered the mismatch branch, `NaN > gen` was false, and
 * the frame was "tolerated" as stale.
 */
describe('hostile and defective frames (C1)', () => {
  const NUMERIC_FIELDS = [
    'sessionGeneration',
    'layoutGeneration',
    'revision',
    'epoch',
    'sessionTimeMs',
    'estimatedUnit',
    'committedUnit',
    'velocityUnitsPerSecond',
    'accelerationUnitsPerSecond2',
    'positionVariance',
    'confidence',
    'tokenIndex',
  ] as const;

  it.each(NUMERIC_FIELDS)('rejects a frame carrying NaN in %s', (field) => {
    const r = receiver();
    const outcome = r.accept(frame({ [field]: Number.NaN } as never), 0);
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe('malformed');
    expect(outcome.field).toBe(field);
    expect(outcome.tolerated).toBeUndefined();
    expect(r.current).toBeNull();
  });

  it.each(NUMERIC_FIELDS)('rejects a frame carrying Infinity in %s', (field) => {
    const r = receiver();
    expect(r.accept(frame({ [field]: Number.POSITIVE_INFINITY } as never), 0).reason).toBe(
      'malformed',
    );
    expect(r.accept(frame({ [field]: Number.NEGATIVE_INFINITY } as never), 0).reason).toBe(
      'malformed',
    );
  });

  it('never reports a NaN layout generation as a tolerated stale layout', () => {
    const r = receiver();
    r.setGate({ layoutGeneration: 8 }, 0);
    const outcome = r.accept(frame({ layoutGeneration: Number.NaN }), 999999);
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe('malformed');
    expect(r.stats.toleratedStaleLayout).toBe(0);
  });

  it.each([
    ['sessionGeneration', 3.5],
    ['layoutGeneration', 7.25],
    ['revision', 10.5],
    ['epoch', 2.5],
    ['tokenIndex', 120.5],
  ] as const)('requires an exact integer for %s', (field, value) => {
    const r = receiver();
    expect(r.accept(frame({ [field]: value } as never), 0).reason).toBe('malformed');
  });

  it.each([
    ['state', 'sprinting'],
    ['behavior', 'vibing'],
    ['sessionId', 42],
    ['blockId', null],
    ['finalEvidence', 'yes'],
  ] as const)('rejects a bad %s', (field, value) => {
    const r = receiver();
    const outcome = r.accept(frame({ [field]: value } as never), 0);
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe('malformed');
    expect(outcome.field).toBe(field);
  });

  it('validates the nested transition directive too', () => {
    const sound = {
      id: 't1',
      type: 'reanchor',
      authority: 'ordinary',
      fromUnit: 1,
      toUnit: 2,
      destinationTokenIndex: 40,
      issuedAtMs: 0,
      expiresAtMs: 5000,
      semanticEpoch: 2,
      reason: 'large_forward_skip',
    } as const;
    expect(receiver().accept(frame({ transition: { ...sound } }), 0).accepted).toBe(true);

    for (const [field, value] of [
      ['toUnit', Number.NaN],
      ['destinationTokenIndex', Number.NaN],
      ['destinationTokenIndex', 40.5],
      ['semanticEpoch', Number.POSITIVE_INFINITY],
      ['expiresAtMs', Number.NaN],
      ['type', 'teleport'],
      ['authority', 'root'],
      ['reason', 'because'],
      ['id', ''],
    ] as const) {
      const r = receiver();
      const outcome = r.accept(
        frame({ transition: { ...sound, [field]: value } as never }),
        0,
      );
      expect(outcome.accepted, `transition.${field} = ${String(value)}`).toBe(false);
      expect(outcome.reason).toBe('malformed');
      expect(outcome.field).toBe(`transition.${field}`);
    }
  });

  it('does not let a rejected frame disturb the accepted one', () => {
    const r = receiver();
    r.accept(frame({ revision: 10 }), 0);
    r.accept(frame({ revision: 11, velocityUnitsPerSecond: Number.NaN }), 1);
    expect(r.current?.revision).toBe(10);
    // The revision baseline is untouched, so the next sound frame still lands.
    expect(r.accept(frame({ revision: 11 }), 2).accepted).toBe(true);
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
