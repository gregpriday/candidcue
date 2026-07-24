import { describe, expect, it } from 'vitest';
import { RustWebSocketTranscriptionTransport } from './wsTransport';
import { NotImplementedError } from './errors';
import { DEFAULT_TRANSCRIPTION_CONFIG } from './sessionConfig';

describe('RustWebSocketTranscriptionTransport (spec §27.4 fallback skeleton)', () => {
  it('fails loudly instead of half-working', async () => {
    const transport = new RustWebSocketTranscriptionTransport();
    await expect(transport.connect(DEFAULT_TRANSCRIPTION_CONFIG)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(transport.setMicrophone('mic-1')).rejects.toBeInstanceOf(NotImplementedError);
    expect(() => transport.commit('vad_silence')).toThrow(NotImplementedError);
    expect(() => transport.clearBufferedAudio()).toThrow(NotImplementedError);
  });

  it('reports disconnected diagnostics and tolerates disconnect', async () => {
    const transport = new RustWebSocketTranscriptionTransport();
    await transport.disconnect('stop');
    expect(transport.getDiagnostics().transportState).toBe('disconnected');
    const off = transport.onEvent(() => {});
    off();
  });
});
