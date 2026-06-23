/**
 * Build a custom-protocol URL the main process serves project media from.
 * Each path segment is percent-encoded so spaces / unicode survive, while the
 * separators stay literal slashes.
 */
export function mediaUrl(relativePath: string): string {
  const encoded = relativePath
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return `candidcue://media/${encoded}`;
}
