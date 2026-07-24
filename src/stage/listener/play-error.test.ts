import { describe, it, expect } from 'vitest';
import { classifyPlayRejection } from './play-error';

/**
 * D2 regression: playActive() attributed EVERY play() rejection to decode
 * trouble and degraded to the poster, so an autoplay-policy refusal — and the
 * entirely routine AbortError raised whenever a crossfade interrupts a pending
 * play() — were both misdiagnosed as broken media.
 */
describe('classifyPlayRejection', () => {
  const domError = (name: string): Error => Object.assign(new Error(name), { name });

  it('ignores an interrupted play(), which a crossfade raises constantly', () => {
    expect(classifyPlayRejection(domError('AbortError'))).toBe('ignored');
  });

  it('separates an autoplay refusal from a codec problem', () => {
    expect(classifyPlayRejection(domError('NotAllowedError'))).toBe('autoplay_blocked');
  });

  it('still reports genuine media failures', () => {
    expect(classifyPlayRejection(domError('NotSupportedError'))).toBe('media_error');
    expect(classifyPlayRejection(domError('EncodingError'))).toBe('media_error');
  });

  it('treats anything unrecognisable as a media failure', () => {
    expect(classifyPlayRejection(undefined)).toBe('media_error');
    expect(classifyPlayRejection(null)).toBe('media_error');
    expect(classifyPlayRejection('AbortError')).toBe('media_error');
    expect(classifyPlayRejection({ name: 42 })).toBe('media_error');
  });
});
