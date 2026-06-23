import { redact, redactString } from '@main/diagnostics/redaction';

describe('redactString', () => {
  it('masks OpenAI sk- key patterns', () => {
    expect(redactString('key is sk-abcdEFGH1234')).toBe('key is [REDACTED]');
  });

  it('masks sk-proj- style keys', () => {
    const masked = redactString('sk-proj-AbCdEf12_3456-XYZ');
    expect(masked).toBe('[REDACTED]');
  });

  it('masks bearer-like tokens', () => {
    const masked = redactString('Authorization: Bearer eyJhbGciOi.JIUzI1Ni}');
    expect(masked).toContain('[REDACTED]');
    expect(masked).not.toContain('eyJhbGciOi');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactString('the quick brown fox')).toBe('the quick brown fox');
  });

  it('does not mask short hyphenated words', () => {
    // "well-formed" has too short a suffix and a real word prefix length.
    expect(redactString('a well-defined plan')).toBe('a well-defined plan');
  });

  it('masks multiple secrets within one string', () => {
    const out = redactString('first sk-AAAABBBBcccc then sk-11112222dddd');
    expect(out).toBe('first [REDACTED] then [REDACTED]');
  });
});

describe('redact', () => {
  it('redacts nested api_key values', () => {
    const input = {
      provider: { api_key: 'sk-abcdEFGH1234', model: 'gpt-4o' },
    };
    const out = redact(input) as { provider: { api_key: unknown; model: unknown } };
    expect(out.provider.api_key).toBe('[REDACTED]');
    expect(out.provider.model).toBe('gpt-4o');
  });

  it('redacts a variety of sensitive key spellings', () => {
    const input = {
      apiKey: 'a',
      'api-key': 'b',
      api_key: 'c',
      Authorization: 'd',
      secret: 'e',
      accessToken: 'f',
      password: 'g',
      credential: 'h',
    };
    const out = redact(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      expect(out[key]).toBe('[REDACTED]');
    }
  });

  it('masks sk- strings that appear as plain string leaves', () => {
    const out = redact({ note: 'leaked sk-abcdEFGH1234 here' }) as Record<string, unknown>;
    expect(out.note).toBe('leaked [REDACTED] here');
  });

  it('redacts known content fields by default', () => {
    const input = {
      rawTranscript: 'sensitive answer',
      cleanedTranscript: 'cleaned answer',
      userEditedTranscript: 'edited answer',
      spokenText: 'what was said',
      content: 'document body',
      partialTranscript: 'half',
      finalTranscriptSoFar: 'so far',
    };
    const out = redact(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      expect(out[key]).toBe('[REDACTED_TEXT]');
    }
  });

  it('keeps content fields when redactText is false', () => {
    const input = {
      rawTranscript: 'sensitive answer',
      content: 'document body',
    };
    const out = redact(input, { redactText: false }) as Record<string, unknown>;
    expect(out.rawTranscript).toBe('sensitive answer');
    expect(out.content).toBe('document body');
  });

  it('still redacts sensitive keys even when redactText is false', () => {
    const out = redact(
      { api_key: 'sk-abcdEFGH1234', content: 'keep me' },
      { redactText: false },
    ) as Record<string, unknown>;
    expect(out.api_key).toBe('[REDACTED]');
    expect(out.content).toBe('keep me');
  });

  it('leaves safe fields untouched', () => {
    const input = {
      state: 'AWAITING_ANSWER',
      model: 'gpt-4o-mini',
      durationMs: 1234,
      retries: 0,
      recoverable: true,
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out).toEqual(input);
  });

  it('handles arrays of objects', () => {
    const input = [
      { api_key: 'sk-aaaa1111bbbb', model: 'm1' },
      { content: 'hello', state: 'IDLE' },
    ];
    const out = redact(input) as Array<Record<string, unknown>>;
    expect(out[0]?.api_key).toBe('[REDACTED]');
    expect(out[0]?.model).toBe('m1');
    expect(out[1]?.content).toBe('[REDACTED_TEXT]');
    expect(out[1]?.state).toBe('IDLE');
  });

  it('handles arrays of strings, masking secret-shaped entries', () => {
    const out = redact(['plain', 'sk-abcdEFGH1234', 'also plain']) as string[];
    expect(out).toEqual(['plain', '[REDACTED]', 'also plain']);
  });

  it('passes through primitives unchanged', () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(false || true);
    expect(redact(null)).toBeNull();
    expect(redact('plain string')).toBe('plain string');
    expect(redact('sk-abcdEFGH1234')).toBe('[REDACTED]');
  });

  it('deep clones rather than mutating the input', () => {
    const input = { nested: { content: 'secret', keep: 1 } };
    const out = redact(input) as { nested: { content: string; keep: number } };
    expect(input.nested.content).toBe('secret');
    expect(out.nested.content).toBe('[REDACTED_TEXT]');
    expect(out).not.toBe(input);
    expect(out.nested).not.toBe(input.nested);
  });

  it('handles deeply nested structures', () => {
    const input = {
      level1: { level2: { level3: { token: 'xyz', value: 'safe' } } },
    };
    const out = redact(input) as {
      level1: { level2: { level3: { token: string; value: string } } };
    };
    expect(out.level1.level2.level3.token).toBe('[REDACTED]');
    expect(out.level1.level2.level3.value).toBe('safe');
  });

  it('does not loop forever on cyclic structures', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = redact(a) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(out.self).toBe('[Circular]');
  });

  it('handles cycles across arrays', () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    const out = redact(arr) as unknown[];
    expect(out[0]).toBe(1);
    expect(out[1]).toBe('[Circular]');
  });

  it('preserves Date values as cloned dates', () => {
    const d = new Date('2026-06-23T00:00:00.000Z');
    const out = redact({ when: d }) as { when: Date };
    expect(out.when).toBeInstanceOf(Date);
    expect(out.when.getTime()).toBe(d.getTime());
    expect(out.when).not.toBe(d);
  });

  it('redacts secret-shaped strings nested under content key only via field rule', () => {
    // A content field is replaced wholesale, not partially masked.
    const out = redact({ content: 'has sk-abcdEFGH1234 inside' }) as Record<string, unknown>;
    expect(out.content).toBe('[REDACTED_TEXT]');
  });
});
