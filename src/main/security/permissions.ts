import type { Session } from 'electron';

/**
 * Permission policy (spec §20.4). Microphone ("media") is granted only to a
 * CandidCue renderer origin; camera and every other capability are denied. We
 * inspect mediaTypes so a media request can never smuggle video capture.
 *
 * `allowedOrigins` must include *every* renderer origin that may request the
 * microphone. The live capture runs in the StageWindow, which in dev is served
 * from its own Vite dev server (a different localhost port than the control
 * window) — so both origins have to be listed or stage capture is denied.
 */
export function applyPermissionHandlers(session: Session, allowedOrigins: readonly string[]): void {
  session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(isPermitted(permission, allowedOrigins, details));
  });

  session.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    return isPermitted(permission, allowedOrigins, { requestingUrl: requestingOrigin, ...details });
  });
}

function isPermitted(
  permission: string,
  allowedOrigins: readonly string[],
  details: { requestingUrl?: string; mediaTypes?: string[] } | undefined,
): boolean {
  const origin = details?.requestingUrl ?? '';
  const sameOrigin = allowedOrigins.some((allowed) => origin.startsWith(allowed)) || origin.startsWith('candidcue:');
  if (!sameOrigin) return false;

  if (permission === 'media') {
    const types = details?.mediaTypes ?? [];
    // Audio only — explicitly reject any video (camera) capture.
    if (types.includes('video')) return false;
    return true;
  }

  // Everything else (geolocation, notifications, MIDI, serial, USB, HID,
  // screen capture, etc.) is denied for the MVP.
  return false;
}
