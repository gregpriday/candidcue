/**
 * Fast deterministic non-cryptographic hashing for stable IDs and cache keys.
 * Pure TS, no dependencies, identical output in workers and windows.
 *
 * `hashString` runs textbook FNV-1a **32-bit** twice over the same input with
 * two different offset bases and concatenates the lanes into 16 hex chars.
 * That is NOT the same thing as FNV-1a-64: the lanes share the 32-bit prime
 * and differ only in initial state, so the effective collision resistance is
 * meaningfully better than a single 32-bit lane but well short of a true
 * 64-bit hash. It is used for IDs and cache keys only — never for integrity,
 * deduplication of user data, or anything security-bearing (asset dedup uses
 * SHA-256 in the Rust core).
 */

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619 (FNV prime) using shifts to stay in 32-bit space.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** Two 32-bit FNV-1a lanes as a fixed-width 16-char lowercase hex string. */
export function hashString(input: string): string {
  const a = fnv1a32(input, 0x811c9dc5);
  const b = fnv1a32(input, 0xcbf29ce4);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Short 8-char variant for embedded IDs. */
export function shortHash(input: string): string {
  return fnv1a32(input, 0x811c9dc5).toString(16).padStart(8, '0');
}
