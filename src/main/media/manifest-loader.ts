/**
 * Loading and validation for a character's media manifest (spec §18.1, §18.4).
 *
 * The manifest is produced offline by the media indexer (scripts/index-media.ts)
 * and committed alongside the clips. At runtime we re-read it defensively: the
 * JSON could be hand-edited, partially written, or out of sync with the files on
 * disk. {@link loadManifest} parses and shape-checks it; {@link validateManifest}
 * cross-checks it against the filesystem and the library's quality rules,
 * returning a structured {@link MediaValidationResult} of errors and warnings.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  CharacterMediaManifest,
  MediaClip,
  MediaMode,
  MediaValidationIssue,
  MediaValidationResult,
} from '@shared/domain';
import { AppError } from '@shared/errors/app-error';
import { isSafeRelativePath, resolveMediaPath } from './media-resolver';

/** Clips shorter/longer than this are flagged (warning only) per §18.4. */
const MIN_RECOMMENDED_CLIP_MS = 4_000;
const MAX_RECOMMENDED_CLIP_MS = 15_000;

const VALID_MODES: readonly MediaMode[] = ['listening', 'speaking'];

/**
 * Read and parse `charRoot/manifest.json` into a typed
 * {@link CharacterMediaManifest}, performing Zod-light structural validation.
 *
 * Throws {@link AppError} `MEDIA_MANIFEST_INVALID` when the file is missing,
 * not valid JSON, or does not match the expected shape. The thrown error is
 * structural only — semantic/filesystem checks live in {@link validateManifest}.
 */
export function loadManifest(charRoot: string): CharacterMediaManifest {
  const manifestPath = join(charRoot, 'manifest.json');

  if (!existsSync(manifestPath)) {
    throw new AppError('MEDIA_MANIFEST_INVALID', {
      message: `Manifest not found at ${manifestPath}`,
      publicMessage: 'The interviewer media library is missing its manifest.',
    });
  }

  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (cause) {
    throw new AppError('MEDIA_MANIFEST_INVALID', {
      message: `Could not read manifest at ${manifestPath}`,
      cause,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new AppError('MEDIA_MANIFEST_INVALID', {
      message: `Manifest at ${manifestPath} is not valid JSON`,
      cause,
    });
  }

  return parseManifest(parsed, manifestPath);
}

/**
 * Validate a manifest against the filesystem and library quality rules (§18.4).
 *
 * `charRoot` is the character's media folder (the directory that contains
 * `manifest.json`). Clip `relativePath` values are stored relative to the
 * *videos* root (e.g. `mira/listening/clip.mp4`), so files are resolved against
 * `dirname(charRoot)`.
 *
 * Errors (any of which set `ok: false`):
 *  - no listening clips, or no speaking clips,
 *  - a clip path that is unsafe or escapes the videos root,
 *  - a referenced clip file that does not exist (`manifest-missing-file`),
 *  - a non-positive `durationMs`, `width`, or `height`,
 *  - an invalid `mode`,
 *  - a speaking clip with embedded audio (`hasAudio: true`) — audio must be
 *    stripped at index time so the synthesized voice is the only sound.
 *
 * Warnings (do not affect `ok`):
 *  - clip duration below {@link MIN_RECOMMENDED_CLIP_MS} or above
 *    {@link MAX_RECOMMENDED_CLIP_MS},
 *  - dimensions or fps that differ from the library's dominant values.
 *
 * Counts reflect every clip declared for each mode, regardless of `enabled`.
 */
export function validateManifest(
  manifest: CharacterMediaManifest,
  charRoot: string,
): MediaValidationResult {
  const errors: MediaValidationIssue[] = [];
  const warnings: MediaValidationIssue[] = [];

  // Clip paths are relative to the videos root, which is the parent of the
  // character folder that holds the manifest.
  const videosRoot = dirname(charRoot);

  const clips = manifest.clips;
  const listeningCount = clips.filter((c) => c.mode === 'listening').length;
  const speakingCount = clips.filter((c) => c.mode === 'speaking').length;

  // §18.4: both modes are required and each must have at least one clip.
  if (listeningCount === 0) {
    errors.push({
      level: 'error',
      code: 'no-listening-clips',
      message: 'The manifest declares no listening clips; at least one is required.',
    });
  }
  if (speakingCount === 0) {
    errors.push({
      level: 'error',
      code: 'no-speaking-clips',
      message: 'The manifest declares no speaking clips; at least one is required.',
    });
  }

  // Determine the library's dominant dimensions/fps so outliers can be flagged.
  const dominant = computeDominantSpec(clips);

  for (const clip of clips) {
    validateClip(clip, videosRoot, dominant, errors, warnings);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    listeningCount,
    speakingCount,
  };
}

/** Per-clip checks, accumulating into the shared error/warning lists. */
function validateClip(
  clip: MediaClip,
  videosRoot: string,
  dominant: DominantSpec,
  errors: MediaValidationIssue[],
  warnings: MediaValidationIssue[],
): void {
  const where = { clipId: clip.id, relativePath: clip.relativePath };

  // Mode must be one of the known values.
  if (!VALID_MODES.includes(clip.mode)) {
    errors.push({
      level: 'error',
      code: 'invalid-mode',
      message: `Clip "${clip.id}" has an unknown mode "${String(clip.mode)}".`,
      ...where,
    });
  }

  // Numeric sanity: a zero/negative duration or dimension is unplayable.
  if (!(clip.durationMs > 0)) {
    errors.push({
      level: 'error',
      code: 'invalid-duration',
      message: `Clip "${clip.id}" has a non-positive durationMs (${clip.durationMs}).`,
      ...where,
    });
  }
  if (!(clip.width > 0) || !(clip.height > 0)) {
    errors.push({
      level: 'error',
      code: 'invalid-dimensions',
      message: `Clip "${clip.id}" has non-positive dimensions (${clip.width}x${clip.height}).`,
      ...where,
    });
  }

  // §18.4: speaking clips must have had embedded audio stripped, so the only
  // sound during playback is the synthesized interviewer voice.
  if (clip.hasAudio) {
    errors.push({
      level: 'error',
      code: 'embedded-audio',
      message: `Clip "${clip.id}" still contains embedded audio; audio must be stripped at index time.`,
      ...where,
    });
  }

  // File-existence: resolve safely, then confirm the file is on disk. An unsafe
  // path is a hard error (and we cannot meaningfully check existence for it).
  if (!isSafeRelativePath(clip.relativePath)) {
    errors.push({
      level: 'error',
      code: 'unsafe-path',
      message: `Clip "${clip.id}" has an unsafe relative path: ${JSON.stringify(clip.relativePath)}.`,
      ...where,
    });
  } else {
    const abs = resolveMediaPath(videosRoot, clip.relativePath);
    if (!existsSync(abs)) {
      errors.push({
        level: 'error',
        code: 'manifest-missing-file',
        message: `Clip "${clip.id}" references a missing file: ${clip.relativePath}.`,
        ...where,
      });
    }
  }

  // Quality warnings: out-of-band duration is allowed but discouraged.
  if (clip.durationMs > 0 && clip.durationMs < MIN_RECOMMENDED_CLIP_MS) {
    warnings.push({
      level: 'warning',
      code: 'clip-too-short',
      message: `Clip "${clip.id}" is shorter than ${MIN_RECOMMENDED_CLIP_MS / 1000}s (${clip.durationMs}ms).`,
      ...where,
    });
  }
  if (clip.durationMs > MAX_RECOMMENDED_CLIP_MS) {
    warnings.push({
      level: 'warning',
      code: 'clip-too-long',
      message: `Clip "${clip.id}" is longer than ${MAX_RECOMMENDED_CLIP_MS / 1000}s (${clip.durationMs}ms).`,
      ...where,
    });
  }

  // Inconsistent dimensions/fps relative to the library make stitched playback
  // jarring; warn so they can be re-rendered to match.
  if (dominant.width !== null && dominant.height !== null) {
    if (clip.width !== dominant.width || clip.height !== dominant.height) {
      warnings.push({
        level: 'warning',
        code: 'inconsistent-dimensions',
        message:
          `Clip "${clip.id}" is ${clip.width}x${clip.height}, ` +
          `but the library is mostly ${dominant.width}x${dominant.height}.`,
        ...where,
      });
    }
  }
  if (dominant.fps !== null && clip.fps !== dominant.fps) {
    warnings.push({
      level: 'warning',
      code: 'inconsistent-fps',
      message: `Clip "${clip.id}" is ${clip.fps}fps, but the library is mostly ${dominant.fps}fps.`,
      ...where,
    });
  }
}

interface DominantSpec {
  width: number | null;
  height: number | null;
  fps: number | null;
}

/**
 * Find the most common width/height/fps across clips so outliers can be flagged.
 * Returns `null` for a field when there are no clips to derive a value from.
 */
function computeDominantSpec(clips: MediaClip[]): DominantSpec {
  return {
    width: mode(clips.map((c) => c.width)),
    height: mode(clips.map((c) => c.height)),
    fps: mode(clips.map((c) => c.fps)),
  };
}

/** Return the most frequently occurring value, or `null` for an empty input. */
function mode(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const counts = new Map<number, number>();
  let best = values[0] as number;
  let bestCount = 0;
  for (const value of values) {
    const next = (counts.get(value) ?? 0) + 1;
    counts.set(value, next);
    if (next > bestCount) {
      best = value;
      bestCount = next;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Zod-light structural parsing
// ---------------------------------------------------------------------------

/**
 * Structurally validate a parsed JSON value into a {@link CharacterMediaManifest}.
 * Throws {@link AppError} `MEDIA_MANIFEST_INVALID` on the first shape mismatch,
 * with a message pointing at the offending field.
 */
function parseManifest(value: unknown, source: string): CharacterMediaManifest {
  const obj = asObject(value, 'manifest', source);

  if (obj.schemaVersion !== 1) {
    fail(`schemaVersion must be 1, got ${JSON.stringify(obj.schemaVersion)}`, source);
  }

  const characterId = asNonEmptyString(obj.characterId, 'characterId', source);
  const generatedAt = asNonEmptyString(obj.generatedAt, 'generatedAt', source);
  const sourceRootHash = asNonEmptyString(obj.sourceRootHash, 'sourceRootHash', source);

  if (!Array.isArray(obj.clips)) {
    fail('clips must be an array', source);
  }
  const clips = obj.clips.map((clip, index) => parseClip(clip, index, source));

  return {
    schemaVersion: 1,
    characterId,
    generatedAt,
    sourceRootHash,
    clips,
  };
}

/** Structurally validate a single clip entry. */
function parseClip(value: unknown, index: number, source: string): MediaClip {
  const label = `clips[${index}]`;
  const obj = asObject(value, label, source);

  const mode = obj.mode;
  if (mode !== 'listening' && mode !== 'speaking') {
    fail(`${label}.mode must be "listening" or "speaking", got ${JSON.stringify(mode)}`, source);
  }

  return {
    id: asNonEmptyString(obj.id, `${label}.id`, source),
    relativePath: asNonEmptyString(obj.relativePath, `${label}.relativePath`, source),
    mode,
    durationMs: asNumber(obj.durationMs, `${label}.durationMs`, source),
    width: asNumber(obj.width, `${label}.width`, source),
    height: asNumber(obj.height, `${label}.height`, source),
    fps: asNumber(obj.fps, `${label}.fps`, source),
    codec: asNonEmptyString(obj.codec, `${label}.codec`, source),
    container: asNonEmptyString(obj.container, `${label}.container`, source),
    hasAudio: asBoolean(obj.hasAudio, `${label}.hasAudio`, source),
    fileSizeBytes: asNumber(obj.fileSizeBytes, `${label}.fileSizeBytes`, source),
    sha256: asNonEmptyString(obj.sha256, `${label}.sha256`, source),
    enabled: asBoolean(obj.enabled, `${label}.enabled`, source),
    tags: asStringArray(obj.tags, `${label}.tags`, source),
  };
}

function asObject(value: unknown, label: string, source: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`, source);
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, label: string, source: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string`, source);
  }
  return value;
}

function asNumber(value: unknown, label: string, source: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    fail(`${label} must be a number`, source);
  }
  return value;
}

function asBoolean(value: unknown, label: string, source: string): boolean {
  if (typeof value !== 'boolean') {
    fail(`${label} must be a boolean`, source);
  }
  return value;
}

function asStringArray(value: unknown, label: string, source: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail(`${label} must be an array of strings`, source);
  }
  return value as string[];
}

/** Throw a structural {@link AppError}; declared as `never` to narrow callers. */
function fail(message: string, source: string): never {
  throw new AppError('MEDIA_MANIFEST_INVALID', {
    message: `Invalid manifest (${source}): ${message}`,
  });
}
