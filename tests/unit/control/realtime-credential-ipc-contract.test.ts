/**
 * C1 regression: the credential expiry must cross the IPC boundary as epoch
 * MILLISECONDS.
 *
 * Both sides read `tests/fixtures/ipc/realtime-credential.json`:
 *  - this file asserts the real TypeScript consumer
 *    (`mintTranscriptionCredential`) accepts the normalized payload and
 *    compares it against a `Date.now()`-shaped clock;
 *  - `src-tauri/tests/ipc_contract_tests.rs` asserts the Rust
 *    `EphemeralCredential` serializes to exactly the same object, converting
 *    the provider's epoch-SECONDS `expires_at`.
 *
 * The defect this pins: Rust returned the provider's raw 10-digit seconds
 * value and the webview compared it against `Date.now()` (13 digits), so every
 * real credential looked already-expired and the session died before SDP
 * negotiation — with the UI none the wiser.
 */
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../fixtures/ipc/realtime-credential.json';
import {
  mintTranscriptionCredential,
  MIN_PLAUSIBLE_EPOCH_MS,
} from '../../../src/control/services/realtime/credentials';
import { DEFAULT_TRANSCRIPTION_CONFIG } from '../../../src/control/services/realtime/sessionConfig';
import type { EphemeralCredential } from '../../../src/shared/contracts';

const PROVIDER_EPOCH_SECONDS = fixture.notes.providerExpiresAtEpochSeconds;
const EXPECTED_EPOCH_MS = fixture.notes.expectedExpiresAtEpochMs;

/** The credential exactly as Rust now serializes it. */
const credential = fixture.expectedCredential as unknown as EphemeralCredential;

/** A realistic wall clock: one minute before the fixture credential expires. */
const nowMs = () => EXPECTED_EPOCH_MS - 60_000;

describe('realtime credential IPC contract (C1 — epoch milliseconds)', () => {
  it('the fixture uses a realistic 10-digit provider timestamp', () => {
    // A millisecond-shaped fixture is precisely what hid this defect, so the
    // shape of the fixture is itself part of the contract.
    expect(String(PROVIDER_EPOCH_SECONDS)).toHaveLength(10);
    expect(String(EXPECTED_EPOCH_MS)).toHaveLength(13);
    expect(EXPECTED_EPOCH_MS).toBe(PROVIDER_EPOCH_SECONDS * 1000);
    expect(PROVIDER_EPOCH_SECONDS).toBeLessThan(MIN_PLAUSIBLE_EPOCH_MS);
    expect(EXPECTED_EPOCH_MS).toBeGreaterThan(MIN_PLAUSIBLE_EPOCH_MS);
  });

  it('the contract field carries its unit in the name', () => {
    expect(fixture.expectedCredential).toHaveProperty('expiresAtEpochMs');
    expect(fixture.expectedCredential).not.toHaveProperty('expiresAt');
  });

  it('accepts the normalized credential against a Date.now()-shaped clock', async () => {
    const invoke = vi.fn().mockResolvedValue(credential);
    const minted = await mintTranscriptionCredential(
      invoke,
      DEFAULT_TRANSCRIPTION_CONFIG,
      nowMs,
    );
    expect(minted.expiresAtEpochMs).toBe(EXPECTED_EPOCH_MS);
  });

  /**
   * The C1 bug itself. Before the fix Rust forwarded the raw seconds value and
   * this is the payload the webview received for EVERY real session — it was
   * rejected as "already expired" and transcription never started.
   */
  it('rejects a raw epoch-SECONDS expiry instead of silently treating it as expired', async () => {
    const unnormalized = { ...credential, expiresAtEpochMs: PROVIDER_EPOCH_SECONDS };
    const invoke = vi.fn().mockResolvedValue(unnormalized);
    await expect(
      mintTranscriptionCredential(invoke, DEFAULT_TRANSCRIPTION_CONFIG, nowMs),
    ).rejects.toMatchObject({
      // Not REALTIME_NEGOTIATION_FAILED: a unit mismatch is a build defect, not
      // a retryable expiry, and retrying it forever is what made the UI lie.
      code: 'PROVIDER_UNAVAILABLE',
      recoverable: false,
    });
  });

  it('still rejects a genuinely expired credential', async () => {
    const invoke = vi.fn().mockResolvedValue(credential);
    await expect(
      mintTranscriptionCredential(
        invoke,
        DEFAULT_TRANSCRIPTION_CONFIG,
        () => EXPECTED_EPOCH_MS + 1,
      ),
    ).rejects.toMatchObject({ code: 'REALTIME_NEGOTIATION_FAILED' });
  });
});
