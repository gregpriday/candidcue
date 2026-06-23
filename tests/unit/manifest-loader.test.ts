import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CharacterMediaManifest, MediaClip } from '@shared/domain';
import { isAppError } from '@shared/errors/app-error';
import { loadManifest, validateManifest } from '@main/media/manifest-loader';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MIRA_ROOT = join(REPO_ROOT, 'videos', 'mira');

/** Deep-clone a manifest so per-test mutations never leak across cases. */
function cloneManifest(manifest: CharacterMediaManifest): CharacterMediaManifest {
  return JSON.parse(JSON.stringify(manifest)) as CharacterMediaManifest;
}

describe('loadManifest', () => {
  it('parses the real mira manifest into a typed object', () => {
    const manifest = loadManifest(MIRA_ROOT);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.characterId).toBe('mira');
    expect(manifest.sourceRootHash.length).toBeGreaterThan(0);
    expect(manifest.clips).toHaveLength(14);

    const first = manifest.clips[0] as MediaClip;
    expect(first.id).toBe('listen_001');
    expect(first.mode).toBe('listening');
    expect(first.width).toBe(1280);
    expect(first.height).toBe(720);
    expect(first.fps).toBe(24);
    expect(first.hasAudio).toBe(false);
  });

  it('throws MEDIA_MANIFEST_INVALID when the manifest file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'candidcue-manifest-missing-'));
    try {
      loadManifest(join(dir, 'mira'));
      throw new Error('should have thrown');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe('MEDIA_MANIFEST_INVALID');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws MEDIA_MANIFEST_INVALID on malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'candidcue-manifest-badjson-'));
    const charRoot = join(dir, 'mira');
    mkdirSync(charRoot, { recursive: true });
    writeFileSync(join(charRoot, 'manifest.json'), '{ not valid json');
    try {
      expect(() => loadManifest(charRoot)).toThrow(/not valid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws MEDIA_MANIFEST_INVALID when a clip is structurally wrong', () => {
    const dir = mkdtempSync(join(tmpdir(), 'candidcue-manifest-badshape-'));
    const charRoot = join(dir, 'mira');
    mkdirSync(charRoot, { recursive: true });
    const broken = {
      schemaVersion: 1,
      characterId: 'mira',
      generatedAt: '2026-06-23T00:00:00.000Z',
      sourceRootHash: 'abc',
      clips: [
        {
          id: 'listen_001',
          relativePath: 'mira/listening/x.mp4',
          mode: 'listening',
          // durationMs intentionally a string to trip the type check.
          durationMs: 'ten',
          width: 1280,
          height: 720,
          fps: 24,
          codec: 'h264',
          container: 'mov',
          hasAudio: false,
          fileSizeBytes: 1,
          sha256: 'deadbeef',
          enabled: true,
          tags: [],
        },
      ],
    };
    writeFileSync(join(charRoot, 'manifest.json'), JSON.stringify(broken));
    try {
      expect(() => loadManifest(charRoot)).toThrow(/durationMs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('validateManifest — real mira library', () => {
  it('returns ok with the expected listening/speaking counts and no errors', () => {
    const manifest = loadManifest(MIRA_ROOT);
    const result = validateManifest(manifest, MIRA_ROOT);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.listeningCount).toBe(2);
    expect(result.speakingCount).toBe(12);
  });

  it('does not warn about dimensions or fps for the consistent library', () => {
    const manifest = loadManifest(MIRA_ROOT);
    const result = validateManifest(manifest, MIRA_ROOT);

    const dimWarnings = result.warnings.filter(
      (w) => w.code === 'inconsistent-dimensions' || w.code === 'inconsistent-fps',
    );
    expect(dimWarnings).toEqual([]);
  });

  it('warns about clips that sit just outside the 4s-15s band', () => {
    const manifest = loadManifest(MIRA_ROOT);
    const result = validateManifest(manifest, MIRA_ROOT);

    // mira-speaking-4s is 4042ms (in band) but listening-7s is fine; the 15s
    // clip is 15042ms which exceeds the 15s ceiling and must warn.
    const tooLong = result.warnings.filter((w) => w.code === 'clip-too-long');
    expect(tooLong.length).toBeGreaterThanOrEqual(1);
    expect(tooLong.some((w) => w.clipId === 'speaki_011')).toBe(true);
  });
});

describe('validateManifest — error cases', () => {
  it('reports a manifest-missing-file error when a clip file is absent', () => {
    const manifest = loadManifest(MIRA_ROOT);
    const mutated = cloneManifest(manifest);
    // Point one speaking clip at a file that does not exist on disk.
    const target = mutated.clips.find((c) => c.mode === 'speaking');
    expect(target).toBeDefined();
    if (target) {
      target.relativePath = 'mira/speaking/does-not-exist.mp4';
    }

    const result = validateManifest(mutated, MIRA_ROOT);
    expect(result.ok).toBe(false);
    const missing = result.errors.filter((e) => e.code === 'manifest-missing-file');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.relativePath).toBe('mira/speaking/does-not-exist.mp4');
  });

  it('reports an embedded-audio error when a speaking clip has hasAudio:true', () => {
    // Build an isolated character dir whose single speaking clip exists on disk
    // but declares embedded audio, so the ONLY error is the audio one.
    const dir = mkdtempSync(join(tmpdir(), 'candidcue-manifest-audio-'));
    const videosRoot = join(dir, 'videos');
    const charRoot = join(videosRoot, 'mira');
    const listeningDir = join(charRoot, 'listening');
    const speakingDir = join(charRoot, 'speaking');
    mkdirSync(listeningDir, { recursive: true });
    mkdirSync(speakingDir, { recursive: true });

    // Write tiny placeholder files so existence checks pass.
    writeFileSync(join(listeningDir, 'listen.mp4'), 'x');
    writeFileSync(join(speakingDir, 'speak.mp4'), 'x');

    const manifest: CharacterMediaManifest = {
      schemaVersion: 1,
      characterId: 'mira',
      generatedAt: '2026-06-23T00:00:00.000Z',
      sourceRootHash: 'abc',
      clips: [
        {
          id: 'listen_001',
          relativePath: 'mira/listening/listen.mp4',
          mode: 'listening',
          durationMs: 8000,
          width: 1280,
          height: 720,
          fps: 24,
          codec: 'h264',
          container: 'mov',
          hasAudio: false,
          fileSizeBytes: 1,
          sha256: 'a',
          enabled: true,
          tags: [],
        },
        {
          id: 'speaki_001',
          relativePath: 'mira/speaking/speak.mp4',
          mode: 'speaking',
          durationMs: 8000,
          width: 1280,
          height: 720,
          fps: 24,
          codec: 'h264',
          container: 'mov',
          // The offending field: embedded audio was not stripped.
          hasAudio: true,
          fileSizeBytes: 1,
          sha256: 'b',
          enabled: true,
          tags: [],
        },
      ],
    };
    writeFileSync(join(charRoot, 'manifest.json'), JSON.stringify(manifest));

    try {
      const result = validateManifest(manifest, charRoot);
      expect(result.ok).toBe(false);
      const audioErrors = result.errors.filter((e) => e.code === 'embedded-audio');
      expect(audioErrors).toHaveLength(1);
      expect(audioErrors[0]?.clipId).toBe('speaki_001');
      // No other error type should fire for this otherwise-valid library.
      const otherErrors = result.errors.filter((e) => e.code !== 'embedded-audio');
      expect(otherErrors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports no-listening-clips and no-speaking-clips when a mode is empty', () => {
    const manifest = loadManifest(MIRA_ROOT);
    const mutated = cloneManifest(manifest);
    mutated.clips = [];

    const result = validateManifest(mutated, MIRA_ROOT);
    expect(result.ok).toBe(false);
    expect(result.listeningCount).toBe(0);
    expect(result.speakingCount).toBe(0);
    expect(result.errors.some((e) => e.code === 'no-listening-clips')).toBe(true);
    expect(result.errors.some((e) => e.code === 'no-speaking-clips')).toBe(true);
  });

  it('reports invalid-duration and invalid-dimensions for non-positive values', () => {
    const manifest = loadManifest(MIRA_ROOT);
    const mutated = cloneManifest(manifest);
    const clip = mutated.clips[0] as MediaClip;
    clip.durationMs = 0;
    clip.width = 0;
    clip.height = -1;

    const result = validateManifest(mutated, MIRA_ROOT);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'invalid-duration' && e.clipId === clip.id)).toBe(
      true,
    );
    expect(
      result.errors.some((e) => e.code === 'invalid-dimensions' && e.clipId === clip.id),
    ).toBe(true);
  });

  it('reports an unsafe-path error for a traversal relativePath', () => {
    const manifest = loadManifest(MIRA_ROOT);
    const mutated = cloneManifest(manifest);
    const clip = mutated.clips[0] as MediaClip;
    clip.relativePath = '../../etc/passwd';

    const result = validateManifest(mutated, MIRA_ROOT);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'unsafe-path' && e.clipId === clip.id)).toBe(true);
  });

  it('resolves clip files against the parent of charRoot (videos root)', () => {
    // The mira manifest stores paths like "mira/listening/...", which only
    // resolve correctly when charRoot's parent is treated as the videos root.
    const manifest = loadManifest(MIRA_ROOT);
    const result = validateManifest(manifest, MIRA_ROOT);
    // If resolution used charRoot directly, every file would be "missing".
    expect(result.errors.filter((e) => e.code === 'manifest-missing-file')).toEqual([]);
    expect(dirname(MIRA_ROOT)).toBe(join(REPO_ROOT, 'videos'));
  });

  it('warns about inconsistent dimensions and fps for an outlier clip', () => {
    const manifest = loadManifest(MIRA_ROOT);
    const mutated = cloneManifest(manifest);
    const clip = mutated.clips[1] as MediaClip;
    clip.width = 1920;
    clip.height = 1080;
    clip.fps = 30;

    const result = validateManifest(mutated, MIRA_ROOT);
    // The outlier is the minority, so the dominant spec stays 1280x720@24.
    expect(
      result.warnings.some((w) => w.code === 'inconsistent-dimensions' && w.clipId === clip.id),
    ).toBe(true);
    expect(result.warnings.some((w) => w.code === 'inconsistent-fps' && w.clipId === clip.id)).toBe(
      true,
    );
  });
});
