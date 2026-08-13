/**
 * §36.2: the retention CHOICE, as distinct from the setting.
 *
 * `settings-transcript-retention.test.ts` proves the value survives a round
 * trip through Rust. This proves the half that decides whether changing it
 * destroys anything — which matters because Rust enforces retention when the
 * setting is written, so picking a shorter window is a delete, not a policy
 * that starts applying to future takes.
 */
import { describe, expect, it } from 'vitest';
import {
  TRANSCRIPT_RETENTION_OPTIONS,
  retentionChangeDeletes,
  retentionConfirmCopy,
} from '../../../src/control/lib/transcript-retention';
import type { TranscriptRetention } from '../../../src/control/services/settings-types';

const ALL: TranscriptRetention[] = ['off', '1d', '7d', '30d', 'forever'];

describe('the offered windows are exactly the ones Rust validates', () => {
  it('offers every value and no others', () => {
    expect(TRANSCRIPT_RETENTION_OPTIONS.map((option) => option.value)).toEqual(ALL);
  });

  it('names each one in words rather than as a code', () => {
    for (const option of TRANSCRIPT_RETENTION_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(option.value.length);
    }
  });
});

describe('a narrowing change deletes and a widening one does not', () => {
  it('says nothing is lost when the value is unchanged', () => {
    for (const value of ALL) {
      expect(retentionChangeDeletes(value, value)).toBe(false);
    }
  });

  it('treats every step towards off as destructive', () => {
    expect(retentionChangeDeletes('forever', '30d')).toBe(true);
    expect(retentionChangeDeletes('30d', '7d')).toBe(true);
    expect(retentionChangeDeletes('7d', '1d')).toBe(true);
    expect(retentionChangeDeletes('1d', 'off')).toBe(true);
    expect(retentionChangeDeletes('forever', 'off')).toBe(true);
  });

  it('treats every step away from off as harmless', () => {
    expect(retentionChangeDeletes('off', '1d')).toBe(false);
    expect(retentionChangeDeletes('1d', '7d')).toBe(false);
    expect(retentionChangeDeletes('7d', '30d')).toBe(false);
    expect(retentionChangeDeletes('30d', 'forever')).toBe(false);
    expect(retentionChangeDeletes('off', 'forever')).toBe(false);
  });

  /*
   * A document written by a later build can hold a window this one does not
   * know. Refusing to call that a deletion is the safe direction: the worst
   * outcome is a confirmation that was not shown, rather than a confirmation
   * whose copy describes the wrong loss.
   */
  it('does not claim a deletion it cannot rank', () => {
    expect(retentionChangeDeletes('90d' as TranscriptRetention, 'off')).toBe(false);
    expect(retentionChangeDeletes('off', '90d' as TranscriptRetention)).toBe(false);
  });
});

describe('the confirmation says which loss is about to happen', () => {
  it('warns that off takes everything, not only the old items', () => {
    const copy = retentionConfirmCopy('off');
    expect(copy.body).toContain('already kept');
    expect(copy.body).not.toContain('older than');
    expect(copy.confirmLabel.toLowerCase()).toContain('delete');
  });

  it('warns that a shorter window takes the older items', () => {
    for (const value of ['1d', '7d', '30d'] as TranscriptRetention[]) {
      const copy = retentionConfirmCopy(value);
      expect(copy.body).toContain('older than the new period');
      expect(copy.confirmLabel.toLowerCase()).toContain('delete');
    }
  });

  it('tells the user where the only other copy would be', () => {
    for (const value of ALL) {
      expect(retentionConfirmCopy(value).body).toContain('exported your data');
    }
  });
});
