import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_TAIL_WORDS, transcriptTail } from './transcript-tail';

const words = (count: number, prefix = 'w') =>
  Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`).join(' ');

describe('transcriptTail', () => {
  it('keeps the NEWEST words, not the oldest', () => {
    // The whole point: the bar reports what was just said. Cropping from the
    // wrong end would leave it frozen on the opening of a long utterance.
    expect(transcriptTail(words(12))).toBe('w3 w4 w5 w6 w7 w8 w9 w10 w11 w12');
  });

  it('leaves anything shorter than the limit alone', () => {
    expect(transcriptTail('so far so good')).toBe('so far so good');
  });

  it('crops at exactly the documented count', () => {
    expect(transcriptTail(words(50)).split(' ')).toHaveLength(TRANSCRIPT_TAIL_WORDS);
  });

  it('normalises the spacing the recogniser arrives with', () => {
    /*
     * Partials and finals get stitched together upstream, which leaves leading
     * space, doubled space and the occasional newline. In a nowrap bar each of
     * those reads as a missing word.
     */
    expect(transcriptTail('  and   then \n we went ')).toBe('and then we went');
  });

  it('answers empty for nothing, and for nothing but whitespace', () => {
    expect(transcriptTail('')).toBe('');
    expect(transcriptTail('   \n\t ')).toBe('');
  });

  it('survives a non-string, because this text crosses a process boundary', () => {
    expect(transcriptTail(undefined as unknown as string)).toBe('');
    expect(transcriptTail(null as unknown as string)).toBe('');
  });

  it('treats a nonsense limit as "do not crop" rather than "show nothing"', () => {
    // An empty bar and a dead recogniser must never look the same.
    expect(transcriptTail('one two three', 0)).toBe('one two three');
    expect(transcriptTail('one two three', -4)).toBe('one two three');
    expect(transcriptTail('one two three', Number.NaN)).toBe('one two three');
  });

  it('rounds a fractional limit down to whole words', () => {
    expect(transcriptTail('one two three four', 2.7)).toBe('three four');
  });

  it('does not let a limit under one word fall through to "keep everything"', () => {
    // `Math.floor(0.5)` is 0 and `slice(-0)` is `slice(0)` — every word. The
    // guard has to catch the whole (0, 1) interval, not just zero and below.
    expect(transcriptTail('one two three', 0.5)).toBe('one two three');
    expect(transcriptTail('one two three', 0.999)).toBe('one two three');
  });

  it('passes unspaced text through for the box to clip', () => {
    /*
     * Chinese arrives as one run with no spaces, so there is nothing to count.
     * Passing it through unchanged is what lets the bar's `max-width` and
     * right-alignment do the same newest-first job by geometry — the wrong
     * answer here would be to return an empty bar.
     */
    const zh = '这是一段没有空格的识别结果文本';
    expect(transcriptTail(zh)).toBe(zh);
  });
});
