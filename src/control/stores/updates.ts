/**
 * The update flow in the control window (docs/updates.md, #191).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DECIDES, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * It decides WHEN to ask and WHAT TO SHOW. It does not decide what is safe:
 * Rust refuses an automatic check when checks are turned off, refuses an
 * install during a take, verifies the signature, and picks the endpoint. A bug
 * here can show a notice at the wrong moment; it cannot install at one.
 *
 * ---------------------------------------------------------------------------
 * NEVER DURING A TAKE, NEVER ON THE GLASS
 * ---------------------------------------------------------------------------
 * Present reshapes this window into the prompter, so anything drawn here during
 * a take is drawn on the glass. Three rules follow, and each is enforced in
 * one place:
 *
 *   - the notice is HELD, not dropped: a check that finds an update during a
 *     take leaves it in `state`, and `UpdateNotice` renders nothing while
 *     `takeActive` is true — so it appears when the take ends;
 *   - a manual check's toast ("up to date", "could not check") is DROPPED if
 *     a take started while it ran — a toast is drawn on the glass;
 *   - `install` stands down while a take is active, and Rust refuses it anyway.
 *
 * ---------------------------------------------------------------------------
 * SCHEDULE
 * ---------------------------------------------------------------------------
 * One automatic check `FIRST_CHECK_DELAY_MS` after launch, then one every
 * `CHECK_INTERVAL_MS` while the app runs. Each tick reads the setting at that
 * moment, so turning checks off stops the next one without a restart, and
 * turning them on lets the next tick run.
 */
import { writable, type Readable } from 'svelte/store';
import type { UpdateCheckResult, UpdateProgress } from '../../shared/contracts/updates';
import { describeError, errorCode } from '../services/errors';
import type { ToastTone } from './toasts';

/** About fifteen seconds after launch: after the window and library settle. */
export const FIRST_CHECK_DELAY_MS = 15_000;
/** Then every six hours while Speaking Glass is running. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** What the notice shows. `hidden` is also what it shows during a take. */
export type UpdateNoticeState =
  | { kind: 'hidden' }
  | {
      kind: 'available';
      version: string;
      currentVersion: string;
      /** False: offer the download page instead of installing. */
      canInstall: boolean;
    }
  | {
      kind: 'downloading';
      version: string;
      /** 0–1, or `null` when the size is not known yet. */
      fraction: number | null;
    }
  | { kind: 'installing'; version: string }
  | { kind: 'restarting'; version: string }
  | {
      kind: 'failed';
      version: string;
      currentVersion: string;
      canInstall: boolean;
      message: string;
    };

export interface UpdateControllerDeps {
  check(options: { automatic: boolean }): Promise<UpdateCheckResult>;
  install(): Promise<void>;
  listenForProgress(onProgress: (progress: UpdateProgress) => void): () => void;
  /** A take is starting, running or still on the glass. */
  takeActive(): boolean;
  /** Settings › "Check for updates automatically". */
  automaticChecksEnabled(): boolean;
  /**
   * Make it safe to quit: flush the editor. Throws — with a sentence a person
   * can read — when something could not be saved, which stops the install.
   */
  prepareToQuit(): Promise<void>;
  /** A passing notice in this window (the toast stack). */
  report(message: string, tone: ToastTone): void;
  /** Help's download page, through the named-destination opener. */
  openDownloadPage(): Promise<void>;
  /** Bring this window forward, so a manual check's answer is seen. */
  bringToFront(): void;
  setTimeout?: (run: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface UpdateController {
  readonly notice: Readable<UpdateNoticeState>;
  /** Start the automatic schedule. Returns its teardown. */
  start(): () => void;
  /** Help › Check for Updates…. */
  checkNow(): Promise<void>;
  /** The notice's "Install and Restart" (and "Try Again"). */
  install(): Promise<void>;
  /** The notice's "Later": not again for this version until next launch. */
  later(): void;
  /** The notice's "Download" for a copy that cannot replace itself. */
  download(): Promise<void>;
}

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const schedule = deps.setTimeout ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const cancel =
    deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const state = writable<UpdateNoticeState>({ kind: 'hidden' });
  let current: UpdateNoticeState = { kind: 'hidden' };
  const set = (next: UpdateNoticeState) => {
    current = next;
    state.set(next);
  };

  /** "Later" for this version, until the app is next launched. */
  let dismissedVersion: string | null = null;
  let checking: Promise<void> | null = null;

  const busyInstalling = () =>
    current.kind === 'downloading' || current.kind === 'installing' || current.kind === 'restarting';

  function offer(result: Extract<UpdateCheckResult, { available: true }>): void {
    set({
      kind: 'available',
      version: result.version,
      currentVersion: result.currentVersion,
      canInstall: result.canInstall,
    });
  }

  async function automaticCheck(): Promise<void> {
    if (!deps.automaticChecksEnabled() || busyInstalling() || checking !== null) return;
    const run = (async () => {
      try {
        const result = await deps.check({ automatic: true });
        if (busyInstalling()) return;
        if (result.available) {
          // Held, not shown, during a take: `UpdateNotice` reads `takeActive`.
          if (result.version !== dismissedVersion) offer(result);
        } else if (current.kind === 'available' || current.kind === 'failed') {
          // Withdrawn from the server since it was offered.
          set({ kind: 'hidden' });
        }
      } catch (err) {
        // Silent by design: a laptop offline on a train is not news, and an
        // automatic check that failed simply runs again at the next tick.
        console.debug('automatic update check did not complete', err);
      }
    })();
    checking = run;
    try {
      await run;
    } finally {
      checking = null;
    }
  }

  function start(): () => void {
    let handle: unknown = null;
    let stopped = false;
    const tick = (delay: number) => {
      handle = schedule(() => {
        if (stopped) return;
        void automaticCheck().finally(() => {
          if (!stopped) tick(CHECK_INTERVAL_MS);
        });
      }, delay);
    };
    tick(FIRST_CHECK_DELAY_MS);
    return () => {
      stopped = true;
      if (handle !== null) cancel(handle);
    };
  }

  async function checkNow(): Promise<void> {
    if (busyInstalling()) {
      // The answer is already on screen.
      deps.bringToFront();
      return;
    }
    if (checking !== null) await checking;
    try {
      const result = await deps.check({ automatic: false });
      if (busyInstalling()) return;
      if (result.available) {
        // Asking again is asking to see it, whatever "Later" said before.
        dismissedVersion = null;
        offer(result);
        if (!deps.takeActive()) deps.bringToFront();
        return;
      }
      if (current.kind === 'available' || current.kind === 'failed') set({ kind: 'hidden' });
      if (deps.takeActive()) return;
      deps.bringToFront();
      deps.report(`Speaking Glass is up to date (${result.currentVersion}).`, 'success');
    } catch (err) {
      if (deps.takeActive()) return;
      deps.bringToFront();
      deps.report(describeError(err), 'danger');
    }
  }

  async function install(): Promise<void> {
    const from = current;
    if (from.kind !== 'available' && from.kind !== 'failed') return;
    if (!from.canInstall) return download();
    if (deps.takeActive()) return;
    let version: string = from.version;
    let currentVersion: string = from.currentVersion;
    let canInstall: boolean = from.canInstall;
    const fail = (message: string) =>
      set({ kind: 'failed', version, currentVersion, canInstall, message });

    set({ kind: 'downloading', version, fraction: null });

    /*
     * "Try Again" asks the server again first. Rust installs what its LAST
     * check found, so retrying a download that failed its signature check
     * without a fresh check would fetch the same manifest's answer and fail
     * the same way, even after the server had been put right.
     */
    if (from.kind === 'failed') {
      try {
        const fresh = await deps.check({ automatic: false });
        if (!fresh.available) {
          set({ kind: 'hidden' });
          if (!deps.takeActive()) {
            deps.report(`Speaking Glass is up to date (${fresh.currentVersion}).`, 'success');
          }
          return;
        }
        ({ version, currentVersion, canInstall } = fresh);
        if (!canInstall) {
          offer(fresh);
          return download();
        }
        set({ kind: 'downloading', version, fraction: null });
      } catch (err) {
        fail(describeError(err));
        return;
      }
      if (deps.takeActive()) {
        set({ kind: 'available', version, currentVersion, canInstall });
        return;
      }
    }
    try {
      await deps.prepareToQuit();
    } catch (err) {
      fail(err instanceof Error && err.message !== '' ? err.message : describeError(err));
      return;
    }

    const stopListening = deps.listenForProgress((progress) => {
      if (progress.phase === 'downloading') {
        const fraction =
          progress.total === null ? null : Math.max(0, Math.min(1, progress.downloaded / progress.total));
        set({ kind: 'downloading', version, fraction });
      } else if (progress.phase === 'installing') {
        set({ kind: 'installing', version });
      } else {
        set({ kind: 'restarting', version });
      }
    });
    try {
      await deps.install();
      // Rust has asked the app to restart; the quit handshake is under way.
      set({ kind: 'restarting', version });
    } catch (err) {
      if (errorCode(err) === 'UPDATE_BLOCKED_BY_TAKE') {
        // A take started while it downloaded. Nothing was installed; offer it
        // again once the take is over (the notice is hidden until then).
        set({ kind: 'available', version, currentVersion, canInstall });
      } else {
        fail(describeError(err));
      }
    } finally {
      stopListening();
    }
  }

  function later(): void {
    if (current.kind !== 'available' && current.kind !== 'failed') return;
    dismissedVersion = current.version;
    set({ kind: 'hidden' });
  }

  async function download(): Promise<void> {
    if (current.kind !== 'available' && current.kind !== 'failed') return;
    const version = current.version;
    try {
      await deps.openDownloadPage();
      dismissedVersion = version;
      set({ kind: 'hidden' });
    } catch (err) {
      deps.report(`The download page could not be opened. ${describeError(err)}`, 'danger');
    }
  }

  return {
    notice: { subscribe: state.subscribe },
    start,
    checkNow,
    install,
    later,
    download,
  };
}
