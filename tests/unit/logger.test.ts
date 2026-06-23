import { createLogger } from '@main/diagnostics/logger';
import type { LogRecord } from '@main/diagnostics/logger';

/** Build a logger backed by a capturing sink so tests assert on records. */
function makeCapturing(redactText?: boolean) {
  const records: LogRecord[] = [];
  const sink = (r: LogRecord) => records.push(r);
  const logger =
    redactText === undefined
      ? createLogger({ sink })
      : createLogger({ sink, redactText });
  return { logger, records };
}

describe('createLogger', () => {
  it('emits a record with level, event, and an ISO timestamp', () => {
    const { logger, records } = makeCapturing();
    logger.info('session.started', { sessionId: 's1' });

    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.level).toBe('info');
    expect(rec.event).toBe('session.started');
    expect(rec.sessionId).toBe('s1');
    // ISO-8601 timestamp that round-trips through Date.
    expect(typeof rec.at).toBe('string');
    expect(new Date(rec.at).toISOString()).toBe(rec.at);
  });

  it('routes warn and error to the same sink with correct levels', () => {
    const { logger, records } = makeCapturing();
    logger.warn('endpoint.timeout', { turnId: 't1' });
    logger.error('tts.failed', { turnId: 't2', code: 'inworld_timeout' });

    expect(records.map((r) => r.level)).toEqual(['warn', 'error']);
    expect(records[0]!.event).toBe('endpoint.timeout');
    expect(records[1]!.code).toBe('inworld_timeout');
  });

  it('works with no fields argument', () => {
    const { logger, records } = makeCapturing();
    logger.info('app.ready');
    expect(records[0]!.event).toBe('app.ready');
    expect(records[0]!.level).toBe('info');
  });

  it('redacts a sensitive apiKey field via the injected sink', () => {
    const { logger, records } = makeCapturing();
    logger.info('provider.configured', { apiKey: 'sk-abcdEFGH1234', model: 'gpt-5.5' });

    const rec = records[0]!;
    expect(rec.apiKey).toBe('[REDACTED]');
    // Non-sensitive sibling fields are preserved.
    expect(rec.model).toBe('gpt-5.5');
  });

  it('redacts a free-text transcript field by default', () => {
    const { logger, records } = makeCapturing();
    logger.info('answer.recorded', {
      rawTranscript: 'a sensitive spoken answer',
      durationMs: 4200,
    });

    const rec = records[0]!;
    expect(rec.rawTranscript).toBe('[REDACTED_TEXT]');
    expect(rec.durationMs).toBe(4200);
  });

  it('preserves transcript fields when redactText is false but still hides keys', () => {
    const { logger, records } = makeCapturing(false);
    logger.info('answer.recorded', {
      rawTranscript: 'keep me visible',
      token: 'sk-abcdEFGH1234',
    });

    const rec = records[0]!;
    expect(rec.rawTranscript).toBe('keep me visible');
    expect(rec.token).toBe('[REDACTED]');
  });

  it('masks secret-shaped strings nested inside otherwise-safe fields', () => {
    const { logger, records } = makeCapturing();
    logger.error('request.failed', { detail: 'auth header was sk-abcdEFGH1234 oops' });
    expect(records[0]!.detail).toBe('auth header was [REDACTED] oops');
  });

  it('does not let caller fields override canonical level/event/at', () => {
    const { logger, records } = makeCapturing();
    logger.info('real.event', {
      level: 'error',
      event: 'fake.event',
      at: 'not-a-date',
    });

    const rec = records[0]!;
    expect(rec.level).toBe('info');
    expect(rec.event).toBe('real.event');
    expect(rec.at).not.toBe('not-a-date');
    expect(new Date(rec.at).toISOString()).toBe(rec.at);
  });

  it('defaults to the console sink when none is injected', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const logger = createLogger();
      logger.info('boot', { ok: true });
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(line) as LogRecord;
      expect(parsed.event).toBe('boot');
      expect(parsed.ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('routes the default sink to console.warn / console.error by level', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const logger = createLogger();
      logger.warn('w');
      logger.error('e');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('logger.child', () => {
  it('merges bound fields into every record', () => {
    const { logger, records } = makeCapturing();
    const child = logger.child({ sessionId: 's42', component: 'interview' });
    child.info('turn.started', { turnId: 't1' });
    child.warn('turn.slow', { turnId: 't1', thinkMs: 7000 });

    expect(records).toHaveLength(2);
    for (const rec of records) {
      expect(rec.sessionId).toBe('s42');
      expect(rec.component).toBe('interview');
    }
    expect(records[0]!.turnId).toBe('t1');
    expect(records[1]!.thinkMs).toBe(7000);
  });

  it('lets per-call fields take precedence over bound fields', () => {
    const { logger, records } = makeCapturing();
    const child = logger.child({ component: 'default' });
    child.info('evt', { component: 'override' });
    expect(records[0]!.component).toBe('override');
  });

  it('supports nested children that accumulate bound fields', () => {
    const { logger, records } = makeCapturing();
    const a = logger.child({ sessionId: 's1' });
    const b = a.child({ turnId: 't1' });
    b.info('nested.evt');

    const rec = records[0]!;
    expect(rec.sessionId).toBe('s1');
    expect(rec.turnId).toBe('t1');
  });

  it('redacts sensitive values that arrive via bound fields', () => {
    const { logger, records } = makeCapturing();
    const child = logger.child({ apiKey: 'sk-abcdEFGH1234' });
    child.info('configured');
    expect(records[0]!.apiKey).toBe('[REDACTED]');
  });

  it('does not let a child mutate the parent logger bindings', () => {
    const { logger, records } = makeCapturing();
    const child = logger.child({ scope: 'child' });
    logger.info('parent.evt');
    child.info('child.evt');

    // Parent record carries no `scope`; child record does.
    expect(records[0]!.scope).toBeUndefined();
    expect(records[1]!.scope).toBe('child');
  });
});
