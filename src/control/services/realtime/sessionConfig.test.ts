import { describe, expect, it } from 'vitest';
import { buildSessionUpdateEvent, DEFAULT_TRANSCRIPTION_CONFIG } from './sessionConfig';

describe('buildSessionUpdateEvent (spec §27.5)', () => {
  it('builds the transcription-only session with manual commits and near-field NR', () => {
    const event = buildSessionUpdateEvent(DEFAULT_TRANSCRIPTION_CONFIG);
    expect(event.type).toBe('session.update');
    const session = event.session as Record<string, unknown>;
    expect(session.type).toBe('transcription');
    const input = (session.audio as { input: Record<string, unknown> }).input;
    expect(input.turn_detection).toBeNull(); // manual commit strategy (§29.3)
    expect(input.noise_reduction).toEqual({ type: 'near_field' });
    expect(input.transcription).toEqual({
      model: 'gpt-realtime-whisper',
      delay: 'low',
      language: 'en',
    });
    expect(session.include).toEqual(['item.input_audio_transcription.logprobs']);
  });

  it('injects the vocabulary prompt at the transcription prompt slot', () => {
    const event = buildSessionUpdateEvent(DEFAULT_TRANSCRIPTION_CONFIG, {
      vocabularyPrompt: '  Vocabulary: CandidCue, SiteOrigin.  ',
    });
    const session = event.session as { audio: { input: { transcription: Record<string, unknown> } } };
    expect(session.audio.input.transcription.prompt).toBe('Vocabulary: CandidCue, SiteOrigin.');
  });

  it('omits an empty vocabulary prompt', () => {
    const event = buildSessionUpdateEvent(DEFAULT_TRANSCRIPTION_CONFIG, { vocabularyPrompt: '   ' });
    const session = event.session as { audio: { input: { transcription: Record<string, unknown> } } };
    expect(session.audio.input.transcription.prompt).toBeUndefined();
  });

  it('omits logprobs when not requested — absence must not break matching', () => {
    const event = buildSessionUpdateEvent({ ...DEFAULT_TRANSCRIPTION_CONFIG, requestLogprobs: false });
    expect((event as { include?: unknown }).include).toBeUndefined();
    expect((event.session as { include?: unknown }).include).toBeUndefined();
  });

  it('passes through delay levels and supports disabling noise reduction', () => {
    const event = buildSessionUpdateEvent(
      { ...DEFAULT_TRANSCRIPTION_CONFIG, delay: 'high' },
      { noiseReduction: null },
    );
    const session = event.session as { audio: { input: Record<string, unknown> } };
    expect((session.audio.input.transcription as { delay: string }).delay).toBe('high');
    expect(session.audio.input.noise_reduction).toBeNull();
  });
});
