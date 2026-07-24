/**
 * §12.6. The ring buffer's whole job is to hand back *exactly* the audio that
 * sat between two audio-clock timestamps. Every test here therefore writes a
 * signal whose value is a known function of its sample index, so a read that
 * is off by even one sample, or that splices across a gap, is detectable —
 * an implementation returning zeros, a constant, or the wrong window fails.
 */
import { describe, expect, it } from 'vitest';
import {
  PcmRingBuffer,
  RING_BUFFER_MAX_SECONDS_WITHOUT_CONSENT,
  RING_BUFFER_MAX_SECONDS_WITH_CONSENT,
} from '../../../../src/shared/coaching/audio/ring-buffer';

const RATE = 1000; // 1 sample per ms keeps the arithmetic auditable by eye.

/** samples[i] === firstIndex + i, so every sample identifies its own position. */
function ramp(firstIndex: number, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = firstIndex + i;
  return out;
}

describe('PcmRingBuffer capacity', () => {
  it('clamps to 60 s without recording consent', () => {
    const buffer = new PcmRingBuffer({ sampleRate: RATE, capacitySeconds: 600 });
    expect(buffer.capacitySamples).toBe(RING_BUFFER_MAX_SECONDS_WITHOUT_CONSENT * RATE);
  });

  it('allows a larger buffer with consent but still bounds it', () => {
    const buffer = new PcmRingBuffer({
      sampleRate: RATE,
      capacitySeconds: 100_000,
      recordingConsent: true,
    });
    expect(buffer.capacitySamples).toBe(RING_BUFFER_MAX_SECONDS_WITH_CONSENT * RATE);
  });

  it('defaults to 30 s', () => {
    expect(new PcmRingBuffer({ sampleRate: RATE }).capacitySamples).toBe(30 * RATE);
  });
});

describe('PcmRingBuffer reads', () => {
  it('returns the exact samples that were written at the requested audio time', () => {
    const buffer = new PcmRingBuffer({ sampleRate: RATE, capacitySeconds: 1 });
    buffer.write(ramp(0, 400));

    const slice = buffer.read(100, 140);
    expect(slice).not.toBeNull();
    expect(slice?.length).toBe(40);
    // Value identity: sample at 100 ms is index 100 because RATE = 1/ms.
    expect(Array.from(slice as Float32Array)).toEqual(
      Array.from({ length: 40 }, (_, i) => 100 + i),
    );
  });

  it('reads correctly across the wrap point', () => {
    const buffer = new PcmRingBuffer({ sampleRate: RATE, capacitySeconds: 0.2 }); // 200 samples
    buffer.write(ramp(0, 150));
    buffer.write(ramp(150, 100)); // wraps: physical index 200 -> 0

    const slice = buffer.read(180, 220);
    expect(Array.from(slice as Float32Array)).toEqual(
      Array.from({ length: 40 }, (_, i) => 180 + i),
    );
  });

  it('refuses a partially evicted interval instead of returning it short', () => {
    const buffer = new PcmRingBuffer({ sampleRate: RATE, capacitySeconds: 0.2 });
    buffer.write(ramp(0, 500)); // only 300..500 survive

    expect(buffer.read(250, 350)).toBeNull(); // straddles the eviction edge
    expect(buffer.read(0, 100)).toBeNull(); // fully evicted
    expect(buffer.read(320, 380)).not.toBeNull();
    expect(buffer.availableStartMs).toBe(300);
    expect(buffer.availableEndMs).toBe(500);
  });

  it('refuses an interval that has not been captured yet', () => {
    const buffer = new PcmRingBuffer({ sampleRate: RATE, capacitySeconds: 1 });
    buffer.write(ramp(0, 100));
    expect(buffer.read(90, 150)).toBeNull();
    expect(buffer.read(50, 50)).toBeNull();
  });

  it('keeps only the newest capacity worth of a single oversized write', () => {
    const buffer = new PcmRingBuffer({ sampleRate: RATE, capacitySeconds: 0.1 }); // 100
    buffer.write(ramp(0, 350));
    expect(buffer.availableStartMs).toBe(250);
    expect(Array.from(buffer.read(250, 350) as Float32Array)).toEqual(
      Array.from({ length: 100 }, (_, i) => 250 + i),
    );
  });

  it('readInto copies without allocating and reports the sample count', () => {
    const buffer = new PcmRingBuffer({ sampleRate: RATE, capacitySeconds: 1 });
    buffer.write(ramp(0, 200));
    const out = new Float32Array(50);
    expect(buffer.readInto(10, 60, out)).toBe(50);
    expect(out[0]).toBe(10);
    expect(out[49]).toBe(59);
    expect(buffer.readInto(500, 560, out)).toBe(0);
  });
});

describe('PcmRingBuffer gaps (§12.4 dropout)', () => {
  it('does not splice audio across a capture gap', () => {
    const buffer = new PcmRingBuffer({ sampleRate: RATE, capacitySeconds: 1 });
    buffer.write(ramp(0, 100), 100, 0);
    // 50 ms of capture lost; the next quantum is stamped at 150 ms.
    buffer.write(ramp(150, 100), 100, 150);

    // A read spanning the gap must fail rather than return 200 contiguous ms.
    expect(buffer.read(50, 200)).toBeNull();
    // Everything before the gap is no longer offered at all.
    expect(buffer.availableStartMs).toBe(150);
    // Post-gap audio is intact and correctly dated.
    expect(Array.from(buffer.read(150, 250) as Float32Array)).toEqual(
      Array.from({ length: 100 }, (_, i) => 150 + i),
    );
  });

  it('ignores a backwards timestamp rather than rewinding the clock', () => {
    const buffer = new PcmRingBuffer({ sampleRate: RATE, capacitySeconds: 1 });
    buffer.write(ramp(0, 100), 100, 0);
    buffer.write(ramp(100, 100), 100, 40); // bogus rewind
    expect(buffer.availableEndMs).toBe(200);
  });
});

describe('PcmRingBuffer clearing (§12.6)', () => {
  it('drops all content on clear and does not resurface it', () => {
    const buffer = new PcmRingBuffer({ sampleRate: RATE, capacitySeconds: 1 });
    buffer.write(ramp(0, 300));
    buffer.clear('take_end');

    expect(buffer.clearReason).toBe('take_end');
    expect(buffer.availableSampleCount).toBe(0);
    expect(buffer.read(100, 200)).toBeNull();

    // New audio after the clear keeps the original timeline (no rewind).
    buffer.write(ramp(1000, 100));
    expect(buffer.availableStartMs).toBe(300);
    expect(buffer.read(200, 320)).toBeNull(); // cannot reach behind the clear
    expect(Array.from(buffer.read(300, 400) as Float32Array)).toEqual(
      Array.from({ length: 100 }, (_, i) => 1000 + i),
    );
  });
});
