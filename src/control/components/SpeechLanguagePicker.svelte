<!--
  §153: pick a language, and fetch the model that serves it.

  ONE component for two screens. Welcome asks the question at first run and
  Settings changes the answer afterwards, but the state machine underneath is
  identical — progress, verification, unpacking, cancel, failure, retry — and
  Welcome's own comment already warned that running it from two screens means
  two copies of that logic drifting apart. `compact` is the only difference:
  Welcome hides the disk inventory, because reclaiming space is not a first-run
  concern.

  WHAT THIS SHOWS BEFORE ANYTHING DOWNLOADS
  -----------------------------------------
  The transfer size, the size on disk, and the host the bytes come from. All
  three are named by §153 as things worth knowing on a metered connection, and
  all three come from Rust rather than being restated here — the origin in
  particular is derived from the function the downloader itself uses, so this
  cannot name a host the download does not contact.

  The licence is shown and never gated on. §153 is explicit that attribution is
  an obligation the app carries, not a decision to put in front of the user, so
  there is no accept step and no checkbox anywhere in this flow.

  WHY THE STATE IS KEYED BY MODEL
  -------------------------------
  A snapshot request and the event stream race: a status call can be issued
  while an install is validating, the install can finish and emit its terminal
  event, and the older reply can then land on top and strand the panel on a
  phase that is over. Settings solved that for ONE model with a counter.

  Generalising that counter to a single global one would be wrong in a new way:
  a progress event for model A would discard a perfectly good snapshot for model
  B. So every map here is keyed by model id, and reconciliation compares only
  the count for the model whose status came back.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import Select from './Select.svelte';
  import StatusPill from './StatusPill.svelte';
  import { describeError } from '../services/errors';
  import {
    cancelSpeechModelDownload,
    deleteSpeechModel,
    formatBytes,
    getSpeechLanguageOptions,
    isBusy as isModelBusy,
    languageDisplayName,
    onSpeechModelProgress,
    phaseLabel,
    progressFraction,
    selectSpeechLanguage,
    startSpeechModelDownload,
    type SpeechLanguageOption,
    type SpeechLanguageOptions,
    type SpeechModelStatus,
  } from '../services/speech-models';

  interface Props {
    /** Welcome's form: no disk inventory, tighter copy. */
    compact?: boolean;
    /**
     * The settings revision to write against. Owned by the caller because the
     * settings document is, and a second copy held here could go stale against
     * the store the rest of the screen renders from.
     */
    revision: number;
    /** Told when a language is committed, so the caller can refresh settings. */
    onlanguagechange?: () => void;
  }

  let { compact = false, revision, onlanguagechange }: Props = $props();

  let options = $state<SpeechLanguageOptions | null>(null);
  /** Per model, so one model's event cannot invalidate another's snapshot. */
  let statusByModel = $state<Record<string, SpeechModelStatus>>({});
  let eventCountByModel = $state<Record<string, number>>({});
  let busyByModel = $state<Record<string, boolean>>({});
  let errorByModel = $state<Record<string, string | null>>({});
  let confirmingDelete = $state<string | null>(null);
  /** The row the user is looking at. Selecting one downloads nothing. */
  let highlighted = $state<string | null>(null);
  let selecting = $state(false);
  let selectError = $state<string | null>(null);

  const languages = $derived(options?.languages ?? []);
  const changeBlocked = $derived(options?.changeBlocked ?? false);

  /**
   * The row being looked at, defaulting to the active one.
   *
   * Falls back to the first offer so the panel is never blank: a build whose
   * persisted language is no longer offered still has to show the user
   * something they can act on.
   */
  const shown = $derived<SpeechLanguageOption | null>(
    languages.find((option) => option.languageTag === highlighted) ??
      languages.find((option) => option.active) ??
      languages[0] ??
      null,
  );

  /** Rust's snapshot, overlaid with anything newer the event stream carried. */
  function statusOf(option: SpeechLanguageOption): SpeechModelStatus {
    return statusByModel[option.modelId] ?? option.status;
  }

  const shownStatus = $derived(shown ? statusOf(shown) : null);
  const shownBusy = $derived(isModelBusy(shownStatus));
  const shownFraction = $derived(progressFraction(shownStatus));

  /**
   * Whether committing to the shown language is possible right now.
   *
   * Every clause is a different refusal Rust would issue, mirrored here so the
   * button is disabled rather than clicked into an error. Rust re-checks all of
   * them — this is courtesy, not enforcement.
   */
  const canActivate = $derived(
    shown !== null &&
      !shown.active &&
      !changeBlocked &&
      !selecting &&
      (shownStatus?.installed ?? false),
  );

  function pillFor(option: SpeechLanguageOption): { tone: 'success' | 'neutral' | 'warning'; label: string } {
    const status = statusOf(option);
    if (isModelBusy(status)) return { tone: 'neutral', label: phaseLabel(status) };
    if (option.active) return { tone: 'success', label: status.installed ? 'Active' : 'Needs download' };
    if (status.installed) return { tone: 'neutral', label: 'Installed' };
    return { tone: 'warning', label: 'Not downloaded' };
  }

  /**
   * Re-read everything, discarding any model whose status moved meanwhile.
   *
   * The comparison is PER MODEL: a snapshot for English is still good even if a
   * progress event for another model landed while it was in flight.
   */
  async function refresh(): Promise<void> {
    const seen = { ...eventCountByModel };
    try {
      const next = await getSpeechLanguageOptions();
      options = next;
      const merged: Record<string, SpeechModelStatus> = { ...statusByModel };
      for (const row of [...next.languages.map((l) => l.status), ...next.removable]) {
        if ((eventCountByModel[row.modelId] ?? 0) === (seen[row.modelId] ?? 0)) {
          merged[row.modelId] = row;
        }
      }
      statusByModel = merged;
    } catch {
      // Leave whatever was last known rather than blanking the panel: an IPC
      // hiccup is not evidence that the language list changed.
    }
  }

  /**
   * Subscribed FIRST, then reconciled with a snapshot.
   *
   * The other order loses the terminal event when the screen opens during the
   * last seconds of an install: the snapshot catches `validating`, the install
   * finishes before the listener attaches, and nothing ever arrives to move the
   * panel off it.
   */
  $effect(() => {
    let stop: (() => void) | null = null;
    let disposed = false;
    onSpeechModelProgress((status) => {
      if (disposed) return;
      // Reassigned rather than mutated: Svelte tracks the record, not its keys.
      eventCountByModel = {
        ...eventCountByModel,
        [status.modelId]: (eventCountByModel[status.modelId] ?? 0) + 1,
      };
      statusByModel = { ...statusByModel, [status.modelId]: status };
    })
      .then((unlisten) => {
        // Awaiting the listener can outlive the effect if the screen is left
        // immediately; without this the subscription leaks.
        if (disposed) unlisten();
        else stop = unlisten;
      })
      // An event bus that will not open is not worth an unhandled rejection.
      // The panel still works — it just will not live-update.
      .catch(() => {})
      .finally(() => {
        if (!disposed) void refresh();
      });
    return () => {
      disposed = true;
      stop?.();
    };
  });

  async function runModelAction(
    modelId: string,
    action: (id: string) => Promise<SpeechModelStatus>,
  ): Promise<void> {
    busyByModel = { ...busyByModel, [modelId]: true };
    errorByModel = { ...errorByModel, [modelId]: null };
    try {
      const status = await action(modelId);
      statusByModel = { ...statusByModel, [modelId]: status };
    } catch (err) {
      // Tauri rejects with a serialized AppError OBJECT, not an Error, so
      // `String(err)` renders "[object Object]".
      errorByModel = { ...errorByModel, [modelId]: describeError(err) };
    } finally {
      busyByModel = { ...busyByModel, [modelId]: false };
    }
    await refresh();
  }

  async function activate(option: SpeechLanguageOption): Promise<void> {
    selecting = true;
    selectError = null;
    try {
      await selectSpeechLanguage(revision, option.languageTag);
      onlanguagechange?.();
    } catch (err) {
      selectError = describeError(err);
    } finally {
      selecting = false;
    }
    await refresh();
  }

  /** "github.com" — or "mirror.example, then github.com" once one is stood up. */
  function originLine(option: SpeechLanguageOption): string {
    const hosts = option.origins.map((origin) => origin.host);
    const last = hosts.at(-1);
    if (last === undefined) return 'an unnamed host';
    const earlier = hosts.slice(0, -1);
    return earlier.length === 0 ? last : `${earlier.join(', ')}, then ${last}`;
  }
</script>

<div class="picker" class:compact>
  {#if options === null}
    <p class="hint-line" role="status" aria-live="polite">Checking which languages are available…</p>
  {:else if languages.length === 0}
    <!--
      Reachable only from a build whose catalogue and recogniser tables
      disagree. Says what is wrong rather than showing an empty dropdown.
    -->
    <p class="inline-alert" role="alert">
      This version of CandidCue has no speech languages available. Voice following cannot run;
      everything else works.
    </p>
  {:else}
    <div class="language-row">
      <Select
        label="Language"
        value={shown?.languageTag ?? ''}
        options={languages.map((option) => ({
          value: option.languageTag,
          label: languageDisplayName(option.languageTag),
        }))}
        onchange={(value) => {
          // Looking is not choosing. Changing this starts no download and saves
          // no setting — §153 wants the sizes seen before anything happens.
          highlighted = value;
          confirmingDelete = null;
          selectError = null;
        }}
      />
      {#if shown}
        {@const pill = pillFor(shown)}
        <StatusPill tone={pill.tone} label={pill.label} />
      {/if}
    </div>

    {#if shown}
      {@const status = statusOf(shown)}
      {@const busy = isModelBusy(status)}
      {@const fraction = progressFraction(status)}
      {@const name = languageDisplayName(shown.languageTag)}

      <!--
        The three facts §153 asks for, before any button that spends bandwidth.
        Shown whatever the state, because "how much disk is this using?" is as
        real a question as "how much will this cost me to fetch?".
      -->
      <p class="hint-line">
        {formatBytes(status.downloadBytes)} to download, {formatBytes(status.installedBytes)} on
        disk. From {originLine(shown)}.
      </p>

      {#if busy}
        <p class="hint-line" role="status" aria-live="polite">
          {phaseLabel(status)}
          {#if fraction !== null}
            — {formatBytes(status.progressBytes)} of {formatBytes(status.progressTotal)}
          {/if}
        </p>
        <!-- Determinate only while there is a real fraction: `installing` and
             `validating` measure nothing, and a bar snapping back to empty
             there reads as a restart. -->
        <progress
          class="model-progress"
          max="1"
          value={fraction ?? undefined}
          aria-label="{name} speech model install progress"
        ></progress>
        <div class="actions">
          <Button variant="default" onclick={() => void runModelAction(shown.modelId, cancelSpeechModelDownload)}>
            Stop
          </Button>
        </div>
      {:else if !status.installed}
        <!--
          §153: a model the app expects and cannot find must fail somewhere the
          user can act on it. This is that screen, and this is that state.
        -->
        {#if shown.active}
          <p class="inline-alert" role="alert">
            {name} is selected, but its speech data is not on this machine. Voice following cannot
            run until it is downloaded.
          </p>
        {/if}
        {#if status.error}
          <p class="hint-line">{status.error.message}</p>
        {/if}
        <div class="actions">
          <Button
            variant="primary"
            disabled={busyByModel[shown.modelId]}
            onclick={() => void runModelAction(shown.modelId, startSpeechModelDownload)}
          >
            {status.error ? 'Try again' : 'Download'} ({formatBytes(status.downloadBytes)})
          </Button>
        </div>
      {:else}
        <p class="hint-line">
          {#if status.source === 'bundled'}
            Installed with the app.
          {:else if status.source === 'override'}
            Loaded from CANDIDCUE_MODELS_DIR.
          {:else}
            Downloaded to this Mac.
          {/if}
          Transcription runs here; nothing is uploaded.
        </p>

        {#if !shown.active}
          <div class="actions">
            <Button variant="primary" disabled={!canActivate} onclick={() => void activate(shown)}>
              Use {name}
            </Button>
          </div>
          {#if changeBlocked}
            <!-- Rust refuses this too; saying so before the click is kinder
                 than letting it fail. -->
            <p class="hint-line">End the take to change the speech language.</p>
          {/if}
        {/if}
      {/if}

      {#if errorByModel[shown.modelId]}
        <p class="inline-alert" role="alert">{errorByModel[shown.modelId]}</p>
      {/if}
      {#if selectError}
        <p class="inline-alert" role="alert">{selectError}</p>
      {/if}

      <!--
        The attribution, stated and not gated. It also travels in the model
        directory as ATTRIBUTION.md (§157); this is the copy a user can read
        without going to look for a file.
      -->
      <p class="attribution">
        {shown.attribution.title} by {shown.attribution.author} —
        <a href={shown.attribution.license.url} target="_blank" rel="noreferrer noopener">
          {shown.attribution.license.name}
        </a>.
        {#if shown.attribution.licenseNote}
          {shown.attribution.licenseNote}
        {/if}
      </p>
    {/if}

    {#if !compact && options.removable.length > 0}
      <!--
        Models on disk backing no language this build offers — a previous
        choice, or one a downgrade stopped offering. Listed only so the disk can
        be reclaimed; they are deliberately NOT choices.
      -->
      <div class="inventory">
        <h4 class="inventory-title">Other language data on this Mac</h4>
        {#each options.removable as entry (entry.modelId)}
          {@const current = statusByModel[entry.modelId] ?? entry}
          <div class="inventory-row">
            <span class="inventory-name">
              {current.languages.map((tag) => languageDisplayName(tag)).join(', ')}
              <span class="inventory-size">{formatBytes(current.installedBytes)}</span>
            </span>
            {#if confirmingDelete === entry.modelId}
              <span class="inventory-actions">
                <Button
                  variant="danger-primary"
                  disabled={busyByModel[entry.modelId]}
                  onclick={() => {
                    confirmingDelete = null;
                    void runModelAction(entry.modelId, deleteSpeechModel);
                  }}
                >
                  Remove it
                </Button>
                <Button variant="default" onclick={() => (confirmingDelete = null)}>Keep it</Button>
              </span>
            {:else}
              <Button
                variant="danger"
                disabled={busyByModel[entry.modelId] || isModelBusy(current)}
                onclick={() => (confirmingDelete = entry.modelId)}
              >
                Remove
              </Button>
            {/if}
          </div>
          {#if errorByModel[entry.modelId]}
            <p class="inline-alert" role="alert">{errorByModel[entry.modelId]}</p>
          {/if}
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .language-row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .hint-line {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  /*
    A full-row wash, never a one-sided border on a rounded box.
  */
  .inline-alert {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    background: var(--warning-soft);
    color: var(--warning);
    font-size: var(--text-sm);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  /*
   * Styled for both states. With no `value` a progress element is
   * indeterminate, which is exactly what the install and validate phases want
   * — they have no fraction to report, and a bar reading zero there would look
   * like the download had restarted.
   */
  .model-progress {
    width: 100%;
    height: 6px;
    appearance: none;
    border: none;
    border-radius: var(--radius-pill);
    background: var(--bg-sunken);
    overflow: hidden;
  }
  .model-progress::-webkit-progress-bar {
    background: var(--bg-sunken);
    border-radius: var(--radius-pill);
  }
  .model-progress::-webkit-progress-value {
    background: var(--accent);
    border-radius: var(--radius-pill);
  }

  /* Small terracotta text takes --accent-strong for AA in the light theme. */
  .attribution {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.5;
  }
  .attribution a {
    color: var(--accent-strong);
  }

  .inventory {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-2);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-faint);
  }

  .inventory-title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .inventory-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .inventory-name {
    font-size: var(--text-sm);
    color: var(--text-primary);
  }

  .inventory-size {
    color: var(--text-muted);
    margin-left: var(--space-2);
  }

  .inventory-actions {
    display: inline-flex;
    gap: var(--space-2);
  }
</style>
