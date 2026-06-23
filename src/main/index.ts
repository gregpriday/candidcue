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

let controlWindow: BrowserWindow | null = null;
let stageWindow: BrowserWindow | null = null;

async function bootstrap(): Promise<void> {
  const logger = createLogger();
  const videosRoot = resourceRoot('videos');
  setPromptsRoot(resourceRoot('prompts'));

  const repository = createRepository(join(app.getPath('userData'), 'candidcue.sqlite'));
  await repository.migrate();
  const credentials = createCredentialStore();

  // Each renderer is served from its own origin: in dev that's a per-renderer
  // Vite dev server (distinct localhost ports); packaged, both load from file://.
  const controlOrigin = controlDevUrl ?? 'file://';
  const stageOrigin = stageDevUrl ?? 'file://';
  registerCandidCueProtocol({ videosRoot, rendererRoot: join(currentDir, '..', 'renderer', controlName) });
  applyCspHeaders(session.defaultSession, app.isPackaged);
  // The microphone is requested from both the control window (preflight preview)
  // and the stage window (live capture), so both origins must be allowed.
  applyPermissionHandlers(session.defaultSession, [controlOrigin, stageOrigin]);

  controlWindow = createControlWindow(rendererTarget('control'), controlOrigin);

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

  const controller = new AppController({
    repository,
    credentials,
    logger,
    videosRoot,
    getControl,
    getStage,
    ensureStageWindow,
  });

  const guard = makeSenderGuard(() => ({ control: getControl(), stage: getStage() }));
  registerControlIpc(controller, guard);
  registerStageIpc(controller, guard);

  logger.info('app.ready', { packaged: app.isPackaged });
}

app.whenReady().then(bootstrap).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('CandidCue failed to start:', err);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) {
    void bootstrap();
  }
});
