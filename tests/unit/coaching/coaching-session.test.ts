/**
 * §12.2 wiring tests for the control-side coaching session controller.
 *
 * The subsystem below has ~1013 green lane tests and, until this, did nothing —
 * so a green lane proves nothing about integration. Each test here is written to
 * FAIL if the wiring between the analyzer, the orchestrator, and the stage sink
 * is removed:
 *
 *   - frames pushed into the controller reach the orchestrator and a
 *     `CoachRailState` reaches the stage sink;
 *   - `off` mode publishes nothing live (§6.1);
 *   - a throwing stage sink does not stop the session or the frame pump (§5.2);
 *   - the display toggle reaches the published snapshot (§27).
 */
import { describe, it, expect } from 'vitest';
import {
  CoachingSessionController,
  type CoachingSessionDeps,
} from '../../../src/control/services/coaching-session';
import type {
  CoachingAnalyzerHandle,
  CoachingAnalyzerOptions,
} from '../../../src/control/services/coaching-analyzer';
import { defaultCoachingSettings } from '../../../src/control/lib/coaching-profiles';
import type { CoachRailState, CoachRailMode } from '../../../src/shared/contracts/coaching';
import type { AudioFrameFeatures } from '../../../src/shared/contracts/coaching';

function frame(audioTimeMs: number): AudioFrameFeatures {
  return {
    audioTimeMs,
    rmsDbfs: -40,
    peakDbfs: -30,
    clippingRatio: 0,
    noiseFloorDbfs: -90,
    estimatedSnrDb: 40,
    speechProbability: 0.9,
    voicedProbability: 0.9,
    f0Hz: 120,
    f0Confidence: 0.8,
    spectralFlux: 0.1,
    zeroCrossingRate: 0.1,
    processorDropout: false,
  };
}

/** A fake analyzer that hands the controller's `onFrames` back to the test. */
function fakeAnalyzerFactory() {
  let onFrames: ((frames: AudioFrameFeatures[]) => void) | null = null;
  let closed = false;
  const startAnalyzer = async (
    options: CoachingAnalyzerOptions,
  ): Promise<CoachingAnalyzerHandle> => {
    onFrames = options.onFrames;
    return {
      sampleRate: 48000,
      currentTimeMs: () => 0,
      clearBuffer: () => {},
      extract: async () => null,
      reset: () => {},
      close: async () => {
        closed = true;
      },
      frameCount: 0,
      keepAliveInstalled: false,
    };
  };
  return {
    startAnalyzer: startAnalyzer as unknown as typeof import('../../../src/control/services/coaching-analyzer').startCoachingAnalyzer,
    push: (frames: AudioFrameFeatures[]) => onFrames?.(frames),
    isClosed: () => closed,
  };
}

const stream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as CoachingSessionDeps['stream'];

function makeController(
  mode: CoachRailMode,
  published: CoachRailState[],
  extra: Partial<CoachingSessionDeps> = {},
) {
  const analyzer = fakeAnalyzerFactory();
  const controller = new CoachingSessionController({
    sessionId: '00000000-0000-0000-0000-000000000001',
    settings: { ...defaultCoachingSettings(), mode },
    compiled: null,
    stream,
    takePassId: 'take-1',
    publish: (state) => published.push(state),
    startAnalyzer: analyzer.startAnalyzer,
    ...extra,
  });
  return { controller, analyzer };
}

describe('coaching session controller — frame → orchestrator → stage sink', () => {
  it('pumps frames into the orchestrator and publishes a CoachRailState', async () => {
    const published: CoachRailState[] = [];
    const { controller, analyzer } = makeController('coach', published);
    await controller.start();

    // Feed frames spanning past the aggregation window so a rail is published.
    for (let t = 0; t <= 240; t += 20) analyzer.push([frame(t)]);

    expect(published.length).toBeGreaterThan(0);
    const last = published[published.length - 1]!;
    expect(last.sessionId).toBe('00000000-0000-0000-0000-000000000001');
    expect(last.mode).toBe('coach');
    // The builder stamps a strictly increasing revision — the stage relies on it.
    expect(last.stageRevision).toBeGreaterThan(0);
    // The same snapshot the controller cached is the one it published.
    expect(controller.lastRailState()?.stageRevision).toBe(last.stageRevision);

    await controller.dispose();
    expect(analyzer.isClosed()).toBe(true);
  });

  it('publishes nothing live in off mode (§6.1)', async () => {
    const published: CoachRailState[] = [];
    const { controller, analyzer } = makeController('off', published);
    await controller.start();
    for (let t = 0; t <= 400; t += 20) analyzer.push([frame(t)]);
    expect(published).toHaveLength(0);
    await controller.dispose();
  });

  it('publishes nothing live in review_only mode (§6.5)', async () => {
    const published: CoachRailState[] = [];
    const { controller, analyzer } = makeController('review_only', published);
    await controller.start();
    for (let t = 0; t <= 400; t += 20) analyzer.push([frame(t)]);
    expect(published).toHaveLength(0);
    await controller.dispose();
  });

  it('contains a throwing stage sink — the frame pump never throws (§5.2)', async () => {
    const { controller, analyzer } = makeController('coach', [], {
      publish: () => {
        throw new Error('stage transport is gone');
      },
    });
    await controller.start();
    // Pushing frames through a sink that always throws must not propagate.
    expect(() => {
      for (let t = 0; t <= 240; t += 20) analyzer.push([frame(t)]);
    }).not.toThrow();
    // The subsystem still produced a snapshot internally — it simply could not
    // deliver it. A dead transport is not a dead session.
    expect(controller.lastRailState()).not.toBeNull();
    await controller.dispose();
  });

  /**
   * §5.4/§20.5. The controller used to omit `trackingEpoch` from the host state
   * it pushes, which bought a working filler count at the price of every
   * staleness rule in §23.1: the orchestrator's epoch never moved, so an
   * in-flight Luna answer computed against the pre-jump position could still be
   * applied after a re-anchor. The epoch is propagated now, and the count is
   * preserved by the disfluency lane rather than by not telling it.
   *
   * No frames are pushed on purpose: this is the documented degraded path where
   * the analyzer never attached and filler coaching runs on the transcript
   * alone (§16.5 — "a rail that reads FILLERS 0 through a take full of them
   * because the audio worklet never started is a silent lie").
   */
  it('propagates the tracking epoch without zeroing the filler count (§5.4)', async () => {
    const published: CoachRailState[] = [];
    const { controller } = makeController('coach', published);

    const tracking = {
      tokenIndex: 12,
      alignmentConfidence: 0.9,
      reacquiring: false,
      commandActive: false,
      activeScriptSpanId: 'span-1',
    };

    controller.noteFinalTranscript({
      itemId: 'item-1',
      commitSequence: 1,
      transcript: 'so um we should start with the second section',
    });
    controller.setTrackingState({ ...tracking, trackingEpoch: 3 });
    expect(controller.hostState().trackingEpoch).toBe(3);
    const before = published[published.length - 1];
    expect(before?.fillers.confirmedCount).toBe(1);

    // A command jump / re-anchor: the engine's epoch moves inside the take.
    controller.setTrackingState({ ...tracking, trackingEpoch: 4 });
    expect(controller.hostState().trackingEpoch).toBe(4);
    // The epoch reached the orchestrator *and* the presenter's total survived.
    expect(controller.lastRailState()?.fillers.confirmedCount).toBe(1);

    await controller.dispose();
  });

  it('carries the display toggle into the published snapshot (§27)', async () => {
    const published: CoachRailState[] = [];
    const { controller, analyzer } = makeController('coach', published);
    await controller.start();
    controller.setDisplayState({ visible: false, mirrored: true });
    for (let t = 0; t <= 240; t += 20) analyzer.push([frame(t)]);
    const last = published[published.length - 1]!;
    expect(last.visible).toBe(false);
    expect(last.mirrored).toBe(true);
    await controller.dispose();
  });
});
