import { describe, expect, it } from 'vitest';
import {
  mapProviderErrorEvent,
  mapRealtimeHttpStatus,
  readProviderFailureContext,
} from './errors';

describe('mapRealtimeHttpStatus (spec E.7)', () => {
  it('maps the failure table', () => {
    expect(mapRealtimeHttpStatus(401)).toEqual({ code: 'AUTH_KEY_INVALID', recoverable: false });
    // M4: E.7 lists "401/invalid auth" and "model permission/access" as
    // SEPARATE rows with different remedies. A bare 403 from OpenAI is a
    // project/model access failure, not a bad key — telling the user to
    // re-enter a perfectly valid key sends them down the wrong path entirely.
    expect(mapRealtimeHttpStatus(403)).toEqual({
      code: 'AUTH_MODEL_UNAVAILABLE',
      recoverable: false,
    });
    expect(mapRealtimeHttpStatus(402)).toEqual({ code: 'QUOTA_EXHAUSTED', recoverable: false });
    expect(mapRealtimeHttpStatus(404)).toEqual({ code: 'AUTH_MODEL_UNAVAILABLE', recoverable: false });
    expect(mapRealtimeHttpStatus(429)).toEqual({ code: 'RATE_LIMITED', recoverable: true });
    expect(mapRealtimeHttpStatus(408)).toEqual({ code: 'NETWORK_TIMEOUT', recoverable: true });
    expect(mapRealtimeHttpStatus(500)).toEqual({ code: 'PROVIDER_UNAVAILABLE', recoverable: true });
    expect(mapRealtimeHttpStatus(503)).toEqual({ code: 'PROVIDER_UNAVAILABLE', recoverable: true });
    expect(mapRealtimeHttpStatus(400)).toEqual({
      code: 'REALTIME_NEGOTIATION_FAILED',
      recoverable: true,
    });
  });
});

describe('mapProviderErrorEvent (spec E.7 / §35.4)', () => {
  it('classifies by provider code, never message text', () => {
    expect(mapProviderErrorEvent({ code: 'invalid_api_key', type: 'invalid_request_error' })).toEqual({
      code: 'AUTH_KEY_INVALID',
      recoverable: false,
    });
    expect(mapProviderErrorEvent({ code: 'insufficient_quota', type: 'insufficient_quota' })).toEqual({
      code: 'QUOTA_EXHAUSTED',
      recoverable: false, // never retry a billing error
    });
    expect(mapProviderErrorEvent({ code: 'rate_limit_exceeded', type: 'rate_limit_error' })).toEqual({
      code: 'RATE_LIMITED',
      recoverable: true,
    });
    expect(mapProviderErrorEvent({ code: 'model_not_found', type: 'invalid_request_error' })).toEqual({
      code: 'AUTH_MODEL_UNAVAILABLE',
      recoverable: false,
    });
    expect(mapProviderErrorEvent({ code: 'session_expired', type: 'invalid_request_error' })).toEqual({
      code: 'REALTIME_CONNECTION_LOST',
      recoverable: true,
    });
    expect(mapProviderErrorEvent({ code: null, type: 'server_error' })).toEqual({
      code: 'PROVIDER_UNAVAILABLE',
      recoverable: true,
    });
    expect(mapProviderErrorEvent({})).toEqual({ code: 'PROVIDER_UNAVAILABLE', recoverable: true });
  });
});

describe('M4: status alone is not a classification', () => {
  it('distinguishes 403 model-permission from 403 invalid key', () => {
    expect(
      mapRealtimeHttpStatus(403, { code: 'model_not_found', type: 'invalid_request_error' }),
    ).toEqual({ code: 'AUTH_MODEL_UNAVAILABLE', recoverable: false });

    expect(
      mapRealtimeHttpStatus(403, { code: 'invalid_api_key', type: 'invalid_request_error' }),
    ).toEqual({ code: 'AUTH_KEY_INVALID', recoverable: false });
  });

  it('distinguishes 429 rate limiting from 429 quota exhaustion', () => {
    // Temporary: retrying is correct.
    expect(
      mapRealtimeHttpStatus(429, { code: 'rate_limit_exceeded', type: 'rate_limit_error' }),
    ).toEqual({ code: 'RATE_LIMITED', recoverable: true });

    // Hard quota also arrives as 429. Retrying it can NEVER succeed; the old
    // status-only mapping burned the whole reconnect budget on it while the
    // session looked like it was recovering.
    expect(
      mapRealtimeHttpStatus(429, { code: 'insufficient_quota', type: 'insufficient_quota' }),
    ).toEqual({ code: 'QUOTA_EXHAUSTED', recoverable: false });
  });

  it('honours Retry-After on a rate limit', () => {
    expect(
      mapRealtimeHttpStatus(429, { code: 'rate_limit_exceeded', retryAfterSeconds: 12 }),
    ).toEqual({ code: 'RATE_LIMITED', recoverable: true, retryAfterMs: 12_000 });
  });

  it('reads the structured code and Retry-After, never message prose', () => {
    const headers = { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '30' : null) };
    const context = readProviderFailureContext(
      JSON.stringify({
        error: {
          code: 'insufficient_quota',
          type: 'insufficient_quota',
          message: 'You exceeded your current quota, please check your plan and billing details.',
        },
      }),
      headers,
    );
    expect(context).toEqual({
      code: 'insufficient_quota',
      type: 'insufficient_quota',
      retryAfterSeconds: 30,
    });
    expect(mapRealtimeHttpStatus(429, context)).toEqual({
      code: 'QUOTA_EXHAUSTED',
      recoverable: false,
    });
  });

  it('falls back to status-only classification for a non-JSON body', () => {
    // Prose that MENTIONS quota must not be classified from the text.
    const context = readProviderFailureContext('Too Many Requests: quota', null);
    expect(context).toEqual({});
    expect(mapRealtimeHttpStatus(429, context)).toEqual({
      code: 'RATE_LIMITED',
      recoverable: true,
    });
  });
});
