import { describe, expect, it } from 'vitest';
import { MicrophoneMonitor } from './levelMeter';
import { DEFAULT_VAD_CONFIG } from './defaults';
import type { AnalyserLike, AudioAnalysisGraph, MediaStreamLike } from './types';

const stream: MediaStreamLike = { getAudioTracks: () => [], getTracks: () => [] };

/** Analyser whose output amplitude is controlled by the test. */
class FakeAnalyser implements AnalyserLike {
  readonly fftSize = 128;
  amplitude = 0;
  getFloatTimeDomainData(target: Float32Array): void {
    target.fill(this.amplitude);
  }
}

describe('MicrophoneMonitor (spec §28.4)', () => {
  it('polls the analyser, emits smoothed levels and VAD events, and tears down the graph', async () => {
    const analyser = new FakeAnalyser();
    let closed = false;
    const graph: AudioAnalysisGraph = {
      analyser,
      close: () => {
        closed = true;
      },
    };

    let now = 0;
    const ticks: Array<() => void> = [];
    const monitor = new MicrophoneMonitor({
      createGraph: () => graph,
      now: () => now,
      schedule: (callback) => {
        ticks.push(callback);
        return { cancel: () => ticks.splice(ticks.indexOf(callback), 1) };
      },
      intervalMs: 50,
      vadConfig: { calibrationMs: 100 },
    });

    const snapshots: number[] = [];
    const vadEvents: string[] = [];
    monitor.onLevel((snapshot) => snapshots.push(snapshot.rms));
    monitor.onVadEvent((event) => vadEvents.push(event.type));

    await monitor.start(stream);
    expect(monitor.running).toBe(true);
    const tick = () => {
      now += 50;
      ticks[0]?.();
    };

    // Calibration window (quiet).
    analyser.amplitude = 0.001;
    tick();
    tick();
    tick();
    expect(vadEvents).toContain('calibrated');
    expect(snapshots.length).toBeGreaterThan(0);

    // Speech opens after the configured open duration.
    analyser.amplitude = 0.3;
    tick();
    tick();
    tick();
    expect(vadEvents).toContain('speech_started');
    expect(monitor.speaking).toBe(true);

    // Silence long enough to close the turn.
    analyser.amplitude = 0.001;
    const silentTicks = Math.ceil(DEFAULT_VAD_CONFIG.endOfTurnSilenceMs / 50) + 2;
    for (let i = 0; i < silentTicks; i += 1) tick();
    expect(vadEvents).toContain('speech_ended');
    expect(monitor.speaking).toBe(false);

    await monitor.stop();
    expect(monitor.running).toBe(false);
    expect(closed).toBe(true);
    expect(ticks).toHaveLength(0);
  });
});
