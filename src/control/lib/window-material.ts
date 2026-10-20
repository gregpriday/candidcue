/**
 * The operating system's own glass under the window, and where the page lets
 * it show.
 *
 * ---------------------------------------------------------------------------
 * WHAT RUST DECIDES, AND WHAT THE PAGE DECIDES
 * ---------------------------------------------------------------------------
 * Whether there IS a material is a native question: vibrancy on a Mac, Mica on
 * Windows 11, nothing on Linux or Windows 10. Rust answers it before any page
 * loads (`windows/material.rs`), lays the material under the webview, and
 * hands the answer to every page in an initialization script — a global set
 * before this module runs, so the attribute below is on the root before the
 * first paint and no frame ever shows an opaque rail turning clear.
 *
 * Where the material SHOWS is the page's question, because only the page knows
 * where its chrome is: with a navigation rail drawn, the rail and the toolbar
 * band are glass and the document area is paper (`tokens.css`, WINDOW
 * MATERIAL). A window says it has a rail with {@link showMaterialRail}; until
 * it does, the canvas is opaque and only the titlebar shows the material —
 * which is what makes the boot splash, the recovery screen and a take safe
 * without any of them knowing this exists.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `data-platform`
 * ---------------------------------------------------------------------------
 * A Mac always has vibrancy, but a Windows machine may or may not have Mica,
 * and the escape hatch (`CANDIDCUE_WINDOW_MATERIAL=none`) turns either off.
 * The platform says what the page is running on; this says what Rust actually
 * put under it. Styling the rail from the platform would draw a clear column
 * over a Windows 10 window that has nothing behind it.
 */

export type WindowMaterial = 'vibrancy' | 'mica';

declare global {
  interface Window {
    /** Set by Rust's initialization script; absent in a plain browser. */
    __CANDIDCUE_WINDOW_MATERIAL__?: unknown;
    /** `'overlay'` on a Mac, where the page runs under the traffic lights. */
    __CANDIDCUE_TITLEBAR__?: unknown;
  }
}

/** How the window's titlebar meets the page. */
export type WindowTitlebar = 'overlay';

/**
 * The material Rust laid under this window, or `null` for none.
 *
 * Anything but the two known names is `null`: an unknown string is a material
 * this page has no rules for, and the safe reading of that is the opaque desk.
 */
export function windowMaterial(
  source: { __CANDIDCUE_WINDOW_MATERIAL__?: unknown } = typeof window === 'undefined' ? {} : window,
): WindowMaterial | null {
  const value = source.__CANDIDCUE_WINDOW_MATERIAL__;
  return value === 'vibrancy' || value === 'mica' ? value : null;
}

/**
 * Whether the titlebar is an overlay: on a Mac the window has no titlebar band
 * of its own (tauri.conf.json, `titleBarStyle: Overlay`), the page runs to the
 * top edge, and the traffic lights sit on it — on the sidebar's head when the
 * sidebar is drawn, at the leading end of the toolbar band when it is not.
 */
export function windowTitlebar(
  source: { __CANDIDCUE_TITLEBAR__?: unknown } = typeof window === 'undefined' ? {} : window,
): WindowTitlebar | null {
  return source.__CANDIDCUE_TITLEBAR__ === 'overlay' ? 'overlay' : null;
}

/**
 * Put the material on `root` as `data-window-material`, and the titlebar as
 * `data-titlebar` — or leave either off.
 */
export function applyWindowMaterial(
  root: HTMLElement,
  material = windowMaterial(),
  titlebar = windowTitlebar(),
): void {
  if (material === null) delete root.dataset['windowMaterial'];
  else root.dataset['windowMaterial'] = material;
  if (titlebar === null) delete root.dataset['titlebar'];
  else root.dataset['titlebar'] = titlebar;
}

/**
 * Open (or close) the window's chrome to the material.
 *
 * `true` while a navigation rail is drawn: the canvas goes clear, the rail and
 * the toolbar band show the material, and the document area below the
 * toolbar keeps the desk's paper (`tokens.css`, WINDOW MATERIAL). Harmless on
 * a root with no material — the rules key on both attributes — so callers do
 * not need to ask first.
 */
export function showMaterialRail(root: HTMLElement, shown: boolean): void {
  if (shown) root.dataset['materialRail'] = '';
  else delete root.dataset['materialRail'];
}

/**
 * Say whether a full-height navigation rail is drawn at the window's leading
 * edge (`data-sidebar`).
 *
 * Under an overlay titlebar the traffic lights need somewhere to sit: on the
 * rail's head when there is one, and otherwise at the leading end of the
 * toolbar band, which then keeps their width clear (`--traffic-lights-w`).
 */
export function showSidebar(root: HTMLElement, shown: boolean): void {
  if (shown) root.dataset['sidebar'] = '';
  else delete root.dataset['sidebar'];
}
