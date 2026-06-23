import { TranscriptAccumulator } from '@main/interview/transcript-accumulator';

describe('TranscriptAccumulator', () => {
  describe('addFinalSegment', () => {
    it('appends finalized segments in order', () => {
      const acc = new TranscriptAccumulator();
      acc.addFinalSegment('Hello there.');
      acc.addFinalSegment('How are you?');
      expect(acc.finalSegments).toEqual(['Hello there.', 'How are you?']);
    });

    it('trims surrounding whitespace on stored segments', () => {
      const acc = new TranscriptAccumulator();
      acc.addFinalSegment('  spaced out  ');
      expect(acc.finalSegments).toEqual(['spaced out']);
    });

    it('ignores empty text', () => {
      const acc = new TranscriptAccumulator();
      acc.addFinalSegment('');
      expect(acc.finalSegments).toEqual([]);
    });

    it('ignores whitespace-only text', () => {
      const acc = new TranscriptAccumulator();
      acc.addFinalSegment('   \t\n  ');
      expect(acc.finalSegments).toEqual([]);
    });

    it('does not duplicate an identical immediately-previous segment (reconnect safety)', () => {
      const acc = new TranscriptAccumulator();
      acc.addFinalSegment('repeated phrase');
      acc.addFinalSegment('repeated phrase');
      expect(acc.finalSegments).toEqual(['repeated phrase']);
    });

    it('treats a segment equal to the previous after trimming as a duplicate', () => {
      const acc = new TranscriptAccumulator();
      acc.addFinalSegment('repeated phrase');
      acc.addFinalSegment('  repeated phrase  ');
      expect(acc.finalSegments).toEqual(['repeated phrase']);
    });

    it('allows a repeated phrase if it is not immediately adjacent', () => {
      const acc = new TranscriptAccumulator();
      acc.addFinalSegment('yes');
      acc.addFinalSegment('and more');
      acc.addFinalSegment('yes');
      expect(acc.finalSegments).toEqual(['yes', 'and more', 'yes']);
    });
  });

  describe('setInterim', () => {
    it('replaces rather than accumulates on revision', () => {
      const acc = new TranscriptAccumulator();
      acc.setInterim('I think');
      acc.setInterim('I think the');
      acc.setInterim('I think the answer is');
      expect(acc.displayText).toBe('I think the answer is');
    });

    it('trims the interim text', () => {
      const acc = new TranscriptAccumulator();
      acc.setInterim('   in flight   ');
      expect(acc.displayText).toBe('in flight');
    });

    it('clearing the interim with empty string removes it from display', () => {
      const acc = new TranscriptAccumulator();
      acc.addFinalSegment('Final.');
      acc.setInterim('partial');
      acc.setInterim('');
      expect(acc.displayText).toBe('Final.');
    });
  });

  describe('displayText', () => {
    it('joins finalized segments with a single space', () => {
      const acc = new TranscriptAccumulator();
      acc.addFinalSegment('One.');
      acc.addFinalSegment('Two.');
      expect(acc.displayText).toBe('One. Two.');
    });

    it('appends the interim after the finalized segments', () => {
      const acc = new TranscriptAccumulator();
      acc.addFinalSegment('One.');
      acc.setInterim('two in progress');
      expect(acc.displayText).toBe('One. two in progress');
    });

    it('returns just the interim when there are no final segments', () => {
      const acc = new TranscriptAccumulator();
      acc.setInterim('only interim');
      expect(acc.displayText).toBe('only interim');
    });

    it('returns an empty string when nothing has been added', () => {
      const acc = new TranscriptAccumulator();
      expect(acc.displayText).toBe('');
    });

    it('keeps finalized segments stable across interim changes', () => {
      const acc = new TranscriptAccumulator();
      acc.addFinalSegment('Stable final.');
      acc.setInterim('changing');
      expect(acc.displayText).toBe('Stable final. changing');
      acc.setInterim('changed again now');
      expect(acc.displayText).toBe('Stable final. changed again now');
      expect(acc.finalSegments).toEqual(['Stable final.']);
    });
  });

  describe('commit', () => {
    it('joins finalized segments and trims the result', () => {
      const acc = new TranscriptAccumulator();
      acc.addFinalSegment('First.');
      acc.addFinalSegment('Second.');
      expect(acc.commit()).toBe('First. Second.');
    });

    it('drops the pending interim phrase', () => {
      const acc = new TranscriptAccumulator();
      acc.addFinalSegment('Committed text.');
      acc.setInterim('discard me');
      expect(acc.commit()).toBe('Committed text.');
      expect(acc.displayText).toBe('Committed text.');
    });

    it('returns an empty string when nothing has been finalized', () => {
      const acc = new TranscriptAccumulator();
      acc.setInterim('interim only');
      expect(acc.commit()).toBe('');
    });

    it('leaves finalized segments intact after committing', () => {
      const acc = new TranscriptAccumulator();
      acc.addFinalSegment('Keep me.');
      acc.commit();
      expect(acc.finalSegments).toEqual(['Keep me.']);
    });
  });

  describe('reset', () => {
    it('clears finalized segments and interim', () => {
      const acc = new TranscriptAccumulator();
      acc.addFinalSegment('Gone.');
      acc.setInterim('also gone');
      acc.reset();
      expect(acc.finalSegments).toEqual([]);
      expect(acc.displayText).toBe('');
      expect(acc.commit()).toBe('');
    });
  });

  describe('finalSegments', () => {
    it('exposes a read-only view reflecting later additions', () => {
      const acc = new TranscriptAccumulator();
      const view = acc.finalSegments;
      acc.addFinalSegment('Added.');
      expect(view).toEqual(['Added.']);
    });
  });

  describe('end-to-end streaming flow with reconnect', () => {
    it('handles interim revisions, finalization, reconnect replay, and commit', () => {
      const acc = new TranscriptAccumulator();

      // First phrase streams in as interim revisions, then finalizes.
      acc.setInterim('I');
      acc.setInterim('I started');
      acc.setInterim('I started a');
      acc.addFinalSegment('I started a company.');
      acc.setInterim(''); // provider clears interim on finalization

      expect(acc.displayText).toBe('I started a company.');

      // Reconnect replays the last final result; it must not duplicate.
      acc.addFinalSegment('I started a company.');
      expect(acc.finalSegments).toEqual(['I started a company.']);

      // Second phrase streams and finalizes; provider clears interim on finalize.
      acc.setInterim('It was');
      acc.setInterim('It was tough.');
      acc.addFinalSegment('It was tough.');
      acc.setInterim('');

      expect(acc.displayText).toBe('I started a company. It was tough.');
      expect(acc.commit()).toBe('I started a company. It was tough.');
      expect(acc.displayText).toBe('I started a company. It was tough.');
    });
  });
});
