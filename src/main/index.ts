import { app, BrowserWindow, session, powerSaveBlocker, type WebContents } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createRepository } from './persistence';
import { createCredentialStore } from './security/secrets-electron';
import { createLogger } from './diagnostics';
import { setPromptsRoot } from './prompts/prompt-loader';
import { registerCandidCueSchemePrivileges, registerCandidCueProtocol } from './media/protocol-handler';
import { applyCspHeaders } from './security/csp';
import { applyPermissionHandlers } from './security/permissions';
import { createControlWindow, createStageWindow, type RendererTarget } from './windows/windows';
import { boundsForDisplay } from './windows/display-manager';
import { makeSenderGuard } from './ipc/sender-guards';
import { registerControlIpc } from './ipc/register-control-ipc';
import { registerStageIpc } from './ipc/register-stage-ipc';
import { AppController } from './app-controller';

// Privileged scheme must be registered before the app is ready (spec §20.2).
registerCandidCueSchemePrivileges();

const currentDir = dirname(fileURLToPath(import.meta.url));

const controlDevUrl = typeof CONTROL_VITE_DEV_SERVER_URL !== 'undefined' ? CONTROL_VITE_DEV_SERVER_URL : null;
const stageDevUrl = typeof STAGE_VITE_DEV_SERVER_URL !== 'undefined' ? STAGE_VITE_DEV_SERVER_URL : null;
const controlName = typeof CONTROL_VITE_NAME !== 'undefined' ? CONTROL_VITE_NAME : 'control';
const stageName = typeof STAGE_VITE_NAME !== 'undefined' ? STAGE_VITE_NAME : 'stage';

function resourceRoot(name: 'videos' | 'prompts'): string {
  // In dev the main bundle runs from <repo>/.vite/build, so the repo root (where
  // videos/ and prompts/ live) is two levels up. Packaged builds copy these
  // folders into resourcesPath via forge's extraResource.
  return app.isPackaged ? join(process.resourcesPath, name) : join(currentDir, '..', '..', name);
}

function rendererTarget(name: 'control' | 'stage'): RendererTarget {
  const devUrl = name === 'control' ? controlDevUrl : stageDevUrl;
  const viteName = name === 'control' ? controlName : stageName;
  return {
    devServerUrl: devUrl,
    // Each renderer is rooted at its own folder: its dev server serves
    // index.html at '/', and the packaged output is .vite/renderer/<name>/index.html.
    route: 'index.html',
    filePath: join(currentDir, '..', 'renderer', viteName, 'index.html'),
    preloadPath: join(currentDir, `${name}.js`),
  };
}

// Each renderer is served from its own origin: in dev that's a per-renderer
// Vite dev server (distinct localhost ports); packaged, both load from file://.
const controlOrigin = controlDevUrl ?? 'file://';
const stageOrigin = stageDevUrl ?? 'file://';

let controlWindow: BrowserWindow | null = null;
let stageWindow: BrowserWindow | null = null;

// One-time application services. `bootstrap()` builds these exactly once; window
// (re)creation is a separate concern so macOS reactivation never re-runs
// bootstrap — which would re-register IPC handlers and throw on the first
// duplicate channel (BOOT-02).
let started = false;
let repository: ReturnType<typeof createRepository> | null = null;
let controller: AppController | null = null;

/** Create (or focus) the operator ControlWindow, reusing existing services. */
function openControlWindow(): void {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.focus();
    return;
  }
  controlWindow = createControlWindow(rendererTarget('control'), controlOrigin);
}

async function bootstrap(): Promise<void> {
  if (started) {
    openControlWindow();
    return;
  }
  started = true;

  const logger = createLogger();
  const videosRoot = resourceRoot('videos');
  setPromptsRoot(resourceRoot('prompts'));

  const repo = createRepository(join(app.getPath('userData'), 'candidcue.sqlite'));
  // Assign before migrate() so a failed migration still lets before-quit close
  // the DB handle opened in the repository constructor.
  repository = repo;
  await repo.migrate();
  const credentials = createCredentialStore();

  registerCandidCueProtocol({ videosRoot, rendererRoot: join(currentDir, '..', 'renderer', controlName) });
  applyCspHeaders(session.defaultSession, app.isPackaged);
  // The microphone is requested from both the control window (preflight preview)
  // and the stage window (live capture), so both origins must be allowed.
  applyPermissionHandlers(session.defaultSession, [controlOrigin, stageOrigin]);

  openControlWindow();

  const getControl = (): WebContents | null => (controlWindow && !controlWindow.isDestroyed() ? controlWindow.webContents : null);
  const getStage = (): WebContents | null => (stageWindow && !stageWindow.isDestroyed() ? stageWindow.webContents : null);

  let blockerId: number | null = null;
  const ensureStageWindow = (displayId: string | null): WebContents => {
    if (!stageWindow || stageWindow.isDestroyed()) {
      stageWindow = createStageWindow(rendererTarget('stage'), stageOrigin, boundsForDisplay(displayId));
      stageWindow.on('closed', () => {
        stageWindow = null;
        if (blockerId != null && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
      });
      // Block display sleep while the teleprompter is live (spec §23.3).
      blockerId = powerSaveBlocker.start('prevent-display-sleep');
    }
    return stageWindow.webContents;
  };

  const ctrl = new AppController({
    repository: repo,
    credentials,
    logger,
    videosRoot,
    getControl,
    getStage,
    ensureStageWindow,
  });
  controller = ctrl;

  const guard = makeSenderGuard(() => ({ control: getControl(), stage: getStage() }));
  registerControlIpc(ctrl, guard);
  registerStageIpc(ctrl, guard);

  logger.info('app.ready', { packaged: app.isPackaged });
}

app.whenReady().then(bootstrap).catch((err) => {
  console.error('CandidCue failed to start:', err);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  // Reactivation recreates (or focuses) only the ControlWindow; services persist
  // (BOOT-02). Keyed off the ControlWindow itself rather than the total window
  // count, so a closed operator window is restored even while the StageWindow is
  // still up (openControlWindow no-ops/focuses when it already exists).
  if (started) openControlWindow();
});

// Release live resources before exit (BOOT-04): tear down the active session's
// provider connections, then close the database. Guarded so the deferred quit
// does not re-enter this handler.
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || (!repository && !controller)) return;
  quitting = true;
  event.preventDefault();
  // Close provider connections and the database concurrently and best-effort, so
  // a hung provider shutdown can't prevent the DB from closing. allSettled never
  // rejects; the 1.5s deadline guarantees the quit proceeds regardless.
  const teardown = Promise.allSettled([
    Promise.resolve(controller?.shutdown()),
    Promise.resolve(repository?.close()),
  ]);
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, 1500));
  void Promise.race([teardown, deadline]).finally(() => app.quit());
});
