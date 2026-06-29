/**
 * File-backed {@link LogSink} (spec §23.5). The console sink in ./logger keeps
 * records visible in dev, but a packaged app has nowhere to scroll back to — so
 * the main process also appends every (already-redacted) record as one JSON line
 * to a log file under the user-data directory, where it can be retrieved after a
 * failure. The directory is created on first use and any write failure is
 * swallowed so logging never throws back into the app.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { LogRecord, LogSink } from './logger';

export interface FileSink {
  /** The sink to hand to {@link createLogger}. */
  sink: LogSink;
  /** Absolute path of the log file, for surfacing "logs are here" to the user. */
  filePath: string;
}

/**
 * Build a {@link LogSink} that appends JSON lines to `<logDir>/candidcue.log`.
 * Throws if the directory can't be created or the file can't be opened for
 * append, so the caller can fall back to console-only rather than discovering at
 * every log call that nothing is being persisted. The returned sink itself never
 * throws. Each record is flushed synchronously so a record written just before a
 * crash or quit is still on disk — the case where a log matters most.
 */
export function createFileSink(logDir: string, fileName = 'candidcue.log'): FileSink {
  mkdirSync(logDir, { recursive: true });
  const filePath = join(logDir, fileName);
  // Probe writability now (a zero-byte append creates the file if absent) so an
  // unwritable target surfaces here, not silently inside the swallowed sink.
  appendFileSync(filePath, '');
  const sink: LogSink = (record: LogRecord) => {
    try {
      appendFileSync(filePath, `${JSON.stringify(record)}\n`);
    } catch {
      // A logging failure must never propagate into application code.
    }
  };
  return { sink, filePath };
}

/**
 * Fan each record out to every sink. One sink throwing never blocks the others,
 * so a flaky file write can't suppress console output (or vice versa).
 */
export function combineSinks(...sinks: LogSink[]): LogSink {
  return (record: LogRecord) => {
    for (const s of sinks) {
      try {
        s(record);
      } catch {
        // Isolate sinks from one another.
      }
    }
  };
}
