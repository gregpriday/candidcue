/**
 * An authorized discontinuity survives an invalid-map window (§53, §62).
 *
 * `consumePlantOverwrite()` hands the frame loop the one licence it has to
 * write plant state. The loop used to spend that licence unconditionally: if
 * there was no line map, `destinationScrollPx()` returned null, nothing moved,
 * and `transitions.complete(id)` ran anyway. Directives are idempotent by `id`,
 * so every copy the worker re-sent on later frames was `duplicate`-ignored —
 * the re-anchor was not delayed, it was destroyed.
 *
 * Backward, that is unrecoverable by ordinary motion: the §30.5 reverse-travel
 * budget hard-caps a rewind at 420 px, so a distant retake arriving during a
 * §62 rebuild window left the plant parked 1154 px above the retake point for
 * the rest of the session. Forward, it "recovers" by rolling at full speed for
 * about two seconds — which is precisely the spectacle §53 re-anchors exist to
 * prevent.
 */
import { describe, expect, it } from 'vitest';
import type { AlignmentSnapshot, StageTransitionDirective } from '../../../src/shared/contracts';
import {
  buildRenderedLineMap,
  createStageMotionEngine,
  createStageTransitionController,
  emptyRenderedLineMap,
  REANCHOR_FADE_MS,
} from '../../../src/stage/motion';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';

function frame(overrides: Partial<AlignmentSnapshot>): AlignmentSnapshot {
  return {
    sessionGeneration: 1,
    seq: 1,
    atAudioMs: 0,
    evidenceAudioMs: 0,
    observedToken: 0,
    confirmedToken: 0,
    rateTokensPerSecond: 0,
    maxPredictionMs: 900,
  pauseOnsetMs: 1800,
  leadFloorMs: 550,
  maxLeadTokens: 2.5,
  leadMarginTokens: 1.2,
  leadEaseMs: 450,
  leadHoldMs: 0,
  leadDecayMs: 1200,
  displayLimitToken: 10_000,
    confidence: 0.9,
    state: 'following',
    decision: 'localConfirmed',
    suggestionToken: null,
    scriptLenTokens: 10_000,
    observedAtom: 0,
    confirmedAtom: 0,
    ...overrides,
  };
}

function retakeDirective(
  overrides: Partial<StageTransitionDirective> = {},
): StageTransitionDirective {
  return {
    id: 'dir-1',
    type: 'reanchor',
    authority: 'command',
    fromUnit: 180,
    toUnit: 10,
    destinationTokenIndex: 10,
    issuedAtMs: 100,
    expiresAtMs: 5000,
    semanticEpoch: 1,
    reason: 'distant_retake',
    ...overrides,
  };
}

function scenario() {
  const layout = syntheticLayout({
    blocks: [
      { kind: 'paragraph', tokens: 120 },
      { kind: 'paragraph', tokens: 120 },
    ],
    startY: 800,
  });
  const validMap = buildRenderedLineMap({
    fingerprint: fixtureFingerprint({ layoutGeneration: 1 }),
    tokens: layout.tokens,
    blocks: layout.blocks,
    readingLineStartY: 400,
    lineHeightPx: layout.lineHeightPx,
    viewportHeightPx: 1080,
    maxScrollPx: layout.contentHeightPx,
  });
  const engine = createStageMotionEngine();
  engine.configureSession(1, 0);
  // Mid-relayout retry window (§62): the map is momentarily unusable.
  engine.setLineMap(emptyRenderedLineMap(fixtureFingerprint({ layoutGeneration: 1 })));
  engine.setBounds(0, layout.contentHeightPx);
  // The presenter is deep in the document.
  engine.reset(2100);
  return { engine, validMap, layout };
}

describe('a directive that cannot be resolved is parked, not spent', () => {
  it('re-anchors as soon as the rebuilt map lands', () => {
    const { engine, validMap } = scenario();
    const directive = retakeDirective();

    engine.transitions.submit(directive, 100);
    engine.receiveSnapshot(frame({ seq: 1, atAudioMs: 100, evidenceAudioMs: 100 }), 100);
    const held = engine.frame(116);
    // Nothing moved — there was nowhere to move to — and the licence was
    // parked rather than burned.
    expect(held.scrollPx).toBeCloseTo(2100, 6);
    expect(held.controllerState).toContain('transition_deferred');
    expect(engine.deferredPlantOverwrites).toBeGreaterThan(0);

    // 300 ms later the rebuilt map lands (same generation, §62 retry).
    engine.setLineMap(validMap);
    let scroll = 0;
    for (let t = 132; t < 4000; t += 16) {
      const step = Math.floor(t / 50);
      if (step * 50 >= t - 16) {
        // The same directive is re-submitted; it stays a duplicate, and it no
        // longer needs to be anything else.
        engine.transitions.submit(directive, t);
        engine.receiveSnapshot(
          frame({
            seq: step + 2,
            atAudioMs: step * 50,
            evidenceAudioMs: step * 50,
            observedToken: 10,
            confirmedToken: 10,
          }),
          t,
        );
      }
      scroll = engine.frame(t).scrollPx;
    }

    const wanted = validMap.sampleMotionPath(10)?.scrollPx ?? 0;
    expect(Math.abs(scroll - wanted)).toBeLessThan(validMap.linePitchPx);
    // It was spent exactly once, as a re-anchor always is.
    expect(engine.transitions.active).toBeNull();
  });

  it('spends the licence on the FIRST frame after the map resolves', () => {
    const { engine, validMap } = scenario();
    engine.transitions.submit(retakeDirective(), 100);
    engine.receiveSnapshot(frame({ seq: 1, atAudioMs: 100, evidenceAudioMs: 100 }), 100);
    engine.frame(116);
    engine.frame(132);
    expect(engine.deferredPlantOverwrites).toBe(2);

    engine.setLineMap(validMap);
    // The §62 park ends on the first frame after the map resolves: the licence
    // now has a destination, so it stops being deferred and starts being
    // *obscured* (§20.4). It is still parked — but for a different, bounded
    // reason, and the counter no longer moves.
    const resolved = engine.frame(148);
    expect(resolved.controllerState).not.toContain('transition_deferred');
    expect(resolved.controllerState).toContain('reanchor_fade');
    expect(engine.deferredPlantOverwrites).toBe(2);
    expect(Math.abs(resolved.scrollPx - 2100)).toBeLessThan(1);

    let applied = resolved;
    for (let t = 164; t <= 148 + REANCHOR_FADE_MS + 16; t += 16) applied = engine.frame(t);
    const wanted = validMap.sampleMotionPath(10)?.scrollPx ?? 0;
    // A re-anchor IS the discontinuity: it lands in one frame, it does not
    // become a two-second roll. (The controller then integrates that one
    // sub-frame normally, so this is a rendered line's worth of tolerance, not
    // an equality.)
    expect(Math.abs(applied.scrollPx - wanted)).toBeLessThan(validMap.linePitchPx);
    expect(Math.abs(applied.scrollPx - 2100)).toBeGreaterThan(validMap.linePitchPx);
    expect(engine.deferredPlantOverwrites).toBe(2);
  });

  it('lets the directive expire rather than parking a licence forever', () => {
    const { engine, validMap } = scenario();
    engine.transitions.submit(retakeDirective({ expiresAtMs: 800 }), 100);
    engine.receiveSnapshot(frame({ seq: 1, atAudioMs: 100, evidenceAudioMs: 100 }), 100);
    for (let t = 116; t < 1200; t += 16) {
      engine.receiveSnapshot(frame({ seq: 1000 + t, atAudioMs: t , evidenceAudioMs: t }), t);
      engine.frame(t);
    }
    expect(engine.transitions.active).toBeNull();

    // The map comes back AFTER the deadline: a stale licence must not teleport
    // the plant on the next frame the loop happens to run.
    engine.setLineMap(validMap);
    const after = engine.frame(1216);
    expect(Math.abs(after.scrollPx - 2100)).toBeLessThan(1);
    expect(after.controllerState).not.toContain('transition_deferred');
  });

  it('does not resurrect a licence for a superseded directive', () => {
    const { engine, validMap } = scenario();
    engine.transitions.submit(retakeDirective(), 100);
    engine.receiveSnapshot(frame({ seq: 1, atAudioMs: 100, evidenceAudioMs: 100 }), 100);
    engine.frame(116);
    expect(engine.deferredPlantOverwrites).toBe(1);

    // A newer command directive supersedes the parked one.
    const newer = retakeDirective({
      id: 'dir-2',
      toUnit: 150,
      destinationTokenIndex: 150,
      issuedAtMs: 200,
      expiresAtMs: 6000,
    });
    engine.transitions.submit(newer, 200);
    engine.receiveSnapshot(frame({seq: 2, atAudioMs: 200, evidenceAudioMs: 200}), 200);
    engine.setLineMap(validMap);
    let applied = engine.frame(216);
    for (let t = 232; t <= 216 + REANCHOR_FADE_MS + 16; t += 16) applied = engine.frame(t);
    // The destination is the NEW directive's, not the parked one's.
    const newerPx = validMap.sampleMotionPath(150)?.scrollPx ?? -1;
    const parkedPx = validMap.sampleMotionPath(10)?.scrollPx ?? -1;
    expect(Math.abs(applied.scrollPx - newerPx)).toBeLessThan(validMap.linePitchPx);
    expect(Math.abs(applied.scrollPx - parkedPx)).toBeGreaterThan(validMap.linePitchPx);
    expect(engine.transitions.active).toBeNull();
  });
});

describe('deferPlantOverwrite obeys the same activity rule as consuming (§26.3)', () => {
  it('parks a licence only while its own directive is still active', () => {
    const controller = createStageTransitionController();
    const directive = retakeDirective();
    controller.submit(directive, 0);
    expect(controller.consumePlantOverwrite()).toBe(directive);
    expect(controller.consumePlantOverwrite()).toBeNull();

    controller.deferPlantOverwrite(directive);
    expect(controller.consumePlantOverwrite()).toBe(directive);

    // Once the directive is finished, its licence cannot be handed back.
    controller.deferPlantOverwrite(directive);
    controller.complete(directive.id);
    expect(controller.consumePlantOverwrite()).toBeNull();
  });

  it('ignores a licence for a directive that was never active', () => {
    const controller = createStageTransitionController();
    controller.deferPlantOverwrite(retakeDirective({ id: 'ghost' }));
    expect(controller.consumePlantOverwrite()).toBeNull();
  });

  it('drops a parked licence when the directive expires', () => {
    const controller = createStageTransitionController();
    const directive = retakeDirective({ expiresAtMs: 500 });
    controller.submit(directive, 0);
    controller.consumePlantOverwrite();
    controller.deferPlantOverwrite(directive);
    controller.update(600);
    expect(controller.active).toBeNull();
    expect(controller.consumePlantOverwrite()).toBeNull();
  });
});
