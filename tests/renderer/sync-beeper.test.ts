import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncBeeper } from '../../src/renderer/stage/audio/SyncBeeper';

// SyncBeeper only touches the Web Audio API, so this suite runs in the default
// node environment with a hand-rolled fake AudioContext rather than jsdom.

const FAKE_NOW = 10;

interface ParamCall {
  method: 'setValueAtTime' | 'linearRampToValueAtTime' | 'setTargetAtTime';
  args: number[];
}

class FakeAudioParam {
  value = 0;
  readonly calls: ParamCall[] = [];

  setValueAtTime(value: number, time: number): this {
    this.calls.push({ method: 'setValueAtTime', args: [value, time] });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.calls.push({ method: 'linearRampToValueAtTime', args: [value, time] });
    return this;
  }

  setTargetAtTime(target: number, startTime: number, timeConstant: number): this {
    this.calls.push({ method: 'setTargetAtTime', args: [target, startTime, timeConstant] });
    return this;
  }
}

class FakeOscillator {
  type = '';
  readonly frequency = new FakeAudioParam();
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeGain {
  readonly gain = new FakeAudioParam();
  connect = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly destination = { id: 'destination' };
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  get currentTime(): number {
    return FAKE_NOW;
  }

  createOscillator(): FakeOscillator {
    const osc = new FakeOscillator();
    this.oscillators.push(osc);
    return osc;
  }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
}

/** Let the play() async IIFE settle (it awaits resume() before scheduling). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SyncBeeper', () => {
  it('resumes the context and schedules a single 880 Hz sine pulse', async () => {
    const beeper = new SyncBeeper();
    beeper.play();
    await flush();

    const ctx = FakeAudioContext.instances[0];
    expect(ctx.resume).toHaveBeenCalledOnce();
    expect(ctx.oscillators).toHaveLength(1);

    const osc = ctx.oscillators[0];
    expect(osc.type).toBe('sine');
    expect(osc.frequency.value).toBe(880);
    // Default destination = system output, so the camera mic captures the tone.
    expect(osc.connect).toHaveBeenCalledWith(ctx.gains[0]);
    expect(ctx.gains[0].connect).toHaveBeenCalledWith(ctx.destination);
  });

  it('shapes an attack/sustain/release envelope anchored to currentTime', async () => {
    const beeper = new SyncBeeper();
    beeper.play();
    await flush();

    const gain = FakeAudioContext.instances[0].gains[0];
    expect(gain.gain.calls).toEqual([
      { method: 'setValueAtTime', args: [0, FAKE_NOW] },
      { method: 'linearRampToValueAtTime', args: [0.8, FAKE_NOW + 0.005] },
      { method: 'setValueAtTime', args: [0.8, FAKE_NOW + 0.045] },
      { method: 'setTargetAtTime', args: [0, FAKE_NOW + 0.045, 0.015] },
    ]);
  });

  it('starts and stops the oscillator on the audio clock', async () => {
    const beeper = new SyncBeeper();
    beeper.play();
    await flush();

    const osc = FakeAudioContext.instances[0].oscillators[0];
    expect(osc.start).toHaveBeenCalledWith(FAKE_NOW);
    expect(osc.stop).toHaveBeenCalledWith(FAKE_NOW + 0.08);
  });

  it('never throws when resume() rejects (suspended/closed context)', async () => {
    const beeper = new SyncBeeper();
    const ctx = FakeAudioContext.instances[0];
    ctx.resume.mockRejectedValueOnce(new Error('not allowed'));

    expect(() => beeper.play()).not.toThrow();
    await flush();
    // resume failed before any node was created — no tone scheduled, no crash.
    expect(ctx.oscillators).toHaveLength(0);
  });

  it('closes the context on dispose', async () => {
    const beeper = new SyncBeeper();
    const ctx = FakeAudioContext.instances[0];
    await beeper.dispose();
    expect(ctx.close).toHaveBeenCalledOnce();
  });

  it('swallows a close() failure on dispose', async () => {
    const beeper = new SyncBeeper();
    const ctx = FakeAudioContext.instances[0];
    ctx.close.mockRejectedValueOnce(new Error('already closed'));
    await expect(beeper.dispose()).resolves.toBeUndefined();
  });
});
