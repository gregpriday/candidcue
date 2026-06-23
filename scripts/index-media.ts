/**
 * Media indexer (spec §18.3). Scans a character's listening/ and speaking/
 * folders, probes each clip with ffprobe, and writes a deterministic
 * manifest.json. Run: `npm run media:index -- [characterId]` (default: mira).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VIDEOS_ROOT = join(ROOT, 'videos');

interface ProbeResult {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  container: string;
  hasAudio: boolean;
}

function probe(file: string): ProbeResult {
  const raw = execFileSync(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate',
      '-show_entries', 'format=duration,format_name',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(raw) as {
    streams: Array<{
      codec_type: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }>;
    format: { duration?: string; format_name?: string };
  };
  const video = parsed.streams.find((s) => s.codec_type === 'video');
  const hasAudio = parsed.streams.some((s) => s.codec_type === 'audio');
  if (!video) throw new Error(`No video stream in ${file}`);
  const parts = (video.r_frame_rate ?? '0/1').split('/');
  const num = Number(parts[0] ?? 0);
  const den = Number(parts[1] ?? 1);
  const fps = den ? Math.round((num / den) * 100) / 100 : 0;
  return {
    durationMs: Math.round(Number(parsed.format.duration ?? 0) * 1000),
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps,
    codec: video.codec_name ?? 'unknown',
    container: (parsed.format.format_name ?? '').split(',')[0] ?? 'unknown',
    hasAudio,
  };
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function indexMode(charRoot: string, mode: 'listening' | 'speaking') {
  const dir = join(charRoot, mode);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.mp4') || f.toLowerCase().endsWith('.webm'))
    .sort();
  return files.map((file, idx) => {
    const abs = join(dir, file);
    const p = probe(abs);
    const size = statSync(abs).size;
    return {
      id: `${mode.slice(0, 6)}_${String(idx + 1).padStart(3, '0')}`,
      relativePath: relative(VIDEOS_ROOT, abs).split('\\').join('/'),
      mode,
      durationMs: p.durationMs,
      width: p.width,
      height: p.height,
      fps: p.fps,
      codec: p.codec,
      container: p.container,
      hasAudio: p.hasAudio,
      fileSizeBytes: size,
      sha256: sha256(abs),
      enabled: true,
      tags: [] as string[],
    };
  });
}

function main() {
  const characterId = process.argv[2] ?? 'mira';
  const charRoot = join(VIDEOS_ROOT, characterId);
  if (!existsSync(charRoot)) throw new Error(`Character folder not found: ${charRoot}`);

  const clips = [...indexMode(charRoot, 'listening'), ...indexMode(charRoot, 'speaking')];
  // sourceRootHash is the hash of all clip hashes so a content change is detected.
  const sourceRootHash = createHash('sha256')
    .update(clips.map((c) => `${c.relativePath}:${c.sha256}`).join('\n'))
    .digest('hex');

  const manifest = {
    schemaVersion: 1 as const,
    characterId,
    generatedAt: new Date().toISOString(),
    sourceRootHash,
    clips,
  };

  const out = join(charRoot, 'manifest.json');
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `Indexed ${clips.length} clips (${clips.filter((c) => c.mode === 'listening').length} listening, ` +
      `${clips.filter((c) => c.mode === 'speaking').length} speaking) → ${relative(ROOT, out)}`,
  );
}

main();
