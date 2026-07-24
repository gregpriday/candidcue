import { describe, expect, it } from 'vitest';
import { classifyGetUserMediaError, SilentInputDetector, watchTrackHealth } from './failures';
import type { AudioLevelSnapshot } from '../../../shared/contracts';
import type { MediaStreamTrackLike } from './types';

function named(name: string): Error {
  return Object.assign(new Error(name), { name });
}

describe('classifyGetUserMediaError (spec §28.6)', () => {
  it('maps denial and dismissal to MIC_PERMISSION_DENIED', () => {
    expect(classifyGetUserMediaError(named('NotAllowedError'))).toBe('MIC_PERMISSION_DENIED');
    expect(classifyGetUserMediaError(named('SecurityError'))).toBe('MIC_PERMISSION_DENIED');
  });

  it('maps missing/overconstrained devices to MIC_DEVICE_MISSING', () => {
    expect(classifyGetUserMediaError(named('NotFoundError'))).toBe('MIC_DEVICE_MISSING');
    expect(classifyGetUserMediaError(named('OverconstrainedError'))).toBe('MIC_DEVICE_MISSING');
  });

  it('maps busy/unreadable devices to MIC_DEVICE_LOST', () => {
    expect(classifyGetUserMediaError(named('NotReadableError'))).toBe('MIC_DEVICE_LOST');
    expect(classifyGetUserMediaError(named('AbortError'))).toBe('MIC_DEVICE_LOST');
  });

  it('falls back safely for unknown shapes', () => {
    expect(classifyGetUserMediaError('boom')).toBe('MIC_DEVICE_MISSING');
    expect(classifyGetUserMediaError(undefined)).toBe('MIC_DEVICE_MISSING');
  });
});

describe('watchTrackHealth (spec §28.6 track ended / device gone)', () => {
  function fakeTrack(): MediaStreamTrackLike & { fire: (type: string) => void } {
    const listeners = new Map<string, Set<() => void>>();
    return {
      kind: 'audio',
      label: 'Mic',
      readyState: 'live',
      stop() {},
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
      fire(type: string) {
        for (const listener of listeners.get(type) ?? []) listener();
      },
    };
  }

  it('reports ended, muted, and recovered; dispose detaches', () => {
    const track = fakeTrack();
    const seen: Array<[string, string | null]> = [];
    const dispose = watchTrackHealth(track, (failure, code) => seen.push([failure, code]));
    track.fire('mute');
    track.fire('unmute');
    track.fire('ended');
    expect(seen).toEqual([
      ['track_muted', null],
      ['track_recovered', null],
      ['track_ended', 'MIC_DEVICE_LOST'],
    ]);
    dispose();
    track.fire('ended');
    expect(seen).toHaveLength(3);
  });
});

describe('SilentInputDetector (spec §28.6 silent input)', () => {
  function snap(signalPresent: boolean, atMs: number): AudioLevelSnapshot {
    return { rms: 0, peak: 0, noiseFloor: 0, speaking: false, clipped: false, signalPresent, generatedAtMs: atMs };
  }

  it('raises MIC_NO_SIGNAL once after sustained silence and resets on signal', () => {
    const detector = new SilentInputDetector(1000);
    expect(detector.observe(snap(false, 0))).toBeNull();
    expect(detector.observe(snap(false, 500))).toBeNull();
    expect(detector.observe(snap(false, 1000))).toBe('MIC_NO_SIGNAL');
    expect(detector.observe(snap(false, 2000))).toBeNull(); // raised only once
    expect(detector.observe(snap(true, 2100))).toBeNull(); // signal resets
    expect(detector.observe(snap(false, 2200))).toBeNull();
    expect(detector.observe(snap(false, 3200))).toBe('MIC_NO_SIGNAL');
  });
});
