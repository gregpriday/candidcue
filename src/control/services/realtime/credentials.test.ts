import { describe, expect, it, vi } from 'vitest';
import {
  CREATE_REALTIME_TRANSCRIPTION_CREDENTIAL_COMMAND,
  mintTranscriptionCredential,
} from './credentials';
import { DEFAULT_TRANSCRIPTION_CONFIG } from './sessionConfig';
import { RealtimeTransportError } from './errors';
import type { EphemeralCredential } from '../../../shared/contracts';

const NOW = 1_000_000;
const validCredential: EphemeralCredential = {
  value: 'ek_live_shortlived',
  expiresAt: NOW + 60_000,
  sessionType: 'transcription',
  credentialGeneration: 3,
};

describe('mintTranscriptionCredential (spec §46.4/§27.2)', () => {
  it('invokes the exact Tauri command with the session config', async () => {
    const invoke = vi.fn().mockResolvedValue(validCredential);
    const credential = await mintTranscriptionCredential(invoke, DEFAULT_TRANSCRIPTION_CONFIG, () => NOW);
    expect(invoke).toHaveBeenCalledWith('create_realtime_transcription_credential', {
      config: DEFAULT_TRANSCRIPTION_CONFIG,
    });
    expect(CREATE_REALTIME_TRANSCRIPTION_CREDENTIAL_COMMAND).toBe(
      'create_realtime_transcription_credential',
    );
    expect(credential).toEqual(validCredential);
  });

  it('rejects an already-expired credential (mint fresh, never reuse — E.7)', async () => {
    const invoke = vi.fn().mockResolvedValue({ ...validCredential, expiresAt: NOW + 1000 });
    await expect(
      mintTranscriptionCredential(invoke, DEFAULT_TRANSCRIPTION_CONFIG, () => NOW),
    ).rejects.toMatchObject({ code: 'REALTIME_NEGOTIATION_FAILED' });
  });

  it('rejects malformed payloads', async () => {
    const invoke = vi.fn().mockResolvedValue({ nope: true });
    await expect(
      mintTranscriptionCredential(invoke, DEFAULT_TRANSCRIPTION_CONFIG, () => NOW),
    ).rejects.toBeInstanceOf(RealtimeTransportError);
  });

  it('propagates structured Rust AppError rejections with their code', async () => {
    const invoke = vi.fn().mockRejectedValue({
      code: 'AUTH_KEY_INVALID',
      recoverable: false,
      userMessage: 'Your OpenAI key is invalid.',
    });
    await expect(
      mintTranscriptionCredential(invoke, DEFAULT_TRANSCRIPTION_CONFIG, () => NOW),
    ).rejects.toMatchObject({ code: 'AUTH_KEY_INVALID', recoverable: false });
  });

  it('wraps unshaped failures as PROVIDER_UNAVAILABLE', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('ipc broke'));
    await expect(
      mintTranscriptionCredential(invoke, DEFAULT_TRANSCRIPTION_CONFIG, () => NOW),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', recoverable: true });
  });
});
