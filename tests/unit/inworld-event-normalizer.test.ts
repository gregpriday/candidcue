import { normalizeSttEvent } from '@main/providers/inworld/event-normalizer';

describe('normalizeSttEvent', () => {
  describe('recognized events', () => {
    it('maps a non-final transcription to a partial event carrying text', () => {
      expect(
        normalizeSttEvent({ transcription: { transcript: 'I think the', isFinal: false } }),
      ).toEqual({ kind: 'partial', text: 'I think the' });
    });

    it('maps a final transcription to a finalSegment event carrying text', () => {
      expect(
        normalizeSttEvent({ transcription: { transcript: 'I started a company.', isFinal: true } }),
      ).toEqual({ kind: 'finalSegment', text: 'I started a company.' });
    });

    it('treats a missing isFinal as a partial (interim) result', () => {
      expect(normalizeSttEvent({ transcription: { transcript: 'mid' } })).toEqual({
        kind: 'partial',
        text: 'mid',
      });
    });

    it('maps speechStarted to a speechStarted event with no text', () => {
      expect(normalizeSttEvent({ speechStarted: { startTimeMs: 120, confidence: 0.9 } })).toEqual({
        kind: 'speechStarted',
      });
    });

    it('maps speechStopped to a speechStopped event with no text', () => {
      expect(normalizeSttEvent({ speechStopped: { silenceDurationMs: 800 } })).toEqual({
        kind: 'speechStopped',
      });
    });

    it('maps an error object to an error event carrying the message', () => {
      expect(normalizeSttEvent({ error: { message: 'socket closed' } })).toEqual({
        kind: 'error',
        message: 'socket closed',
      });
    });

    it('maps a string error to an error event carrying the message', () => {
      expect(normalizeSttEvent({ error: 'socket closed' })).toEqual({
        kind: 'error',
        message: 'socket closed',
      });
    });
  });

  describe('field tolerance', () => {
    it('defaults missing partial transcript to an empty string', () => {
      expect(normalizeSttEvent({ transcription: { isFinal: false } })).toEqual({
        kind: 'partial',
        text: '',
      });
    });

    it('defaults missing final transcript to an empty string', () => {
      expect(normalizeSttEvent({ transcription: { isFinal: true } })).toEqual({
        kind: 'finalSegment',
        text: '',
      });
    });

    it('defaults a missing error message to an empty string', () => {
      expect(normalizeSttEvent({ error: {} })).toEqual({ kind: 'error', message: '' });
    });

    it('coerces a non-string transcript to an empty string', () => {
      expect(normalizeSttEvent({ transcription: { transcript: 42, isFinal: false } })).toEqual({
        kind: 'partial',
        text: '',
      });
    });

    it('coerces a non-string error message to an empty string', () => {
      expect(normalizeSttEvent({ error: { message: { nested: true } } })).toEqual({
        kind: 'error',
        message: '',
      });
    });

    it('preserves an empty final transcript (downstream accumulator ignores it)', () => {
      expect(normalizeSttEvent({ transcription: { transcript: '', isFinal: true } })).toEqual({
        kind: 'finalSegment',
        text: '',
      });
    });

    it('treats a non-boolean isFinal as not final (partial)', () => {
      expect(
        normalizeSttEvent({ transcription: { transcript: 'x', isFinal: 'true' } }),
      ).toEqual({ kind: 'partial', text: 'x' });
    });
  });

  describe('unknown and malformed input maps to null', () => {
    it('returns null for an unknown wrapper key', () => {
      expect(normalizeSttEvent({ usage: { transcribedAudioMs: 1000 } })).toBeNull();
    });

    it('returns null when the transcription wrapper is not an object', () => {
      expect(normalizeSttEvent({ transcription: 'oops' })).toBeNull();
    });

    it('returns null for an empty object', () => {
      expect(normalizeSttEvent({})).toBeNull();
    });

    it('returns null for null input', () => {
      expect(normalizeSttEvent(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(normalizeSttEvent(undefined)).toBeNull();
    });

    it('returns null for a primitive string', () => {
      expect(normalizeSttEvent('transcription')).toBeNull();
    });

    it('returns null for a number', () => {
      expect(normalizeSttEvent(123)).toBeNull();
    });

    it('returns null for an array', () => {
      expect(normalizeSttEvent([{ transcription: { transcript: 'x' } }])).toBeNull();
    });
  });

  describe('purity', () => {
    it('does not mutate the input event object', () => {
      const raw = { transcription: { transcript: 'unchanged', isFinal: false } };
      const snapshot = JSON.parse(JSON.stringify(raw));
      normalizeSttEvent(raw);
      expect(raw).toEqual(snapshot);
    });
  });
});
