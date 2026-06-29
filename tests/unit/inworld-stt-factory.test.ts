import { buildSttWsUrl } from '@main/providers/factory';

/**
 * The Inworld streamBidirectional endpoint authenticates via a URL query
 * parameter (`?authorization=Basic%20<key>`), not an `Authorization` upgrade
 * header. These tests pin the encoding contract of buildSttWsUrl: the space
 * must be `%20` (not `+`), and a base64 credential's `+` `/` `=` must be
 * percent-escaped so the server reads the credential verbatim. Regression
 * guard for issue #10.
 */
describe('buildSttWsUrl', () => {
  const BASE = 'wss://example.com/stt/v1/transcribe:streamBidirectional';

  it('places the Basic credential in a lowercase `authorization` query param', () => {
    const url = buildSttWsUrl(BASE, 'abc123');
    expect(url).toBe(`${BASE}?authorization=Basic%20abc123`);
  });

  it('encodes the separating space as %20, never a `+`', () => {
    const url = buildSttWsUrl(BASE, 'abc123');
    expect(url).toContain('?authorization=Basic%20');
    // A `+` between "Basic" and the key would be decoded as a space only under
    // form-encoding semantics — the streaming endpoint reads the value verbatim.
    expect(url).not.toContain('Basic+');
  });

  it('percent-escapes base64 credential characters (+ / =)', () => {
    // A realistic base64 Basic credential containing every reserved char.
    const key = 'aGVsbG8+d29ybGQ/Zm9v==';
    const url = buildSttWsUrl(BASE, key);
    expect(url).toBe(`${BASE}?authorization=Basic%20aGVsbG8%2Bd29ybGQ%2FZm9v%3D%3D`);
    // No raw base64 reserved characters leak into the credential query value.
    const credentialValue = url.slice(`${BASE}?authorization=`.length);
    expect(credentialValue).not.toMatch(/[+/=]/);
  });

  it('round-trips back to the original credential when URL-decoded', () => {
    const key = 'aGVsbG8+d29ybGQ/Zm9v==';
    const url = buildSttWsUrl(BASE, key);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('authorization')).toBe(`Basic ${key}`);
  });
});
