import { describe, it, expect } from 'vitest';

import { extractResponseText } from '@main/providers/openai/openai-client';
import { AppError, isAppError } from '@shared/errors/app-error';

/** Run `fn`, returning whatever it throws (and failing if it does not throw). */
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected extractResponseText to throw');
}

describe('extractResponseText', () => {
  it('returns the output text on a complete response', () => {
    expect(extractResponseText({ output_text: '{"ok":true}' }, 'prepared_interview_output')).toBe(
      '{"ok":true}',
    );
  });

  it('classifies an output-token truncation as OPENAI_TRUNCATED with token usage in the internal message', () => {
    // A response cut off at the model's output ceiling: status incomplete, the
    // body is partial (invalid) JSON, and the usage shows the budget exhausted.
    const err = caught(() =>
      extractResponseText(
        {
          output_text: '{"brief":{"title":"Daintree',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { output_tokens: 2048, output_tokens_details: { reasoning_tokens: 1700 } },
        },
        'prepared_interview_output',
      ),
    );

    expect(isAppError(err)).toBe(true);
    const appErr = err as AppError;
    expect(appErr.code).toBe('OPENAI_TRUNCATED');
    // The diagnostic detail (token usage) rides on the INTERNAL message so it
    // reaches the logs; it must not depend on the partial body being parseable.
    expect(appErr.message).toContain('output_tokens=2048');
    expect(appErr.message).toContain('reasoning_tokens=1700');
    // The public message is actionable and never echoes the partial response body.
    expect(appErr.publicMessage).toMatch(/shorter sources|smaller question target/i);
    expect(appErr.publicMessage).not.toContain('Daintree');
  });

  it('tolerates missing usage on a truncated response (reports the cap without counts)', () => {
    const err = caught(() =>
      extractResponseText(
        { output_text: '{"partial', incomplete_details: { reason: 'max_output_tokens' } },
        'prepared_interview_output',
      ),
    ) as AppError;

    expect(err.code).toBe('OPENAI_TRUNCATED');
    expect(err.message).toContain('output_tokens=unknown');
  });

  it('still treats an empty body as OPENAI_SCHEMA, not truncation', () => {
    const err = caught(() =>
      extractResponseText({ output_text: '' }, 'prepared_interview_output'),
    ) as AppError;

    expect(err.code).toBe('OPENAI_SCHEMA');
  });

  it('does not misclassify a non-token incomplete reason as truncation when a body is present', () => {
    // Only `max_output_tokens` means cut-off JSON; other incomplete reasons fall
    // through to the normal path (return the text, let the caller parse it).
    expect(
      extractResponseText(
        { output_text: '{"ok":true}', incomplete_details: { reason: 'content_filter' } },
        'prepared_interview_output',
      ),
    ).toBe('{"ok":true}');
  });
});
