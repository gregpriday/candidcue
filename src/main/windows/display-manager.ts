import { screen, BrowserWindow } from 'electron';
import type { DisplayInfo } from '@shared/contracts';

/** Enumerate connected displays for the teleprompter picker (spec §8.3). */
export function listDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: d.label || `Display ${i + 1} (${d.size.width}×${d.size.height})`,
    bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    scaleFactor: d.scaleFactor,
    isPrimary: d.id === primaryId,
    isInternal: d.internal,
  }));
}

/** Resolve a stored display id to live bounds, falling back to primary. */
export function boundsForDisplay(displayId: string | null): Electron.Rectangle {
  const all = screen.getAllDisplays();
  const match = displayId ? all.find((d) => String(d.id) === displayId) : undefined;
  const target = match ?? screen.getPrimaryDisplay();
  return target.bounds;
}

export function isDisplayConnected(displayId: string | null): boolean {
  if (!displayId) return false;
  return screen.getAllDisplays().some((d) => String(d.id) === displayId);
}

/**
 * Briefly flash a large number on every connected display so the operator can
 * tell which physical screen is which before choosing the teleprompter output
 * (CORR-03). Each overlay is a transparent, click-through, always-on-top window
 * that auto-closes after `durationMs`.
 */
export function identifyDisplays(durationMs = 2000): void {
  const primaryId = screen.getPrimaryDisplay().id;
  screen.getAllDisplays().forEach((d, i) => {
    const win = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      fullscreenable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    void win.loadURL(identifyOverlayUrl(i + 1, d.id === primaryId));
    const timer = setTimeout(() => {
      if (!win.isDestroyed()) win.close();
    }, durationMs);
    // If the window goes away first (e.g. quit), drop the pending timer.
    win.on('closed', () => clearTimeout(timer));
  });
}

/** A transparent data: page showing the display's number (and a primary tag). */
function identifyOverlayUrl(displayNumber: number, isPrimary: boolean): string {
  const tag = isPrimary
    ? '<div style="font-size:4vh;font-weight:500;margin-top:2vh;opacity:.85;">Primary</div>'
    : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:transparent;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff;">
<div style="display:flex;flex-direction:column;align-items:center;background:rgba(13,15,18,0.78);border-radius:32px;padding:6vh 9vh;text-shadow:0 2px 16px rgba(0,0,0,.55);">
<div style="font-size:22vh;font-weight:650;line-height:1;">${displayNumber}</div>${tag}
</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
