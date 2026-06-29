import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileSink, combineSinks } from '@main/diagnostics/file-sink';
import type { LogRecord, LogSink } from '@main/diagnostics/logger';

function rec(event: string, extra: Record<string, unknown> = {}): LogRecord {
  return { level: 'info', event, at: '2026-06-29T00:00:00.000Z', ...extra };
}

describe('createFileSink', () => {
  it('creates the directory and appends one JSON line per record', () => {
    // A nested, not-yet-existing dir proves the recursive mkdir.
    const logDir = join(mkdtempSync(join(tmpdir(), 'candidcue-logs-')), 'a', 'b');
    const { sink, filePath } = createFileSink(logDir);
    expect(existsSync(logDir)).toBe(true);

    sink(rec('prepare.failed', { code: 'OPENAI_SCHEMA' }));
    sink(rec('app.log_file', { path: '/x' }));

    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'prepare.failed', code: 'OPENAI_SCHEMA' });
    expect(JSON.parse(lines[1]!)).toMatchObject({ event: 'app.log_file', path: '/x' });
  });

  it('appends across separate sink instances pointed at the same file', () => {
    const logDir = mkdtempSync(join(tmpdir(), 'candidcue-logs-'));
    createFileSink(logDir).sink(rec('one'));
    createFileSink(logDir).sink(rec('two'));
    const { filePath } = createFileSink(logDir);
    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).event)).toEqual(['one', 'two']);
  });

  it('throws at setup when the target is unwritable, so the caller can fall back', () => {
    // Point the log dir *inside* an existing regular file: mkdir/open must fail
    // up front rather than the sink silently swallowing every record later.
    const base = mkdtempSync(join(tmpdir(), 'candidcue-logs-'));
    const notADir = join(base, 'a-file');
    writeFileSync(notADir, 'x');
    expect(() => createFileSink(join(notADir, 'logs'))).toThrow();
  });
});

describe('combineSinks', () => {
  it('delivers each record to every sink', () => {
    const a: LogRecord[] = [];
    const b: LogRecord[] = [];
    const combined = combineSinks((r) => a.push(r), (r) => b.push(r));
    combined(rec('x'));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('isolates sinks: one throwing does not stop the others', () => {
    const seen: LogRecord[] = [];
    const throwing: LogSink = () => {
      throw new Error('disk full');
    };
    const combined = combineSinks(throwing, (r) => seen.push(r));
    expect(() => combined(rec('y'))).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});
