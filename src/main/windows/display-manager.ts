import { screen } from 'electron';
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
