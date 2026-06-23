/**
 * Log redaction (spec §21.5).
 *
 * Two entry points:
 *   - `redactString` masks secret-shaped substrings inside a single string.
 *   - `redact` deep-clones an arbitrary value, scrubbing sensitive object keys,
 *     known free-text content fields, and any secret-shaped string leaves.
 *
 * The goal is defence-in-depth before anything is written to a diagnostics log:
 * even if a provider key or raw transcript slips into a structure, it should not
 * leave the process in cleartext.
 */

/** Placeholder substituted for masked secret material inside strings. */
const REDACTED = '[REDACTED]';

/** Placeholder substituted for redacted free-text content fields. */
const REDACTED_TEXT = '[REDACTED_TEXT]';

/**
 * Object keys whose values are always secrets and must be fully replaced,
 * regardless of their shape. Matched case-insensitively against each key.
 */
const SENSITIVE_KEY_PATTERN = /api[_-]?key|authorization|secret|token|password|credential/i;

/**
 * Free-text fields that may contain interview content. These are redacted by
 * default but preserved when the caller opts out via `{ redactText: false }`.
 */
const CONTENT_KEYS = new Set<string>([
  'rawTranscript',
  'cleanedTranscript',
  'userEditedTranscript',
  'spokenText',
  'content',
  'partialTranscript',
  'finalTranscriptSoFar',
]);

/**
 * Secret-shaped substring patterns. Each match is replaced wholesale with the
 * `[REDACTED]` placeholder.
 *
 *   - Provider keys such as OpenAI `sk-...` tokens.
 *   - Long bearer-like opaque tokens (optionally prefixed by `Bearer `).
 */
const SECRET_STRING_PATTERNS: readonly RegExp[] = [
  // Provider key prefixes: sk-..., sk-proj-..., pk-..., rk-... etc.
  /\b[a-z]{2,4}-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g,
  // Bearer-prefixed opaque tokens.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

/** Mask provider key patterns and bearer-like tokens within a string. */
export function redactString(s: string): string {
  let out = s;
  for (const pattern of SECRET_STRING_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export interface RedactOptions {
  /** When false, known free-text content fields are preserved. Default true. */
  redactText?: boolean;
}

/**
 * Deep-clone `value`, redacting sensitive keys, content fields, and
 * secret-shaped string leaves. Arrays, nested objects, `null`, and primitives
 * are all handled. Cyclic references are short-circuited to avoid infinite
 * recursion.
 */
export function redact(value: unknown, opts: RedactOptions = {}): unknown {
  const redactText = opts.redactText !== false;
  return walk(value, redactText, new WeakSet<object>());
}

function walk(value: unknown, redactText: boolean, seen: WeakSet<object>): unknown {
  if (value === null) return null;

  const type = typeof value;
  if (type === 'string') return redactString(value as string);
  if (type !== 'object') {
    // number, boolean, bigint, symbol, undefined, function — pass through.
    return type === 'function' || type === 'symbol' ? undefined : value;
  }

  // Preserve common non-plain objects without descending into internals.
  if (value instanceof Date) return new Date(value.getTime());

  const obj = value as object;
  if (seen.has(obj)) return '[Circular]';
  seen.add(obj);

  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => walk(item, redactText, seen));
  } else {
    result = redactPlainObject(value as Record<string, unknown>, redactText, seen);
  }

  seen.delete(obj);
  return result;
}

function redactPlainObject(
  input: Record<string, unknown>,
  redactText: boolean,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const child = input[key];
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
    } else if (redactText && CONTENT_KEYS.has(key)) {
      out[key] = REDACTED_TEXT;
    } else {
      out[key] = walk(child, redactText, seen);
    }
  }
  return out;
}
