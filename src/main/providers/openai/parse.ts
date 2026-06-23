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
    throw new AppError('OPENAI_SCHEMA', {
      message: `OpenAI returned non-JSON output for ${context}`,
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
