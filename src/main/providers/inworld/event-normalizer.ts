/**
 * Inworld STT event normalizer (spec §13.4, §17).
 *
 * The Inworld streaming STT transport emits raw JSON event objects over its
 * WebSocket. Their exact wire shapes are an external concern; this module is the
 * single place that maps those raw objects into the small set of normalized
 * domain events the rest of the app understands. Keeping this mapping pure (no
 * I/O, no state) makes it cheap to test exhaustively and easy to adjust if the
 * provider's event names drift.
 *
 * Recognized raw event shapes (documented assumptions — adjust here if Inworld
 * changes its protocol):
 *
 *   { type: 'PARTIAL',         text: string }   → interim/partial transcript
 *   { type: 'FINAL',           text: string }   → a finalized transcript segment
 *   { type: 'SPEECH_STARTED' }                  → voice activity began
 *   { type: 'SPEECH_STOPPED' }                  → voice activity ended
 *   { type: 'ERROR',           message: string }→ transport/recognition error
 *
 * Anything else (unknown `type`, missing fields, non-object input) maps to
 * `null` so callers can safely ignore noise rather than crash.
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

/** Narrow an unknown value to a plain record so we can read string fields safely. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
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
  const record = asRecord(raw);
  if (record === null) return null;

  const type = record['type'];
  if (typeof type !== 'string') return null;

  // Compare case-insensitively so a transport that emits 'final' or 'Final'
  // still maps cleanly; the canonical wire form is upper snake case.
  switch (type.toUpperCase()) {
    case 'PARTIAL':
      return { kind: 'partial', text: readString(record, 'text') };
    case 'FINAL':
      return { kind: 'finalSegment', text: readString(record, 'text') };
    case 'SPEECH_STARTED':
      return { kind: 'speechStarted' };
    case 'SPEECH_STOPPED':
      return { kind: 'speechStopped' };
    case 'ERROR':
      return { kind: 'error', message: readString(record, 'message') };
    default:
      return null;
  }
}
