/**
 * Reading-band geometry (spec §16.3, §32.5) and compact-display adaptation
 * (§16.8). Pure logic — all units are logical (CSS) pixels unless noted.
 *
 * Coordinate model: "document space" has y = 0 at the top of the scroll plane
 * content (including its top padding). The plane is translated by -scrollY,
 * so a document y appears on screen at `y - scrollY`.
 */

export interface ReadingBandSettings {
  /** Band center as percent of viewport height from the top (default 38). */
  centerPercent: number;
  /** Band half-height as percent of viewport height (default 4). */
  halfHeightPercent: number;
}

export interface ReadingBand {
  centerPx: number;
  topPx: number;
  bottomPx: number;
}

export function computeReadingBand(
  viewportHeightPx: number,
  settings: ReadingBandSettings,
): ReadingBand {
  const center = clamp(settings.centerPercent, 20, 70) / 100;
  const half = clamp(settings.halfHeightPercent, 2, 12) / 100;
  const centerPx = viewportHeightPx * center;
  return {
    centerPx,
    topPx: Math.max(0, centerPx - viewportHeightPx * half),
    bottomPx: Math.min(viewportHeightPx, centerPx + viewportHeightPx * half),
  };
}

/**
 * Dead-zone check + correction (spec §16.3): while the target token's center
 * remains inside the band, do not scroll (returns null). Once it leaves,
 * return the scrollY that puts the token center back at the band center.
 */
export function bandCorrection(
  tokenTopDocPx: number,
  tokenHeightPx: number,
  scrollY: number,
  band: ReadingBand,
): number | null {
  const centerDoc = tokenTopDocPx + tokenHeightPx / 2;
  const viewportY = centerDoc - scrollY;
  if (viewportY >= band.topPx && viewportY <= band.bottomPx) {
    return null;
  }
  return centerDoc - band.centerPx;
}

/** ScrollY that centers a document-space y on the band center. */
export function scrollTargetFor(centerDocPx: number, band: ReadingBand): number {
  return centerDocPx - band.centerPx;
}

/**
 * Provisional matches may not trigger large movement (spec §16.4): clamp the
 * correction distance to maxCorrectionPx around the current position.
 */
export function clampProvisionalTarget(
  currentScrollY: number,
  targetScrollY: number,
  maxCorrectionPx: number,
): number {
  const delta = targetScrollY - currentScrollY;
  if (Math.abs(delta) <= maxCorrectionPx) return targetScrollY;
  return currentScrollY + Math.sign(delta) * maxCorrectionPx;
}

/* ---------------------------------------------------------------------------
 * Compact-display adaptation (spec §16.8, A.3)
 * ------------------------------------------------------------------------- */

/** A display around 1024×600 gets the compact treatment. */
export function isCompactViewport(widthPx: number, heightPx: number): boolean {
  return heightPx > 0 && heightPx <= 700 && widthPx <= 1280;
}

export interface StagePadding {
  topVh: number;
  bottomVh: number;
}

/** Top/bottom column padding so first/last words can reach the band (A.3). */
export function stagePadding(compact: boolean): StagePadding {
  return compact ? { topVh: 34, bottomVh: 60 } : { topVh: 38, bottomVh: 55 };
}

/** Depth of the top/bottom focus fades; reduced on compact displays (§16.8). */
export function fadeDepthVh(compact: boolean): number {
  return compact ? 10 : 16;
}

/** Max image height as percent of viewport height (§16.8). */
export function imageMaxHeightVh(compact: boolean): number {
  return compact ? 70 : 78;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
