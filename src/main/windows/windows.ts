import { BrowserWindow, app } from 'electron';
import type { WebPreferences, Rectangle, BrowserWindowConstructorOptions } from 'electron';
import { hardenNavigation } from '../security/navigation';

export interface RendererTarget {
  /** Dev server URL when running under Forge/Vite, else null. */
  devServerUrl: string | null;
  /** Dev-server route, e.g. "control/index.html". */
  route: string;
  /** Packaged renderer html file path. */
  filePath: string;
  /** Resolved preload script path. */
  preloadPath: string;
}

function secureWebPreferences(preload: string): WebPreferences {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    preload,
    devTools: !app.isPackaged,
  };
}

/** Windows that have already been shown a diagnostic — show it only once. */
const diagnosed = new WeakSet<BrowserWindow>();

/**
 * Native Windows/Linux title-bar overlay palette per shell theme. The overlay
 * is a real OS-drawn rectangle, so it must track the renderer theme or a dark
 * block sits over the light workspace. Colours mirror the token substrate:
 * workspace = warm paper, studio = dark. Used both for the initial overlay and
 * by `applyTitleBarOverlay` when the renderer switches themes.
 */
export type ChromeTheme = 'workspace' | 'studio';

const TITLE_BAR_OVERLAY: Record<ChromeTheme, { color: string; symbolColor: string }> = {
  workspace: { color: '#F6F4F0', symbolColor: '#5D626C' },
  studio: { color: '#14171D', symbolColor: '#A8AFBC' },
};

const TITLE_BAR_OVERLAY_HEIGHT = 48;

/**
 * Re-skin the native window-control overlay for the given theme. No-op on macOS
 * (native traffic lights are used instead) and when the overlay API is absent.
 */
export function applyTitleBarOverlay(win: BrowserWindow, theme: ChromeTheme): void {
  if (process.platform === 'darwin' || win.isDestroyed()) return;
  win.setTitleBarOverlay({ ...TITLE_BAR_OVERLAY[theme], height: TITLE_BAR_OVERLAY_HEIGHT });
}

/**
 * Build a self-contained diagnostic page as a `data:` URL. data: documents do
 * not go through the network stack, so the session CSP (injected via
 * onHeadersReceived) does not apply and inline styles render fine. No scripts.
 */
function fatalDiagnosticUrl(summary: string, detail: string): string {
  const esc = (s: string): string =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CandidCue</title></head>
<body style="margin:0;background:#101114;color:#f4f2ee;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;">
<main style="max-width:540px;padding:40px;">
<h1 style="font-size:18px;font-weight:650;margin:0 0 12px;">CandidCue couldn’t finish loading</h1>
<p style="margin:0 0 18px;color:#b1b5bc;">${esc(summary)}</p>
<pre style="white-space:pre-wrap;word-break:break-word;background:#15181d;border:1px solid #303640;border-radius:8px;padding:12px;color:#7d838d;font-size:12px;margin:0;">${esc(detail)}</pre>
</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** Show the diagnostic page and force the window visible (once). */
function showFatalDiagnostic(win: BrowserWindow, summary: string, detail: string): void {
  if (win.isDestroyed() || diagnosed.has(win)) return;
  diagnosed.add(win);
  void win.loadURL(fatalDiagnosticUrl(summary, detail));
  if (!win.isVisible()) win.show();
}

async function loadRenderer(win: BrowserWindow, target: RendererTarget): Promise<void> {
  // Register failure listeners BEFORE the load starts and in EVERY build mode.
  // The window is created hidden and only shown on `ready-to-show`, which never
  // fires if the load fails — so without this a renderer failure leaves the app
  // permanently invisible with no recovery surface (BOOT-01).
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED — superseded load, ignore */) return;
    // eslint-disable-next-line no-console
    console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`);
    showFatalDiagnostic(
      win,
      'The interface failed to load. Quit and relaunch CandidCue; if it persists, reinstall.',
      `${desc} (${code})\n${url}`,
    );
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    // eslint-disable-next-line no-console
    console.error(`[renderer] render-process-gone ${details.reason}`);
    showFatalDiagnostic(
      win,
      'The interface stopped unexpectedly. Quit and relaunch CandidCue.',
      `Renderer process ended: ${details.reason}`,
    );
  });

  const base = target.devServerUrl ? target.devServerUrl.replace(/\/?$/, '/') : null;
  if (base) {
    await win.loadURL(new URL(target.route, base).toString());
  } else {
    await win.loadFile(target.filePath);
  }
}

/** Operator ControlWindow (spec §7.3, §20.1). */
export function createControlWindow(target: RendererTarget, appOrigin: string): BrowserWindow {
  // Custom in-app title bar so the operator console reads as a desktop
  // application rather than a framed web page. On macOS the native traffic
  // lights are kept and inset into our title bar; on Windows/Linux the native
  // window controls are overlaid on the right of the same bar. The renderer
  // reserves the matching gutter (see app.module.css .header).
  // The control window opens at the workspace (home) route, so the initial
  // overlay must be the light workspace palette — never the dark studio block.
  // The renderer flips it via `window:set-theme-chrome` when a session goes live.
  const chrome: BrowserWindowConstructorOptions =
    process.platform === 'darwin'
      ? { trafficLightPosition: { x: 18, y: 18 } }
      : { titleBarOverlay: { ...TITLE_BAR_OVERLAY.workspace, height: TITLE_BAR_OVERLAY_HEIGHT } };
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#0d0e11',
    titleBarStyle: 'hidden',
    ...chrome,
    webPreferences: secureWebPreferences(target.preloadPath),
  });
  hardenNavigation(win.webContents, appOrigin);
  win.once('ready-to-show', () => win.show());
  void loadRenderer(win, target).catch((err: unknown) => {
    showFatalDiagnostic(win, 'The interface failed to load. Quit and relaunch CandidCue.', String(err));
  });
  return win;
}

/** Teleprompter StageWindow — frameless, display-sized (spec §7.9, §20.1). */
export function createStageWindow(target: RendererTarget, appOrigin: string, bounds: Rectangle): BrowserWindow {
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    // The operator clicks Start in the control window, so the stage never
    // receives a user gesture before Mira's TTS audio plays. Playback works
    // today only because Electron defaults autoplayPolicy to
    // 'no-user-gesture-required'; pin it here (stage window only) so a future
    // default change can't silently mute the interviewer. The control window
    // plays no audio and is intentionally left on the default.
    webPreferences: {
      ...secureWebPreferences(target.preloadPath),
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  hardenNavigation(win.webContents, appOrigin);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.once('ready-to-show', () => win.show());
  void loadRenderer(win, target).catch((err: unknown) => {
    showFatalDiagnostic(win, 'The teleprompter failed to load.', String(err));
  });
  return win;
}
