import { describe, expect, it, vi } from 'vitest';
import {
  CREATE_REALTIME_TRANSCRIPTION_CREDENTIAL_COMMAND,
  mintTranscriptionCredential,
} from './credentials';
import { DEFAULT_TRANSCRIPTION_CONFIG } from './sessionConfig';
import { RealtimeTransportError } from './errors';
import type { EphemeralCredential } from '../../../shared/contracts';

/**
 * C1: use a REALISTIC epoch-millisecond clock. The previous fixtures used
 * `NOW = 1_000_000`, a value no provider or `Date.now()` ever produces, which
 * is why the seconds/milliseconds mismatch survived here undetected.
 */
const NOW = 1_785_110_400_000; // 2026-07-25T00:00:00Z in epoch ms
const validCredential: EphemeralCredential = {
  value: 'ek_live_shortlived',
  expiresAtEpochMs: NOW + 60_000,
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
    const invoke = vi.fn().mockResolvedValue({ ...validCredential, expiresAtEpochMs: NOW + 1000 });
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

  /**
   * C1 regression. Rust used to forward the provider's epoch-SECONDS value
   * verbatim; the webview compares against `Date.now()` (milliseconds), so a
   * real credential was ALWAYS "expired" and no session ever negotiated. This
   * must fail loudly and non-recoverably rather than look like a retryable
   * expiry.
   */
  it('rejects a seconds-shaped expiry as a boundary unit mismatch (C1)', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ...validCredential,
      expiresAtEpochMs: Math.floor((NOW + 600_000) / 1000), // 10-digit seconds
    });
    await expect(
      mintTranscriptionCredential(invoke, DEFAULT_TRANSCRIPTION_CONFIG, () => NOW),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', recoverable: false });
  });

  it('rejects a missing or non-numeric expiry', async () => {
    const invoke = vi.fn().mockResolvedValue({ ...validCredential, expiresAtEpochMs: undefined });
    await expect(
      mintTranscriptionCredential(invoke, DEFAULT_TRANSCRIPTION_CONFIG, () => NOW),
    ).rejects.toBeInstanceOf(RealtimeTransportError);
  });
});
