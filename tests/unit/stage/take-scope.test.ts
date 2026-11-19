import { describe, expect, it } from 'vitest';
import { takeScopeText } from '../../../src/stage/renderer/take-scope';

describe('takeScopeText (#241)', () => {
  const part = { ordinal: 3, totalParts: 5, label: 'Pricing' };

  it('says nothing over an ordinary take of the whole script', () => {
    expect(takeScopeText(false, null, false)).toBeNull();
    expect(takeScopeText(false, undefined, true)).toBeNull();
  });

  it('says Practising over a practice of the whole script', () => {
    expect(takeScopeText(true, null, false)).toEqual({
      lead: 'Practising',
      name: null,
      done: null,
    });
  });

  it('names the part a take is recording', () => {
    expect(takeScopeText(false, part, false)).toEqual({
      lead: 'Part 3 of 5',
      name: 'Pricing',
      done: null,
    });
  });

  it('says both over a practice of a part, and marks its end once reached', () => {
    expect(takeScopeText(true, part, true)).toEqual({
      lead: 'Practising · Part 3 of 5',
      name: 'Pricing',
      done: 'end reached',
    });
  });

  it('marks no end without a part, and drops a blank name', () => {
    expect(takeScopeText(true, null, true)?.done).toBeNull();
    expect(takeScopeText(false, { ...part, label: '  ' }, false)?.name).toBeNull();
  });
});
