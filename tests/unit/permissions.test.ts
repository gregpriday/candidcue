import { describe, it, expect } from 'vitest';
import type { Session } from 'electron';
import { applyPermissionHandlers } from '@main/security/permissions';

type RequestHandler = (
  wc: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: { requestingUrl?: string; mediaTypes?: string[] },
) => void;

type CheckHandler = (
  wc: unknown,
  permission: string,
  requestingOrigin: string,
  details: { mediaTypes?: string[] },
) => boolean;

interface Captured {
  request: RequestHandler;
  check: CheckHandler;
}

/** Capture the two handlers `applyPermissionHandlers` installs on a session. */
function install(allowedOrigins: string[]): Captured {
  let request: RequestHandler | null = null;
  let check: CheckHandler | null = null;
  const session = {
    setPermissionRequestHandler: (h: RequestHandler) => {
      request = h;
    },
    setPermissionCheckHandler: (h: CheckHandler) => {
      check = h;
    },
  } as unknown as Session;
  applyPermissionHandlers(session, allowedOrigins);
  if (request === null || check === null) throw new Error('handlers not installed');
  return { request, check };
}

/** Drive the request handler and return its callback decision. */
function request(
  c: Captured,
  permission: string,
  details: { requestingUrl?: string; mediaTypes?: string[] },
): boolean {
  let decision: boolean | null = null;
  c.request(null, permission, (granted) => {
    decision = granted;
  }, details);
  if (decision === null) throw new Error('callback not invoked');
  return decision;
}

const CONTROL = 'http://localhost:5173';
const STAGE = 'http://localhost:5174';

describe('applyPermissionHandlers', () => {
  it('grants audio media to the control origin', () => {
    const c = install([CONTROL, STAGE]);
    expect(request(c, 'media', { requestingUrl: `${CONTROL}/index.html`, mediaTypes: ['audio'] })).toBe(true);
  });

  it('grants audio media to the stage origin even when it is a different port', () => {
    // Regression: the live capture runs in the stage window, served from its own
    // dev server. It must be permitted, not just the control origin.
    const c = install([CONTROL, STAGE]);
    expect(request(c, 'media', { requestingUrl: `${STAGE}/index.html`, mediaTypes: ['audio'] })).toBe(true);
  });

  it('grants audio media to the candidcue:// origin (packaged scheme)', () => {
    const c = install([CONTROL, STAGE]);
    expect(request(c, 'media', { requestingUrl: 'candidcue://app/index.html', mediaTypes: ['audio'] })).toBe(true);
  });

  it('denies camera (video) capture even from an allowed origin', () => {
    const c = install([CONTROL, STAGE]);
    expect(request(c, 'media', { requestingUrl: `${STAGE}/index.html`, mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(request(c, 'media', { requestingUrl: `${STAGE}/index.html`, mediaTypes: ['video'] })).toBe(false);
  });

  it('denies media from an unknown origin', () => {
    const c = install([CONTROL, STAGE]);
    expect(request(c, 'media', { requestingUrl: 'http://evil.example/index.html', mediaTypes: ['audio'] })).toBe(false);
  });

  it('denies non-media permissions even from an allowed origin', () => {
    const c = install([CONTROL, STAGE]);
    for (const permission of ['geolocation', 'notifications', 'midi', 'serial', 'hid', 'display-capture']) {
      expect(request(c, permission, { requestingUrl: `${CONTROL}/index.html` })).toBe(false);
    }
  });

  it('applies the same policy through the synchronous check handler', () => {
    const c = install([CONTROL, STAGE]);
    expect(c.check(null, 'media', STAGE, { mediaTypes: ['audio'] })).toBe(true);
    expect(c.check(null, 'media', STAGE, { mediaTypes: ['video'] })).toBe(false);
    expect(c.check(null, 'media', 'http://evil.example', { mediaTypes: ['audio'] })).toBe(false);
  });
});
