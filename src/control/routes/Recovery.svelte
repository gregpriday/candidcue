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

  It reads in the order somebody standing in front of it needs answers:

    1. Are my scripts safe? — said first, with the one action that cannot make
       anything worse ("Save a copy of my scripts") right beside it. It reads
       the canonical Markdown files, which are the authority for script content
       and are not what broke.
    2. What happened — one or two sentences per failure code.
    3. What to do — ONE recommended way back for this failure, then the other.
       Restore and rebuild are explained by what each keeps and what each does
       not, because that is the choice a person is actually making; the
       mechanics are not.
    4. Getting help, last.

  A repair ends the screen's job: once one has run, the choices are replaced by
  what to do next (quit and reopen), so a second, conflicting repair cannot be
  started on top of the first.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Button from '../components/Button.svelte';
  import Disclosure from '../components/Disclosure.svelte';
  import Icon from '../components/Icon.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import * as recovery from '../services/recovery';
  import { exportSupportBundle, revealSupportBundle } from '../services/diagnostics';
  import { closeControlWindow, openWebDestination } from '../services/desktop-shell';
  import { describeError, isAppErrorPayload, looksLikeCode } from '../services/errors';
  import { requestConfirm } from '../stores/confirm';
  import { relativeTime } from '../lib/format';
  import { osCopy } from '../lib/os-copy';

  const { status }: { status: recovery.BootStatusReport } = $props();

  type Outcome<T> = ({ ok: true } & T) | { ok: false; message: string };

  let backups = $state<recovery.DatabaseBackup[]>([]);
  /*
   * Three states, not two. A backups folder that could not be listed used to
   * be shown as "there are no backups", which steered the person away from
   * what may well have been their best way back.
   */
  let backupsState = $state<'loading' | 'ready' | 'failed'>('loading');
  let backupsError = $state('');
  let busy = $state<string | null>(null);
  let rescue = $state<Outcome<{ count: number; path: string; namesFile?: string }> | null>(null);
  let help = $state<Outcome<{ path?: string }> | null>(null);
  /** Set once a repair has run: from here the screen only says what to do next. */
  let done = $state<{ kind: 'restore' | 'rebuild'; previousStateAt: string; when: string | null } | null>(
    null,
  );
  /*
   * Set when a repair was refused — and, like `done`, it ends the choosing.
   *
   * A refusal does not say how far the repair got. Restoring sets the current
   * database aside BEFORE it checks the copied backup, so "it failed" can mean
   * nothing moved or that the live database is already in quarantine, and the
   * reply does not say which. Offering the same choices again invited a second
   * repair on top of a first that had half happened. Reopening is always safe:
   * it runs the database start-up again, from whatever is now on disk.
   */
  let halted = $state<{ kind: 'restore' | 'rebuild'; detail: string } | null>(null);
  let quitError = $state<string | null>(null);

  /*
   * Two live regions, both mounted from the start. A region inserted together
   * with its message is announced unreliably; one that is already there and
   * changes its text is not. Progress and success are polite; a failure
   * interrupts.
   */
  let announcement = $state('');
  let alarm = $state('');

  let titleElement = $state<HTMLElement | null>(null);
  let outcomeTitleElement = $state<HTMLElement | null>(null);
  let restoreTitleElement = $state<HTMLElement | null>(null);
  let rescueButton = $state<HTMLButtonElement | null>(null);
  let revealButton = $state<HTMLButtonElement | null>(null);
  let bundleButton = $state<HTMLButtonElement | null>(null);

  /*
   * The platform's words: Finder or File Explorer, and Quit or Exit — the verb
   * on the native menu's own item (`menu.rs`), so every "quit and reopen" here
   * names the command the menu actually shows.
   */
  const os = osCopy();
  const revealLabel = os.revealInFileManager;
  /*
   * Once a repair has run, the headline is what to do next. Left as the
   * failure ("Speaking Glass's database is damaged") it outranked "Ready to
   * rebuild" beneath it, and someone scanning for "am I done?" read the
   * opposite answer first.
   */
  const title = $derived(
    done
      ? 'Reopen Speaking Glass to finish'
      : halted
        ? 'Reopen Speaking Glass before trying again'
        : recovery.bootFailureTitle(status),
  );
  const cause = $derived(recovery.describeBootFailure(status));
  const advice = $derived(recovery.recommendRepair(status, backupsState === 'ready' ? backups : null));
  /** The backup a failed update recommends: the newest one that can be restored. */
  const recommendedBackup = $derived(
    advice === 'restore' ? (backups.find((backup) => backup.verified)?.name ?? null) : null,
  );

  onMount(() => {
    // The screen replaced the app at launch; start a screen reader at its name.
    titleElement?.focus();
    void loadBackups();
  });

  /**
   * `retry` is a person pressing Try again. Its button goes the moment the
   * list starts loading, so focus moves to the section's heading THEN — not
   * when the answer lands, by which time they may be somewhere else.
   */
  async function loadBackups(retry = false): Promise<void> {
    backupsState = 'loading';
    if (retry) {
      void say('Looking for backups…');
      await tick();
      restoreTitleElement?.focus();
    }
    try {
      backups = await recovery.listDatabaseBackups();
      backupsState = 'ready';
      const usable = backups.filter((backup) => backup.verified).length;
      void say(
        backups.length === 0
          ? 'There are no backups to restore.'
          : `Found ${backups.length === 1 ? '1 backup' : `${backups.length} backups`}, ${usable} ready to restore.` +
              (advice === 'restore' ? ' The newest one that’s ready to restore is recommended.' : ''),
      );
    } catch (err) {
      backups = [];
      backupsError = describeError(err);
      backupsState = 'failed';
      void say(`Speaking Glass couldn’t check for backups. ${backupsError}`, true);
    }
  }

  async function say(message: string, urgent = false): Promise<void> {
    // Cleared first, so the same words twice are read twice.
    announcement = '';
    alarm = '';
    await tick();
    if (urgent) alarm = message;
    else announcement = message;
  }

  /**
   * What a refused action tells the person. The recovery commands' own
   * messages are written for the user — the copy-in-place failure names where
   * the previous database went — so they win over the generic sentence for
   * their code, which says nothing was changed: not something this screen can
   * promise once a repair has started moving files.
   */
  function failureText(err: unknown): string {
    const generic = describeError(err);
    if (isAppErrorPayload(err) && typeof err.userMessage === 'string') {
      const own = err.userMessage.trim();
      if (own !== '' && !looksLikeCode(own)) return own;
    }
    return generic;
  }

  /**
   * Put focus back on the button that started a safe action.
   *
   * Each one disables its own button while it runs — and a native picker may
   * take the keyboard away entirely — so whatever happened, focus came back to
   * the document rather than to anything. Only then: focus the person moved
   * somewhere deliberately is left where they put it.
   */
  async function refocus(button: HTMLButtonElement | null): Promise<void> {
    await tick();
    const active = document.activeElement;
    if (active === null || active === document.body) button?.focus();
  }

  // ---- The safe actions: neither changes anything ----

  async function rescueScripts(): Promise<void> {
    busy = 'rescue';
    rescue = null;
    try {
      const result = await recovery.rescueScripts();
      if (result === null) return; // the folder picker was cancelled
      rescue = {
        ok: true,
        count: result.scriptsCopied,
        path: result.path,
        ...(result.namesFile === undefined ? {} : { namesFile: result.namesFile }),
      };
      void say(`Saved a copy of ${scriptCount(result.scriptsCopied)}.`);
    } catch (err) {
      rescue = { ok: false, message: failureText(err) };
      void say(`Your scripts weren’t copied. ${rescue.message}`, true);
    } finally {
      busy = null;
      void refocus(rescueButton);
    }
  }

  async function revealDataFolder(): Promise<void> {
    busy = 'reveal';
    try {
      await recovery.revealDataFolder();
    } catch (err) {
      rescue = { ok: false, message: `The data folder couldn’t be shown. ${failureText(err)}` };
      void say(rescue.message, true);
    } finally {
      busy = null;
      void refocus(revealButton);
    }
  }

  // ---- The repairs: each replaces the database, so each asks first ----

  async function restoreBackup(backup: recovery.DatabaseBackup): Promise<void> {
    const when = backupMoment(backup.takenAt);
    const confirmed = await requestConfirm({
      title: when === null ? 'Restore this backup?' : `Restore the backup from ${when}?`,
      body:
        'Script names, the Trash and reading settings go back to how they were then, and ' +
        'session history after that date isn’t in the backup. Every script keeps the text it ' +
        'has now. Speaking Glass moves its current database into the ' +
        '“quarantine” folder in its data folder rather than deleting it, and the restore ' +
        `finishes when you ${os.quitLower} and reopen Speaking Glass.`,
      confirmLabel: 'Restore backup',
      danger: true,
    });
    if (!confirmed) return;
    await repair('restore', `restore:${backup.name}`, when, () =>
      recovery.restoreDatabaseBackup(backup.name),
    );
  }

  async function rebuildDatabase(): Promise<void> {
    const confirmed = await requestConfirm({
      title: 'Rebuild the database from your script files?',
      body:
        'Speaking Glass moves its current database into the “quarantine” folder in its data folder ' +
        `rather than deleting it, and builds a new one from your script files when you ${os.quitLower} ` +
        'and reopen it. Session history doesn’t come back, and names, the Trash and reading ' +
        'settings come back only where the old database can still be read.',
      confirmLabel: 'Rebuild database',
      danger: true,
    });
    if (!confirmed) return;
    await repair('rebuild', 'rebuild', null, () => recovery.rebuildDatabaseIndex());
  }

  async function repair(
    kind: 'restore' | 'rebuild',
    label: string,
    when: string | null,
    action: () => Promise<recovery.RecoveryOutcome>,
  ): Promise<void> {
    busy = label;
    void say(kind === 'restore' ? 'Restoring the backup…' : 'Setting the database aside…');
    try {
      const outcome = await action();
      done = { kind, previousStateAt: outcome.previousStateAt, when };
      void say(
        kind === 'restore'
          ? `Backup restored. ${os.quit} and reopen Speaking Glass to finish.`
          : `Ready to rebuild. ${os.quit} and reopen Speaking Glass to finish.`,
      );
    } catch (err) {
      halted = { kind, detail: failureText(err) };
      void say(`${haltedTitle(kind)}. ${os.quit} and reopen Speaking Glass before trying again.`, true);
    } finally {
      busy = null;
    }
    await tick();
    outcomeTitleElement?.focus();
  }

  /*
   * "Didn't finish", not "wasn't restored": a restore can be refused AFTER the
   * backup is already in place (the directory sync that follows the rename
   * can fail), and the title must not assert an outcome the reply cannot.
   */
  function haltedTitle(kind: 'restore' | 'rebuild'): string {
    return kind === 'restore' ? 'The restore didn’t finish' : 'The rebuild didn’t finish';
  }

  async function quit(): Promise<void> {
    busy = 'quit';
    quitError = null;
    try {
      await closeControlWindow();
    } catch {
      quitError = os.quitFailed;
      void say(quitError, true);
    } finally {
      busy = null;
    }
  }

  // ---- Getting help ----

  async function exportBundle(): Promise<void> {
    busy = 'bundle';
    help = null;
    try {
      const result = await exportSupportBundle();
      if (result.cancelled) return;
      help = { ok: true, ...(result.path === undefined ? {} : { path: result.path }) };
      void say('Support bundle saved.');
    } catch (err) {
      help = { ok: false, message: `The support bundle couldn’t be saved. ${failureText(err)}` };
      void say(help.message, true);
    } finally {
      busy = null;
      void refocus(bundleButton);
    }
  }

  async function reportProblem(): Promise<void> {
    try {
      await openWebDestination('support');
    } catch (err) {
      help = { ok: false, message: `The problem report page couldn’t be opened. ${failureText(err)}` };
      void say(help.message, true);
    }
  }

  async function revealBundle(): Promise<void> {
    try {
      await revealSupportBundle();
    } catch (err) {
      help = { ok: false, message: `The support bundle couldn’t be shown. ${failureText(err)}` };
      void say(help.message, true);
    }
  }

  // ---- Formatting ----

  /** "18 Oct 2026, 6:13 AM", in the reader's own time zone and conventions. */
  function backupMoment(iso: string | undefined): string | null {
    if (iso === undefined) return null;
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return null;
    return new Date(then).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  /**
   * "2 hours ago", "5 weeks ago". `relativeTime` answers with a date past a
   * month, which beside the date it came from just said the date twice.
   */
  function backupAge(iso: string): string {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return '';
    const days = Math.floor((Date.now() - then) / 86_400_000);
    if (days < 30) return relativeTime(iso);
    if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
    if (days < 365) return `${Math.floor(days / 30)} months ago`;
    const years = Math.floor(days / 365);
    return years === 1 ? 'a year ago' : `${years} years ago`;
  }

  function scriptCount(count: number): string {
    return count === 1 ? '1 script' : `${count.toLocaleString()} scripts`;
  }

  function megabytes(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<main class="recovery" aria-labelledby="recovery-title">
  <div class="column">
    <div class="head">
      <h1 id="recovery-title" tabindex="-1" bind:this={titleElement}>{title}</h1>

      {#if done}
        <!--
          The repair has run, and the database it replaced has moved. From here
          the only correct action is to quit and reopen, which is what re-runs
          `database::init` — so that is all this offers, and it leads the page.
          Leaving the choices up invited a restore and then a rebuild on top.
        -->
        <section class="callout outcome" aria-labelledby="outcome-title">
          <span class="callout-mark" aria-hidden="true"><Icon name="check" size={18} /></span>
          <div class="callout-body">
            <h2 id="outcome-title" class="outcome-title" tabindex="-1" bind:this={outcomeTitleElement}>
              {done.kind === 'restore' ? 'Backup restored' : 'Ready to rebuild'}
            </h2>
            <p class="outcome-text">
              {os.quit} and reopen Speaking Glass to finish.
              {#if done.kind === 'restore'}
                It opens with the backup{#if done.when !== null}&#32;from <span class="moment"
                    >{done.when}</span
                  >{/if}, and every script keeps the text it has now.
              {:else}
                As it opens, it builds a new database from your script files.
              {/if}
            </p>
            <p class="outcome-aside">Your previous database is kept here, in case you need it:</p>
            <code class="path">{done.previousStateAt}</code>
            {@render quitAction()}
          </div>
        </section>
      {:else if halted}
        <!--
          Refused, and the screen cannot tell how far it got (see `halted`), so
          it stops offering repairs and says the one thing that is always safe.
          What the command said is kept, beneath, for anyone who asks for help.
        -->
        <section class="callout outcome refused" aria-labelledby="outcome-title">
          <span class="callout-mark" aria-hidden="true"><Icon name="alert" size={18} /></span>
          <div class="callout-body">
            <h2 id="outcome-title" class="outcome-title" tabindex="-1" bind:this={outcomeTitleElement}>
              {haltedTitle(halted.kind)}
            </h2>
            <!--
              What reopening does, every way it can have stopped. A backup
              already renamed into place simply opens. A database moved aside
              with nothing put back is exactly the state a rebuild leaves
              (`database::init` creates a new one and reconciliation adopts the
              script folders with the names salvaged from the old one). One that
              never moved fails again and brings this screen back.
            -->
            <p class="outcome-text">
              {#if halted.kind === 'restore'}
                This screen can’t tell how far the restore got, so it won’t start another repair
                now. Reopening carries on from wherever it stopped: with the backup, if it was
                already in place; with a new database built from your script files, as a rebuild
                does, if only the old one had been set aside; or back on this screen, if nothing
                had moved.
              {:else}
                This screen can’t tell how far the rebuild got, so it won’t start another repair
                now. Reopening either finishes it, building a new database from your script files,
                or brings this screen back so you can choose again.
              {/if}
            </p>
            <p class="outcome-aside">
              Nothing is ever deleted: anything Speaking Glass set aside is in the “quarantine” folder
              inside its data folder.
            </p>
            <p class="outcome-detail">Details: {halted.detail}</p>
            {@render quitAction()}
          </div>
        </section>
      {/if}

      <!--
        SAY WHAT IS SAFE, FIRST.

        The title states the condition; this states the consequence, which is
        the thing somebody standing in front of this screen actually needs.
        Without it the screen reads as "your scripts may be gone", and saving a
        copy reads as salvage rather than as a precaution.
      -->
      <div class="callout safety">
        <span class="callout-mark" aria-hidden="true"><Icon name="check" size={18} /></span>
        <div class="callout-body">
          <p class="safety-title">Your scripts are safe</p>
          <p class="safety-text">
            Each one is a Markdown file in Speaking Glass’s data folder, kept apart from the database,
            and nothing on this screen changes them.
          </p>
          {#if status.dataDirectory}
            <!-- Selectable: the one thing somebody does with a path is copy it. -->
            <code class="path">{status.dataDirectory}</code>
          {/if}
          <div class="actions">
            <Button
              variant="default"
              bind:element={rescueButton}
              disabled={busy !== null}
              onclick={() => void rescueScripts()}
            >
              {busy === 'rescue' ? 'Saving…' : 'Save a copy of my scripts…'}
            </Button>
            <Button
              variant="ghost"
              bind:element={revealButton}
              disabled={busy !== null}
              onclick={() => void revealDataFolder()}
            >
              {revealLabel}
            </Button>
          </div>
          {#if rescue}
            <div class="result" class:bad={!rescue.ok}>
              {@render mark(rescue.ok)}
              <div class="result-body">
                {#if rescue.ok}
                  <p class="result-title">Saved a copy of {scriptCount(rescue.count)}</p>
                  <code class="path">{rescue.path}</code>
                  {#if rescue.namesFile}
                    <p>“{rescue.namesFile}” in that folder says which script is which.</p>
                  {/if}
                {:else}
                  <p>{rescue.message}</p>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>

    {#if !done && !halted}
      <section class="next" aria-labelledby="next-title" aria-busy={busy !== null && busy !== 'rescue'}>
        <h2 id="next-title" class="sr-only">What to do</h2>
        <p class="cause">{cause}</p>

        {#if advice === 'reopen'}
          {@render reopen()}
          <Disclosure label="Other ways back">
            <div class="others">
              {@render restoreOption()}
              {@render rebuildOption(false)}
            </div>
          </Disclosure>
        {:else if advice === 'rebuild'}
          {@render rebuildOption(true)}
          {@render restoreOption()}
        {:else}
          {@render restoreOption()}
          {@render rebuildOption(false)}
        {/if}
      </section>
    {/if}

    <section class="help" aria-labelledby="help-title">
      <h2 id="help-title" class="help-title">Get help</h2>
      <p class="help-text">
        If none of this works, report the problem and attach a support bundle: Speaking Glass’s logs
        and diagnostics, designed to leave out your scripts. Read it before you send it.
      </p>
      <div class="help-actions">
        <Button
          variant="default"
          bind:element={bundleButton}
          disabled={busy !== null}
          onclick={() => void exportBundle()}
        >
          {busy === 'bundle' ? 'Exporting…' : 'Export support bundle…'}
        </Button>
        <Button variant="ghost" disabled={busy !== null} onclick={() => void reportProblem()}>
          Report a problem
        </Button>
      </div>
      {#if help}
        <div class="result" class:bad={!help.ok}>
          {@render mark(help.ok)}
          <div class="result-body">
            {#if help.ok}
              <p class="result-title">Support bundle saved</p>
              {#if help.path}<code class="path">{help.path}</code>{/if}
              <div class="result-actions">
                <Button variant="ghost" size="sm" onclick={() => void revealBundle()}>{revealLabel}</Button>
              </div>
            {:else}
              <p>{help.message}</p>
            {/if}
          </div>
        </div>
      {/if}
    </section>
  </div>

  <p class="sr-only" role="status">{announcement}</p>
  <p class="sr-only" aria-live="assertive" aria-atomic="true">{alarm}</p>
</main>

{#snippet quitAction()}
  <div class="actions">
    <Button variant="primary" disabled={busy !== null} onclick={() => void quit()}>{os.quit} Speaking Glass</Button>
  </div>
  {#if quitError}
    <div class="result bad">
      {@render mark(false)}
      <div class="result-body"><p>{quitError}</p></div>
    </div>
  {/if}
{/snippet}

{#snippet reopen()}
  <div class="option">
    <div class="option-head">
      <h3 class="option-title">
        {status.code === 'DATABASE_BACKUP_REQUIRED' ? 'Make room, then reopen' : 'Try reopening'}
      </h3>
      <StatusPill tone="accent" label="Recommended" size="sm" dot={false} />
    </div>
    <p class="option-text">
      {#if status.code === 'DATABASE_BACKUP_REQUIRED'}
        Free up some space on this computer’s disk, or check that Speaking Glass is allowed to write
        to its data folder. Then {os.quitLower} and reopen Speaking Glass, and it tries the update again.
      {:else}
        {os.quit} and reopen Speaking Glass — a problem like this can be a one-off. If this screen comes
        back, export a support bundle below and report the problem.
      {/if}
    </p>
    {@render quitAction()}
  </div>
{/snippet}

<!--
  No "Recommended" on this heading even when restoring is the advice: it goes
  on the one backup to restore, and saying it twice made two things compete
  for the same word.
-->
{#snippet restoreOption()}
  <div class="option">
    <div class="option-head">
      <h3 class="option-title" tabindex="-1" bind:this={restoreTitleElement}>Restore a backup</h3>
    </div>
    {#if backupsState === 'ready' && backups.length === 0}
      <!-- Says when backups are made, without guessing why this person has none. -->
      <p class="option-text">
        There are no backups to restore. Speaking Glass saves one just before each update changes its
        database.
      </p>
    {:else}
      <p class="option-text">
        Speaking Glass saves a backup of its database just before each update changes it. Restoring
        one puts the database back the way it was then.
      </p>
      <dl class="outcomes">
        <dt>Stays as it is</dt>
        <dd>Every script’s text — it isn’t in the backup.</dd>
        <dt>Goes back to that date</dt>
        <dd>Script names, the Trash and reading settings.</dd>
        <dt>Not in the backup</dt>
        <dd>Session history after that date.</dd>
      </dl>
    {/if}

    {#if backupsState === 'loading'}
      <div class="backups">
        <div class="list-note">
          <span class="note-mark pending" aria-hidden="true"><Icon name="clock" size={16} /></span>
          <p>Looking for backups…</p>
        </div>
      </div>
    {:else if backupsState === 'failed'}
      <div class="backups">
        <div class="list-note failed">
          {@render mark(false)}
          <p>Speaking Glass couldn’t check for backups. {backupsError}</p>
          <Button size="sm" disabled={busy !== null} onclick={() => void loadBackups(true)}>
            Try again
          </Button>
        </div>
      </div>
    {:else if backups.length > 0}
      <ul class="backups" aria-label="Backups, newest first">
        {#each backups as backup (backup.name)}
          {@const when = backupMoment(backup.takenAt)}
          {@const id = `backup-${backup.name.replace(/[^a-z0-9]+/gi, '-')}`}
          {@const isRecommended = backup.name === recommendedBackup}
          <li class="backup" class:damaged={!backup.verified}>
            <!--
              Verified state as an ICON AND WORDS, never opacity alone (§9.4).
              A dimmed row says "this is less important"; it does not say "this
              backup is damaged and cannot be restored", which is the one thing
              somebody choosing between backups has to know.
            -->
            <span class="backup-mark" class:bad={!backup.verified} aria-hidden="true">
              <Icon name={backup.verified ? 'check' : 'alert'} size={16} />
            </span>
            <div class="backup-facts" {id}>
              <span class="backup-when">
                <span class="backup-moment">{when ?? 'Date not recorded'}</span>
                {#if when !== null}<span class="backup-age">{backupAge(backup.takenAt ?? '')}</span>{/if}
                {#if isRecommended}<StatusPill tone="accent" label="Recommended" size="sm" dot={false} />{/if}
              </span>
              <span class="backup-meta">
                {#if backup.verified}
                  Ready to restore · {backup.appVersion
                    ? `saved just before the update to Speaking Glass ${backup.appVersion}`
                    : 'saved just before an update'}
                {:else}
                  Damaged, so it can’t be restored
                {/if}
                · {megabytes(backup.bytes)}
                {#if when === null}· <code class="backup-file">{backup.name}</code>{/if}
              </span>
            </div>
            <Button
              variant={isRecommended ? 'primary' : 'default'}
              size="sm"
              describedby={id}
              disabled={busy !== null || !backup.verified}
              onclick={() => void restoreBackup(backup)}
            >
              {busy === `restore:${backup.name}` ? 'Restoring…' : 'Restore…'}
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/snippet}

{#snippet rebuildOption(recommended: boolean)}
  <div class="option">
    <div class="option-head">
      <h3 class="option-title">Rebuild from your script files</h3>
      {#if recommended}<StatusPill tone="accent" label="Recommended" size="sm" dot={false} />{/if}
    </div>
    <p class="option-text">
      Your script files are the authority for what each script says, so Speaking Glass can build a new
      database from them.
    </p>
    <dl class="outcomes">
      <dt>Comes back</dt>
      <dd>Every script’s text, with the saved versions and images that are intact.</dd>
      <dt>Comes back where it can</dt>
      <dd>
        Names, the Trash and reading settings, read out of the old database
        where it can still be read. Where it can’t, a script is named after its first line and
        comes back out of the Trash if it was in it.
      </dd>
      <dt>Doesn’t come back</dt>
      <dd>Session history, and why each saved version was saved — versions keep their dates.</dd>
    </dl>
    <div class="actions">
      <Button
        variant={recommended ? 'primary' : 'default'}
        disabled={busy !== null}
        onclick={() => void rebuildDatabase()}
      >
        {busy === 'rebuild' ? 'Setting it aside…' : 'Rebuild from script files…'}
      </Button>
    </div>
  </div>
{/snippet}

{#snippet mark(ok: boolean)}
  <span class="note-mark" aria-hidden="true"><Icon name={ok ? 'check' : 'alert'} size={16} /></span>
{/snippet}

<style>
  /*
   * A SYSTEM UTILITY, not an editorial page (§17.1), and every value comes from
   * the token scale. Two colours here once named tokens that do not exist, and
   * the backup rows rendered with no border and no background at all.
   *
   * The scroller is the whole window and the column sits inside it. The column
   * used to BE the scroller — a fixed-height flex column — so instead of the
   * page scrolling, its children shrank: the backup list was squeezed to a row
   * and a half and clipped its own options, with nothing to say it scrolled.
   */
  .recovery {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
  }

  .column {
    max-width: 720px;
    margin: 0 auto;
    padding: var(--space-9) var(--page-x-wide) var(--space-10);
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
  }
  /* Below the traffic lights and the drag strip, under an overlay titlebar. */
  :global(html[data-titlebar='overlay']) .column {
    padding-top: calc(var(--toolbar-h) + var(--space-4));
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  h1 {
    margin: 0;
    font-size: var(--text-page-title);
    line-height: var(--lh-page-title);
    font-weight: 650;
    letter-spacing: var(--ls-title);
  }
  /* Focused so a screen reader starts here; not a control, so no ring. */
  h1:focus,
  .outcome-title:focus,
  .option-title:focus {
    outline: none;
  }

  p {
    margin: 0;
  }

  .actions,
  .help-actions,
  .result-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  /* A path: monospace, selectable, and allowed to break anywhere. */
  .path {
    display: block;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
    overflow-wrap: anywhere;
    user-select: text;
  }

  /*
   * The three cards — what is safe, a repair that finished, a repair that was
   * refused — share one set of measurements, so stacked together their marks
   * and their text sit on the same two vertical lines.
   */
  .callout {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5) var(--space-5) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
  }
  /*
   * Each mark is as tall as the first line beside it and centred in it, so it
   * sits on that line at any type size without an optical nudge.
   */
  .callout-mark {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    height: var(--lh-label);
    color: var(--success);
  }
  .outcome .callout-mark {
    height: var(--lh-section);
  }
  .callout-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }
  .callout .actions {
    margin-top: var(--space-2);
  }

  /* ---- What is safe, stated where it is read first ---- */
  .safety {
    border-color: var(--success);
    background: var(--success-soft);
  }
  .safety-title {
    font-size: var(--text-base);
    line-height: var(--lh-label);
    font-weight: 650;
  }
  .safety-text {
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    max-width: var(--prose-measure);
  }

  /* ---- A repair that ran, or was refused: what to do next ---- */
  .outcome-title {
    margin: 0;
    font-size: var(--text-section);
    line-height: var(--lh-section);
    font-weight: 600;
  }
  .outcome-text {
    font-size: var(--text-base);
    line-height: var(--lh-body);
    max-width: var(--prose-measure);
  }
  .outcome-aside {
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    max-width: var(--prose-measure);
  }
  .outcome-detail {
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    overflow-wrap: anywhere;
    user-select: text;
  }
  .refused {
    border-color: var(--danger);
    background: var(--danger-soft);
  }
  .refused .callout-mark {
    color: var(--danger);
  }

  /* ---- What happened, and what to do ---- */
  .next {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .cause {
    font-size: var(--text-base);
    line-height: var(--lh-body);
    max-width: var(--prose-measure);
  }

  .option {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  /* The other way back sits under a divider, so the recommended one leads. */
  .option + .option {
    padding-top: var(--space-6);
    border-top: 1px solid var(--divider);
  }

  .option-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }
  .option-title,
  .help-title {
    margin: 0;
    font-size: var(--text-section);
    line-height: var(--lh-section);
    font-weight: 600;
  }
  .option-text,
  .help-text {
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    max-width: var(--prose-measure);
  }

  /*
   * What each repair keeps and what it does not: the choice, side by side. One
   * fixed first column for both lists, so the two read as one comparison
   * rather than two tables that happen to be near each other.
   */
  .outcomes {
    display: grid;
    grid-template-columns: 13rem 1fr;
    gap: var(--space-2) var(--space-4);
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    max-width: var(--prose-measure);
  }
  .outcomes dt {
    color: var(--text-muted);
    font-weight: 600;
  }
  .outcomes dd {
    margin: 0;
  }
  @media (max-width: 600px) {
    .outcomes {
      grid-template-columns: 1fr;
      gap: 0;
    }
    .outcomes dd + dt {
      margin-top: var(--space-2);
    }
  }

  /* ---- The backups: dense rows on one continuous surface ---- */
  .backups {
    list-style: none;
    margin: var(--space-1) 0 0;
    padding: 0;
    border: 1px solid var(--border-faint);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
  }

  .backup,
  .list-note {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--list-row-h);
    padding: var(--space-3) var(--space-4);
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
    gap: 0;
    min-width: 0;
    flex: 1 1 auto;
  }

  .backup-when {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-2);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
  }
  .backup-moment {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .backup-age {
    color: var(--text-muted);
  }
  .backup-meta {
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }
  .backup-file {
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
  /* No opacity dimming — the icon and the words carry the state (§9.4). */
  .damaged .backup-moment {
    color: var(--text-secondary);
  }

  .list-note {
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-muted);
  }
  .list-note.failed {
    color: var(--text-primary);
  }
  .list-note.failed p {
    flex: 1 1 auto;
  }

  /* ---- Results: icon and words, next to the action that produced them ---- */
  .result {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
  }
  .result-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .result-title {
    font-weight: 600;
  }
  .note-mark {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    height: var(--lh-label);
    color: var(--success);
  }
  .bad .note-mark,
  .list-note.failed .note-mark {
    color: var(--danger);
  }
  .note-mark.pending {
    color: var(--text-muted);
  }

  /* A date is read as one thing; it does not break across a line. */
  .moment {
    white-space: nowrap;
  }

  /* The alternatives behind "Other ways back", spaced as they are above it. */
  .others {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  /* ---- Help, last ---- */
  .help {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-top: var(--space-6);
    border-top: 1px solid var(--divider);
  }
  .help-title {
    font-size: var(--text-base);
    line-height: var(--lh-label);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>
