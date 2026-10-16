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
  import Icon from '../components/Icon.svelte';
  import * as recovery from '../services/recovery';
  import { exportSupportBundle } from '../services/diagnostics';
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
  <header class="head">
    <h1 id="recovery-title">CandidCue could not open its database</h1>
    <p class="lede">{headline}</p>
    <!--
      SAY WHAT IS SAFE, FIRST (§17.1).

      The lede above states the condition. This states the consequence, which is
      the thing somebody standing in front of this screen actually needs: their
      writing is Markdown on disk and is not what broke. Without it the screen
      reads as "your scripts may be gone", and the first action offered is a
      button that says "save my scripts somewhere else" — which sounds like
      salvage rather than a precaution.
    -->
    <p class="safety">
      <Icon name="check" size={15} />
      <span>
        Your scripts are Markdown files on this machine and are not affected. What did not
        open is the index CandidCue keeps beside them.
      </span>
    </p>
  </header>

  <!--
    The safe actions, ruled off from the ones that replace something (§17.1).
    Neither of these changes anything: one copies the scripts out, one opens a
    folder.
  -->
  <div class="actions">
    <Button
      variant="default"
      disabled={busy !== null}
      onclick={() =>
        void run('rescue', async () => {
          const result = await recovery.rescueScripts();
          if (result === null) return null; // cancelled picker
          const names =
            result.namesFile === undefined ? '' : ` ${result.namesFile} there lists them by name.`;
          return `Saved ${result.scriptsCopied} scripts to ${result.path}.${names}`;
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

    <!--
      §17.1: offer the support bundle from the same surface. A boot that failed
      here is exactly the report worth sending, and the screen it otherwise
      points at — Settings › Diagnostics — is on the other side of an
      application that will not start.
    -->
    <Button
      variant="ghost"
      disabled={busy !== null}
      onclick={() =>
        void run('bundle', async () => {
          const result = await exportSupportBundle();
          if (result.cancelled) return null;
          return result.path === undefined
            ? 'Support bundle saved.'
            : `Support bundle saved to ${result.path}.`;
        })}
    >
      {busy === 'bundle' ? 'Exporting…' : 'Export support bundle'}
    </Button>
  </div>

  {#if status.dataDirectory}
    <!-- Where it all is, in plain sight beside the button that opens it. -->
    <p class="path">
      <span class="path-label">Data folder</span>
      <code class="path-value">{status.dataDirectory}</code>
    </p>
  {/if}

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
          <!--
            Verified state as an ICON AND WORDS, never opacity alone (§17.1,
            §9.4). A dimmed row says "this is less important"; it does not say
            "this backup failed its integrity check and cannot be restored",
            which is the one thing somebody choosing between backups has to
            know.
          -->
          <span class="backup-mark" class:bad={!backup.verified} aria-hidden="true">
            <Icon name={backup.verified ? 'check' : 'alert'} size={14} />
          </span>
          <div class="backup-facts">
            <span class="backup-when">{backup.takenAt?.slice(0, 16).replace('T', ' ') ?? backup.name}</span>
            <span class="muted">
              {backup.verified ? 'Verified' : 'Failed its integrity check'}
              · {megabytes(backup.bytes)}
              {#if backup.appVersion}· CandidCue {backup.appVersion}{/if}
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
    says. Rebuilding sets the current database aside and, when you reopen CandidCue, builds
    a new index from them — their text, and the saved versions and images that are intact.
    Names, the Trash and each script's reading settings are only in the database, so they
    are read back out of the old one where it can still be read; a script it cannot name is
    named after its first line, and comes back out of the Trash if it was in it. Saved
    versions keep their dates but not why they were saved. Session and take history are not
    rebuilt this way — the old database is kept, not deleted, so they are still there if you
    need them.
  </p>
  <Button
    variant="ghost"
    disabled={busy !== null}
    onclick={() =>
      void run('rebuild', async () => {
        const outcome = await recovery.rebuildDatabaseIndex();
        return `Ready to rebuild. The previous database is at ${outcome.previousStateAt}. Quit and reopen CandidCue to finish.`;
      })}
  >
    {busy === 'rebuild' ? 'Rebuilding…' : 'Rebuild the index'}
  </Button>

  {#if note !== null}
    <p class="note" class:bad={noteKind === 'bad'} role="status">{note}</p>
  {/if}
</section>

<style>
  /*
   * A SYSTEM UTILITY, not an editorial page (§17.1).
   *
   * This was rem-based and hand-sized, and two of its colours — `--border-subtle`
   * and `--surface-raised` — DO NOT EXIST in `tokens.css`, so the backup rows
   * had been rendering with no border and no background at all since they were
   * written. Everything here now goes through the token scale, which is also
   * what makes the invented names impossible: a token that is not in the file
   * is one nobody can spell by accident twice.
   */
  .recovery {
    max-width: 720px;
    margin: 0 auto;
    padding: var(--space-9) var(--page-x-wide) var(--space-10);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    overflow-y: auto;
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-bottom: var(--space-2);
  }

  h1 {
    font-size: var(--text-2xl);
    font-weight: 650;
    letter-spacing: var(--ls-title);
    margin: 0;
  }

  h2 {
    font-size: var(--text-sm);
    font-weight: 650;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-muted);
    margin: var(--space-6) 0 0;
  }

  .lede {
    margin: 0;
    line-height: var(--lh-body);
    color: var(--text-primary);
  }

  /* What is safe, stated where it is read first. */
  .safety {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: var(--space-1) 0 0;
    padding: var(--space-3);
    border: 1px solid var(--success);
    border-radius: var(--radius-sm);
    background: var(--success-soft);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-primary);
  }
  .safety :global(svg) {
    flex: 0 0 auto;
    margin-top: 2px;
    color: var(--success);
  }

  .muted {
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  /* The data folder, named beside the button that opens it (§17.1). */
  .path {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    min-width: 0;
  }
  .path-label {
    flex: 0 0 auto;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .path-value {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    /* Selectable: the one thing somebody does with a path is copy it. */
    user-select: text;
  }

  /* Dense rows on one continuous surface, like every other list in the app. */
  .backups {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-faint);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    overflow: hidden;
  }

  .backup {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
  }
  .backup + .backup {
    border-top: 1px solid var(--border-faint);
  }

  .backup-mark {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--success);
  }
  .backup-mark.bad {
    color: var(--warning);
  }

  .backup-facts {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .backup-when {
    font-size: var(--text-sm);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  /* No opacity dimming — the icon and the words carry the state (§9.4). */
  .damaged .backup-when {
    color: var(--text-secondary);
  }

  .note {
    margin: var(--space-3) 0 0;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
  }

  .note.bad {
    border-color: var(--danger);
    background: var(--danger-soft);
    color: var(--text-primary);
  }
</style>
