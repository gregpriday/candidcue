/**
 * Semantic motion frames, transition directives, and the "why did it move?"
 * record (companion §26.1, §53, §65).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SMOOTH_FOLLOW_PROFILE } from '../../../src/shared/contracts/smooth-follow';
import type { SemanticMotionFrame } from '../../../src/shared/contracts/smooth-follow';
import { MovementDecisionLog } from '../../../src/shared/tracking/decision-log';
import { AlignmentEngine } from '../../../src/shared/tracking/engine';
import {
  directiveTypeFor,
  SemanticFrameEmitter,
  TransitionDirectiveManager,
  type FrameInput,
} from '../../../src/shared/tracking/motion-frame';
import { DEFAULT_TRACKING_PROFILE } from '../../../src/shared/tracking/profile';
import { demoDocument } from '../../fixtures/alignment/fixture-script';
import { TranscriptScripter } from '../../fixtures/transcript-events/builder';

const profile = DEFAULT_TRACKING_PROFILE;
const smooth = DEFAULT_SMOOTH_FOLLOW_PROFILE;

function frameInput(overrides?: Partial<FrameInput>): FrameInput {
  return {
    sessionId: 's',
    sessionGeneration: 1,
    scriptCompileHash: 'hash',
    layoutGeneration: 1,
    epoch: 0,
    sessionTimeMs: 0,
    estimatedUnit: 0,
    committedUnit: 0,
    velocityUnitsPerSecond: 0,
    accelerationUnitsPerSecond2: 0,
    positionVariance: 0,
    confidence: 0.9,
    sectionId: 'h0',
    tokenIndex: 0,
    sentenceId: 's0',
    blockId: 'b0',
    state: 'following',
    behavior: 'normal',
    finalEvidence: true,
    motionProfileId: smooth.id,
    ...overrides,
  };
}

function engine(id: string): AlignmentEngine {
  return new AlignmentEngine(demoDocument(), {
    sessionId: id,
    sessionGeneration: 1,
    stageGeneration: 1,
    layoutGeneration: 1,
  });
}

describe('SemanticFrameEmitter (companion §26.1)', () => {
  it('revisions are strictly monotonic and every value is finite', () => {
    const emitter = new SemanticFrameEmitter(profile, smooth);
    let previous = 0;
    for (let t = 0; t < 20; t++) {
      const frame = emitter.emit(
        frameInput({
          sessionTimeMs: t * 40,
          estimatedUnit: t * 1.3,
          // Deliberately feed poison; the emitter must sanitize it.
          velocityUnitsPerSecond: t === 5 ? Number.NaN : 2,
          positionVariance: t === 7 ? Number.POSITIVE_INFINITY : 1,
          confidence: t === 9 ? 5 : 0.8,
        }),
      );
      expect(frame.revision).toBeGreaterThan(previous);
      previous = frame.revision;
      expect(Number.isFinite(frame.estimatedUnit)).toBe(true);
      expect(Number.isFinite(frame.velocityUnitsPerSecond)).toBe(true);
      expect(Number.isFinite(frame.positionVariance)).toBe(true);
      expect(frame.confidence).toBeGreaterThanOrEqual(0);
      expect(frame.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('caps the changing-value rate at maxFramesPerSecond', () => {
    const emitter = new SemanticFrameEmitter(profile, smooth);
    emitter.emit(frameInput({ sessionTimeMs: 0 }));
    const minInterval = 1000 / profile.maxFramesPerSecond;
    expect(
      emitter.shouldEmit(frameInput({ sessionTimeMs: minInterval / 2, estimatedUnit: 9 }), false),
    ).toBe(false);
    expect(
      emitter.shouldEmit(frameInput({ sessionTimeMs: minInterval + 1, estimatedUnit: 9 }), false),
    ).toBe(true);
  });

  it('emits a slow heartbeat while values are held (§26.1)', () => {
    const emitter = new SemanticFrameEmitter(profile, smooth);
    emitter.emit(frameInput({ sessionTimeMs: 0 }));
    const held = frameInput({ sessionTimeMs: 100 });
    expect(emitter.shouldEmit(held, false)).toBe(false);
    expect(
      emitter.shouldEmit(frameInput({ sessionTimeMs: profile.heldFrameIntervalMs + 1 }), false),
    ).toBe(true);
  });

  it('always emits on a state or behavior change', () => {
    const emitter = new SemanticFrameEmitter(profile, smooth);
    emitter.emit(frameInput({ sessionTimeMs: 0 }));
    const changed = frameInput({ sessionTimeMs: 40, state: 'adlib_hold', behavior: 'adlib' });
    expect(emitter.shouldEmit(changed, false)).toBe(true);
  });

  it('keeps revisions increasing across a reset so no frame looks stale', () => {
    const emitter = new SemanticFrameEmitter(profile, smooth);
    const before = emitter.emit(frameInput({ sessionTimeMs: 0 })).revision;
    emitter.reset();
    expect(emitter.emit(frameInput({ sessionTimeMs: 10 })).revision).toBeGreaterThan(before);
  });
});

describe('TransitionDirectiveManager (companion §53)', () => {
  const request = (overrides?: Partial<Parameters<TransitionDirectiveManager['issue']>[0]>) => ({
    type: 'reanchor' as const,
    authority: 'ordinary' as const,
    reason: 'large_forward_skip' as const,
    fromUnit: 0,
    toUnit: 50,
    destinationTokenIndex: 40,
    issuedAtMs: 1000,
    semanticEpoch: 2,
    ...overrides,
  });

  it('issues one directive at a time and is idempotent by destination', () => {
    const manager = new TransitionDirectiveManager(profile);
    const first = manager.issue(request());
    expect(first).toBeDefined();
    const again = manager.issue(request({ issuedAtMs: 1100 }));
    expect(again?.id).toBe(first?.id); // same id → the stage must not re-run it
  });

  it('rejects a competing ordinary directive while one is live', () => {
    const manager = new TransitionDirectiveManager(profile);
    manager.issue(request());
    expect(manager.issue(request({ destinationTokenIndex: 90, issuedAtMs: 1100 }))).toBeUndefined();
  });

  it('authoritative directives supersede an in-flight ordinary one', () => {
    const manager = new TransitionDirectiveManager(profile);
    const ordinary = manager.issue(request());
    const command = manager.issue(
      request({
        authority: 'command',
        reason: 'command_navigation',
        destinationTokenIndex: 120,
        issuedAtMs: 1100,
      }),
    );
    expect(command?.id).not.toBe(ordinary?.id);
    expect(manager.active(1100)?.id).toBe(command?.id);
  });

  it('expires rather than lingering, and is epoch-stamped', () => {
    const manager = new TransitionDirectiveManager(profile);
    const directive = manager.issue(request());
    expect(directive?.semanticEpoch).toBe(2);
    expect(manager.active(1000 + profile.transitionTtlMs - 1)).toBeDefined();
    expect(manager.active(1000 + profile.transitionTtlMs)).toBeUndefined();
    expect(manager.activeType(1000 + profile.transitionTtlMs)).toBe('none');
  });

  it('maps correction classes to directive types per A.3', () => {
    expect(directiveTypeFor('micro')).toBe('none');
    expect(directiveTypeFor('local')).toBe('none');
    expect(directiveTypeFor('catch_up')).toBe('catch_up');
    expect(directiveTypeFor('reanchor')).toBe('reanchor');
    expect(directiveTypeFor('backward_near')).toBe('rewind');
    expect(directiveTypeFor('backward_distant')).toBe('reanchor');
  });
});

describe('engine frame emission (companion §26.1, §56.1)', () => {
  it('emits a frame alongside every snapshot and on due ticks', () => {
    const e = engine('frames');
    const s = new TranscriptScripter(10_000, 1);
    const frames: SemanticMotionFrame[] = [];
    for (const event of s.speak({ text: 'Hello everyone and welcome to the channel.' })) {
      const output = e.handleTranscriptEvent(event);
      if (output.frame) frames.push(output.frame);
      if (output.snapshot) expect(output.frame).toBeDefined();
    }
    expect(frames.length).toBeGreaterThan(0);
    // Ticks keep motion alive between transcript events (§3.1).
    let ticked = 0;
    for (let t = 1; t <= 60; t++) {
      const output = e.tick(s.clockMs + t * 33);
      if (output.frame) {
        frames.push(output.frame);
        ticked++;
      }
    }
    expect(ticked).toBeGreaterThan(0);

    let previous = 0;
    for (const frame of frames) {
      expect(frame.revision).toBeGreaterThan(previous);
      previous = frame.revision;
      expect(Number.isFinite(frame.estimatedUnit)).toBe(true);
      expect(Number.isFinite(frame.velocityUnitsPerSecond)).toBe(true);
      expect(frame.scriptCompileHash).toBe('fixture-script');
      expect(frame.layoutGeneration).toBe(1);
      expect(frame.motionProfileId).toBe(smooth.id);
    }
  });

  it('command navigation increments the semantic epoch and re-anchors (§56.1)', () => {
    const e = engine('epoch');
    expect(e.semanticEpoch).toBe(0);
    const output = e.moveTo(120, 'command', 5000);
    expect(e.semanticEpoch).toBe(1);
    expect(output.frame?.epoch).toBe(1);
    expect(output.frame?.transition?.type).toBe('reanchor');
    expect(output.frame?.transition?.authority).toBe('command');
    expect(output.frame?.transition?.reason).toBe('command_navigation');
    expect(output.frame?.transition?.semanticEpoch).toBe(1);
    expect(output.frame?.behavior).toBe('command_navigation');
  });

  it('manual navigation is stamped as manual authority', () => {
    const e = engine('manual');
    const output = e.moveTo(40, 'manual', 5000);
    expect(output.frame?.transition?.authority).toBe('manual');
    expect(output.frame?.transition?.reason).toBe('manual_navigation');
  });

  it('session reset issues a reset directive and a fresh epoch (§53)', () => {
    const e = engine('reset');
    const output = e.reset(9000);
    expect(output.frame?.transition?.type).toBe('reset');
    expect(output.frame?.transition?.reason).toBe('session_reset');
    expect(output.frame?.estimatedUnit).toBe(0);
  });

  it('a rebuilt line map produces a layout_recovery directive (§7.2, §62)', () => {
    const e = engine('layout');
    const output = e.setLayoutGeneration(2, 4000);
    expect(output.frame?.layoutGeneration).toBe(2);
    expect(output.frame?.transition?.reason).toBe('layout_recovery');
    // Repeating the same generation is a no-op.
    expect(e.setLayoutGeneration(2, 4100).frame).toBeUndefined();
  });

  it('the same directive id rides successive frames (idempotency, §53)', () => {
    const e = engine('idempotent');
    const first = e.moveTo(120, 'command', 5000).frame;
    const directiveId = first?.transition?.id;
    expect(directiveId).toBeDefined();
    const later = e.tick(5200).frame ?? e.tick(5400).frame;
    if (later?.transition !== undefined) expect(later.transition.id).toBe(directiveId);
  });
});

describe('MovementDecisionLog (companion §65)', () => {
  it('is a bounded ring buffer', () => {
    const log = new MovementDecisionLog(3);
    for (let i = 0; i < 10; i++) {
      log.push({
        revision: i,
        sessionTimeMs: i,
        fromUnit: 0,
        toUnit: 0,
        behavior: 'normal',
        stateBefore: 'following',
        stateAfter: 'following',
        localConfidence: 1,
        secondBestMargin: 0,
        sectionGate: 'allowed',
        authority: 'ordinary',
        visualDisposition: 'absorbed',
        reason: 'r',
        fromTokenIndex: 0,
        toTokenIndex: 0,
        fromSectionId: 'h0',
        toSectionId: 'h0',
        continuityPrior: 1,
        blockedCandidateCount: 0,
        beamSize: 1,
        positionVariance: 0,
        finalEvidence: true,
      });
    }
    expect(log.all()).toHaveLength(3);
    expect(log.latest()?.revision).toBe(9);
    expect(log.withBehavior('normal')).toHaveLength(3);
  });

  it('records carry the §65 explanation fields and no transcript text', () => {
    const e = engine('records');
    const s = new TranscriptScripter(10_000, 1);
    for (const event of s.speak({ text: 'Hello everyone and welcome to the channel.' })) {
      e.handleTranscriptEvent(event);
    }
    const records = e.decisionRecords();
    expect(records.length).toBeGreaterThan(0);
    const record = records[records.length - 1];
    expect(record).toBeDefined();
    if (record === undefined) return;
    expect(record.sectionGate === 'allowed' || record.sectionGate === 'blocked').toBe(true);
    expect(['ordinary', 'command', 'manual']).toContain(record.authority);
    expect(Number.isFinite(record.fromUnit)).toBe(true);
    expect(Number.isFinite(record.toUnit)).toBe(true);
    // §57.3: diagnostics must never carry script or transcript text.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('welcome');
    expect(serialized).not.toContain('everyone');
  });

  it('explains a blocked distant candidate (§65 sectionGate)', () => {
    const e = engine('blocked-record');
    const s = new TranscriptScripter(10_000, 1);
    for (const event of s.speak({ text: 'Hello everyone and welcome to the channel.' })) {
      e.handleTranscriptEvent(event);
    }
    for (const event of s.speak({
      text: 'Thank you so much for watching until the very end.',
    })) {
      e.handleTranscriptEvent(event);
    }
    const blocked = e.decisionRecords().filter((r) => r.sectionGate === 'blocked');
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0]?.blockedReason).toBe('prohibited_non_contiguous');
    expect(blocked[0]?.blockedCandidateCount).toBeGreaterThan(0);
  });
});
