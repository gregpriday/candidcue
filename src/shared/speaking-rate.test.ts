import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORDS_PER_MINUTE as COMPILER_DEFAULT } from './markdown';
import { DEFAULT_WORDS_PER_MINUTE } from './speaking-rate';

describe('the default speaking rate', () => {
  it('is the spec rate of 130 words per minute', () => {
    expect(DEFAULT_WORDS_PER_MINUTE).toBe(130);
  });

  it('is the one the compiler estimates at', () => {
    expect(COMPILER_DEFAULT).toBe(DEFAULT_WORDS_PER_MINUTE);
  });

  /*
   * The Library's durations come from Rust, at the script's own
   * `words_per_minute_estimate`. Read the Rust source rather than a copy of
   * it: a copy is how the editor and the Library came to disagree.
   */
  it('agrees with the default Rust gives a new script', () => {
    const rustSource = readFileSync(
      new URL('../../src-tauri/src/scripts/mod.rs', import.meta.url),
      'utf8',
    );
    const match = rustSource.match(/words_per_minute_estimate:\s*(\d+)/);
    expect(match, 'words_per_minute_estimate no longer parses out of the Rust defaults').not.toBeNull();
    expect(Number(match![1])).toBe(DEFAULT_WORDS_PER_MINUTE);
  });
});
