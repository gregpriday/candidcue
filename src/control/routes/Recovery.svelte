<!--
  The screen the application shows instead of itself when the database did not
  come up.

  The 1.0 readiness review's finding: `database::init` ran inside Tauri's setup
  hook, so `DATABASE_CORRUPT` and a failed migration aborted startup BEFORE a
  webview existed. The two failures most likely to need a human therefore
  removed every in-app recovery action, and in a release build the user got an
  application that vanished with nothing on screen saying why.

  Rust now carries the failure into the running app (`database::BootStatus`),
  the shell asks `get_boot_status` before it routes anywhere, and this renders.

  The ordering of the actions is deliberate. "Save my scripts somewhere else"
  is first because it is the thing a person actually wants at this moment and
  it cannot make anything worse — it reads the canonical Markdown files, which
  are the authority for script content and are not what broke. The destructive
  options come last, and each says where the thing it replaces went.
-->
<script lang="ts">
  import Button from '../components/Button.svelte';
  import * as recovery from '../services/recovery';
  import { describeError } from '../services/errors';

  const { status }: { status: recovery.BootStatusReport } = $props();

  let backups = $state<recovery.DatabaseBackup[]>([]);
  let backupsLoaded = $state(false);
  let busy = $state<string | null>(null);
  let note = $state<string | null>(null);
  let noteKind = $state<'ok' | 'bad'>('ok');

  const headline = $derived(recovery.describeBootFailure(status));

  $effect(() => {
    void (async () => {
      try {
        backups = await recovery.listDatabaseBackups();
      } catch {
        // A backups directory that cannot be listed is not worth its own
        // error state here: the section simply offers nothing, and the other
        // actions — which do not depend on it — still work.
        backups = [];
      } finally {
        backupsLoaded = true;
      }
    })();
  });

  /** One runner, so no action can forget to report its failure. */
  async function run(label: string, action: () => Promise<string | null>): Promise<void> {
    busy = label;
    note = null;
    try {
      const message = await action();
      if (message !== null) {
        note = message;
        noteKind = 'ok';
      }
    } catch (err) {
      note = describeError(err);
      noteKind = 'bad';
    } finally {
      busy = null;
    }
  }

  function megabytes(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<section class="recovery" role="alert" aria-labelledby="recovery-title">
  <h1 id="recovery-title">CandidCue could not open its database</h1>
  <p class="lede">{headline}</p>

  <div class="actions">
    <!--
      First, and a `default` rather than a ghost button: this is the action
      that gets the writing out, and it cannot make anything worse.
    -->
    <Button
      variant="default"
      disabled={busy !== null}
      onclick={() =>
        void run('rescue', async () => {
          const result = await recovery.rescueScripts();
          if (result === null) return null; // cancelled picker
          return `Saved ${result.scriptsCopied} scripts to ${result.path}.`;
        })}
    >
      {busy === 'rescue' ? 'Saving…' : 'Save my scripts somewhere else'}
    </Button>

    <Button
      variant="ghost"
      disabled={busy !== null}
      onclick={() =>
        void run('reveal', async () => {
          await recovery.revealDataFolder();
          return null;
        })}
    >
      Show CandidCue’s data folder
    </Button>
  </div>

  <h2>Restore a backup</h2>
  {#if !backupsLoaded}
    <p class="muted">Looking for backups…</p>
  {:else if backups.length === 0}
    <p class="muted">
      There are no database backups. CandidCue takes one immediately before it upgrades the
      database, so there is nothing here until the first upgrade — rebuilding is the option
      below.
    </p>
  {:else}
    <ul class="backups">
      {#each backups as backup (backup.name)}
        <li class="backup" class:damaged={!backup.verified}>
          <div class="backup-facts">
            <span class="backup-when">{backup.takenAt?.slice(0, 16).replace('T', ' ') ?? backup.name}</span>
            <span class="muted">
              {megabytes(backup.bytes)}
              {#if backup.appVersion}· CandidCue {backup.appVersion}{/if}
              {#if !backup.verified}· failed its integrity check{/if}
            </span>
          </div>
          <Button
            variant="ghost"
            disabled={busy !== null || !backup.verified}
            onclick={() =>
              void run(backup.name, async () => {
                const outcome = await recovery.restoreDatabaseBackup(backup.name);
                return `Restored. The database that was there is at ${outcome.previousStateAt}. Quit and reopen CandidCue.`;
              })}
          >
            {busy === backup.name ? 'Restoring…' : 'Restore this'}
          </Button>
        </li>
      {/each}
    </ul>
  {/if}

  <h2>Rebuild from your script files</h2>
  <p class="muted">
    Your scripts are Markdown files, and those files are the authority for what a script
    says. Rebuilding sets the current database aside and builds a new index from them.
    Session and take history are not rebuilt this way — the old database is kept, not
    deleted, so they are still there if you need them.
  </p>
  <Button
    variant="ghost"
    disabled={busy !== null}
    onclick={() =>
      void run('rebuild', async () => {
        const outcome = await recovery.rebuildDatabaseIndex();
        return `Rebuilt. The previous database is at ${outcome.previousStateAt}. Quit and reopen CandidCue.`;
      })}
  >
    {busy === 'rebuild' ? 'Rebuilding…' : 'Rebuild the index'}
  </Button>

  {#if note !== null}
    <p class="note" class:bad={noteKind === 'bad'} role="status">{note}</p>
  {/if}
</section>

<style>
  .recovery {
    max-width: 46rem;
    margin: 0 auto;
    padding: 3rem 2rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  h1 {
    font-size: 1.5rem;
    margin: 0;
  }

  h2 {
    font-size: 1rem;
    margin: 1.5rem 0 0;
  }

  .lede {
    margin: 0 0 0.5rem;
    line-height: 1.5;
  }

  .muted {
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .backups {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .backup {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
  }

  .backup-facts {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .backup-when {
    font-variant-numeric: tabular-nums;
  }

  .damaged {
    opacity: 0.6;
  }

  .note {
    margin: 0.5rem 0 0;
    line-height: 1.5;
  }

  .bad {
    color: var(--danger-strong, crimson);
  }
</style>
