/**
 * The recovery path exists and can be reached.
 *
 * The 1.0 readiness review's most pointed finding: the frontend contained a
 * carefully authored boot-failure screen, classified `DATABASE_CORRUPT` and
 * `DATABASE_MIGRATION_FAILED` as fatal — and its own comment correctly stated
 * that neither code could ever arrive, because `database::init` runs inside
 * Tauri's setup hook and aborts before a webview exists. The exact failures
 * most likely to need a human removed every in-app recovery action.
 *
 * These tests pin the two halves of the fix that are testable without a
 * running Tauri:
 *
 *  1. the shell ASKS whether the database came up, before it routes anywhere;
 *  2. what it says when the answer is no is specific, actionable, and does not
 *     frighten the user about files that are fine.
 *
 * The Rust half — that a failed `init` no longer aborts setup — is asserted in
 * `src-tauri/tests/backup_tests.rs` and by the `BootStatus` type itself.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => {
  const calls: Array<{ command: string; args?: unknown }> = [];
  return {
    calls,
    response: {} as Record<string, unknown>,
    invoke: async (command: string, args?: unknown) => {
      calls.push({ command, args });
      if (command in ipc.response) return ipc.response[command];
      throw new Error(`unexpected command ${command}`);
    },
  };
});

vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  BackendUnavailableError: class extends Error {},
  ipcInvoke: ipc.invoke,
}));

const appSource = readFileSync(
  new URL('../../../src/control/App.svelte', import.meta.url),
  'utf8',
);

/** Comments stripped: the shell explains at length why this code exists. */
const appCode = appSource
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

describe('the shell asks whether the database came up before it opens', () => {
  it('calls get_boot_status during boot', () => {
    expect(appCode, 'the boot sequence must ask').toMatch(/getBootStatus\(\)/);
  });

  it('renders recovery INSTEAD of the application, not alongside it', () => {
    /*
     * The rule the review asked for: the normal application cannot open until
     * recovery has produced a writable, valid database. A recovery panel
     * rendered next to the routes would leave the editor reachable, which is
     * how somebody types a script into a store that cannot keep it.
     */
    expect(appCode).toMatch(/\{#if recoveryStatus !== null\}/);
    const branch = appCode.slice(appCode.indexOf('{#if recoveryStatus !== null}'));
    const untilNext = branch.slice(0, branch.indexOf('{:else'));
    expect(untilNext, 'the recovery branch renders the recovery screen').toMatch(/<Recovery\b/);
    expect(untilNext, 'and nothing else').not.toMatch(/<Sidebar\b|<Editor\b|<Live\b/);
  });

  it('does not route into the app when the database is not ready', () => {
    /*
     * Structural: the guard has to RETURN, not merely record a flag and carry
     * on into `initAppStatus`, `loadSettings` and `setInitialRoute` — all of
     * which read the database that just failed.
     */
    const guard = appCode.slice(
      appCode.indexOf('const boot = await getBootStatus()'),
      appCode.indexOf('const status = await initAppStatus()'),
    );
    expect(guard, 'the boot-status guard must be found').toContain('databaseReady');
    expect(guard, 'and it must stop the boot sequence').toMatch(/return;/);
  });
});

describe('recovery reports a database failure without frightening the user', () => {
  beforeEach(() => {
    ipc.calls.length = 0;
    ipc.response = {};
  });

  it('asks Rust rather than assuming', async () => {
    const { getBootStatus } = await import('../../../src/control/services/recovery');
    ipc.response['get_boot_status'] = {
      databaseReady: false,
      code: 'DATABASE_CORRUPT',
      message: 'raw',
      dataDirectory: '/tmp/x',
    };
    const status = await getBootStatus();
    expect(status.databaseReady).toBe(false);
    expect(ipc.calls.map((c) => c.command)).toEqual(['get_boot_status']);
  });

  it('says the scripts are safe, because they are separate files', () => {
    /*
     * The single most useful sentence this screen can carry. Script content
     * lives in Markdown files and those files are the authority (§48.1) — a
     * database failure does not touch them. Without saying so, "Speaking Glass
     * could not open its database" reads as "your work is gone".
     *
     * The screen says it once, above every failure's own explanation, rather
     * than each explanation repeating it.
     */
    const recoverySource = readFileSync(
      new URL('../../../src/control/routes/Recovery.svelte', import.meta.url),
      'utf8',
    );
    expect(recoverySource).toMatch(/Your scripts are safe/);
  });

  it('distinguishes the three failures rather than saying one thing', async () => {
    /*
     * They call for different first actions: corruption invites a rebuild, a
     * failed migration invites the backup taken immediately before it, and a
     * missing backup is a disk problem. One generic sentence would send
     * everyone down the same wrong path.
     */
    const { describeBootFailure } = await import('../../../src/control/services/recovery');
    const at = (code: string) =>
      describeBootFailure({ databaseReady: false, code, dataDirectory: '' });

    expect(at('DATABASE_CORRUPT')).toMatch(/damage/i);
    expect(at('DATABASE_MIGRATION_FAILED')).toMatch(/update/i);
    expect(at('DATABASE_BACKUP_REQUIRED')).toMatch(/disk|permission/i);

    const all = new Set([
      at('DATABASE_CORRUPT'),
      at('DATABASE_MIGRATION_FAILED'),
      at('DATABASE_BACKUP_REQUIRED'),
    ]);
    expect(all.size, 'three codes, three sentences').toBe(3);
  });

  it('falls back to what Rust said rather than inventing a diagnosis', async () => {
    const { describeBootFailure } = await import('../../../src/control/services/recovery');
    const copy = describeBootFailure({
      databaseReady: false,
      code: 'SOMETHING_NEW',
      message: 'The disk is read-only.',
      dataDirectory: '',
    });
    expect(copy).toContain('The disk is read-only.');
  });

  it('treats a browser dev session as a working app, not a broken database', async () => {
    /*
     * `isTauriRuntime()` false means there is no backend at all, which is not
     * the same thing as a broken one. Reporting a boot failure there would put
     * the recovery screen in front of every `pnpm dev`.
     */
    vi.resetModules();
    vi.doMock('../../../src/control/services/ipc', () => ({
      isTauriRuntime: () => false,
      BackendUnavailableError: class extends Error {},
      ipcInvoke: async () => {
        throw new Error('no backend');
      },
    }));
    const { getBootStatus } = await import('../../../src/control/services/recovery');
    expect((await getBootStatus()).databaseReady).toBe(true);
    vi.doUnmock('../../../src/control/services/ipc');
    vi.resetModules();
  });
});

describe('the recovery screen offers the actions the review asked for', () => {
  const recoverySource = readFileSync(
    new URL('../../../src/control/routes/Recovery.svelte', import.meta.url),
    'utf8',
  );

  it('leads with getting the scripts out, which cannot make anything worse', () => {
    /*
     * Ordering is a claim about priorities, and this one is deliberate: the
     * first action reads the canonical Markdown files and copies them
     * elsewhere. It needs no database, and it is what a person actually wants
     * at this moment.
     */
    const rescue = recoverySource.indexOf('rescueScripts');
    const rebuild = recoverySource.indexOf('rebuildDatabaseIndex');
    const restore = recoverySource.indexOf('restoreDatabaseBackup');
    expect(rescue, 'the rescue action must exist').toBeGreaterThan(-1);
    expect(rescue, 'saving the scripts comes before restoring a backup').toBeLessThan(restore);
    expect(rescue, 'and before rebuilding').toBeLessThan(rebuild);
  });

  it('offers every recovery action the review named', () => {
    for (const action of [
      'revealDataFolder',
      'rescueScripts',
      'listDatabaseBackups',
      'restoreDatabaseBackup',
      'rebuildDatabaseIndex',
    ]) {
      expect(recoverySource, `${action} must be reachable from the screen`).toContain(action);
    }
  });

  it('never offers to restore a backup that failed its integrity check', () => {
    /*
     * Restoring a corrupt snapshot over a corrupt database leaves the user
     * with two corrupt databases and one fewer option. Rust refuses it too;
     * the button being disabled is what stops them trying.
     */
    expect(recoverySource).toMatch(/disabled=\{busy !== null \|\| !backup\.verified\}/);
  });

  it('says where the thing it replaced went', () => {
    // Every destructive action quarantines rather than deletes, and the note
    // has to name the location — otherwise "Rebuilt." reads as "erased".
    expect(recoverySource).toMatch(/previousStateAt/);
  });

  it('says what a rebuild cannot bring back, and that it finishes on reopening', () => {
    /*
     * #252: the copy warned only about session history, while names, the
     * Trash and every image went too. Names and the Trash now come back when
     * the old database can still be read, so the screen must say that is the
     * condition — and the index is built on the NEXT launch, so "Rebuilt."
     * before anything was rebuilt was a claim about work not yet done.
     */
    expect(recoverySource).toMatch(/where it can still be read/);
    expect(recoverySource).toMatch(/named after its first line/);
    // "Quit" on macOS and "Exit" elsewhere, the native menu's own verb, so the
    // source carries it as `{os.quit}` (lib/os-copy.ts).
    expect(recoverySource).toMatch(/\{os\.quit\} and reopen Speaking Glass to finish/);
    expect(recoverySource).not.toMatch(/`Rebuilt\./);
  });
});

describe('an answer the shell cannot read is not an answer that it started', () => {
  /*
   * The whole browser journey suite ran into this: a backend that replied
   * `null` to `get_boot_status` made `boot.databaseReady` throw a `TypeError`
   * out of the startup path, and every route landed on the generic "Speaking Glass
   * could not finish starting" screen reading "Cannot read properties of null
   * (reading 'databaseReady')".
   *
   * Two defects in one: the shell died on a shape it never checked, and what
   * it told the user named a JavaScript property instead of the problem.
   *
   * Each case installs its own backend with `doMock` rather than leaning on
   * the file-level `vi.mock`: the browser-dev test above calls `doUnmock`,
   * which removes the mapping for the rest of the file, so anything after it
   * that assumed the hoisted mock would silently be talking to the real
   * module — and `isTauriRuntime()` is false there, which is the one answer
   * that makes every assertion here vacuous.
   */
  async function bootStatusFrom(answer: unknown) {
    vi.resetModules();
    vi.doMock('../../../src/control/services/ipc', () => ({
      isTauriRuntime: () => true,
      BackendUnavailableError: class extends Error {},
      ipcInvoke: async () => answer,
    }));
    const { getBootStatus } = await import('../../../src/control/services/recovery');
    const status = await getBootStatus();
    vi.doUnmock('../../../src/control/services/ipc');
    vi.resetModules();
    return status;
  }

  const bad: Array<[string, unknown]> = [
    ['null', null],
    ['a string', 'ready'],
    ['a number', 1],
  ];
  for (const [label, answer] of bad) {
    it(`treats ${label} as "could not determine", not as ready`, async () => {
      const status = await bootStatusFrom(answer);
      expect(status.databaseReady).toBe(false);
      expect(status.code).toBe('DATABASE_UNAVAILABLE');
      // And the message is about the database, not about a property access.
      expect(status.message ?? '').toMatch(/database/i);
      expect(status.message ?? '').not.toMatch(/undefined|null|properties of/i);
    });
  }

  it('does not read a missing flag as a set one', async () => {
    // An object with no `databaseReady` is not a document that says yes.
    const status = await bootStatusFrom({ dataDirectory: '/data' });
    expect(status.databaseReady).toBe(false);
  });

  it('passes a well-formed answer through unchanged', async () => {
    expect(await bootStatusFrom({ databaseReady: true, dataDirectory: '/data' })).toEqual({
      databaseReady: true,
      dataDirectory: '/data',
    });
  });
});
