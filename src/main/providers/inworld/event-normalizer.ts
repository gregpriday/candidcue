/**
 * Inworld STT event normalizer (spec §13.4, §17).
 *
 * The Inworld streaming STT transport (transcribe:streamBidirectional) emits raw
 * JSON event objects over its WebSocket. This module is the single place that
 * maps those raw objects into the small set of normalized domain events the rest
 * of the app understands. Keeping this mapping pure (no I/O, no state) makes it
 * cheap to test exhaustively and easy to adjust if the provider's event names
 * drift.
 *
 * Recognized raw event shapes (VERIFIED against the live streamBidirectional
 * API — https://docs.inworld.ai/api-reference/sttAPI/speechtotext/transcribe-stream-websocket):
 *
 * The live server wraps every successful event in a `result` envelope:
 *
 *   { result: { transcription: { transcript: string, isFinal: false } } } → interim/partial
 *   { result: { transcription: { transcript: string, isFinal: true  } } } → finalized segment
 *   { result: { speechStarted:  {...} } }                                  → voice activity began (VAD)
 *   { result: { speechStopped:  {...} } }                                  → voice activity ended (VAD)
 *   { error: { code, message: string, details: [...] } } | { error: string } → transport/recognition error
 *
 * The `result` wrapper is stripped first below, so the legacy unwrapped shapes
 * (`{ transcription: {...} }`, etc.) are still accepted for back-compat. Errors
 * arrive at the top level (NOT under `result`). Anything else (unknown wrapper
 * key, missing fields, non-object input) maps to `null` so callers can safely
 * ignore noise rather than crash.
 */

/** The normalized event kinds consumed by the STT client and orchestrator. */
export type NormalizedSttEventKind =
  | 'partial'
  | 'finalSegment'
  | 'speechStarted'
  | 'speechStopped'
  | 'error';

/** A normalized STT event. `text` is present for transcript events; `message` for errors. */
export interface NormalizedSttEvent {
  kind: NormalizedSttEventKind;
  /** Transcript text for `partial` / `finalSegment` events. */
  text?: string;
  /** Human-readable error detail for `error` events. */
  message?: string;
}

/** Narrow an unknown value to a plain record so we can read fields safely. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read a string field off a record, returning '' when absent or non-string. */
function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Map a single raw Inworld STT event object to a normalized domain event.
 * Returns `null` for any unrecognized or malformed event so the caller can
 * ignore it without special-casing.
 */
export function normalizeSttEvent(raw: unknown): NormalizedSttEvent | null {
  const outer = asRecord(raw);
  if (outer === null) return null;

  // The live API wraps successful events in a `result` envelope
  // ({ result: { transcription | speechStarted | speechStopped } }); descend into
  // it when present. Errors arrive at the top level, and legacy unwrapped shapes
  // (no `result` key) still pass through unchanged.
  const inner = asRecord(outer['result']);
  const record = inner ?? outer;

  // Inbound messages are tagged by their wrapper key (transcription / speechStarted
  // / speechStopped / error).

  if ('transcription' in record) {
    const transcription = asRecord(record['transcription']);
    if (transcription === null) return null;
    const text = readString(transcription, 'transcript');
    return transcription['isFinal'] === true
      ? { kind: 'finalSegment', text }
      : { kind: 'partial', text };
  }

  if ('speechStarted' in record) return { kind: 'speechStarted' };
  if ('speechStopped' in record) return { kind: 'speechStopped' };

  if ('error' in record) {
    // The error envelope is undocumented; accept either a string or an object
    // carrying a `message` field.
    const error = record['error'];
    if (typeof error === 'string') return { kind: 'error', message: error };
    const errorRecord = asRecord(error);
    return { kind: 'error', message: errorRecord ? readString(errorRecord, 'message') : '' };
  }

  return null;
}
