import { describe, expect, it } from 'vitest';
import { mapProviderErrorEvent, mapRealtimeHttpStatus } from './errors';

describe('mapRealtimeHttpStatus (spec E.7)', () => {
  it('maps the failure table', () => {
    expect(mapRealtimeHttpStatus(401)).toEqual({ code: 'AUTH_KEY_INVALID', recoverable: false });
    expect(mapRealtimeHttpStatus(403)).toEqual({ code: 'AUTH_KEY_INVALID', recoverable: false });
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
