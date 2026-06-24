/** Format a millisecond elapsed duration as M:SS or H:MM:SS. */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const ss = seconds.toString().padStart(2, '0');
  if (hours > 0) {
    const mm = minutes.toString().padStart(2, '0');
    return `${hours}:${mm}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

/** Format an ISO timestamp as a short relative phrase ("just now", "2h ago"),
 *  falling back to an absolute date once it's more than a week old. */
export function formatRelative(iso: string | null): string {
  if (!iso) {
    return 'never';
  }
  const date = new Date(iso);
  const time = date.getTime();
  if (Number.isNaN(time)) {
    return '—';
  }
  const diffMinutes = Math.floor((Date.now() - time) / 60_000);
  if (diffMinutes < 1) {
    return 'just now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }
  return date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** Format an ISO timestamp for display, or a placeholder when absent. */
export function formatTimestamp(iso: string | null): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
