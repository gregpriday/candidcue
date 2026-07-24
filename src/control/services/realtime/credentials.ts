/**
 * Ephemeral credential minting (spec §27.2/§27.3 step 2, §46.4).
 *
 * The permanent OpenAI key lives only in Rust. The webview asks Rust for a
 * short-lived client secret via the `create_realtime_transcription_credential`
 * Tauri command; the secret is held in memory only for the lifetime of one
 * connection and a fresh one is minted for every reconnect (spec §29.6).
 */
import type { EphemeralCredential, TranscriptionConfig } from '../../../shared/contracts';
import { RealtimeTransportError } from './errors';

/** Exact Tauri command name (spec §46.4). */
export const CREATE_REALTIME_TRANSCRIPTION_CREDENTIAL_COMMAND =
  'create_realtime_transcription_credential';

/** Injected invoke so tests never need a Tauri runtime. */
export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Refuse to use a credential this close to its expiry (ms). */
export const CREDENTIAL_EXPIRY_MARGIN_MS = 5_000;

/**
 * Smallest plausible epoch-millisecond expiry (2001-09-09). A provider
 * timestamp in epoch SECONDS is ~1e9 and falls far below this, so the check
 * catches a seconds/milliseconds regression at the boundary (C1) instead of
 * letting it masquerade as "already expired".
 */
export const MIN_PLAUSIBLE_EPOCH_MS = 1_000_000_000_000;

export async function mintTranscriptionCredential(
  invoke: TauriInvoke,
  config: TranscriptionConfig,
  now: () => number = () => Date.now(),
): Promise<EphemeralCredential> {
  let credential: EphemeralCredential;
  try {
    credential = await invoke<EphemeralCredential>(
      CREATE_REALTIME_TRANSCRIPTION_CREDENTIAL_COMMAND,
      { config },
    );
  } catch (cause) {
    throw toMintError(cause);
  }
  if (!credential || typeof credential.value !== 'string' || credential.value.length === 0) {
    throw new RealtimeTransportError(
      'PROVIDER_UNAVAILABLE',
      'Credential mint returned an invalid payload',
      true,
    );
  }
  // C1: `expiresAtEpochMs` is epoch MILLISECONDS, normalized in Rust, so it is
  // directly comparable with `Date.now()`. Reject an implausibly small value
  // rather than silently treating a seconds-shaped timestamp as expired —
  // that failure mode killed transcription in production while the UI looked
  // healthy, so it must surface loudly instead.
  if (
    typeof credential.expiresAtEpochMs !== 'number' ||
    !Number.isFinite(credential.expiresAtEpochMs) ||
    credential.expiresAtEpochMs < MIN_PLAUSIBLE_EPOCH_MS
  ) {
    throw new RealtimeTransportError(
      'PROVIDER_UNAVAILABLE',
      'Credential expiry is not epoch milliseconds (unit mismatch at the IPC boundary)',
      false,
    );
  }
  if (credential.expiresAtEpochMs <= now() + CREDENTIAL_EXPIRY_MARGIN_MS) {
    // Expired client secret: mint fresh, never reuse (E.7).
    throw new RealtimeTransportError(
      'REALTIME_NEGOTIATION_FAILED',
      'Credential already expired at mint time',
      true,
    );
  }
  return credential;
}

/** Rust rejections arrive as structured AppError-shaped payloads. */
function toMintError(cause: unknown): RealtimeTransportError {
  if (cause instanceof RealtimeTransportError) return cause;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const shaped = cause as { code: unknown; recoverable?: unknown; userMessage?: unknown };
    return new RealtimeTransportError(
      String(shaped.code) as RealtimeTransportError['code'],
      typeof shaped.userMessage === 'string' ? shaped.userMessage : 'Credential mint failed',
      shaped.recoverable !== false,
    );
  }
  return new RealtimeTransportError('PROVIDER_UNAVAILABLE', 'Credential mint failed', true);
}
