/**
 * Path-safety for interviewer media (spec §18.2).
 *
 * Manifest `relativePath` values arrive from generated JSON and are used to read
 * video files off disk. They MUST be confined to the videos root: a malicious or
 * malformed manifest must never be able to read `../../etc/passwd`, an absolute
 * path, or a Windows UNC/drive path. This module performs the only sanctioned
 * conversion from a manifest-supplied relative path to an absolute filesystem
 * path, rejecting anything that could escape `videosRoot`.
 */
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { AppError } from '@shared/errors/app-error';

/**
 * Reject a relative path early if it is obviously unsafe — without touching the
 * filesystem. A path is considered safe only when it:
 *
 *  - is a non-empty string,
 *  - is not absolute (`/foo`, `C:\foo`, `\\server\share`),
 *  - contains no `..` traversal segment (raw or percent-encoded),
 *  - contains no NUL byte,
 *  - and, once normalized, does not climb above its own root.
 *
 * Both POSIX (`/`) and Windows (`\`) separators are inspected so a manifest
 * authored on either platform is validated consistently.
 */
export function isSafeRelativePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) {
    return false;
  }

  // NUL bytes can truncate paths in native fs calls; never allow them.
  if (p.includes('\0')) {
    return false;
  }

  // Decode percent-encoding so encoded traversal (`%2e%2e`, `%2f`) is caught.
  // A malformed sequence (which would throw) is itself treated as unsafe.
  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    return false;
  }
  if (decoded.includes('\0')) {
    return false;
  }

  // Absolute paths (POSIX, Windows drive, or UNC) escape the root by definition.
  if (isAbsolute(p) || isAbsolute(decoded)) {
    return false;
  }
  // `isAbsolute` on POSIX does not flag Windows-style roots; check explicitly so
  // a manifest is rejected the same way regardless of the host OS.
  if (isWindowsRooted(p) || isWindowsRooted(decoded)) {
    return false;
  }

  // Split on either separator and inspect each segment for traversal.
  for (const candidate of [p, decoded]) {
    const segments = candidate.split(/[\\/]+/);
    for (const segment of segments) {
      if (segment === '..') {
        return false;
      }
    }
  }

  return true;
}

/**
 * Resolve a manifest-supplied `relativePath` to an absolute path inside
 * `videosRoot`, throwing {@link AppError} `MEDIA_MANIFEST_INVALID` on any path
 * that is unsafe or that escapes the root.
 *
 * `videosRoot` is the directory the manifest's `relativePath` values are
 * relative to (e.g. the `videos/` folder, since paths look like
 * `mira/listening/clip.mp4`). The returned path is guaranteed to be a descendant
 * of `videosRoot`.
 */
export function resolveMediaPath(videosRoot: string, relativePath: string): string {
  if (typeof videosRoot !== 'string' || videosRoot.length === 0) {
    throw new AppError('MEDIA_MANIFEST_INVALID', {
      message: 'resolveMediaPath called with an empty videos root',
    });
  }

  // Cheap structural checks first: anything obviously unsafe is rejected before
  // we resolve it against the filesystem root.
  if (!isSafeRelativePath(relativePath)) {
    throw new AppError('MEDIA_MANIFEST_INVALID', {
      message: `Unsafe media path: ${JSON.stringify(relativePath)}`,
      publicMessage: 'The interviewer media library references an invalid file path.',
    });
  }

  // Resolve and then re-verify containment. Even after the structural checks,
  // `resolve` is the authority on where the path actually lands; comparing the
  // resolved path against the (normalized) root closes any gap.
  const root = resolve(videosRoot);
  const resolved = resolve(root, normalize(relativePath));

  // The resolved path must be the root itself or sit strictly beneath it. The
  // trailing-separator guard prevents a sibling like `/videos-evil` from
  // matching a `/videos` prefix.
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new AppError('MEDIA_MANIFEST_INVALID', {
      message: `Resolved media path escapes videos root: ${JSON.stringify(relativePath)}`,
      publicMessage: 'The interviewer media library references an invalid file path.',
    });
  }

  return resolved;
}

/** Detect a Windows drive (`C:\`) or UNC (`\\server`) root on any platform. */
function isWindowsRooted(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p);
}
