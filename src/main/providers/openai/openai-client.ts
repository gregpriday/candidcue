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
  /**
   * Optional progress callback invoked as output streams in, with the running
   * count of characters generated so far. Only {@link createStreamingResponder}
   * calls it; the non-streaming responder ignores it. The count resets toward 0
   * on a retried attempt (each stream accumulates from empty), so treat it as a
   * latest-known value rather than a monotonic counter.
   */
  onProgress?: (charsGenerated: number) => void;
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
 * The subset of an OpenAI Responses-API result this module inspects. Declared
 * structurally rather than importing the SDK's `Response` so the extraction
 * logic is unit-testable with a plain object; the real SDK response satisfies it.
 */
export interface ResponseEnvelope {
  /** Why the response stopped early, when it stopped early. */
  incomplete_details?: { reason?: string | null } | null;
  /** SDK-accumulated output text — the final JSON string. */
  output_text: string;
  /** Token accounting, used only to enrich the truncation diagnostic. */
  usage?: {
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number } | null;
  } | null;
}

/**
 * Pull the final JSON string out of a Responses-API result, classifying the two
 * structural failures the orchestrator must tell apart:
 *
 *  - The model hit its output-token ceiling, so the JSON is cut off mid-stream
 *    (`incomplete_details.reason === 'max_output_tokens'`). Left alone this would
 *    reach `JSON.parse` and surface as a generic "unexpected response"; we raise
 *    `OPENAI_TRUNCATED` instead so the UI can tell the user to shorten the source,
 *    and fold the token usage into the internal message so the truncation shows
 *    up in logs. Other incomplete reasons fall through to the normal path.
 *  - An empty body — a structural failure, not a transient one — stays
 *    `OPENAI_SCHEMA`, leaving the existing repair/fallback path unchanged.
 */
export function extractResponseText(response: ResponseEnvelope, schemaName: string): string {
  if (response.incomplete_details?.reason === 'max_output_tokens') {
    const usage = response.usage;
    throw new AppError('OPENAI_TRUNCATED', {
      message:
        `OpenAI truncated the "${schemaName}" response at the output-token limit ` +
        `(output_tokens=${usage?.output_tokens ?? 'unknown'}, ` +
        `reasoning_tokens=${usage?.output_tokens_details?.reasoning_tokens ?? 'unknown'}).`,
    });
  }
  const text = response.output_text;
  if (typeof text !== 'string' || text.length === 0) {
    // An empty body is a structural failure, not a transient one; surface it as
    // a schema error so the orchestrator can repair or fall back.
    throw new AppError('OPENAI_SCHEMA', {
      message: `OpenAI returned an empty response for schema "${schemaName}"`,
    });
  }
  return text;
}

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
        return extractResponseText(response, req.schemaName);
      },
      { shouldAbort: () => req.signal?.aborted ?? false },
    );
}

/**
 * Build a streaming {@link StructuredResponder} backed by the OpenAI Responses
 * API. The structured-output contract is identical to
 * {@link createDefaultResponder} — same `json_schema` format, same final JSON
 * string — but the response is consumed incrementally so the caller can observe
 * generation progress: each `response.output_text.delta` reports the accumulated
 * character count through {@link StructuredRequest.onProgress}. This is used only
 * by the project-preparation adapter, whose single long call benefits from live
 * progress and mid-flight cancellation; the other adapters stay non-streaming.
 *
 * Wrapped in {@link withRetry}; the caller's {@link AbortSignal} is forwarded to
 * the stream, which aborts the underlying request and throws `APIUserAbortError`
 * (already non-retryable). This live path is intentionally not unit-tested.
 */
export function createStreamingResponder(client: OpenAI): StructuredResponder {
  return (req: StructuredRequest): Promise<string> =>
    withRetry(
      async () => {
        const stream = client.responses.stream(
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
        // Register the delta listener BEFORE awaiting the final response: the
        // EventStream fires synchronously as tokens arrive, so a listener
        // attached after the await would miss every delta. `snapshot` is the
        // SDK-accumulated text so far — its length is the running char count.
        const { onProgress } = req;
        if (onProgress) {
          stream.on('response.output_text.delta', (event) => {
            onProgress(event.snapshot.length);
          });
        }
        const response = await stream.finalResponse();
        return extractResponseText(response, req.schemaName);
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
