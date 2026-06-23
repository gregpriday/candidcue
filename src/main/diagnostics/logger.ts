/**
 * Structured diagnostics logger (spec §23.5-23.6, §21.5).
 *
 * Every log call produces a flat record of the shape:
 *   { level, event, at, ...fields }
 * where `at` is an ISO-8601 timestamp. The full record is passed through
 * `redact()` from ./redaction before it reaches the sink, so provider keys and
 * raw interview content never leave the process in cleartext.
 *
 * The sink is injectable. The default sink writes one JSON object per line to
 * the matching `console.*` method (info/warn/error). Tests inject a capturing
 * sink to assert on the structured records directly without touching the
 * console or relying on its formatting.
 */

import { redact } from './redaction';

/** Severity levels emitted by the logger, mapped 1:1 to method names. */
export type LogLevel = 'info' | 'warn' | 'error';

/** Arbitrary structured fields attached to a log record. */
export type LogFields = Record<string, unknown>;

/**
 * A fully-formed, post-redaction log record. `level`, `event`, and `at` are
 * always present; any caller-supplied fields are spread alongside them. Note
 * that a field named `level`, `event`, or `at` will be overwritten by the
 * canonical values to keep the record shape predictable.
 */
export interface LogRecord {
  level: LogLevel;
  event: string;
  /** ISO-8601 timestamp captured at emit time. */
  at: string;
  [key: string]: unknown;
}

/**
 * Destination for emitted records. Receives the redacted record; never throws
 * back into the logger (the default sink swallows console failures implicitly).
 */
export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions {
  /** Where redacted records are delivered. Defaults to the console JSON sink. */
  sink?: LogSink;
  /**
   * When false, known free-text content fields (transcripts, spoken text) are
   * preserved rather than masked. Sensitive keys (api_key, token, ...) are
   * always redacted regardless. Defaults to true.
   */
  redactText?: boolean;
}

/** Structured logger surface. */
export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /**
   * Derive a child logger that merges `boundFields` into every record it emits.
   * Per-call fields take precedence over bound fields on key collisions. The
   * child shares the parent's sink and redaction policy.
   */
  child(boundFields: LogFields): Logger;
}

/**
 * Default sink: serialise each record to a single JSON line and route it to the
 * console method matching its level. Kept tiny and dependency-free so it works
 * in the main process without additional wiring.
 */
const consoleSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  switch (record.level) {
    case 'error':
      // eslint-disable-next-line no-console
      console.error(line);
      break;
    case 'warn':
      // eslint-disable-next-line no-console
      console.warn(line);
      break;
    default:
      // eslint-disable-next-line no-console
      console.info(line);
      break;
  }
};

/**
 * Create a structured logger.
 *
 * @param options.sink       Destination for redacted records (default console).
 * @param options.redactText Whether to mask free-text content fields (default true).
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? consoleSink;
  const redactText = options.redactText !== false;
  return makeLogger(sink, redactText, {});
}

/**
 * Internal factory shared by the root logger and every `child()`. `boundFields`
 * are merged into each record before the caller's per-call fields, which means
 * per-call fields win on collisions.
 */
function makeLogger(sink: LogSink, redactText: boolean, boundFields: LogFields): Logger {
  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    // Assemble in order: bound fields first, then per-call fields, then the
    // canonical level/event/at so the record shape is always well-defined and
    // never clobbered by a caller-supplied field of the same name.
    const merged: LogFields = {
      ...boundFields,
      ...(fields ?? {}),
      level,
      event,
      at: new Date().toISOString(),
    };
    // Redact the whole record (deep) before it leaves the process. The result
    // is structurally a LogRecord: level/event/at survive redaction unchanged.
    const record = redact(merged, { redactText }) as LogRecord;
    sink(record);
  };

  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (childFields) => makeLogger(sink, redactText, { ...boundFields, ...childFields }),
  };
}
