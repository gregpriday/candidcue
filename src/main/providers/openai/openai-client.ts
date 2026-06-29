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
  /** Overall lifecycle state: `completed` | `incomplete` | `failed` | … */
  status?: string | null;
  /** Why the response stopped early, when it stopped early. */
  incomplete_details?: { reason?: string | null } | null;
  /** Set when the API itself failed to produce a response. */
  error?: { code?: string | null; message?: string | null } | null;
  /** SDK-accumulated output text — the final JSON string. */
  output_text: string;
  /**
   * Raw output items, scanned only to recover a model refusal when text is empty.
   * Typed as `unknown[]` because the SDK's item union is heterogeneous (messages,
   * reasoning, tool calls); {@link findRefusal} narrows each item at runtime.
   */
  output?: readonly unknown[] | null;
  /** Token accounting, used only to enrich the truncation diagnostic. */
  usage?: {
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number } | null;
  } | null;
}

/**
 * Pull the final JSON string out of a Responses-API result, classifying the
 * structural failures the orchestrator must tell apart:
 *
 *  - The model hit its output-token ceiling, so the JSON is cut off mid-stream
 *    (`incomplete_details.reason === 'max_output_tokens'`). Left alone this would
 *    reach `JSON.parse` and surface as a generic "unexpected response"; we raise
 *    `OPENAI_TRUNCATED` instead so the UI can tell the user to shorten the source,
 *    and fold the token usage into the internal message so the truncation shows
 *    up in logs.
 *  - No usable output text (empty body, a refusal, a `failed`/`incomplete`
 *    response). This stays `OPENAI_SCHEMA` so the existing repair/fallback path is
 *    unchanged, but the internal message now spells out the actual reason —
 *    status, incomplete reason, API error, or refusal text — because a bare
 *    "empty response" is undiagnosable.
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
  // Prefer the SDK's aggregated getter, but fall back to assembling the text from
  // the output items. `stream.finalResponse().output_text` comes back EMPTY for
  // gpt-5.5 even when the message item holds the full JSON (the non-streaming
  // `responses.create()` getter works, the streamed one does not), so trusting
  // the getter alone drops a perfectly good completed response on the floor.
  const text =
    typeof response.output_text === 'string' && response.output_text.length > 0
      ? response.output_text
      : collectOutputText(response);
  if (text.length > 0) {
    return text;
  }
  // Still nothing. Spell out WHY so an empty body is diagnosable instead of
  // opaque — this is the difference between "unexpected response" and "the model
  // refused" / "content_filter" / "the API failed".
  throw new AppError('OPENAI_SCHEMA', { message: describeMissingText(response, schemaName) });
}

/**
 * Assemble the output text from a response's items — the `output_text` content
 * parts of its message items, concatenated. The fallback for when the SDK's
 * convenience getter returns empty (notably a streamed `finalResponse()`).
 */
function collectOutputText(response: ResponseEnvelope): string {
  let text = '';
  for (const item of response.output ?? []) {
    const obj = item as { type?: unknown; content?: unknown };
    // Mirror the SDK's own aggregator: only `message` items carry output text,
    // so reasoning / tool-call items never leak into the assembled string.
    if (obj?.type !== 'message' || !Array.isArray(obj.content)) continue;
    for (const raw of obj.content) {
      const part = raw as { type?: unknown; text?: unknown };
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        text += part.text;
      }
    }
  }
  return text;
}

/** Build a diagnostic for a Responses result that carried no usable output text. */
function describeMissingText(response: ResponseEnvelope, schemaName: string): string {
  const bits: string[] = [];
  if (response.status) bits.push(`status=${response.status}`);
  if (response.incomplete_details?.reason) bits.push(`incomplete=${response.incomplete_details.reason}`);
  if (response.error?.code || response.error?.message) {
    bits.push(`error=${[response.error.code, response.error.message].filter(Boolean).join(': ')}`);
  }
  const refusal = findRefusal(response);
  if (refusal) bits.push(`refusal=${refusal.slice(0, 400)}`);
  const suffix = bits.length > 0 ? ` (${bits.join('; ')})` : '';
  return `OpenAI returned no output text for schema "${schemaName}"${suffix}`;
}

/** Recover a model refusal string from the output items, if the model refused. */
function findRefusal(response: ResponseEnvelope): string | null {
  for (const item of response.output ?? []) {
    const content = (item as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      const part = raw as { type?: unknown; refusal?: unknown };
      if (part?.type === 'refusal' && typeof part.refusal === 'string' && part.refusal.length > 0) {
        return part.refusal;
      }
    }
  }
  return null;
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
