/** Deterministic PRNG (mulberry32) for property/fuzz tests (spec §55.3). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error('pick from empty array');
  return item;
}

export function randomInt(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const NOISE = ".,!?;:'\"()-–—…“”‘’ %&#@0123456789";

export function randomWord(rand: () => number, minLen = 1, maxLen = 10): string {
  const length = randomInt(rand, minLen, maxLen);
  let out = '';
  for (let i = 0; i < length; i++) out += LETTERS.charAt(Math.floor(rand() * LETTERS.length));
  return out;
}

export function randomNoisyText(rand: () => number, words: number): string {
  const parts: string[] = [];
  for (let i = 0; i < words; i++) {
    let word = randomWord(rand, 1, 9);
    if (rand() < 0.3) word += NOISE.charAt(Math.floor(rand() * NOISE.length));
    if (rand() < 0.1) word = NOISE.charAt(Math.floor(rand() * NOISE.length)) + word;
    parts.push(word);
  }
  return parts.join(rand() < 0.1 ? '  ' : ' ');
}
