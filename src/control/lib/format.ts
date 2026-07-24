/**
 * Small pure formatting helpers shared by the control-window screens.
 * Kept dependency-free so they are trivially unit-testable.
 */

/** Words-per-minute used for speaking-duration estimates (spec §21 metadata). */
export const DEFAULT_WPM = 150;

/** Rough spoken word count of a Markdown source (informational only). */
export function countWords(source: string): number {
  const stripped = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/:::[a-z-]*[\s\S]*?:::/gi, ' ')
    .replace(/\[(?:cue|take|pause|beat|breathe)[^\]]*\]/gi, ' ')
    .replace(/[#>*_`~|-]/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  const words = stripped.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length;
}

export function estimateDurationSeconds(words: number, wpm: number = DEFAULT_WPM): number {
  if (words <= 0) return 0;
  return Math.round((words / wpm) * 60);
}

/** "≈ 4 min" / "≈ 40 sec" speaking-length label. */
export function formatSpeakingDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  if (seconds < 60) return `≈ ${Math.max(5, Math.round(seconds / 5) * 5)} sec`;
  const minutes = Math.round(seconds / 60);
  return `≈ ${minutes} min`;
}

/** "12:04" or "1:02:03" clock for elapsed session time. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(secs).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Relative "last edited" label for library rows (spec §12.2). */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const deltaSec = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (deltaSec < 60) return 'just now';
  const minutes = Math.floor(deltaSec / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const date = new Date(then);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** One-line plain-text excerpt of a Markdown source for library rows. */
export function plainExcerpt(source: string, maxLength = 140): string {
  const stripped = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/:::[a-z-]*\n?/gi, ' ')
    .replace(/^#{1,6}\s+.*$/gm, ' ')
    .replace(/\[(?:cue|take|pause|beat|breathe)[^\]]*\]/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length <= maxLength) return stripped;
  return `${stripped.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Stable non-cryptographic hash of a script source (FNV-1a, hex). */
export function hashSource(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
