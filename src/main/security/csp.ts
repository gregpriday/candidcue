import type { Session } from 'electron';

/** Production Content-Security-Policy (spec §20.3). Provider calls run in main,
 * so renderers never need provider domains in connect-src. */
export const PRODUCTION_CSP = [
  "default-src 'self' candidcue:",
  "script-src 'self'",
  // AudioWorklet modules (mic capture) are same-origin assets; declare it
  // explicitly rather than relying on the worker-src -> script-src fallback.
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' candidcue: blob: data:",
  "media-src 'self' candidcue: blob:",
  "connect-src 'self' candidcue:",
  "font-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * Development CSP additionally permits the Vite dev server websocket and the
 * inline styles React injects. Never used in packaged builds.
 */
export const DEVELOPMENT_CSP = [
  "default-src 'self' candidcue: http://localhost:* ws://localhost:*",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' candidcue: blob: data: http://localhost:*",
  "media-src 'self' candidcue: blob: http://localhost:*",
  "connect-src 'self' candidcue: http://localhost:* ws://localhost:*",
  "font-src 'self'",
  "object-src 'none'",
].join('; ');

/** Inject the CSP response header on every request in the given session. */
export function applyCspHeaders(session: Session, isPackaged: boolean): void {
  const csp = isPackaged ? PRODUCTION_CSP : DEVELOPMENT_CSP;
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}
