import { describe, expect, it } from 'vitest';
import {
  countWords,
  estimateDurationSeconds,
  formatClock,
  formatSpeakingDuration,
  hashSource,
  plainExcerpt,
  relativeTime,
} from '../../../src/control/lib/format';

describe('countWords', () => {
  it('counts spoken words and ignores directives and markup', () => {
    const source = '# Heading\n\nHello **world** out there.\n\n[Cue: smile]\n\n[Take: One]\n';
    // Heading words count as words; cue/take directives do not.
    expect(countWords(source)).toBe(5);
  });

  it('returns zero for empty source', () => {
    expect(countWords('')).toBe(0);
  });
});

describe('durations', () => {
  it('estimates duration from words at the default pace', () => {
    expect(estimateDurationSeconds(150)).toBe(60);
    expect(estimateDurationSeconds(0)).toBe(0);
  });

  it('formats speaking durations', () => {
    expect(formatSpeakingDuration(0)).toBe('—');
    expect(formatSpeakingDuration(40)).toBe('≈ 40 sec');
    expect(formatSpeakingDuration(240)).toBe('≈ 4 min');
  });

  it('formats clocks', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(724)).toBe('12:04');
    expect(formatClock(3723)).toBe('1:02:03');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-07-24T12:00:00Z');

  it('covers the ladder of ranges', () => {
    expect(relativeTime('2026-07-24T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-07-24T11:45:00Z', now)).toBe('15 min ago');
    expect(relativeTime('2026-07-24T09:00:00Z', now)).toBe('3 hours ago');
    expect(relativeTime('2026-07-23T09:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-07-20T09:00:00Z', now)).toBe('4 days ago');
  });

  it('returns empty for invalid dates', () => {
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});

describe('plainExcerpt', () => {
  it('strips markdown and directives', () => {
    const source = '# Title\n\nHello **bold** and [link](https://x).\n\n[Cue: wave]\n';
    expect(plainExcerpt(source)).toBe('Hello bold and link.');
  });

  it('truncates long text with an ellipsis', () => {
    const long = 'word '.repeat(60);
    const excerpt = plainExcerpt(long, 50);
    expect(excerpt.length).toBeLessThanOrEqual(50);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});

describe('hashSource', () => {
  it('is stable and distinguishes content', () => {
    expect(hashSource('abc')).toBe(hashSource('abc'));
    expect(hashSource('abc')).not.toBe(hashSource('abd'));
    expect(hashSource('')).toMatch(/^[0-9a-f]{8}$/);
  });
});
