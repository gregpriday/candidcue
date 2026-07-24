import { describe, expect, it } from 'vitest';
import { MicTestRecorder } from './micTest';
import type { MediaStreamLike, RecorderLike } from './types';

class FakeRecorder implements RecorderLike {
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['chunk-a'], { type: 'audio/webm' }) });
    this.ondataavailable?.({ data: new Blob(['chunk-b'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

const stream: MediaStreamLike = { getAudioTracks: () => [], getTracks: () => [] };

describe('MicTestRecorder (spec §28.5/§28.7)', () => {
  it('records a clip into memory and reports its duration', async () => {
    let t = 1000;
    const recorder = new MicTestRecorder({ createRecorder: () => new FakeRecorder(), now: () => t });
    recorder.start(stream);
    expect(recorder.recording).toBe(true);
    t = 4200;
    const clip = await recorder.stop();
    expect(clip).not.toBeNull();
    expect(clip?.durationMs).toBe(3200);
    expect(clip?.mimeType).toBe('audio/webm');
    expect(clip?.blob.size).toBeGreaterThan(0);
    expect(recorder.getClip()).toBe(clip);
  });

  it('resolves null when nothing was captured', async () => {
    class EmptyRecorder extends FakeRecorder {
      override stop(): void {
        this.state = 'inactive';
        this.onstop?.();
      }
    }
    const recorder = new MicTestRecorder({ createRecorder: () => new EmptyRecorder() });
    recorder.start(stream);
    expect(await recorder.stop()).toBeNull();
  });

  it('creates and revokes a playback URL, and discard drops everything', async () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    const recorder = new MicTestRecorder({
      createRecorder: () => new FakeRecorder(),
      createObjectUrl: (blob) => {
        created.push(blob);
        return `blob:fake-${created.length}`;
      },
      revokeObjectUrl: (url) => revoked.push(url),
    });
    recorder.start(stream);
    await recorder.stop();
    const url = recorder.createPlaybackUrl();
    expect(url).toBe('blob:fake-1');
    expect(recorder.createPlaybackUrl()).toBe(url); // stable while clip lives
    recorder.discard();
    expect(revoked).toEqual(['blob:fake-1']);
    expect(recorder.getClip()).toBeNull();
    expect(recorder.createPlaybackUrl()).toBeNull();
  });

  it('starting a new recording discards the previous clip', async () => {
    const recorder = new MicTestRecorder({ createRecorder: () => new FakeRecorder() });
    recorder.start(stream);
    await recorder.stop();
    expect(recorder.getClip()).not.toBeNull();
    recorder.start(stream);
    expect(recorder.getClip()).toBeNull();
  });
});
