import type OpenAI from 'openai';

import { AppError } from '@shared/errors/app-error';

import { withRetry } from '../retry';

/**
 * A single structured-output request. The adapter builds the `system`
 * (instructions) and `user` (input) text plus a JSON Schema, and the responder
 * returns the model's raw JSON string for the caller to parse with Zod.
 */
export interface StructuredRequest {
  /** Model id to invoke (e.g. `gpt-5.5`). */
  model: string;
  /** System / developer instructions for the model. */
  system: string;
  /** The user-facing input payload. */
  user: string;
  /** Stable name for the response format (a-z, 0-9, `_`, `-`; <= 64 chars). */
  schemaName: string;
  /** JSON Schema the model output must conform to. */
  schema: Record<string, unknown>;
  /** Abort signal forwarded to the underlying request. */
  signal?: AbortSignal;
}

/**
 * Produces a structured JSON string for a {@link StructuredRequest}. The default
 * implementation talks to the OpenAI Responses API; tests inject a fake.
 */
export type StructuredResponder = (req: StructuredRequest) => Promise<string>;

/**
 * Runs OpenAI moderation on `text` and returns the raw moderation result. The
 * default implementation calls `client.moderations.create`; tests inject a fake.
 */
export type Moderator = (
  text: string,
  signal?: AbortSignal,
) => Promise<{
  flagged: boolean;
  categories: Record<string, boolean>;
  category_scores: Record<string, number>;
}>;

/**
 * Build the default {@link StructuredResponder} backed by the OpenAI Responses
 * API. SDK specifics (request shape, structured-output format, output
 * extraction) are isolated here so the adapters stay provider-agnostic.
 *
 * The call is wrapped in {@link withRetry} for transient faults and the
 * caller's {@link AbortSignal} is forwarded through the request options. This
 * live path is intentionally not unit-tested.
 */
export function createDefaultResponder(client: OpenAI): StructuredResponder {
  return (req: StructuredRequest): Promise<string> =>
    withRetry(
      async () => {
        const response = await client.responses.create(
          {
            model: req.model,
            instructions: req.system,
            input: req.user,
            text: {
              format: {
                type: 'json_schema',
                name: req.schemaName,
                schema: req.schema,
                strict: true,
              },
            },
          },
          req.signal ? { signal: req.signal } : undefined,
        );
        const text = response.output_text;
        if (typeof text !== 'string' || text.length === 0) {
          // An empty body is a structural failure, not a transient one; surface
          // it as a schema error so the orchestrator can repair or fall back.
          throw new AppError('OPENAI_SCHEMA', {
            message: `OpenAI returned an empty response for schema "${req.schemaName}"`,
          });
        }
        return text;
      },
      { shouldAbort: () => req.signal?.aborted ?? false },
    );
}

/**
 * Build the default {@link Moderator} backed by the OpenAI Moderations API.
 * Wrapped in {@link withRetry} and forwards the caller's {@link AbortSignal}.
 * This live path is intentionally not unit-tested.
 */
export function createDefaultModerator(client: OpenAI, model: string): Moderator {
  return (text: string, signal?: AbortSignal) =>
    withRetry(
      async () => {
        const result = await client.moderations.create(
          { model, input: text },
          signal ? { signal } : undefined,
        );
        const first = result.results[0];
        if (!first) {
          throw new AppError('OPENAI_SCHEMA', {
            message: 'OpenAI moderation returned no results',
          });
        }
        return {
          flagged: first.flagged,
          // The SDK types categories/scores as fixed-key objects; widen to the
          // open record shape the domain model carries.
          categories: first.categories as unknown as Record<string, boolean>,
          category_scores: first.category_scores as unknown as Record<string, number>,
        };
      },
      { shouldAbort: () => signal?.aborted ?? false },
    );
}
