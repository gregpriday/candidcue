<!--
  §153: pick a language, and fetch the model that serves it.

  ONE component for two screens. Welcome asks the question at first run and
  Settings changes the answer afterwards, but the state machine underneath is
  identical — progress, verification, unpacking, cancel, failure, retry — and
  Welcome's own comment already warned that running it from two screens means
  two copies of that logic drifting apart.

  TWO LAYOUTS, BECAUSE THE HOSTS ALREADY SAY DIFFERENT THINGS
  ------------------------------------------------------------
  Full (Settings) is an install card. Its first line answers "can it follow
  me?" for the ACTIVE language and nothing else does: the dropdown, the costs
  and the one button that moves things forward sit beneath it, and the licence
  is the card's footer. Three kinds of message look different on purpose,
  because they ask for different decisions — a problem with the language
  (amber, in the status line), a command that just failed (red, under the
  button that issued it), and a removal waiting for an answer (neutral ink, a
  question with its answers under it).

  Compact (Welcome) has no card and no status line. The Welcome row it sits in
  already paints the readiness, a pill and a sentence, and a second status for
  the same language was the panel arguing with its host. What is left is the
  choice, the one action, its progress, why the last download failed, and the
  same facts and licence. The disk inventory and removal are Settings'
  business: reclaiming space is not a first-run concern.

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
  import { tick } from 'svelte';
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';
  import Select from './Select.svelte';
  import StatusPill from './StatusPill.svelte';
  import type { IconName } from './icon-names';
  import { describeError } from '../services/errors';
  import { openModelLicence } from '../services/speech-models';
  import {
    canRemove,
    cancelSpeechModelDownload,
    deleteSpeechModel,
    formatBytes,
    getSpeechLanguageOptions,
    isBusy as isModelBusy,
    isDamaged,
    languageDisplayName,
    MODEL_DAMAGED_CODE,
    onSpeechModelProgress,
    phaseLabel,
    progressFraction,
    reconcileModelStatuses,
    selectSpeechLanguage,
    startSpeechModelDownload,
    type SpeechLanguageOption,
    type SpeechLanguageOptions,
    type SpeechModelStatus,
  } from '../services/speech-models';

  interface Props {
    /**
     * Welcome's form: no status line of its own (the Welcome row paints one),
     * no disk inventory and no removal.
     */
    compact?: boolean;
    /**
     * The settings revision to write against. Owned by the caller because the
     * settings document is, and a second copy held here could go stale against
     * the store the rest of the screen renders from.
     */
    revision: number;
    /**
     * Told when a language is committed. AWAITED — the caller reloads the
     * settings document here, and activation stays busy until it has, so a
     * second click cannot be issued against the revision Rust has just
     * superseded.
     */
    onlanguagechange?: () => void | Promise<void>;
    /**
     * The ACTIVE language's install state, whenever it changes.
     *
     * Exists so Welcome and Settings can paint a readiness pill without running
     * a second copy of this state machine. They used to keep their own status,
     * their own listener and their own counter — which asked the CATALOGUE
     * DEFAULT rather than the selected model, and accepted a progress event for
     * any model at all, so downloading an inactive language moved a pill that
     * was describing the active one.
     */
    onactivestatus?: (status: SpeechModelStatus | null) => void;
  }

  let { compact = false, revision, onlanguagechange, onactivestatus }: Props = $props();

  /** Ties each removal question to its group, per instance. */
  const uid = $props.id();

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
  /** Set when the FIRST snapshot fails, so the panel is not "Checking…" forever. */
  let loadError = $state<string | null>(null);

  /**
   * Which refresh is current.
   *
   * Without it an older reply can land after a newer one and repaint the whole
   * panel — the language list, the active row and `changeBlocked` — from a
   * snapshot that has been superseded. The per-model event rule below cannot
   * catch that: it compares snapshots against EVENTS, not against each other.
   */
  let refreshToken = 0;

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

  /** The language currently in use, whether or not it is the one on screen. */
  const activeOption = $derived(languages.find((option) => option.active) ?? null);

  /** What was last handed to `onactivestatus`, so it is not told twice. */
  let reportedActive: SpeechModelStatus | null = null;

  /**
   * Report the ACTIVE language's status upward whenever it CHANGES.
   *
   * `$effect` rather than a call inside `refresh()`, so an event that arrives
   * with no refresh behind it still reaches the parent.
   *
   * The change check is not an optimisation. Every progress event replaces
   * `statusByModel`, so this effect reruns for a DOWNLOAD OF SOME OTHER MODEL
   * — several times a second — while the active model sits unchanged and
   * settled. Settings responds to a settled status by re-reading the engine,
   * so without this guard an inactive language's download would fire an IPC
   * call every progress frame to ask a question whose answer had not moved.
   */
  $effect(() => {
    const status = activeOption ? statusOf(activeOption) : null;
    if (sameStatus(status, reportedActive)) return;
    reportedActive = status;
    onactivestatus?.(status);
  });

  /** Whether two statuses say the same thing about the same model. */
  function sameStatus(a: SpeechModelStatus | null, b: SpeechModelStatus | null): boolean {
    if (a === null || b === null) return a === b;
    return (
      a.modelId === b.modelId &&
      a.phase === b.phase &&
      a.installed === b.installed &&
      a.source === b.source &&
      a.progressBytes === b.progressBytes &&
      a.progressTotal === b.progressTotal &&
      a.error?.code === b.error?.code
    );
  }

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

  type Tone = 'success' | 'accent' | 'neutral' | 'warning';

  /**
   * The card's first line: whether the ACTIVE language can follow a take.
   *
   * It describes the active language whatever row the dropdown is showing,
   * because that is the question somebody opening this screen came with — and
   * it is the one status the panel paints. There used to be three: a sentence
   * saying "Currently using English", "(in use)" in the menu, and a pill beside
   * it, which on a machine without the model read "Needs download" in the
   * success green. A reader had to assemble the answer, and the first two
   * pieces said yes.
   *
   * It never says "Ready". Whether the engine has loaded is Settings' call,
   * and its header pill makes it; this says what is on disk.
   */
  function summaryOf(option: SpeechLanguageOption | null): { tone: Tone; icon: IconName; title: string } {
    if (!option) return { tone: 'neutral', icon: 'info', title: 'No speech language selected' };
    const status = statusOf(option);
    const name = languageDisplayName(option.languageTag);
    // Busy first: what is happening supersedes what was true before it.
    if (isModelBusy(status)) return { tone: 'accent', icon: 'import', title: `Installing ${name}` };
    // Before the not-downloaded reading, which would be false: it IS
    // downloaded, and what it needs is to be downloaded AGAIN (#258).
    if (isDamaged(status)) return { tone: 'warning', icon: 'alert', title: 'Speech data is damaged' };
    if (status.error) return { tone: 'warning', icon: 'alert', title: 'The download did not finish' };
    if (status.installed) return { tone: 'success', icon: 'check', title: 'Speech data installed' };
    return { tone: 'accent', icon: 'import', title: 'Voice following needs a download' };
  }

  /** Where a usable copy came from, as the end of "Currently using English, …". */
  function sourcePhrase(status: SpeechModelStatus): string {
    if (status.source === 'bundled') return 'installed with the app';
    if (status.source === 'override') return 'loaded from SPEAKING_GLASS_MODELS_DIR';
    return 'downloaded to this machine';
  }

  /**
   * Rust's sentence for a damaged download, when it says something the panel
   * does not already say.
   *
   * For STT_MODEL_DAMAGED it does not — it restates the damage — so it is
   * dropped rather than printed under a sentence saying the same thing. A
   * repair that then failed on its own terms (no network, no space) still
   * reports the files as damaged, and THAT reason is worth showing.
   */
  function damagedReason(status: SpeechModelStatus): string | null {
    if (!isDamaged(status) || !status.error || status.error.code === MODEL_DAMAGED_CODE) return null;
    return status.error.message;
  }

  /**
   * What the download button says, for what actually happened: never fetched,
   * a fetch that failed, or a download here whose files were damaged since.
   */
  function downloadLabel(status: SpeechModelStatus): string {
    if (isDamaged(status)) return 'Download again';
    return status.error ? 'Try again' : 'Download';
  }

  /** Whether removing this model would actually remove anything. */
  function removable(status: SpeechModelStatus, modelId: string): boolean {
    return canRemove(status) && !busyByModel[modelId];
  }

  /**
   * The non-destructive half of the open confirmation.
   *
   * One variable for every confirm in this component, because `confirmingDelete`
   * holds a single id — only one question can be open at a time.
   */
  let keepButton = $state<HTMLButtonElement | null>(null);

  /**
   * Ask before removing, and move focus onto "Keep it".
   *
   * Pressing Remove destroys the button that had focus. Without this the focus
   * ring lands back on the document and a keyboard user is dropped at the top
   * of the panel with an unanswered question they never heard. Focus goes to
   * the SAFE choice, so the destructive key is never the one already under a
   * waiting Return — the same rule `RevisionHistory` follows.
   */
  async function askToRemove(modelId: string): Promise<void> {
    confirmingDelete = modelId;
    await tick();
    keepButton?.focus();
  }

  /**
   * Every Remove button, by model, so declining can hand focus back.
   *
   * "Keep it" is destroyed by its own click, exactly as Remove was on the way
   * in; without this a keyboard user who said no was dropped at the top of the
   * window, one Return away from nothing.
   */
  let removeTriggers = $state<Record<string, HTMLButtonElement | null>>({});

  async function keepIt(modelId: string): Promise<void> {
    confirmingDelete = null;
    await tick();
    removeTriggers[modelId]?.focus();
  }

  /*
   * Focus that the panel itself destroyed, put back inside it.
   *
   * Nearly every transition here replaces the control that was pressed:
   * Download becomes Stop, Stop becomes Download, "Remove it" becomes nothing,
   * "Use German" disappears once German is in use. Each of those dropped focus
   * on the body. So the panel remembers what last had focus inside it, and
   * when that element has left the document AND nothing else has taken focus,
   * it moves to the next thing worth pressing — or the dropdown, when there is
   * nothing to press. A download finishing in the background while somebody
   * types elsewhere moves nothing: their focus is not on the body.
   */
  let root = $state<HTMLDivElement | null>(null);
  let lastFocused: HTMLElement | null = null;

  function noteFocus(event: FocusEvent): void {
    if (event.target instanceof HTMLElement) lastFocused = event.target;
  }

  async function recoverFocus(): Promise<void> {
    await tick();
    if (!root || !lastFocused || lastFocused.isConnected) return;
    const holder = document.activeElement;
    if (holder !== null && holder !== document.body) return;
    const next =
      root.querySelector<HTMLElement>('.picker-actions button:not(:disabled)') ??
      root.querySelector<HTMLElement>('select');
    lastFocused = null;
    next?.focus();
  }

  $effect(() => {
    // Everything that swaps one control for another.
    void [shown?.modelId, shownStatus?.phase, shownStatus?.installed, confirmingDelete, selecting];
    void recoverFocus();
  });

  /*
   * How a download of an INACTIVE language ended, for a screen reader.
   *
   * The active language's outcome is the status line changing, which is a
   * live region. A language somebody is only looking at has no status line:
   * its phase region disappears when the install ends and "ready to switch to"
   * arrives as an ordinary paragraph, so somebody who started it and went back
   * to writing heard nothing. Only the transition OUT of a busy phase speaks —
   * opening the screen on a finished download is not news.
   */
  let outcome = $state('');
  let outcomeAlert = $state('');
  const lastPhase = new Map<string, SpeechModelStatus['phase']>();

  $effect(() => {
    if (!shown || shown.active || !shownStatus) return;
    const before = lastPhase.get(shown.modelId);
    lastPhase.set(shown.modelId, shownStatus.phase);
    if (before === undefined || before === shownStatus.phase) return;
    const wasBusy = isModelBusy({ ...shownStatus, phase: before });
    // A new attempt empties both regions, so that the SAME outcome a second
    // time — the same failure after a retry — is still a change, and heard.
    if (!wasBusy && isModelBusy(shownStatus)) {
      outcome = '';
      outcomeAlert = '';
      return;
    }
    if (!wasBusy || isModelBusy(shownStatus)) return;
    const name = languageDisplayName(shown.languageTag);
    if (shownStatus.installed) outcome = `${name} is downloaded and ready to switch to.`;
    else if (shownStatus.error) outcomeAlert = `${name} did not download. ${shownStatus.error.message}`;
  });

  /** A re-check of a FIRST snapshot that failed, so the button can say so. */
  let rechecking = $state(false);

  async function recheck(): Promise<void> {
    rechecking = true;
    try {
      await refresh();
    } finally {
      rechecking = false;
    }
  }

  /**
   * Re-read everything, discarding any model whose status moved meanwhile.
   *
   * The comparison is PER MODEL: a snapshot for English is still good even if a
   * progress event for another model landed while it was in flight.
   */
  async function refresh(): Promise<void> {
    const seen = { ...eventCountByModel };
    const token = ++refreshToken;
    try {
      const next = await getSpeechLanguageOptions();
      // A newer refresh started while this one was in flight, so this reply is
      // already history. Dropping it whole — rather than merging it — is what
      // stops the language list and the active row flickering back.
      if (token !== refreshToken) return;
      options = next;
      statusByModel = reconcileModelStatuses(statusByModel, seen, eventCountByModel, [
        ...next.languages.map((language) => language.status),
        ...next.removable,
      ]);
      loadError = null;
    } catch (err) {
      // After a first success, keep what was last known: an IPC hiccup is not
      // evidence that the language list changed. Before one, there is nothing
      // to keep, and a panel stuck on "Checking…" for ever tells the user
      // nothing they can act on.
      if (options === null && token === refreshToken) loadError = describeError(err);
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

  /**
   * Run one install command against one model.
   *
   * `failed` names the operation for when it is refused. A bare "Speaking Glass
   * cannot reach the network" under a Download button reads as a fact about
   * the language; "The download could not start" first says it was the press
   * that failed, and that the language is exactly where it was.
   */
  async function runModelAction(
    modelId: string,
    action: (id: string) => Promise<SpeechModelStatus>,
    failed: string,
  ): Promise<void> {
    busyByModel = { ...busyByModel, [modelId]: true };
    errorByModel = { ...errorByModel, [modelId]: null };
    const seen = { ...eventCountByModel };
    try {
      const status = await action(modelId);
      // Reconciled, not assigned. A command reply is a snapshot like any other
      // and races the event stream the same way: a fast install can emit its
      // terminal event before `start_speech_model_download`'s promise delivers
      // the "downloading" status it captured at the start, and assigning that
      // unconditionally would walk a finished install backwards.
      statusByModel = reconcileModelStatuses(statusByModel, seen, eventCountByModel, [status]);
    } catch (err) {
      // Tauri rejects with a serialized AppError OBJECT, not an Error, so
      // `String(err)` renders "[object Object]".
      errorByModel = { ...errorByModel, [modelId]: `${failed} ${describeError(err)}` };
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
    } catch (err) {
      // The write itself failed, so nothing changed and the revision this
      // component holds is still good.
      selectError = `Could not switch to ${languageDisplayName(option.languageTag)}. ${describeError(err)}`;
      selecting = false;
      await refresh();
      return;
    }

    /*
     * Past this line the language IS changed, and the two failures are not the
     * same failure.
     *
     * Rust has superseded the revision this component was handed, so until the
     * caller has reloaded the settings document another write anywhere in the
     * app would be issued against a revision that no longer exists. If that
     * reload fails, reporting it as "could not change the language" would be
     * simply untrue — the language changed — and releasing the button would
     * arm exactly the conflict the reload was there to prevent. So the button
     * stays disabled and the message says what actually needs doing.
     */
    try {
      await onlanguagechange?.();
      await refresh();
      selecting = false;
    } catch {
      selectError =
        `${languageDisplayName(option.languageTag)} is now the speech language, but this screen ` +
        'could not reload. Reopen Settings before changing it again.';
    }
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

<!--
  The one button that moves the language on screen forward, if it has one —
  Download, Try again, Download again, or Use. A snippet because the two
  layouts put it in different places (beside the dropdown in Welcome, under the
  costs in Settings) and the rule for WHICH button it is must not exist twice.
  The size rides on the button: it is the price of pressing it.
-->
{#snippet nextAction(option: SpeechLanguageOption, status: SpeechModelStatus)}
  <!-- Filled in Settings, where installing a language is the page's job.
       Plain on Welcome: there the setup is optional, and the filled button
       belongs to starting a script — two of them is no primary at all. -->
  {#if !status.installed}
    <Button
      variant={compact ? 'default' : 'primary'}
      disabled={busyByModel[option.modelId]}
      onclick={() =>
        void runModelAction(option.modelId, startSpeechModelDownload, 'The download could not start.')}
    >
      {downloadLabel(status)}
      <span class="button-size">{formatBytes(status.downloadBytes)}</span>
    </Button>
  {:else if !option.active}
    <Button
      variant={compact ? 'default' : 'primary'}
      disabled={!canActivate}
      onclick={() => void activate(option)}
    >
      Use {languageDisplayName(option.languageTag)}
    </Button>
  {/if}
{/snippet}

<!--
  A download in flight: what it is doing, how far, and the way to stop it.

  The PHASE is the live region and the byte count is not. A count changes
  several times a second, and a polite region re-reading "59 MB of 128 MB" on
  every event buries anything else a screen reader was about to say; a phase
  changes four or five times in an install, which is what is worth hearing.
  The bar carries the count as its value text instead.
-->
{#snippet progress(option: SpeechLanguageOption, status: SpeechModelStatus)}
  {@const fraction = progressFraction(status)}
  {@const counted = `${formatBytes(status.progressBytes)} of ${formatBytes(status.progressTotal)}`}
  <div class="progress">
    <div class="progress-main">
      <p class="progress-line">
        <span class="progress-phase" role="status">{phaseLabel(status)}</span>
        <span class="progress-count">{fraction !== null ? counted : 'Download complete'}</span>
      </p>
      <!-- Determinate only while there is a real fraction: `installing` and
           `validating` measure nothing, and a bar snapping back to empty there
           reads as a restart. -->
      <progress
        class="model-progress"
        max="1"
        value={fraction ?? undefined}
        aria-label="{languageDisplayName(option.languageTag)} speech model install progress"
        aria-valuetext={fraction !== null ? counted : phaseLabel(status)}
      ></progress>
    </div>
    <div class="picker-actions">
      <Button
        size="sm"
        variant="default"
        onclick={() =>
          void runModelAction(option.modelId, cancelSpeechModelDownload, 'The download could not be stopped.')}
      >
        Stop
      </Button>
    </div>
  </div>
{/snippet}

<!--
  A problem WITH THE LANGUAGE — a download that failed, files that are
  damaged. Amber, like the status line that leads with it.
-->
{#snippet trouble(message: string, announce: boolean)}
  <p class="line trouble" role={announce ? 'alert' : undefined}>
    <span class="line-icon" aria-hidden="true"><Icon name="alert" size={14} /></span>
    <span>{message}</span>
  </p>
{/snippet}

<!--
  A COMMAND that failed — Download refused, Stop refused, Remove refused, the
  language not saved. Red, and directly under the controls that issued it: it
  is about what was just pressed, and says nothing new about the language.
-->
{#snippet failure(message: string)}
  <p class="line failure" role="alert">
    <span class="line-icon" aria-hidden="true"><Icon name="alert" size={14} /></span>
    <span>{message}</span>
  </p>
{/snippet}

<!--
  Remove, waiting for an answer.

  A QUESTION, so it looks like one: neutral ink on a sunken well, the sentence
  first and its answers under it, the safe answer first and focused so the
  destructive key is never the one under a waiting Return. It used to be the
  same amber wash as "your speech data is missing", printed after the buttons
  that answered it. Focus landing on "Keep it" inside this labelled group is
  what announces the question, so it is not an alert.
-->
{#snippet confirmRemove(modelId: string, question: string, consequence: string)}
  <div
    class="confirm"
    role="group"
    aria-labelledby="{uid}-question-{modelId}"
    aria-describedby="{uid}-consequence-{modelId}"
  >
    <p class="confirm-question" id="{uid}-question-{modelId}">{question}</p>
    <p class="confirm-detail" id="{uid}-consequence-{modelId}">{consequence}</p>
    <div class="picker-actions">
      <Button bind:element={keepButton} variant="default" onclick={() => void keepIt(modelId)}>
        Keep it
      </Button>
      <Button
        variant="danger-primary"
        onclick={() => {
          confirmingDelete = null;
          void runModelAction(modelId, deleteSpeechModel, 'The speech data could not be removed.');
        }}
      >
        Remove it
      </Button>
    </div>
  </div>
{/snippet}

<!--
  The three facts §153 asks for, before any button that spends bandwidth, and
  the disk figure afterwards — "how much disk is this using?" is as real a
  question as "how much will this cost me to fetch?". Once the model is
  installed the transfer size is history, so the line stops quoting it.
-->
{#snippet facts(option: SpeechLanguageOption, status: SpeechModelStatus)}
  <p class="facts">
    {#if isModelBusy(status)}
      <!-- The transfer is the bar's to report while it runs; quoting "128 MB
           to download" under "Download complete" read as a contradiction. -->
      <span>{formatBytes(status.installedBytes)} once installed</span>
      <span class="sep" aria-hidden="true">·</span> <span>from {originLine(option)}</span>
    {:else if status.installed}
      <span>{formatBytes(status.installedBytes)} on disk</span>
      {#if status.source === 'downloaded'}
        <span class="sep" aria-hidden="true">·</span> <span>from {originLine(option)}</span>
      {/if}
    {:else}
      <span>{formatBytes(status.downloadBytes)} to download</span>
      <span class="sep" aria-hidden="true">·</span>
      <!-- "on disk" would be a false claim about a machine that does not have
           the model; the number is the footprint it WOULD take. -->
      <span>{formatBytes(status.installedBytes)} once installed</span>
      <span class="sep" aria-hidden="true">·</span> <span>from {originLine(option)}</span>
    {/if}
  </p>
{/snippet}

<!--
  The attribution, stated and not gated. It also travels in the model
  directory as ATTRIBUTION.md (§157); this is the copy a user can read without
  going to look for a file.
-->
{#snippet attribution(option: SpeechLanguageOption)}
  <p class="attribution">
    {option.attribution.title} by {option.attribution.author} —
    <!--
      A button, not an anchor.

      An `<a target="_blank">` asks the WEBVIEW to navigate, which is a thing
      this window must never do — and it needed `opener:default` on the control
      capability to work at all, which is standing permission to open any url.
      `openModelLicence` goes to Rust, which checks the url against the licence
      urls the model catalogue itself declares.
    -->
    <button
      type="button"
      class="licence-link"
      data-focus="control"
      onclick={() => void openModelLicence(option.attribution.license.url)}
      >{option.attribution.license.name}</button
    >.
    {#if option.attribution.licenseNote}
      {option.attribution.licenseNote}
    {/if}
  </p>
{/snippet}

<!--
  What the row on screen is, when it is NOT the active one. The status line
  describes the active language whatever the dropdown shows, so a looked-at
  language needs its own short answer — and only the parts the costs and the
  button beneath it do not already give.
-->
{#snippet inspected(option: SpeechLanguageOption, status: SpeechModelStatus)}
  {@const name = languageDisplayName(option.languageTag)}
  {#if isModelBusy(status)}
    <!-- The progress below says it. -->
  {:else if isDamaged(status)}
    {@render trouble(`${name}’s speech data on this machine is damaged. Download it again to repair it.`, false)}
  {:else if status.error}
    {@render trouble(status.error.message, false)}
  {:else if status.installed}
    <p class="line">{name} is downloaded and ready to switch to.</p>
  {:else}
    <p class="line">{name} is not downloaded yet. Downloading it does not switch to it.</p>
  {/if}
{/snippet}

<div class="picker" class:compact bind:this={root} onfocusin={noteFocus}>
  <!-- How a download of a language you are only LOOKING at ended. Always in
       the document, so the change is what is heard. -->
  <p class="sr-only" role="status">{outcome}</p>
  <p class="sr-only" role="alert">{outcomeAlert}</p>
  {#if options === null && loadError !== null}
    <!-- The FIRST snapshot failed, so there is nothing to fall back to.
         "Checking…" for ever would be the panel lying about still trying. -->
    {#if compact}
      <div class="stack">
        {@render trouble(`Could not check speech languages. ${loadError}`, true)}
        <div class="picker-actions">
          <Button size="sm" variant="default" disabled={rechecking} onclick={() => void recheck()}>
            {rechecking ? 'Checking…' : 'Check again'}
          </Button>
        </div>
      </div>
    {:else}
      <div class="card">
        <div class="summary tone-warning">
          <span class="summary-icon" aria-hidden="true"><Icon name="alert" size={16} /></span>
          <p class="summary-title">Could not check speech languages</p>
          <p class="summary-body" role="alert">{loadError}</p>
          <div class="summary-actions picker-actions">
            <Button variant="default" disabled={rechecking} onclick={() => void recheck()}>
              {rechecking ? 'Checking…' : 'Check again'}
            </Button>
          </div>
        </div>
      </div>
    {/if}
  {:else if options === null}
    <p class="checking" class:card={!compact} role="status">Checking which languages are available…</p>
  {:else}
    {#if languages.length === 0}
      <!--
        Reachable only from a build whose catalogue and recogniser tables
        disagree. Says what is wrong rather than showing an empty dropdown.
      -->
      {#if compact}
        {@render trouble(
          'This version of Speaking Glass has no speech languages available. Voice following cannot run; everything else works.',
          true,
        )}
      {:else}
        <div class="card">
          <div class="summary tone-neutral">
            <span class="summary-icon" aria-hidden="true"><Icon name="info" size={16} /></span>
            <p class="summary-title">Voice following is unavailable</p>
            <p class="summary-body" role="alert">
              This version of Speaking Glass has no speech languages available. Voice following cannot
              run; everything else works.
            </p>
          </div>
        </div>
      {/if}
    {:else}
      {@const summary = summaryOf(activeOption)}
      {@const status = shown ? statusOf(shown) : null}
      {@const busy = isModelBusy(status)}
      {@const hasNext = shown !== null && status !== null && !busy && (!status.installed || !shown.active)}

      {#snippet chooser()}
        <div class="chooser">
          <Select
            label="Language"
            value={shown?.languageTag ?? ''}
            options={languages.map((option) => ({
              value: option.languageTag,
              // Marked in the menu too, so the choice is legible while it is
              // open. "Selected" until the data is here: "in use" beside a
              // language that cannot follow anybody yet was the menu saying yes.
              label: option.active
                ? `${languageDisplayName(option.languageTag)} (${statusOf(option).installed ? 'in use' : 'selected'})`
                : languageDisplayName(option.languageTag),
            }))}
            onchange={(value) => {
              // Looking is not choosing. Changing this starts no download and
              // saves no setting — §153 wants the sizes seen before anything
              // happens.
              highlighted = value;
              confirmingDelete = null;
              selectError = null;
            }}
          />
        </div>
      {/snippet}

      {#if compact}
        {@render chooser()}
        {#if !activeOption}
          <p class="line">No language this version can follow is selected.</p>
        {:else if shown && !shown.active}
          <!-- §153: which language is listening has to survive looking at
               another one. Welcome's row owns the readiness, so this names the
               choice and claims nothing about whether it can follow yet. -->
          <p class="line">
            Selected speech language: <strong>{languageDisplayName(activeOption.languageTag)}</strong>.
          </p>
        {/if}
        {#if shown && status}
          {#if !shown.active}{@render inspected(shown, status)}{/if}
          <!-- Language, then what it costs, then the button that spends it:
               the order §153 asks for, in reading order as well as on screen. -->
          {@render facts(shown, status)}
          {#if busy}{@render progress(shown, status)}{/if}
          <!-- Welcome's row says the language needs downloading; only this
               panel knows why the last attempt failed, and the reason belongs
               directly above the button that retries it. -->
          {#if shown.active && status.error && !isDamaged(status)}
            {@render trouble(status.error.message, true)}
          {/if}
          {#if damagedReason(status)}{@render trouble(damagedReason(status)!, false)}{/if}
          {#if hasNext}
            <div class="picker-actions">{@render nextAction(shown, status)}</div>
          {/if}
          {#if !shown.active && status.installed && changeBlocked}
            <p class="line">End the take to change the speech language.</p>
          {/if}
          {#if errorByModel[shown.modelId]}{@render failure(errorByModel[shown.modelId]!)}{/if}
          {#if selectError}{@render failure(selectError)}{/if}
          {@render attribution(shown)}
        {/if}
      {:else}
        <div class="card">
          <!--
            §153 asks for "a clear indication of which language is active", and
            that has to survive the user looking at a DIFFERENT row — so this
            line is about the active language whatever the dropdown shows.
          -->
          <div class="summary tone-{summary.tone}">
            <span class="summary-icon" aria-hidden="true"><Icon name={summary.icon} size={16} /></span>
            <!-- The live region is the STATUS, which changes a handful of
                 times in an install; never the byte count beneath it. -->
            <p class="summary-title" role="status">{summary.title}</p>
            {#if !activeOption}
              <!-- The persisted language is not one this build offers — a
                   downgrade, or a model whose profile went away. Named rather
                   than hidden. -->
              <p class="summary-body">No language this version can follow is selected.</p>
            {:else}
              {@const active = statusOf(activeOption)}
              {@const activeName = languageDisplayName(activeOption.languageTag)}
              {#if isModelBusy(active)}
                <p class="summary-body">
                  Voice following can use {activeName} once this finishes. Everything else works
                  meanwhile.
                </p>
              {:else if isDamaged(active)}
                <!-- §153: a model the app expects and cannot find must fail
                     somewhere the user can act on it. This is that screen. -->
                <p class="summary-body" role="alert">
                  {activeName}’s speech data on this machine is damaged, so voice following cannot
                  run. Download it again to repair it.
                </p>
              {:else if active.error}
                <p class="summary-body" role="alert">
                  {active.error.message} Voice following cannot run until {activeName} is downloaded.
                </p>
              {:else if active.installed}
                <!-- Not "nothing is uploaded" again: Settings says that, at
                     length, directly under this card. -->
                <p class="summary-body">
                  Currently using <strong>{activeName}</strong>, {sourcePhrase(active)}.
                </p>
              {:else}
                <p class="summary-body" role="alert">
                  {activeName} is selected, but its speech data is not on this machine. Everything else
                  works without it.
                </p>
              {/if}
            {/if}
          </div>

          <div class="install" class:inspecting={shown !== null && !shown.active}>
            {@render chooser()}
            {#if shown && status}
              {@const confirming = confirmingDelete === shown.modelId}
              {@const name = languageDisplayName(shown.languageTag)}
              {#if !shown.active}{@render inspected(shown, status)}{/if}

              <!-- The language, what it costs, then whatever is happening to it
                   and the button that moves it on — the same order as Welcome. -->
              <div class="facts-row">
                {@render facts(shown, status)}
                <!--
                  §153 asks for a way to remove a model that is no longer
                  wanted, and the language on screen is the commonest thing
                  somebody wants to reclaim — including the active one, which is
                  the only model most installations have. It sits on the disk
                  line because the disk is what it changes.

                  `canRemove` decides, not an inline condition: only a model
                  this machine DOWNLOADED is ours to delete. `bundled` lives
                  inside the app bundle, and `override` is a developer's
                  SPEAKING_GLASS_MODELS_DIR, where Remove would delete an invisible
                  app-data copy and leave the visible model exactly where it
                  was — a button that appears to do nothing.
                -->
                {#if removable(status, shown.modelId) && !confirming}
                  <span class="remove-slot">
                    <Button
                      bind:element={
                        () => removeTriggers[shown.modelId] ?? null,
                        (el) => (removeTriggers[shown.modelId] = el)
                      }
                      size="sm"
                      variant="danger"
                      onclick={() => void askToRemove(shown.modelId)}
                    >
                      Remove download
                    </Button>
                  </span>
                {/if}
              </div>

              {#if busy}{@render progress(shown, status)}{/if}
              {#if damagedReason(status)}{@render trouble(damagedReason(status)!, false)}{/if}

              {#if confirming}
                {@render confirmRemove(
                  shown.modelId,
                  isDamaged(status)
                    ? `Remove the damaged ${name} speech data?`
                    : `Remove the ${name} speech data?`,
                  `${isDamaged(status) ? '' : `This frees ${formatBytes(status.installedBytes)}. `}Voice following will not work in ${name} until it is downloaded again.`,
                )}
              {:else if hasNext}
                <div class="picker-actions">{@render nextAction(shown, status)}</div>
              {/if}
              {#if !shown.active && status.installed && changeBlocked}
                <!-- Rust refuses this too; saying so before the click is
                     kinder than letting it fail. -->
                <p class="line">End the take to change the speech language.</p>
              {/if}
              {#if errorByModel[shown.modelId]}{@render failure(errorByModel[shown.modelId]!)}{/if}
              {#if selectError}{@render failure(selectError)}{/if}
            {/if}
          </div>

          {#if shown}
            <div class="card-foot">{@render attribution(shown)}</div>
          {/if}
        </div>
      {/if}
    {/if}

    {#if !compact && options.removable.length > 0}
      <!--
        Models on disk backing no language this build offers — a previous
        choice, or one a downgrade stopped offering. Listed only so the disk can
        be reclaimed; they are deliberately NOT choices. Outside the
        language branch, so a build that offers nothing can still free them.
      -->
      <section class="inventory" aria-labelledby="{uid}-inventory">
        <h3 class="inventory-title" id="{uid}-inventory">Other language data on this computer</h3>
        <p class="inventory-hint">
          Speech data for languages this version no longer offers. It cannot be downloaded again
          here, so remove it only to free the space.
        </p>
        <ul class="inventory-list">
          {#each options.removable as entry (entry.modelId)}
            <!--
              The OVERLAID status, not the snapshot's: a removal that has
              already completed leaves a stale row in `options.removable` until
              the next refresh, and rendering a Remove button for a model that
              is no longer there is a button that can only fail.
            -->
            {@const current = statusByModel[entry.modelId] ?? entry}
            {@const label = current.languages.map((tag) => languageDisplayName(tag)).join(', ')}
            {#if current.installed || current.source === 'downloaded'}
              <li class="inventory-row">
                <div class="inventory-main">
                  <span class="inventory-name">{label}</span>
                  <span class="inventory-size">{formatBytes(current.installedBytes)}</span>
                  {#if isDamaged(current)}<StatusPill tone="warning" label="Damaged" />{/if}
                  {#if removable(current, entry.modelId) && confirmingDelete !== entry.modelId}
                    <span class="remove-slot">
                      <Button
                        bind:element={
                          () => removeTriggers[entry.modelId] ?? null,
                          (el) => (removeTriggers[entry.modelId] = el)
                        }
                        size="sm"
                        variant="danger"
                        onclick={() => void askToRemove(entry.modelId)}
                      >
                        Remove
                      </Button>
                    </span>
                  {/if}
                </div>
                {#if confirmingDelete === entry.modelId}
                  {@render confirmRemove(
                    entry.modelId,
                    `Remove the ${label} speech data?`,
                    `This frees ${formatBytes(current.installedBytes)}. This version cannot download it again.`,
                  )}
                {/if}
                {#if errorByModel[entry.modelId]}{@render failure(errorByModel[entry.modelId]!)}{/if}
              </li>
            {/if}
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }
  .picker.compact {
    gap: var(--space-2);
  }

  /*
    The install card, Settings only. A white panel on the warm canvas with the
    same border and radius as the rig rows and monitor tiles elsewhere in
    Settings. Welcome gets no card: it is already inside one.
  */
  .card {
    display: flex;
    flex-direction: column;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
  }

  /* The tone is the ICON's colour and nothing else's: the title stays in
     primary ink, so a problem reads by its words first and its colour second. */
  .tone-success {
    --tone: var(--success);
  }
  .tone-accent {
    --tone: var(--accent);
  }
  .tone-neutral {
    --tone: var(--text-muted);
  }
  .tone-warning {
    --tone: var(--warning);
  }

  .summary {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr);
    column-gap: var(--space-3);
    row-gap: var(--space-1);
    padding: var(--space-4) var(--space-4) 0;
  }
  .summary:only-child {
    padding-bottom: var(--space-4);
  }
  .summary-icon {
    grid-row: 1;
    display: inline-flex;
    margin-top: 3px;
    color: var(--tone);
  }
  .summary-title {
    margin: 0;
    font-size: var(--text-base);
    line-height: 22px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .summary-body {
    grid-column: 2;
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--text-secondary);
  }
  .summary-body strong {
    font-weight: 600;
    color: var(--text-primary);
  }
  .summary-actions {
    grid-column: 2;
    margin-top: var(--space-2);
  }

  /* Under the status text, not under the icon: the block belongs to the line
     above it, the way Welcome's picker sits under its row title. */
  .install {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-4) var(--space-4) calc(var(--space-4) + 16px + var(--space-3));
  }

  /* Looking at another language: the status line above is still about the
     active one, so the looked-at language gets its own ruled-off block. */
  .install.inspecting {
    margin-top: var(--space-4);
    border-top: 1px solid var(--border-faint);
  }

  /* The licence lines up with the text above it, not with the icon. */
  .card-foot {
    padding: var(--space-3) var(--space-4) var(--space-3) calc(var(--space-4) + 16px + var(--space-3));
    border-top: 1px solid var(--border-faint);
  }

  .checking {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .checking.card {
    padding: var(--space-4);
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* A language name is short; a dropdown the width of the card read as a
     field to type into. */
  .chooser {
    width: 100%;
    max-width: 320px;
  }

  /* One-line notes: the looked-at row's state, the take that blocks a switch,
     and — with an icon — trouble and failure. */
  .line {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--text-secondary);
  }
  .line strong {
    font-weight: 600;
    color: var(--text-primary);
  }
  .line-icon {
    display: inline-flex;
    flex: 0 0 auto;
    margin-top: 3px;
  }
  .trouble {
    color: var(--warning);
  }
  .failure {
    color: var(--danger);
  }

  .picker-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  /* The size on the button is the price, not the verb: same size, less weight. */
  .button-size {
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }

  /* Centred in a row as tall as the Remove button, whether or not the button
     is there — so the line does not drop when it appears. */
  .facts-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-1) var(--space-3);
    flex-wrap: wrap;
    min-height: var(--toolbar-control-h);
  }
  .facts {
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .compact .facts {
    font-size: var(--text-xs);
  }
  .sep {
    color: var(--text-muted);
    padding: 0 2px;
  }

  /* A danger trigger carries its own padding; pulled out by it so the word,
     not the hit area, lines up with the edge. */
  .remove-slot {
    display: inline-flex;
    margin-right: calc(-1 * var(--space-3));
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* --- progress ------------------------------------------------------------ */

  .progress {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3);
  }
  .progress-main {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .progress-line {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    margin: 0;
    font-size: var(--text-sm);
    line-height: 18px;
  }
  .progress-phase {
    font-weight: 600;
    color: var(--text-primary);
  }
  .progress-count {
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  /*
   * The track is drawn with a 3:1 edge (WCAG 1.4.11): the empty part of the
   * bar is half of what it says, and a track the colour of the page beneath it
   * left a terracotta stroke ending nowhere.
   *
   * With no `value` a progress element is indeterminate, which is exactly what
   * the install and validate phases want — they have no fraction to report.
   * It gets a travelling segment, not an empty track: an empty track there
   * read as "0%", which is the restart this exists to avoid.
   */
  .model-progress {
    display: block;
    width: 100%;
    height: 8px;
    appearance: none;
    border: none;
    border-radius: var(--radius-pill);
    background: var(--bg-sunken);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    overflow: hidden;
  }
  .model-progress::-webkit-progress-bar {
    background: transparent;
    border-radius: var(--radius-pill);
  }
  .model-progress::-webkit-progress-value {
    background: var(--accent);
    border-radius: var(--radius-pill);
  }
  .model-progress::-moz-progress-bar {
    background: var(--accent);
    border-radius: var(--radius-pill);
  }
  /* Stripes along the whole track, not a segment: a still frame of a segment
     reads as a bar part-filled from somewhere in the middle, and stripes say
     "working, no fraction" whether or not they move. */
  .model-progress:indeterminate {
    background:
      linear-gradient(
          -45deg,
          var(--accent) 25%,
          transparent 25% 50%,
          var(--accent) 50% 75%,
          transparent 75%
        )
        0 0 / 12px 12px,
      var(--bg-sunken);
    animation: install-indeterminate 0.6s linear infinite;
  }
  @keyframes install-indeterminate {
    from {
      background-position: 0 0, 0 0;
    }
    to {
      background-position: 12px 0, 0 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    /* Still, and still not empty: the stripes stay, at full contrast against
       the track, and the phase label beside it says what. */
    .model-progress:indeterminate {
      animation: none;
    }
  }

  /* --- removal question ---------------------------------------------------- */

  .confirm {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
  }
  .confirm-question {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-primary);
  }
  .confirm-detail {
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--text-secondary);
  }
  .confirm .picker-actions {
    margin-top: var(--space-2);
  }

  /* --- licence ------------------------------------------------------------- */

  .attribution {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.5;
  }

  /* Reads as a link, because it is one; it simply does not navigate this window.
     Ink with a quiet underline, like every link on the desk. */
  .licence-link {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--text-primary);
    text-decoration: underline;
    text-decoration-color: var(--border-strong);
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .licence-link:hover {
    text-decoration-color: currentColor;
  }

  /* --- inventory ----------------------------------------------------------- */

  .inventory {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .inventory-title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .inventory-hint {
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--text-secondary);
  }
  .inventory-list {
    margin: var(--space-1) 0 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
  }
  .inventory-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
  }
  .inventory-row:has(.confirm),
  .inventory-row:has(.failure) {
    padding-bottom: var(--space-3);
  }
  .inventory-row + .inventory-row {
    border-top: 1px solid var(--border-faint);
  }
  .inventory-main {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--control-h);
  }
  .inventory-name {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .inventory-size {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .inventory-main .remove-slot {
    margin-left: auto;
  }
</style>
