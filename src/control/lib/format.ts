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

/**
 * "0 words · — · 0 cues" statistics line under the editor title (spec §21.8).
 *
 * Returns a populated string at every count, including zero, and that is the
 * whole point: the header renders this line only when it has text, so a version
 * that went empty at zero words vanished from a blank script and reappeared on
 * the first keystroke — shoving the editor body down 20px exactly as the author
 * started typing. Every script passes through zero on its way to being written,
 * so this is the one state worth reserving room for.
 *
 * The em dash comes from `formatSpeakingDuration`'s own "nothing to estimate"
 * branch rather than new zero copy, so the segment reads the same here as it
 * does anywhere else a duration is unknown.
 */
export function formatScriptMeta(
  wordCount: number,
  durationSeconds: number,
  cueCount: number,
): string {
  const words = `${wordCount.toLocaleString()} ${wordCount === 1 ? 'word' : 'words'}`;
  const cues = `${cueCount} ${cueCount === 1 ? 'cue' : 'cues'}`;
  return `${words} · ${formatSpeakingDuration(durationSeconds)} · ${cues}`;
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
  // Cut on a word boundary — see `preview_text` in src-tauri/src/scripts/words.rs,
  // which owns the real thing. This is the dev/mock path and has to agree with it,
  // or a preview looks different in `pnpm dev` than it does in the app.
  const head = stripped.slice(0, maxLength - 1);
  const boundary = head.lastIndexOf(' ');
  if (boundary > 0) return `${head.slice(0, boundary).trimEnd()}…`;
  /*
   * No boundary to back up to — one unbroken run, so the flat cut is all there
   * is. `slice` counts UTF-16 code units, and Rust's `chars()` counts scalars, so
   * this is the one path where the two implementations can disagree: a run of
   * emoji cut between the halves of a surrogate pair renders as a replacement
   * glyph right before the ellipsis. Dropping the orphaned half costs one
   * character and cannot produce broken glass.
   */
  const cut = /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
  return `${cut.trimEnd()}…`;
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
