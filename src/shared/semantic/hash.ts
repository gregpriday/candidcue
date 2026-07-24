/**
 * Stable, dependency-free hashes for stale-response detection (companion
 * §36.4). These are cache/identity keys, never security primitives.
 */

/** FNV-1a 32-bit, hex encoded. Deterministic across runs and platforms. */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply without BigInt.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Hash of the candidate set a classification request was built for. Any change
 * to membership, order, span, or text invalidates a pending response.
 */
export function candidateSetHash(
  candidates: ReadonlyArray<{
    id: string;
    sectionId: string;
    startTokenIndex: number;
    endTokenIndex: number;
    text: string;
  }>,
): string {
  const parts = candidates.map(
    (c) => `${c.id}|${c.sectionId}|${c.startTokenIndex}|${c.endTokenIndex}|${stableHash(c.text)}`,
  );
  return stableHash(parts.join('\n'));
}

/** Hash of the landmark set a retrieval request was built for (§37.2). */
export function landmarkSetHash(
  landmarks: ReadonlyArray<{ id: string; proposition: string }>,
): string {
  return stableHash(landmarks.map((l) => `${l.id}|${stableHash(l.proposition)}`).join('\n'));
}
