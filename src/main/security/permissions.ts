import type { Session } from 'electron';

/**
 * Permission policy (spec §20.4). Microphone ("media") is granted only to the
 * CandidCue stage origin; camera and every other capability are denied. We
 * inspect mediaTypes so a media request can never smuggle video capture.
 */
export function applyPermissionHandlers(session: Session, appOrigin: string): void {
  session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(isPermitted(permission, appOrigin, details));
  });

  session.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    return isPermitted(permission, appOrigin, { requestingUrl: requestingOrigin, ...details });
  });
}

function isPermitted(
  permission: string,
  appOrigin: string,
  details: { requestingUrl?: string; mediaTypes?: string[] } | undefined,
): boolean {
  const origin = details?.requestingUrl ?? '';
  const sameOrigin = origin.startsWith(appOrigin) || origin.startsWith('candidcue:');
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
