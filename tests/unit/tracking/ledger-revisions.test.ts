/**
 * A partial transcript is a replacement, not an append.
 *
 * The ledger used to keep whichever provisional string was LONGER, which
 * cannot express the single most common thing a streaming recogniser does:
 * withdraw a word it is no longer confident about.
 *
 *   revision 1: "we should build a very complicated navigation system"
 *   revision 2: "we should build a complicated navigation system"
 *
 * The second revision is shorter AND more accurate. Under the old policy it
 * was discarded wholesale and `very` stayed in the alignable tail for the rest
 * of the utterance, where it went on to be matched against the script as
 * though the presenter had said it.
 *
 * These tests pin the replacement model, the stability counter that makes a
 * revision's newest guess distinguishable from evidence, and the two shapes
 * that must NOT be treated as retractions.
 */
import { describe, expect, it } from 'vitest';
import { TranscriptLedger } from '../../../src/shared/tracking/ledger';
import { STABLE_REVISIONS, isStableToken } from '../../../src/shared/tracking/types';
import type { ReconciledTranscriptUpdate, TranscriptEvent } from '../../../src/shared/tracking/types';

let clock = 1_000;

function ledger(): TranscriptLedger {
  const l = new TranscriptLedger();
  l.setSessionGeneration(1);
  l.apply({
    type: 'item_started',
    sessionGeneration: 1,
    itemId: 'item-1',
    commitSequence: 1,
    audioStartMs: 0,
    receivedAtMs: (clock += 10),
  } as TranscriptEvent);
  return l;
}

function partial(l: TranscriptLedger, text: string): ReconciledTranscriptUpdate | undefined {
  return l.apply({
    type: 'delta',
    sessionGeneration: 1,
    itemId: 'item-1',
    text,
    receivedAtMs: (clock += 10),
  } as TranscriptEvent);
}

function complete(l: TranscriptLedger, text: string): ReconciledTranscriptUpdate | undefined {
  return l.apply({
    type: 'completed',
    sessionGeneration: 1,
    itemId: 'item-1',
    text,
    audioEndMs: 4_000,
    receivedAtMs: (clock += 10),
  } as TranscriptEvent);
}

function words(l: TranscriptLedger): string[] {
  return (l.getItem('item-1')?.normalizedTokens ?? []).map((t) => t.normalized);
}

describe('a shorter revision retracts', () => {
  it('drops a word the provider withdrew', () => {
    const l = ledger();
    partial(l, 'we should build a very complicated navigation system');
    const update = partial(l, 'we should build a complicated navigation system');

    expect(words(l)).toEqual([
      'we',
      'should',
      'build',
      'a',
      'complicated',
      'navigation',
      'system',
    ]);
    // The exact failure: `very` outliving the revision that removed it.
    expect(words(l)).not.toContain('very');
    expect(update?.retractedTokens).toBe(4); // very complicated navigation system
    expect(update?.stablePrefixTokens).toBe(4); // we should build a
  });

  it('reports a pure extension as no retraction at all', () => {
    const l = ledger();
    partial(l, 'we should build');
    const update = partial(l, 'we should build a teleprompter');

    expect(update?.retractedTokens).toBe(0);
    expect(update?.stablePrefixTokens).toBe(3);
  });

  it('retracts everything when the provider restates the whole utterance', () => {
    const l = ledger();
    partial(l, 'the quick brown fox');
    const update = partial(l, 'a slow grey badger');

    expect(words(l)).toEqual(['a', 'slow', 'grey', 'badger']);
    expect(update?.retractedTokens).toBe(4);
    expect(update?.stablePrefixTokens).toBe(0);
  });

  it('lets a completion retract text the partials had offered', () => {
    const l = ledger();
    partial(l, 'she said she would definitely be there');
    const update = complete(l, 'she said she would be there');

    expect(words(l)).not.toContain('definitely');
    expect(update?.final).toBe(true);
    expect(update?.retractedTokens).toBeGreaterThan(0);
  });
});

describe('stability separates evidence from the recogniser thinking aloud', () => {
  it('counts the revisions a token has survived at its position', () => {
    const l = ledger();
    partial(l, 'hello everyone');
    expect(l.getItem('item-1')?.normalizedTokens.map((t) => t.stability)).toEqual([1, 1]);

    partial(l, 'hello everyone and');
    // `hello everyone` survived a second revision; `and` is brand new.
    expect(l.getItem('item-1')?.normalizedTokens.map((t) => t.stability)).toEqual([2, 2, 1]);

    partial(l, 'hello everyone and welcome');
    expect(l.getItem('item-1')?.normalizedTokens.map((t) => t.stability)).toEqual([3, 3, 2, 1]);
  });

  it('restarts the count past the point the provider changed its mind', () => {
    const l = ledger();
    partial(l, 'hello everyone and welcome');
    partial(l, 'hello everyone and welcome');
    partial(l, 'hello everyone to the channel');

    const tokens = l.getItem('item-1')?.normalizedTokens ?? [];
    expect(tokens.map((t) => t.normalized)).toEqual([
      'hello',
      'everyone',
      'to',
      'the',
      'channel',
    ]);
    /*
     * `hello everyone` kept its history; everything after the break starts
     * over. Two, not three: the identical middle revision is a no-op, so it
     * never counted as a revision survived — consistent with the repeat test
     * below, and the reason the count means something.
     */
    expect(tokens.map((t) => t.stability)).toEqual([2, 2, 1, 1, 1]);
  });

  it('does not credit a reappearing word with the retracted one’s history', () => {
    /*
     * `welcome` appears in both revisions but at different positions, either
     * side of the break. Carrying its old count forward would let a word the
     * provider had just moved present itself as long-standing evidence.
     */
    const l = ledger();
    partial(l, 'and welcome');
    partial(l, 'and welcome');
    partial(l, 'a warm welcome');

    const tokens = l.getItem('item-1')?.normalizedTokens ?? [];
    const welcome = tokens.find((t) => t.normalized === 'welcome');
    expect(welcome?.stability).toBe(1);
  });

  it('treats final text as stable however briefly it existed', () => {
    const l = ledger();
    const update = complete(l, 'one two three');
    expect(update?.final).toBe(true);
    for (const token of l.getItem('item-1')?.normalizedTokens ?? []) {
      expect(token.final).toBe(true);
      expect(token.stability).toBeGreaterThanOrEqual(STABLE_REVISIONS);
      expect(isStableToken(token)).toBe(true);
    }
  });

  it('calls a first-revision provisional token unstable', () => {
    const l = ledger();
    partial(l, 'possibly');
    const [token] = l.getItem('item-1')?.normalizedTokens ?? [];
    expect(token && isStableToken(token)).toBe(false);
  });
});

describe('the restatements that are not retractions', () => {
  it('ignores an empty partial rather than wiping the utterance', () => {
    /*
     * Providers emit an empty partial while re-segmenting. Honouring it as a
     * replacement would retract a whole sentence of good evidence on the
     * strength of the recogniser saying nothing — and no evidence is not
     * evidence of no words.
     */
    const l = ledger();
    partial(l, 'this is a complete thought');
    const update = partial(l, '   ');

    expect(update).toBeUndefined();
    expect(words(l)).toEqual(['this', 'is', 'a', 'complete', 'thought']);
  });

  it('is a no-op when the provider repeats itself exactly', () => {
    const l = ledger();
    partial(l, 'hello everyone');
    const update = partial(l, 'hello everyone');
    expect(update).toBeUndefined();
    // A repeat is not a revision survived: nothing was reconsidered.
    expect(l.getItem('item-1')?.normalizedTokens.map((t) => t.stability)).toEqual([1, 1]);
  });

  it('keeps a completion authoritative against a late partial', () => {
    const l = ledger();
    complete(l, 'the final word');
    const update = partial(l, 'the final word and more');

    expect(update).toBeUndefined();
    expect(words(l)).toEqual(['the', 'final', 'word']);
  });
});
