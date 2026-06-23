import { normalizeSttEvent } from '@main/providers/inworld/event-normalizer';

describe('normalizeSttEvent', () => {
  describe('recognized events', () => {
    it('maps PARTIAL to a partial event carrying text', () => {
      expect(normalizeSttEvent({ type: 'PARTIAL', text: 'I think the' })).toEqual({
        kind: 'partial',
        text: 'I think the',
      });
    });

    it('maps FINAL to a finalSegment event carrying text', () => {
      expect(normalizeSttEvent({ type: 'FINAL', text: 'I started a company.' })).toEqual({
        kind: 'finalSegment',
        text: 'I started a company.',
      });
    });

    it('maps SPEECH_STARTED to a speechStarted event with no text', () => {
      expect(normalizeSttEvent({ type: 'SPEECH_STARTED' })).toEqual({ kind: 'speechStarted' });
    });

    it('maps SPEECH_STOPPED to a speechStopped event with no text', () => {
      expect(normalizeSttEvent({ type: 'SPEECH_STOPPED' })).toEqual({ kind: 'speechStopped' });
    });

    it('maps ERROR to an error event carrying the message', () => {
      expect(normalizeSttEvent({ type: 'ERROR', message: 'socket closed' })).toEqual({
        kind: 'error',
        message: 'socket closed',
      });
    });
  });

  describe('field tolerance', () => {
    it('defaults missing PARTIAL text to an empty string', () => {
      expect(normalizeSttEvent({ type: 'PARTIAL' })).toEqual({ kind: 'partial', text: '' });
    });

    it('defaults missing FINAL text to an empty string', () => {
      expect(normalizeSttEvent({ type: 'FINAL' })).toEqual({ kind: 'finalSegment', text: '' });
    });

    it('defaults missing ERROR message to an empty string', () => {
      expect(normalizeSttEvent({ type: 'ERROR' })).toEqual({ kind: 'error', message: '' });
    });

    it('coerces non-string PARTIAL text to an empty string', () => {
      expect(normalizeSttEvent({ type: 'PARTIAL', text: 42 })).toEqual({ kind: 'partial', text: '' });
    });

    it('coerces non-string ERROR message to an empty string', () => {
      expect(normalizeSttEvent({ type: 'ERROR', message: { nested: true } })).toEqual({
        kind: 'error',
        message: '',
      });
    });

    it('preserves an empty FINAL text (downstream accumulator ignores it)', () => {
      expect(normalizeSttEvent({ type: 'FINAL', text: '' })).toEqual({
        kind: 'finalSegment',
        text: '',
      });
    });
  });

  describe('case-insensitive type matching', () => {
    it('accepts a lower-case type', () => {
      expect(normalizeSttEvent({ type: 'final', text: 'done.' })).toEqual({
        kind: 'finalSegment',
        text: 'done.',
      });
    });

    it('accepts a mixed-case type', () => {
      expect(normalizeSttEvent({ type: 'Partial', text: 'mid' })).toEqual({
        kind: 'partial',
        text: 'mid',
      });
    });
  });

  describe('unknown and malformed input maps to null', () => {
    it('returns null for an unknown event type', () => {
      expect(normalizeSttEvent({ type: 'HEARTBEAT' })).toBeNull();
    });

    it('returns null for an empty-string type', () => {
      expect(normalizeSttEvent({ type: '' })).toBeNull();
    });

    it('returns null when type is missing', () => {
      expect(normalizeSttEvent({ text: 'orphaned text' })).toBeNull();
    });

    it('returns null when type is not a string', () => {
      expect(normalizeSttEvent({ type: 7 })).toBeNull();
    });

    it('returns null for null input', () => {
      expect(normalizeSttEvent(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(normalizeSttEvent(undefined)).toBeNull();
    });

    it('returns null for a primitive string', () => {
      expect(normalizeSttEvent('FINAL')).toBeNull();
    });

    it('returns null for a number', () => {
      expect(normalizeSttEvent(123)).toBeNull();
    });

    it('returns null for an array', () => {
      // Arrays are objects but carry no string `type` field.
      expect(normalizeSttEvent(['FINAL', 'text'])).toBeNull();
    });
  });

  describe('purity', () => {
    it('does not mutate the input event object', () => {
      const raw = { type: 'PARTIAL', text: 'unchanged' };
      const snapshot = { ...raw };
      normalizeSttEvent(raw);
      expect(raw).toEqual(snapshot);
    });
  });
});
