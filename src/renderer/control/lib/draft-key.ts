/**
 * Monotonic client-side key generator for draft list items (project sources).
 * Keys are stable React identities and selection handles only — never persisted.
 * A single shared counter guarantees uniqueness across initial hydration and any
 * sources added later in the same session.
 */
let counter = 0;

export function nextDraftKey(): string {
  counter += 1;
  return `draft-${counter}`;
}
