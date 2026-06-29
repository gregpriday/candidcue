import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication } from '@playwright/test';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Artifacts `npm run build:app` must produce for the unbundled Electron launch
 * (args: ['.']) to work: the main bundle, both preloads, and both renderer
 * index.html files. Asserted up front so a missing/stale build fails clearly
 * rather than as a confusing Electron launch error.
 */
const REQUIRED_ARTIFACTS = [
  '.vite/build/main.js',
  '.vite/build/control.js',
  '.vite/build/stage.js',
  '.vite/renderer/control/index.html',
  '.vite/renderer/stage/index.html',
];

/**
 * Resolve the installed Electron binary path. The `electron` npm package ships
 * only the launcher; its main export IS the resolved absolute path to the real
 * binary under `dist/` (e.g. `.../electron/dist/Electron.app/.../Electron`),
 * which it computes by joining `dist/` with `path.txt`. Requiring the package
 * reuses that resolution (and honors `ELECTRON_OVERRIDE_DIST_PATH`) rather than
 * hand-rolling it. Playwright needs the binary itself, not the launcher.
 */
export function electronExecutablePath(): string {
  return require('electron') as string;
}

/** Run `npm run build:app` (once) unless the caller pre-built with the skip env. */
export async function ensureAppBuilt(): Promise<void> {
  if (process.env.CANDIDCUE_E2E_SKIP_BUILD === '1') {
    assertArtifacts();
    return;
  }
  await run('npm run build:app', repoRoot);
  assertArtifacts();
}

function assertArtifacts(): void {
  const missing = REQUIRED_ARTIFACTS.filter((rel) => !existsSync(join(repoRoot, rel)));
  if (missing.length > 0) {
    throw new Error(`build:app did not produce expected artifacts: ${missing.join(', ')}`);
  }
}

function run(command: string, cwd: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`\`${command}\` exited with code ${code ?? 'null'}`)),
    );
  });
}

export interface LaunchedApp {
  electronApp: ElectronApplication;
  /** Isolated userData dir (SQLite DB + credential envelopes) for this launch. */
  userDataDir: string;
  /** Close the app and remove the isolated userData dir. Safe to call once. */
  cleanup: () => Promise<void>;
}

/**
 * Launch the real CandidCue Electron app backed by the provider fakes, against
 * an isolated userData dir. The app reads `CANDIDCUE_PROVIDERS=fake` (provider
 * seam) and `CANDIDCUE_E2E_USER_DATA_DIR` (data isolation) at bootstrap.
 *
 * `NODE_OPTIONS` is explicitly cleared so the Playwright parent's
 * `--experimental-sqlite` (if any) does not leak into the Electron child —
 * Electron bundles its own Node where `node:sqlite` is usable without the flag.
 */
export async function launchApp(): Promise<LaunchedApp> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'candidcue-e2e-'));
  const electronApp = await _electron.launch({
    executablePath: electronExecutablePath(),
    // '.' = run the app from the repo root (package.json main → .vite/build/main.js).
    // The fake-media switches auto-grant mic permission and feed a synthetic mic,
    // so the control window's preflight preview and the stage capture never block
    // on a real permission prompt or a missing audio device.
    args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    cwd: repoRoot,
    env: {
      ...process.env,
      CANDIDCUE_PROVIDERS: 'fake',
      CANDIDCUE_E2E_USER_DATA_DIR: userDataDir,
      NODE_OPTIONS: '',
    },
    timeout: 60_000,
  });

  const cleanup = async (): Promise<void> => {
    try {
      await electronApp.close();
    } catch {
      /* best-effort: the app may already be gone */
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  };

  return { electronApp, userDataDir, cleanup };
}
