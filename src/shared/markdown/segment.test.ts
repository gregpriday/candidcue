import { describe, expect, it } from 'vitest';
import { segmentSentences } from './segment';

const texts = (input: string) => segmentSentences(input).map((r) => r.text);

describe('segmentSentences (golden cases, spec §25.5)', () => {
  it('splits plain sentences', () => {
    expect(texts('First sentence. Second sentence! Third one?')).toEqual([
      'First sentence.',
      'Second sentence!',
      'Third one?',
    ]);
  });

  it('keeps Mr. Smith as one fragment', () => {
    expect(texts('Mr. Smith arrived early. He sat down.')).toEqual([
      'Mr. Smith arrived early.',
      'He sat down.',
    ]);
  });

  it('treats 3.14 as a number', () => {
    expect(texts('The value is 3.14 today. Tomorrow it changes.')).toEqual([
      'The value is 3.14 today.',
      'Tomorrow it changes.',
    ]);
  });

  it('treats e.g. as an abbreviation', () => {
    expect(texts('Use fruit, e.g. apples. Then continue.')).toEqual([
      'Use fruit, e.g. apples.',
      'Then continue.',
    ]);
  });

  it('does not split inside URLs or domains', () => {
    expect(texts('Visit https://example.com/docs now. Then report back.')).toEqual([
      'Visit https://example.com/docs now.',
      'Then report back.',
    ]);
    expect(texts('Email me at greg@example.com today. Thanks.')).toEqual([
      'Email me at greg@example.com today.',
      'Thanks.',
    ]);
  });

  it('keeps single-letter initials attached', () => {
    expect(texts('J. K. Rowling wrote it. It sold well.')).toEqual([
      'J. K. Rowling wrote it.',
      'It sold well.',
    ]);
  });

  it('handles dotted acronyms mid-sentence', () => {
    expect(texts('The U.S.A. team won. Everyone cheered.')).toEqual([
      'The U.S.A. team won.',
      'Everyone cheered.',
    ]);
  });

  it('keeps honorific times together', () => {
    expect(texts('We met at 3 p.m. sharp and left at 4. It was quick.')).toEqual([
      'We met at 3 p.m. sharp and left at 4.',
      'It was quick.',
    ]);
  });

  it('handles trailing text without terminal punctuation', () => {
    expect(texts('A complete sentence. And a trailing fragment')).toEqual([
      'A complete sentence.',
      'And a trailing fragment',
    ]);
  });

  it('consumes closing quotes after terminators', () => {
    expect(texts('She said "stop." Then silence.')).toEqual([
      'She said "stop."',
      'Then silence.',
    ]);
  });

  it('treats an ellipsis as one boundary', () => {
    expect(texts('Wait for it... Here it comes.')).toEqual([
      'Wait for it...',
      'Here it comes.',
    ]);
  });

  it('returns a single range for unpunctuated text', () => {
    expect(texts('just a list item without punctuation')).toEqual([
      'just a list item without punctuation',
    ]);
  });

  it('returns nothing for whitespace', () => {
    expect(texts('   \n  ')).toEqual([]);
  });
});
