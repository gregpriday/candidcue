import type { z } from 'zod';
import { ZodError } from 'zod';

import { AppError } from '@shared/errors/app-error';

/**
 * Parse a model's raw JSON string against `schema`. Any failure — malformed
 * JSON or a Zod validation error — is normalized to `AppError('OPENAI_SCHEMA')`
 * so the orchestrator can run its single repair/fallback path (spec §19.2).
 */
export function parseStructured<T>(raw: string, schema: z.ZodType<T>, context: string): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    // Carry the body length and a bounded head/tail preview so a truncated or
    // otherwise non-JSON response is diagnosable from the error itself — a hard
    // cut-off shows as JSON that simply stops partway through.
    throw new AppError('OPENAI_SCHEMA', {
      message: `OpenAI returned non-JSON output for ${context} (${raw.length} chars): ${previewRaw(raw)}`,
      cause,
    });
  }

  try {
    return schema.parse(json);
  } catch (cause) {
    if (cause instanceof ZodError) {
      throw new AppError('OPENAI_SCHEMA', {
        message: `OpenAI output failed schema validation for ${context}: ${cause.message}`,
        cause,
      });
    }
    throw cause;
  }
}

/** A bounded, single-line head/tail preview of a raw model body for diagnostics. */
function previewRaw(raw: string, head = 300, tail = 140): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= head + tail + 3) return oneLine;
  return `${oneLine.slice(0, head)} … ${oneLine.slice(-tail)}`;
}
