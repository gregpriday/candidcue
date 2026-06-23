import { BrowserWindow, app } from 'electron';
import type { WebPreferences, Rectangle } from 'electron';
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

async function loadRenderer(win: BrowserWindow, target: RendererTarget): Promise<void> {
  const base = target.devServerUrl ? target.devServerUrl.replace(/\/?$/, '/') : null;
  if (base) {
    await win.loadURL(new URL(target.route, base).toString());
  } else {
    await win.loadFile(target.filePath);
  }
  if (!app.isPackaged) win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    // eslint-disable-next-line no-console
    console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`);
  });
}

/** Operator ControlWindow (spec §7.3, §20.1). */
export function createControlWindow(target: RendererTarget, appOrigin: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#101114',
    webPreferences: secureWebPreferences(target.preloadPath),
  });
  hardenNavigation(win.webContents, appOrigin);
  win.once('ready-to-show', () => win.show());
  void loadRenderer(win, target);
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
    webPreferences: secureWebPreferences(target.preloadPath),
  });
  hardenNavigation(win.webContents, appOrigin);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.once('ready-to-show', () => win.show());
  void loadRenderer(win, target);
  return win;
}
