/**
 * §36.2 transcript retention — the choices, and which changes destroy data.
 *
 * This lives outside Settings.svelte because the interesting half is a
 * judgement, not markup: Rust enforces retention the instant the setting is
 * written (`settings::update` → `sessions::enforce_transcript_retention`), and
 * 'off' does not mean "stop keeping them from now on" — it deletes every
 * retained item there is. Whether a given change deletes something is
 * therefore a question worth asserting on directly.
 */
import type { TranscriptRetention } from '../services/settings-types';

export interface TranscriptRetentionOption {
  value: TranscriptRetention;
  label: string;
}

/**
 * Shortest-lived first, so the index doubles as a rank: a change to a LOWER
 * index is a change to a window that keeps less.
 */
export const TRANSCRIPT_RETENTION_OPTIONS: readonly TranscriptRetentionOption[] = [
  { value: 'off', label: 'Off — do not keep recognised words' },
  { value: '1d', label: 'Keep for 1 day' },
  { value: '7d', label: 'Keep for 7 days' },
  { value: '30d', label: 'Keep for 30 days' },
  { value: 'forever', label: 'Keep until I delete them' },
];

function rank(value: TranscriptRetention): number {
  return TRANSCRIPT_RETENTION_OPTIONS.findIndex((option) => option.value === value);
}

/**
 * True when moving from `current` to `next` can remove transcripts that are
 * already on disk.
 *
 * Lengthening the window deletes nothing — the items simply live longer — so
 * only a narrowing change needs to ask. An unrecognised value ranks as -1,
 * which is deliberately treated as "no worse than anything": a stored value
 * this build does not know about must not be used as grounds for deleting.
 */
export function retentionChangeDeletes(
  current: TranscriptRetention,
  next: TranscriptRetention,
): boolean {
  if (next === current) return false;
  const from = rank(current);
  const to = rank(next);
  if (from < 0 || to < 0) return false;
  return to < from;
}

export interface RetentionConfirmCopy {
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * What to ask before a narrowing change. 'off' is called out separately
 * because it takes everything rather than only the old items, and a user who
 * reads "older than the new period" would not expect that.
 */
export function retentionConfirmCopy(next: TranscriptRetention): RetentionConfirmCopy {
  const noOtherCopy =
    'There is no other copy unless you have exported your data.';
  if (next === 'off') {
    return {
      title: 'Delete every saved transcript?',
      body: `Turning transcript saving off removes the transcripts CandidCue has already kept. ${noOtherCopy}`,
      confirmLabel: 'Turn off and delete',
    };
  }
  return {
    title: 'Delete older transcripts?',
    body: `Transcripts older than the new period are removed as soon as you change this. ${noOtherCopy}`,
    confirmLabel: 'Shorten and delete',
  };
}
