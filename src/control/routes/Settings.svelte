<!--
  Settings (spec §18): seven sections. The OpenAI key field is one-shot and
  masked — it submits through the secrets service and the stored key is never
  displayed (§18.2). Privacy copy is Appendix F.18 verbatim.
-->
<script lang="ts">
  import Button from '../components/Button.svelte';
  import FollowSettingsFields from '../components/FollowSettingsFields.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Section from '../components/Section.svelte';
  import Select from '../components/Select.svelte';
  import Slider from '../components/Slider.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import TextField from '../components/TextField.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { openExternal } from '../lib/app-actions';
  import {
    SUPPORT_BUNDLE_CONTENTS,
    SUPPORT_BUNDLE_EXCLUSIONS,
    diagnosticRows,
    diagnosticsClipboardText,
    type SystemDiagnostics,
  } from '../lib/diagnostics-format';
  import * as diagnosticsService from '../services/diagnostics';
  import { describeError } from '../services/errors';
  import { BackendUnavailableError } from '../services/ipc';
  import {
    DOWNLOADS_SUPPORTED,
    DOWNLOADS_UNAVAILABLE_NOTE,
    formatPackSize,
    getListenerCatalogue,
    mergeCatalogue,
    removeListener,
    type ListenerPackRow,
  } from '../services/listeners-catalogue';
  import { listInstalledListeners } from '../services/listeners';
  import * as secretsService from '../services/secrets';
  import * as settingsService from '../services/settings';
  import type { OpenAiKeyStatus } from '../services/secrets-types';
  import { appStatus } from '../stores/app-status';
  import { requestConfirm } from '../stores/confirm';
  import { navigate, route, type SettingsSection } from '../stores/router';
  import { loadSettings, patchSettings, settings } from '../stores/settings';
  import { showToast } from '../stores/toasts';

  interface Props {
    section: SettingsSection;
  }
  let { section }: Props = $props();

  const sections: Array<{ id: SettingsSection; label: string }> = [
    { id: 'general', label: 'General' },
    { id: 'openai', label: 'OpenAI' },
    { id: 'audio', label: 'Audio' },
    { id: 'teleprompter', label: 'Teleprompter' },
    { id: 'following', label: 'Following' },
    { id: 'commands', label: 'Commands' },
    { id: 'listeners', label: 'Listeners' },
    { id: 'privacy', label: 'Data, privacy & updates' },
  ];

  let keyStatus = $state<OpenAiKeyStatus | null>(null);
  let keyField = $state('');
  let keyBusy = $state(false);
  let keyNote = $state('');
  let updateNote = $state('');
  let diagnostics = $state<SystemDiagnostics | null>(null);
  let diagnosticsError = $state<string | null>(null);
  let diagnosticsLoading = $state(false);

  $effect(() => {
    void loadSettings();
    void secretsService.getOpenAiKeyStatus().then((status) => (keyStatus = status));
  });

  let packs = $state<ListenerPackRow[]>([]);
  let packsError = $state<string | null>(null);
  let packsLoading = $state(false);

  /** Diagnostics are only fetched for the screen that shows them (§47.10). */
  $effect(() => {
    if (section === 'privacy') void loadDiagnostics();
  });

  $effect(() => {
    if (section === 'listeners') void loadPacks();
  });

  async function loadPacks(): Promise<void> {
    packsLoading = true;
    packsError = null;
    try {
      // The installed list is the authority on what is on disk; the catalogue
      // supplies the description, poster and size.
      const [catalogue, installed] = await Promise.all([
        getListenerCatalogue(),
        listInstalledListeners(),
      ]);
      packs = mergeCatalogue(catalogue, installed);
    } catch (err) {
      packs = [];
      packsError = describeError(err);
    } finally {
      packsLoading = false;
    }
  }

  async function removePack(pack: ListenerPackRow): Promise<void> {
    const accepted = await requestConfirm({
      title: `Remove ${pack.displayName}?`,
      body: 'The downloaded media is deleted from this device. Scripts are unaffected.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!accepted) return;
    await runMaintenance(
      () => removeListener(pack.packId, pack.version),
      () => `${pack.displayName} removed`,
    );
    await loadPacks();
  }

  async function loadDiagnostics(): Promise<void> {
    diagnosticsLoading = true;
    diagnosticsError = null;
    try {
      diagnostics = await diagnosticsService.getSystemDiagnostics();
    } catch (err) {
      diagnostics = null;
      diagnosticsError =
        err instanceof BackendUnavailableError
          ? 'Diagnostics need the CandidCue desktop app.'
          : describeError(err);
    } finally {
      diagnosticsLoading = false;
    }
  }

  async function copyDiagnostics(): Promise<void> {
    if (!diagnostics) return;
    try {
      await navigator.clipboard.writeText(diagnosticsClipboardText(diagnostics));
      showToast('Diagnostics copied', 'success');
    } catch {
      showToast('Could not copy to the clipboard', 'danger');
    }
  }

  async function runSupportBundle(): Promise<void> {
    await runMaintenance(
      () => diagnosticsService.exportSupportBundle(),
      // Rust runs the folder picker; cancelling is not a failure.
      (result) => (result.cancelled ? null : 'Support bundle ready'),
    );
  }

  async function submitKey(): Promise<void> {
    const candidate = keyField.trim();
    if (!candidate) return;
    keyBusy = true;
    keyNote = '';
    try {
      const validation = await secretsService.validateOpenAiKey(candidate);
      if (validation.status === 'valid' || validation.status === 'partial') {
        keyStatus = await secretsService.saveOpenAiKey(candidate);
        keyNote = 'Key saved. Realtime transcription is available.';
      } else if (validation.status === 'quota') {
        keyNote = 'The key is valid, but the OpenAI project has no available quota or billing access.';
      } else {
        keyNote = 'OpenAI rejected this key. Check that it is active and belongs to the project you intend to bill.';
      }
    } finally {
      keyField = ''; // one-shot: purge the plaintext after submission
      keyBusy = false;
    }
  }

  async function removeKey(): Promise<void> {
    const accepted = await requestConfirm({
      title: 'Remove OpenAI key?',
      body: 'Voice tracking and smart analysis will stop until a key is added again. Your scripts are unaffected.',
      confirmLabel: 'Remove key',
      danger: true,
    });
    if (!accepted) return;
    await secretsService.deleteOpenAiKey();
    keyStatus = await secretsService.getOpenAiKeyStatus();
    keyNote = '';
  }

  /**
   * C6: this used to invoke the Rust `all` cache kind, which empties the
   * compiled/vocabulary/thumbnail/download caches and never touches a log
   * file — then reported "Logs cleared." It now calls the real `logs` arm.
   */
  async function clearLogs(): Promise<void> {
    const accepted = await requestConfirm({
      title: 'Clear all logs?',
      body: 'This may make an existing issue harder to diagnose. Scripts and settings are unaffected.',
      confirmLabel: 'Clear logs',
      danger: true,
    });
    if (!accepted) return;
    await runMaintenance(
      () => settingsService.clearCache('logs'),
      (result) => (result.clearedFiles === 0 ? 'No logs to clear' : 'Logs cleared'),
    );
  }

  /**
   * C5/C6: every one of these buttons was `void …then(showToast)` with no
   * `.catch`, so a rejected command produced no export, no toast and no error.
   * A failure is now reported, and a cancelled picker says nothing at all.
   */
  async function runMaintenance<T>(
    run: () => Promise<T>,
    describeSuccess: (result: T) => string | null,
  ): Promise<void> {
    try {
      const message = describeSuccess(await run());
      if (message) showToast(message, 'success');
    } catch (err) {
      showToast(describeError(err), 'danger');
    }
  }

  async function runExportAllData(): Promise<void> {
    await runMaintenance(
      () => settingsService.exportAllData(),
      // Rust runs the folder picker; a cancelled picker is not a failure and
      // is not worth a toast.
      (result) => (result.cancelled ? null : 'Export ready'),
    );
  }

  async function runUpdateCheck(): Promise<void> {
    updateNote = 'Checking…';
    try {
      const result = await settingsService.checkForUpdate();
      updateNote =
        result.status === 'available'
          ? `Update available: ${result.availableVersion}`
          : result.status === 'up_to_date'
            ? 'CandidCue is up to date.'
            : result.status === 'unsupported'
              ? 'Update checks are not available in this build.'
              : `Could not check for updates: ${result.message ?? 'unknown error'}`;
    } catch (err) {
      updateNote = `Could not check for updates: ${describeError(err)}`;
    }
  }
</script>

<div class="page">
  <PageHeader title="Settings" backLabel="Library" onback={() => navigate({ name: 'library', view: 'all' })} />

  <div class="body">
    <nav class="section-nav" aria-label="Settings sections">
      {#each sections as entry (entry.id)}
        <button
          type="button"
          class="section-item"
          class:active={($route.name === 'settings' ? section : 'general') === entry.id}
          aria-current={section === entry.id ? 'page' : undefined}
          onclick={() => navigate({ name: 'settings', section: entry.id })}
        >
          {entry.label}
        </button>
      {/each}
    </nav>

    <div class="content">
      {#if section === 'general'}
        <Section title="General">
          <Select
            label="On launch"
            value={$settings.general.launchBehavior}
            options={[
              { value: 'library', label: 'Open the script library' },
              { value: 'recent', label: 'Open the most recent script' },
            ]}
            onchange={(value) =>
              void patchSettings('general', { launchBehavior: value as 'library' | 'recent' })}
          />
          <Select
            label="Default session mode"
            value={$settings.general.defaultSessionMode}
            options={[
              { value: 'voice', label: 'Voice follow' },
              { value: 'manual', label: 'Manual' },
              { value: 'fixed', label: 'Fixed speed' },
            ]}
            onchange={(value) =>
              void patchSettings('general', {
                defaultSessionMode: value as 'voice' | 'manual' | 'fixed',
              })}
          />
          <Slider
            label="Revision retention"
            value={$settings.general.revisionRetentionDays}
            min={7}
            max={90}
            format={(v) => `${v} days`}
            onchange={(value) => void patchSettings('general', { revisionRetentionDays: value })}
          />
          <Toggle
            checked={$settings.general.restoreWindows}
            label="Restore open windows"
            onchange={(value) => void patchSettings('general', { restoreWindows: value })}
          />
          <Toggle
            checked={$settings.general.confirmEndSession}
            label="Confirm before ending an active session"
            onchange={(value) => void patchSettings('general', { confirmEndSession: value })}
          />
        </Section>
      {:else if section === 'openai'}
        <Section
          title="OpenAI"
          description="CandidCue is bring-your-own-key. Your key is stored in your operating system's secure credential store and is used directly from this app."
        >
          {#snippet actions()}
            {#if keyStatus?.present}
              <StatusPill
                tone={keyStatus.state === 'connected' ? 'success' : 'warning'}
                label={keyStatus.state === 'connected' ? 'Connected' : 'Needs attention'}
              />
            {:else}
              <StatusPill tone="neutral" label="No key stored" />
            {/if}
          {/snippet}

          {#if keyStatus?.present}
            <div class="key-row">
              <span class="key-mask">••••••••{keyStatus.lastFour ?? '····'}</span>
              <div class="row-actions">
                <Button size="sm" onclick={() => void secretsService.getOpenAiKeyStatus().then((s) => (keyStatus = s))}>
                  Test key
                </Button>
                <Button variant="danger" size="sm" onclick={() => removeKey()}>Remove</Button>
              </div>
            </div>
            <p class="hint-line">To replace the key, enter a new one below. The stored key is never displayed.</p>
          {/if}
          <div class="key-form">
            <TextField
              bind:value={keyField}
              type="password"
              label="OpenAI API key"
              placeholder="sk-…"
              hint="Voice tracking uses OpenAI Realtime transcription. Smart command interpretation and vocabulary analysis use GPT-5.6 Luna."
              onsubmit={() => void submitKey()}
            />
            <div class="row-actions">
              <Button variant="primary" disabled={keyBusy || keyField.trim() === ''} onclick={() => submitKey()}>
                {keyBusy ? 'Validating…' : 'Validate and save'}
              </Button>
              <Button variant="ghost" onclick={() => openExternal('https://platform.openai.com/api-keys')}>
                OpenAI API keys
              </Button>
            </div>
            {#if keyNote}<p class="hint-line">{keyNote}</p>{/if}
          </div>

          <Select
            label="Realtime transcription model (advanced)"
            value={$settings.openai.realtimeModel}
            options={[{ value: 'gpt-realtime-whisper', label: 'gpt-realtime-whisper (default)' }]}
            onchange={(value) => void patchSettings('openai', { realtimeModel: value })}
          />
          <Select
            label="Command model"
            value={$settings.openai.commandModel}
            options={[{ value: 'gpt-5.6-luna', label: 'gpt-5.6-luna (default)' }]}
            onchange={(value) => void patchSettings('openai', { commandModel: value })}
          />
          <Toggle
            checked={$settings.openai.scriptAnalysis}
            label="Smart vocabulary analysis"
            description="Send unusual terms and limited context to GPT-5.6 Luna when preparing a script"
            onchange={(value) => void patchSettings('openai', { scriptAnalysis: value })}
          />
          <Toggle
            checked={$settings.openai.commandFallback}
            label="Natural-language command fallback"
            description="Send ambiguous command phrases to GPT-5.6 Luna"
            onchange={(value) => void patchSettings('openai', { commandFallback: value })}
          />
          <Toggle
            checked={true}
            disabled
            label="Do not store API responses (store: false)"
            description="Fixed on. CandidCue asks OpenAI not to retain Responses API requests."
          />
          <p class="hint-line">
            Usage is billed by OpenAI at their published realtime and model rates. Rates can change
            — check your OpenAI dashboard for current pricing.
          </p>
        </Section>
      {:else if section === 'audio'}
        <Section title="Audio">
          <Toggle
            checked={$settings.audio.followSystemDefault}
            label="Follow system default microphone"
            onchange={(value) => void patchSettings('audio', { followSystemDefault: value })}
          />
          <Toggle
            checked={$settings.audio.noiseSuppression}
            label="Noise suppression"
            onchange={(value) => void patchSettings('audio', { noiseSuppression: value })}
          />
          <Toggle
            checked={$settings.audio.echoCancellation}
            label="Echo cancellation"
            onchange={(value) => void patchSettings('audio', { echoCancellation: value })}
          />
          <Toggle
            checked={$settings.audio.autoGainControl}
            label="Automatic gain control"
            onchange={(value) => void patchSettings('audio', { autoGainControl: value })}
          />
          <Slider
            label="Local voice-detection sensitivity"
            value={Math.round($settings.audio.vadSensitivity * 100)}
            min={0}
            max={100}
            format={(v) => `${v}%`}
            onchange={(value) => void patchSettings('audio', { vadSensitivity: value / 100 })}
          />
          <p class="hint-line">
            Device selection, the live level meter, and the spoken transcription test live in
            Preflight, next to the session they configure.
          </p>
        </Section>
      {:else if section === 'teleprompter'}
        <Section title="Teleprompter">
          <Select
            label="Default font family"
            value={$settings.teleprompter.fontFamilyId}
            options={[
              { value: 'system-sans', label: 'System Sans' },
              { value: 'humanist-sans', label: 'Humanist Sans' },
              { value: 'serif', label: 'Serif' },
              { value: 'monospace', label: 'Monospace' },
            ]}
            onchange={(value) => void patchSettings('teleprompter', { fontFamilyId: value })}
          />
          <Slider
            label="Default font size"
            value={$settings.teleprompter.fontSizePx}
            min={24}
            max={160}
            format={(v) => `${v} px`}
            onchange={(value) => void patchSettings('teleprompter', { fontSizePx: value })}
          />
          <Slider
            label="Reading band position"
            value={$settings.teleprompter.readingBandCenterPercent}
            min={20}
            max={70}
            format={(v) => `${v}%`}
            onchange={(value) =>
              void patchSettings('teleprompter', { readingBandCenterPercent: value })}
          />
          <Slider
            label="Fixed-speed default"
            value={$settings.teleprompter.fixedSpeedWpm}
            min={60}
            max={260}
            format={(v) => `${v} wpm`}
            onchange={(value) => void patchSettings('teleprompter', { fixedSpeedWpm: value })}
          />
          <Toggle
            checked={$settings.teleprompter.mirrorX}
            label="Horizontal mirror by default"
            onchange={(value) => void patchSettings('teleprompter', { mirrorX: value })}
          />
          <Toggle
            checked={$settings.teleprompter.phraseHighlight}
            label="Current phrase highlight"
            onchange={(value) => void patchSettings('teleprompter', { phraseHighlight: value })}
          />
          <Toggle
            checked={$settings.teleprompter.pastDimming}
            label="Past-text dimming"
            onchange={(value) => void patchSettings('teleprompter', { pastDimming: value })}
          />
          <Select
            label="When a session ends"
            value={$settings.teleprompter.stageEndBehavior}
            options={[
              { value: 'close', label: 'Close the stage window' },
              { value: 'blank', label: 'Keep the stage open, blanked' },
            ]}
            onchange={(value) =>
              void patchSettings('teleprompter', { stageEndBehavior: value as 'close' | 'blank' })}
          />
          <Toggle
            checked={$settings.teleprompter.hidePointer}
            label="Hide the pointer on the stage"
            onchange={(value) => void patchSettings('teleprompter', { hidePointer: value })}
          />
        </Section>
      {:else if section === 'following'}
        <Section
          title="Following"
          description="How the stage follows your voice. These are feel choices — CandidCue keeps its own safety rules for section jumps and retakes whatever you pick."
        >
          <FollowSettingsFields
            following={$settings.following}
            onchange={(patch) => void patchSettings('following', patch)}
          />
        </Section>
      {:else if section === 'commands'}
        <Section title="Commands">
          <Toggle
            checked={$settings.commands.enabled}
            label="Voice commands"
            onchange={(value) => void patchSettings('commands', { enabled: value })}
          />
          <TextField
            value={$settings.commands.wakePhrase}
            label="Wake phrase"
            oninput={(value) => void patchSettings('commands', { wakePhrase: value })}
          />
          <TextField
            value={$settings.commands.wakeAliases.join(', ')}
            label="Accepted wake aliases"
            hint="Comma-separated variants the transcriber may hear, e.g. “candy cue”."
            oninput={(value) =>
              void patchSettings('commands', {
                wakeAliases: value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })}
          />
          <Toggle
            checked={$settings.commands.strictWake}
            label="Strict mode"
            description="Commands require the wake phrase"
            onchange={(value) => void patchSettings('commands', { strictWake: value })}
          />
          <div class="command-examples">
            <p class="hint-line">Examples:</p>
            <ul class="examples">
              <li>“CandidCue, start” · “CandidCue, pause” · “CandidCue, resume”</li>
              <li>“CandidCue, go to chapter one” · “CandidCue, go to pricing”</li>
              <li>“CandidCue, restart this paragraph” · “CandidCue, retake”</li>
              <li>“CandidCue, bigger text” · “CandidCue, blank the screen”</li>
            </ul>
          </div>
        </Section>
      {:else if section === 'listeners'}
        <Section
          title="Listeners"
          description="A Listener is a silent looping person behind the script. Installed packs are stored on this device."
        >
          {#snippet actions()}
            <Button size="sm" disabled={packsLoading} onclick={() => void loadPacks()}>
              {packsLoading ? 'Loading…' : 'Refresh'}
            </Button>
          {/snippet}

          {#if packsError}
            <p class="hint-line">{packsError}</p>
          {:else if packsLoading && packs.length === 0}
            <p class="hint-line">Loading Listener packs…</p>
          {:else if packs.length === 0}
            <p class="hint-line">No Listener packs are available on this device.</p>
          {:else}
            <ul class="packs">
              {#each packs as pack (pack.packId + pack.version)}
                <li class="pack">
                  <div class="pack-text">
                    <span class="pack-name">{pack.displayName}</span>
                    <span class="pack-desc">{pack.description}</span>
                    <span class="pack-meta">
                      {pack.statusLabel} · v{pack.version}
                      {#if formatPackSize(pack.approximateBytes)}
                        · {formatPackSize(pack.approximateBytes)}
                      {/if}
                    </span>
                  </div>
                  <!--
                    No download button: `download_listener` is an honest
                    NOT_IMPLEMENTED stub in this build, and a control that
                    silently does nothing is worse than an absent one.
                  -->
                  {#if pack.removable}
                    <Button variant="danger" size="sm" onclick={() => void removePack(pack)}>
                      Remove
                    </Button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          {#if !DOWNLOADS_SUPPORTED}
            <p class="hint-line">{DOWNLOADS_UNAVAILABLE_NOTE}</p>
          {/if}
          <Toggle
            checked={$settings.listeners.autoplay}
            label="Autoplay Listener when a session starts"
            onchange={(value) => void patchSettings('listeners', { autoplay: value })}
          />
          <Slider
            label="Default dim"
            value={$settings.listeners.dimPercent}
            min={0}
            max={80}
            format={(v) => `${v}%`}
            onchange={(value) => void patchSettings('listeners', { dimPercent: value })}
          />
        </Section>
      {:else}
        <Section title="Data, privacy & updates">
          <div class="privacy">
            <h3 class="privacy-head">Local by default</h3>
            <p class="privacy-body">
              Your Markdown scripts, imported images, settings, and downloaded Listeners are stored
              on this device.
            </p>
            <h3 class="privacy-head">While voice tracking is active</h3>
            <p class="privacy-body">
              Your selected microphone audio is sent to OpenAI for live transcription. CandidCue
              does not save the audio by default.
            </p>
            <h3 class="privacy-head">Smart vocabulary analysis</h3>
            <p class="privacy-body">
              When enabled, unusual terms and limited surrounding context are sent to GPT-5.6 Luna.
              CandidCue caches the result locally.
            </p>
            <h3 class="privacy-head">Ambiguous voice commands</h3>
            <p class="privacy-body">
              Most commands are handled locally. When a command is unclear, the command phrase and
              a compact list of script targets may be sent to GPT-5.6 Luna.
            </p>
            <h3 class="privacy-head">CandidCue servers</h3>
            <p class="privacy-body">
              CandidCue checks for software updates and downloads optional Listener media. Your
              OpenAI API key and scripts are not sent to CandidCue servers.
            </p>
            <h3 class="privacy-head">OpenAI retention</h3>
            <p class="privacy-body">
              OpenAI's current API data controls and endpoint retention rules apply.
              <button type="button" class="inline-link" onclick={() => openExternal('https://platform.openai.com/docs/guides/your-data')}>
                Open the current policy
              </button>
              for details.
            </p>
          </div>

          <div class="row-actions">
            <Button onclick={() => void runExportAllData()}>
              Export all scripts
            </Button>
            <Button
              variant="ghost"
              onclick={() =>
                void runMaintenance(
                  () => settingsService.clearCache('analysis'),
                  () => 'Analysis cache cleared',
                )}
            >
              Clear analysis cache
            </Button>
            <Button
              variant="ghost"
              onclick={() =>
                void runMaintenance(
                  () => settingsService.clearCache('listeners'),
                  () => 'Listener downloads cleared',
                )}
            >
              Clear Listener downloads
            </Button>
            <Button variant="ghost" onclick={() => clearLogs()}>Clear logs</Button>
          </div>

          <Toggle
            checked={$settings.privacy.diagnosticLogging}
            label="Diagnostic logging"
            description="Keeps redacted local logs to help diagnose problems"
            onchange={(value) => void patchSettings('privacy', { diagnosticLogging: value })}
          />
          <Select
            label="Update channel"
            value={$settings.privacy.updateChannel}
            options={[
              { value: 'stable', label: 'Stable' },
              { value: 'beta', label: 'Beta' },
            ]}
            onchange={(value) =>
              void patchSettings('privacy', { updateChannel: value as 'stable' | 'beta' })}
          />
          <div class="row-actions">
            <Button size="sm" onclick={() => runUpdateCheck()}>Check for updates</Button>
            {#if updateNote}<span class="hint-line">{updateNote}</span>{/if}
          </div>
        </Section>

        <!-- §44.11 / §47.10 diagnostics: the facts a support request needs. -->
        <Section
          title="Diagnostics"
          description="What CandidCue knows about this installation. Useful when something is not working and you need to report it."
        >
          {#snippet actions()}
            <Button size="sm" disabled={diagnosticsLoading} onclick={() => void loadDiagnostics()}>
              {diagnosticsLoading ? 'Checking…' : 'Refresh'}
            </Button>
          {/snippet}

          {#if diagnosticsError}
            <p class="hint-line">{diagnosticsError}</p>
          {:else if !diagnostics}
            <p class="hint-line">{diagnosticsLoading ? 'Checking…' : 'No diagnostics yet.'}</p>
          {:else}
            <dl class="diag">
              {#each diagnosticRows(diagnostics) as row (row.label)}
                <div class="diag-row">
                  <dt class="diag-label">{row.label}</dt>
                  <dd class="diag-value">
                    <span class="diag-figure {row.tone}">{row.value}</span>
                    {#if row.note}<span class="diag-note">{row.note}</span>{/if}
                  </dd>
                </div>
              {/each}
            </dl>
          {/if}

          <div class="row-actions">
            <Button size="sm" disabled={!diagnostics} onclick={() => void copyDiagnostics()}>
              Copy diagnostics
            </Button>
            <Button size="sm" variant="ghost" onclick={() => void runSupportBundle()}>
              Export support bundle
            </Button>
          </div>
          <ul class="bundle-contents">
            {#each SUPPORT_BUNDLE_CONTENTS as line (line)}
              <li>{line}</li>
            {/each}
          </ul>
          <p class="hint-line">{SUPPORT_BUNDLE_EXCLUSIONS}</p>
          <p class="hint-line">CandidCue {$appStatus.version}</p>
        </Section>
      {/if}
    </div>
  </div>
</div>

<style>
  .page {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }

  .section-nav {
    flex: 0 0 208px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-5) var(--space-4);
    overflow-y: auto;
  }
  .section-item {
    display: block;
    width: 100%;
    text-align: left;
    min-height: 34px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 600;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      box-shadow var(--dur-fast) var(--ease-out);
  }
  .section-item:hover {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }
  .section-item.active,
  .section-item.active:hover {
    background: var(--bg-panel);
    border-color: var(--border);
    box-shadow: var(--shadow-card);
    color: var(--text-primary);
  }

  .content {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-6) var(--page-x) var(--space-8);
    max-width: 640px;
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .key-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .key-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .key-mask {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    letter-spacing: 0.08em;
  }

  .hint-line {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  .packs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .pack {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
  }
  .pack-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pack-name {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .pack-desc {
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
  }
  .pack-meta {
    font-size: var(--text-2xs);
    color: var(--text-muted);
  }

  .diag {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .diag-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-4);
  }
  .diag-label {
    flex: 0 0 148px;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .diag-value {
    margin: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .diag-figure {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    word-break: break-word;
  }
  .diag-figure.good {
    color: var(--success);
    font-weight: 600;
  }
  .diag-figure.bad {
    color: var(--danger);
    font-weight: 600;
  }
  .diag-note {
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-faint);
  }

  .bundle-contents {
    margin: 0;
    padding-left: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  .command-examples {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .examples {
    margin: 0;
    padding-left: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .privacy {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .privacy-head {
    margin: var(--space-3) 0 0;
    font-size: var(--text-sm);
    font-weight: 650;
    color: var(--text-primary);
  }
  .privacy-head:first-child {
    margin-top: 0;
  }
  .privacy-body {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    max-width: var(--prose-measure-narrow);
  }
  .inline-link {
    border: none;
    background: transparent;
    padding: 0;
    font: inherit;
    color: var(--accent-strong);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
</style>
