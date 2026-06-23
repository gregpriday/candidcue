import { describe, it, expect } from 'vitest';
import type { MediaClip } from '@shared/domain';
import { mulberry32 } from '@shared/utils';
import { AppError } from '@shared/errors/app-error';
import { ListeningScheduler } from '@main/media/listening-scheduler';

function makeClip(id: string): MediaClip {
  return {
    id,
    relativePath: `listening/${id}.mp4`,
    mode: 'listening',
    durationMs: 4000,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'h264',
    container: 'mp4',
    hasAudio: false,
    fileSizeBytes: 1_000_000,
    sha256: id.padEnd(64, '0'),
    enabled: true,
    tags: [],
  };
}

function makeClips(count: number): MediaClip[] {
  return Array.from({ length: count }, (_, i) => makeClip(`clip-${i}`));
}

describe('ListeningScheduler', () => {
  it('never returns the same clip twice in a row over 50 calls (>= 3 clips)', () => {
    const clips = makeClips(3);
    const scheduler = new ListeningScheduler(mulberry32(1));

    let previousId: string | null = null;
    for (let i = 0; i < 50; i++) {
      const clip = scheduler.next(clips);
      expect(clip.id).not.toBe(previousId);
      previousId = clip.id;
    }
  });

  it('never repeats immediately across many seeds and clip counts', () => {
    for (let seed = 0; seed < 25; seed++) {
      for (const count of [2, 3, 5, 8]) {
        const clips = makeClips(count);
        const scheduler = new ListeningScheduler(mulberry32(seed * 31 + count));
        let previousId: string | null = null;
        for (let i = 0; i < 60; i++) {
          const clip = scheduler.next(clips);
          expect(clip.id).not.toBe(previousId);
          previousId = clip.id;
        }
      }
    }
  });

  it('returns every clip exactly once within a full cycle', () => {
    const clips = makeClips(4);
    const scheduler = new ListeningScheduler(mulberry32(7));

    const cycle = clips.map(() => scheduler.next(clips).id);
    expect(new Set(cycle).size).toBe(clips.length);
    expect([...cycle].sort()).toEqual(clips.map((c) => c.id).sort());
  });

  it('covers all clips within the first full cycle across many seeds', () => {
    const clips = makeClips(5);
    const expected = clips.map((c) => c.id).sort();

    for (let seed = 0; seed < 30; seed++) {
      const scheduler = new ListeningScheduler(mulberry32(seed + 100));
      const seen = new Set<string>();
      for (let i = 0; i < clips.length; i++) {
        seen.add(scheduler.next(clips).id);
      }
      expect([...seen].sort()).toEqual(expected);
    }
  });

  it('returns only valid enabled clips', () => {
    const clips = makeClips(4);
    const validIds = new Set(clips.map((c) => c.id));
    const scheduler = new ListeningScheduler(mulberry32(3));

    for (let i = 0; i < 40; i++) {
      expect(validIds.has(scheduler.next(clips).id)).toBe(true);
    }
  });

  it('returns the same clip every time when only one is enabled', () => {
    const clips = makeClips(1);
    const onlyId = clips[0]!.id;
    const scheduler = new ListeningScheduler(mulberry32(42));

    for (let i = 0; i < 20; i++) {
      expect(scheduler.next(clips).id).toBe(onlyId);
    }
  });

  it('throws an AppError when given no enabled clips', () => {
    const scheduler = new ListeningScheduler(mulberry32(1));
    expect(() => scheduler.next([])).toThrow(AppError);
    expect(() => scheduler.next([])).toThrow(/no enabled clips/i);
    try {
      scheduler.next([]);
      throw new Error('expected next() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('MEDIA_MANIFEST_INVALID');
    }
  });

  it('adapts when the enabled clip set changes between calls', () => {
    const initial = makeClips(3);
    const scheduler = new ListeningScheduler(mulberry32(9));

    scheduler.next(initial);

    // Swap to a disjoint set; the scheduler must only return clips from it.
    const replacement = [makeClip('x-0'), makeClip('x-1'), makeClip('x-2')];
    const replacementIds = new Set(replacement.map((c) => c.id));

    let previousId: string | null = null;
    for (let i = 0; i < 30; i++) {
      const clip = scheduler.next(replacement);
      expect(replacementIds.has(clip.id)).toBe(true);
      expect(clip.id).not.toBe(previousId);
      previousId = clip.id;
    }
  });

  it('does not repeat immediately when transitioning between cycles', () => {
    const clips = makeClips(2);
    const scheduler = new ListeningScheduler(mulberry32(2));

    // 2 clips, run several cycles; the boundary swap must hold across them.
    let previousId: string | null = null;
    for (let i = 0; i < 100; i++) {
      const clip = scheduler.next(clips);
      expect(clip.id).not.toBe(previousId);
      previousId = clip.id;
    }
  });

  it('defaults to Math.random when no rng is injected', () => {
    const clips = makeClips(3);
    const scheduler = new ListeningScheduler();
    const validIds = new Set(clips.map((c) => c.id));

    let previousId: string | null = null;
    for (let i = 0; i < 30; i++) {
      const clip = scheduler.next(clips);
      expect(validIds.has(clip.id)).toBe(true);
      expect(clip.id).not.toBe(previousId);
      previousId = clip.id;
    }
  });
});
