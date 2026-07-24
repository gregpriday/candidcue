/**
 * §12.7. Microphone health.
 *
 * The tests that matter here are the *negative* ones: a single clipped frame
 * must not raise an alert, and quiet speech in a quiet room must not be called
 * noise. Both are cases where a naive implementation looks correct on the happy
 * path and lies to the presenter in the field.
 */
import { describe, expect, it } from 'vitest';
import { MicrophoneHealthMonitor } from '../../../../src/shared/coaching/audio/microphone-health';
import type { AudioFrameFeatures, MicrophoneCoachState } from '../../../../src/shared/contracts/coaching';

const FRAME_MS = 20;

function frame(index: number, overrides: Partial<AudioFrameFeatures> = {}): AudioFrameFeatures {
  return {
    audioTimeMs: index * FRAME_MS,
    rmsDbfs: -24,
    peakDbfs: -12,
    clippingRatio: 0,
    noiseFloorDbfs: -58,
    estimatedSnrDb: 34,
    speechProbability: 0.9,
    voicedProbability: 0.8,
    f0Hz: 180,
    f0Confidence: 0.8,
    spectralFlux: 0.01,
    zeroCrossingRate: 0.03,
    processorDropout: false,
    ...overrides,
  };
}

function feed(
  monitor: MicrophoneHealthMonitor,
  frames: number,
  startIndex: number,
  overrides: (index: number) => Partial<AudioFrameFeatures>,
  speaking = true,
): MicrophoneCoachState {
  let state = monitor.state;
  for (let i = 0; i < frames; i += 1) {
    state = monitor.process(frame(startIndex + i, overrides(startIndex + i)), speaking);
  }
  return state;
}

describe('MicrophoneHealthMonitor baseline', () => {
  it('says learning before it has heard enough, then ok', () => {
    const monitor = new MicrophoneHealthMonitor();
    const early = feed(monitor, 10, 0, () => ({})); // 200 ms
    expect(early.status).toBe('learning');
    expect(early.sustained).toBe(false);

    const settled = feed(monitor, 100, 10, () => ({}));
    expect(settled.status).toBe('ok');
    expect(settled.sustained).toBe(false);
  });

  it('reports a negative rolling level and a positive rolling SNR', () => {
    const monitor = new MicrophoneHealthMonitor();
    const state = feed(monitor, 100, 0, () => ({ rmsDbfs: -24, estimatedSnrDb: 34 }));
    expect(state.levelDbfs as number).toBeCloseTo(-24, 6);
    expect(state.snrDb as number).toBeCloseTo(34, 6);
    expect(state.levelDbfs as number).toBeLessThan(0);
    expect(state.snrDb as number).toBeGreaterThan(0);
  });

  it('has no level or SNR estimate before the first frame', () => {
    const monitor = new MicrophoneHealthMonitor();
    expect(monitor.state.levelDbfs).toBeNull();
    expect(monitor.state.snrDb).toBeNull();
  });
});

describe('clipping (§12.7.1)', () => {
  it('does NOT react to a single isolated clipped frame', () => {
    const monitor = new MicrophoneHealthMonitor();
    feed(monitor, 100, 0, () => ({}));
    const state = feed(monitor, 1, 100, () => ({ peakDbfs: 0, clippingRatio: 0.4 }));
    expect(state.status).toBe('ok');
    expect(monitor.conditionHold.clippingMs).toBe(FRAME_MS);
  });

  it('does not react to isolated clipping repeated intermittently', () => {
    const monitor = new MicrophoneHealthMonitor();
    feed(monitor, 100, 0, () => ({}));
    // One clipped frame in every four, for two seconds.
    const state = feed(monitor, 100, 100, (i) =>
      i % 4 === 0 ? { peakDbfs: 0, clippingRatio: 0.4 } : {},
    );
    expect(state.status).toBe('ok');
  });

  it('flags sustained clipping', () => {
    const monitor = new MicrophoneHealthMonitor();
    feed(monitor, 100, 0, () => ({}));
    const state = feed(monitor, 20, 100, () => ({ peakDbfs: -0.1, clippingRatio: 0.05 }));
    expect(state.status).toBe('clipping');
    expect(state.sustained).toBe(true);
  });

  it('clears once the clipping stops', () => {
    const monitor = new MicrophoneHealthMonitor();
    feed(monitor, 100, 0, () => ({}));
    expect(feed(monitor, 20, 100, () => ({ peakDbfs: 0, clippingRatio: 0.2 })).status).toBe(
      'clipping',
    );
    const recovered = feed(monitor, 60, 120, () => ({}));
    expect(recovered.status).toBe('ok');
  });
});

describe('low level (§12.7.2)', () => {
  it('requires two seconds, not two frames', () => {
    const monitor = new MicrophoneHealthMonitor();
    feed(monitor, 100, 0, () => ({}));
    const quiet = { rmsDbfs: -52, peakDbfs: -40, estimatedSnrDb: 6, noiseFloorDbfs: -58 };
    const early = feed(monitor, 50, 100, () => quiet); // 1 s
    expect(early.status).toBe('ok');
    const sustained = feed(monitor, 60, 150, () => quiet); // 2.2 s total
    expect(sustained.status).toBe('low_level');
    expect(sustained.sustained).toBe(true);
  });

  it('does not fire while the presenter is silent', () => {
    const monitor = new MicrophoneHealthMonitor();
    feed(monitor, 100, 0, () => ({}));
    const state = feed(
      monitor,
      300,
      100,
      () => ({ rmsDbfs: -52, peakDbfs: -46, estimatedSnrDb: 1, speechProbability: 0.02 }),
      false, // not speaking
    );
    expect(state.status).not.toBe('low_level');
  });

  it('does not fire for quiet-but-clean speech', () => {
    const monitor = new MicrophoneHealthMonitor();
    feed(monitor, 100, 0, () => ({}));
    // Below the calibration range, but a 30 dB SNR: the capture is fine.
    const state = feed(monitor, 300, 100, () => ({
      rmsDbfs: -46,
      peakDbfs: -34,
      estimatedSnrDb: 30,
      noiseFloorDbfs: -76,
    }));
    expect(state.status).toBe('ok');
  });

  it('fires for quiet speech when transcription is also degraded', () => {
    const monitor = new MicrophoneHealthMonitor();
    monitor.setTranscriptionDegraded(true);
    feed(monitor, 100, 0, () => ({}));
    const state = feed(monitor, 150, 100, () => ({
      rmsDbfs: -46,
      peakDbfs: -34,
      estimatedSnrDb: 30,
      noiseFloorDbfs: -76,
    }));
    expect(state.status).toBe('low_level');
    expect(state.transcriptionDegraded).toBe(true);
  });
});

describe('noise (§12.7.3)', () => {
  it('warns only when the FLOOR is high, not when the voice is quiet', () => {
    const noisy = new MicrophoneHealthMonitor();
    feed(noisy, 100, 0, () => ({}));
    const noisyState = feed(noisy, 250, 100, () => ({
      rmsDbfs: -30,
      peakDbfs: -18,
      noiseFloorDbfs: -38, // loud room
      estimatedSnrDb: 8,
    }));
    expect(noisyState.status).toBe('noisy');

    // Same SNR shortfall, but produced by a quiet talker in a quiet room.
    const quiet = new MicrophoneHealthMonitor();
    feed(quiet, 100, 0, () => ({}));
    const quietState = feed(quiet, 250, 100, () => ({
      rmsDbfs: -58,
      peakDbfs: -46,
      noiseFloorDbfs: -66, // quiet room
      estimatedSnrDb: 8,
    }));
    expect(quietState.status).not.toBe('noisy');
  });

  it('needs several seconds of it', () => {
    const monitor = new MicrophoneHealthMonitor();
    feed(monitor, 100, 0, () => ({}));
    const brief = feed(monitor, 50, 100, () => ({
      rmsDbfs: -30,
      noiseFloorDbfs: -38,
      estimatedSnrDb: 8,
    })); // 1 s
    expect(brief.status).toBe('ok');
  });
});

describe('signal loss and precedence', () => {
  it('reports no_signal for a dead input', () => {
    const monitor = new MicrophoneHealthMonitor();
    const state = feed(
      monitor,
      100,
      0,
      () => ({ rmsDbfs: -100, peakDbfs: -100, estimatedSnrDb: 0, speechProbability: 0 }),
      false,
    );
    expect(state.status).toBe('no_signal');
    expect(state.sustained).toBe(true);
  });

  it('disconnected outranks every acoustic condition', () => {
    const monitor = new MicrophoneHealthMonitor();
    feed(monitor, 100, 0, () => ({}));
    feed(monitor, 40, 100, () => ({ peakDbfs: 0, clippingRatio: 0.5 }));
    expect(monitor.state.status).toBe('clipping');
    monitor.setDisconnected(true);
    const state = feed(monitor, 1, 140, () => ({ peakDbfs: 0, clippingRatio: 0.5 }));
    expect(state.status).toBe('disconnected');
  });

  it('ignores dropout frames entirely', () => {
    const monitor = new MicrophoneHealthMonitor();
    feed(monitor, 100, 0, () => ({}));
    const before = monitor.state;
    const after = feed(monitor, 200, 100, () => ({
      processorDropout: true,
      rmsDbfs: -100,
      peakDbfs: -100,
    }));
    // A dropout is unmeasured: it is not a dead microphone.
    expect(after.status).toBe('ok');
    expect(after.levelDbfs).toBe(before.levelDbfs);
    expect(monitor.conditionHold.noSignalMs).toBe(0);
  });
});

describe('§12.7.4 absolute loudness', () => {
  it('exposes no SPL or absolute-loudness field of any kind', () => {
    const monitor = new MicrophoneHealthMonitor();
    const state = feed(monitor, 100, 0, () => ({}));
    expect(Object.keys(state).sort()).toEqual([
      'levelDbfs',
      'snrDb',
      'status',
      'sustained',
      'transcriptionDegraded',
    ]);
    for (const key of Object.keys(state)) {
      expect(key.toLowerCase()).not.toContain('spl');
      expect(key.toLowerCase()).not.toContain('loudness');
      expect(key.toLowerCase()).not.toContain('decibel');
    }
    // And the one level it does publish is explicitly relative: dBFS, negative.
    expect(state.levelDbfs as number).toBeLessThan(0);
  });
});
