import { isAbsolute } from 'node:path';
import { isSafeRelativePath, resolveMediaPath } from '@main/media/media-resolver';
import { AppError, isAppError } from '@shared/errors/app-error';

const VIDEOS_ROOT = '/srv/candidcue/videos';

describe('isSafeRelativePath', () => {
  it('accepts ordinary nested clip paths', () => {
    expect(isSafeRelativePath('mira/listening/x.mp4')).toBe(true);
    expect(isSafeRelativePath('mira/speaking/mira-speaking-7s.mp4')).toBe(true);
    expect(isSafeRelativePath('clip.mp4')).toBe(true);
  });

  it('accepts paths with a single dot segment (no traversal)', () => {
    // A bare `.` does not climb above the root.
    expect(isSafeRelativePath('./mira/listening/x.mp4')).toBe(true);
  });

  it('rejects empty and non-string input', () => {
    expect(isSafeRelativePath('')).toBe(false);
    expect(isSafeRelativePath(undefined as unknown as string)).toBe(false);
    expect(isSafeRelativePath(null as unknown as string)).toBe(false);
  });

  it('rejects parent-directory traversal', () => {
    expect(isSafeRelativePath('../etc/passwd')).toBe(false);
    expect(isSafeRelativePath('a/../../b')).toBe(false);
    expect(isSafeRelativePath('mira/../../secret')).toBe(false);
    expect(isSafeRelativePath('..')).toBe(false);
  });

  it('rejects backslash-separated traversal', () => {
    expect(isSafeRelativePath('..\\windows\\system32')).toBe(false);
    expect(isSafeRelativePath('a\\..\\..\\b')).toBe(false);
  });

  it('rejects percent-encoded traversal', () => {
    expect(isSafeRelativePath('%2e%2e/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('mira/%2e%2e/%2e%2e/secret')).toBe(false);
    // Encoded slash with encoded dots.
    expect(isSafeRelativePath('..%2fetc%2fpasswd')).toBe(false);
  });

  it('rejects absolute POSIX paths', () => {
    expect(isSafeRelativePath('/abs/path')).toBe(false);
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
  });

  it('rejects Windows drive and UNC paths', () => {
    expect(isSafeRelativePath('C:\\Windows\\System32')).toBe(false);
    expect(isSafeRelativePath('C:/Windows/System32')).toBe(false);
    expect(isSafeRelativePath('\\\\server\\share\\file.mp4')).toBe(false);
  });

  it('rejects paths containing NUL bytes', () => {
    expect(isSafeRelativePath('mira/listening/x.mp4\0.png')).toBe(false);
  });

  it('rejects malformed percent-encoding', () => {
    expect(isSafeRelativePath('%')).toBe(false);
    expect(isSafeRelativePath('mira/%zz/x.mp4')).toBe(false);
  });
});

describe('resolveMediaPath', () => {
  it('resolves a safe nested path to an absolute path inside the root', () => {
    const resolved = resolveMediaPath(VIDEOS_ROOT, 'mira/listening/x.mp4');
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(`${VIDEOS_ROOT}/mira/listening/x.mp4`);
    expect(resolved.startsWith(`${VIDEOS_ROOT}/`)).toBe(true);
  });

  it('resolves a top-level file inside the root', () => {
    expect(resolveMediaPath(VIDEOS_ROOT, 'clip.mp4')).toBe(`${VIDEOS_ROOT}/clip.mp4`);
  });

  it('throws MEDIA_MANIFEST_INVALID for parent traversal', () => {
    expect(() => resolveMediaPath(VIDEOS_ROOT, '../etc/passwd')).toThrow(AppError);
    try {
      resolveMediaPath(VIDEOS_ROOT, '../etc/passwd');
      throw new Error('should have thrown');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      expect((error as AppError).code).toBe('MEDIA_MANIFEST_INVALID');
    }
  });

  it('throws for embedded traversal that escapes the root', () => {
    expect(() => resolveMediaPath(VIDEOS_ROOT, 'a/../../b')).toThrow(AppError);
    expect(() => resolveMediaPath(VIDEOS_ROOT, 'mira/../../secret')).toThrow(AppError);
  });

  it('throws for absolute POSIX paths', () => {
    expect(() => resolveMediaPath(VIDEOS_ROOT, '/abs/path')).toThrow(AppError);
    expect(() => resolveMediaPath(VIDEOS_ROOT, '/etc/passwd')).toThrow(AppError);
  });

  it('throws for Windows drive and UNC paths', () => {
    expect(() => resolveMediaPath(VIDEOS_ROOT, 'C:\\Windows')).toThrow(AppError);
    expect(() => resolveMediaPath(VIDEOS_ROOT, '\\\\server\\share')).toThrow(AppError);
  });

  it('throws for percent-encoded traversal', () => {
    expect(() => resolveMediaPath(VIDEOS_ROOT, '%2e%2e/etc/passwd')).toThrow(AppError);
  });

  it('throws for an empty videos root', () => {
    expect(() => resolveMediaPath('', 'mira/x.mp4')).toThrow(AppError);
  });

  it('does not allow a sibling directory that shares a name prefix', () => {
    // `mira/x` under `/videos` must never resolve into `/videos-evil`.
    const resolved = resolveMediaPath('/videos', 'mira/x.mp4');
    expect(resolved.startsWith('/videos-evil')).toBe(false);
    expect(resolved.startsWith('/videos/')).toBe(true);
  });
});
