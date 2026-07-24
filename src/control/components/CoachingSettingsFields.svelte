<!--
  §30.1 Live Coaching settings, shared by Settings → Live coaching and the
  Preflight "Live coaching" section, so the same choice is never described two
  ways.

  Copy discipline: §30.2 writes out the four filler-detection labels verbatim
  and this component uses them verbatim (via lib/coaching-profiles.ts). They
  exist to state the cost and recall trade-off honestly — that Basic will miss
  fillers, and that Precision spends the user's own OpenAI key — and a
  friendlier paraphrase would lose exactly the part that matters.

  §32.2 requires the UI to state what is retained. The retention block does
  that as three sentences, one per consent, always — the same rule
  `shared/coaching/review/report-store.ts` applies after a take.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import SegmentedControl from './SegmentedControl.svelte';
  import Select from './Select.svelte';
  import TextField from './TextField.svelte';
  import Toggle from './Toggle.svelte';
  import {
    COACHING_MODE_OPTIONS,
    DELIVERY_STYLE_OPTIONS,
    FILLER_SCOPE_OPTIONS,
    MODE_MODULE_PRESETS,
    PACE_PRESET_OPTIONS,
    PACE_WPM_MAX,
    PACE_WPM_MIN,
    PRECISION_MODE_OPTIONS,
    TIP_FREQUENCY_OPTIONS,
    VARIETY_MAX,
    VARIETY_MIN,
    coachingRetentionLines,
    formatFillerWords,
    formatTargetDuration,
    parseFillerWords,
    parseTargetDuration,
    resolvedPaceBand,
    resolvedVarietyBand,
  } from '../lib/coaching-profiles';
  import type { TranscriptRetention } from '../services/settings-types';
  import type {
    CoachRailMode,
    CoachingSettings,
    DeliveryStyle,
    FillerDetectionScope,
    PaceTargetPreset,
    PrecisionTranscriptionMode,
  } from '../../shared/contracts';

  interface Props {
    coaching: CoachingSettings;
    /** §36.2. Read-only here; it lives with the other privacy settings. */
    transcriptRetention: TranscriptRetention;
    /** Preflight shows the session-relevant subset. */
    compact?: boolean;
    onchange: (patch: Partial<CoachingSettings>) => void;
  }
  let { coaching, transcriptRetention, compact = false, onchange }: Props = $props();

  const modeNote = $derived(
    COACHING_MODE_OPTIONS.find((o) => o.value === coaching.mode)?.description ?? '',
  );
  const paceNote = $derived(
    PACE_PRESET_OPTIONS.find((o) => o.value === coaching.pacePreset)?.description ?? '',
  );
  const styleNote = $derived(
    DELIVERY_STYLE_OPTIONS.find((o) => o.value === coaching.deliveryStyle)?.description ?? '',
  );
  const precisionNote = $derived(
    PRECISION_MODE_OPTIONS.find((o) => o.value === coaching.precisionTranscriptionMode)
      ?.description ?? '',
  );
  const scopeNote = $derived(
    FILLER_SCOPE_OPTIONS.find((o) => o.value === coaching.fillerDetectionScope)?.description ?? '',
  );
  const paceBand = $derived(resolvedPaceBand(coaching));
  const varietyBand = $derived(resolvedVarietyBand(coaching));
  const retentionLines = $derived(coachingRetentionLines(coaching, transcriptRetention));
  const customModules = $derived(coaching.mode === 'custom');
  const analysisOff = $derived(coaching.mode === 'off');

  /*
   * Draft buffers for the two free-text fields.
   *
   * Rewriting an input's value from the store on every keystroke fights the
   * caret: "3:3" would be parsed, rejected and reset while the user was still
   * typing "3:30". A draft of `null` means "no edit in progress", so the field
   * follows the store — including when another window changes it, or when a
   * failed save reverts it.
   */
  let durationDraft = $state<string | null>(null);
  let fillerDraft = $state<string | null>(null);
  const durationText = $derived(
    durationDraft ?? formatTargetDuration(coaching.targetDurationSeconds),
  );
  const fillerText = $derived(fillerDraft ?? formatFillerWords(coaching.customFillerWords));

  /**
   * §6. Changing to a named mode also writes the module flags that mode means,
   * so `CoachRailModules` and the panel agree. `custom` keeps whatever is
   * stored — switching away and back must not erase the user's own set.
   */
  function setMode(mode: CoachRailMode): void {
    if (mode === 'custom') {
      onchange({ mode });
      return;
    }
    onchange({ mode, modules: { ...MODE_MODULE_PRESETS[mode] } });
  }

  function setModule(key: keyof CoachingSettings['modules'], value: boolean): void {
    onchange({ modules: { ...coaching.modules, [key]: value } });
  }

  function setPacePreset(preset: PaceTargetPreset): void {
    // The band travels with the preset; see settings-coaching.ts.
    onchange({ pacePreset: preset });
  }

  function setWpm(edge: 'low' | 'high', text: string): void {
    const value = Number(text);
    if (!Number.isFinite(value)) return;
    const clamped = Math.min(PACE_WPM_MAX, Math.max(PACE_WPM_MIN, Math.round(value)));
    onchange(edge === 'low' ? { targetWpmLow: clamped } : { targetWpmHigh: clamped });
  }

  function setVariety(edge: 'low' | 'high', text: string): void {
    const value = Number(text);
    if (!Number.isFinite(value)) return;
    const clamped = Math.min(VARIETY_MAX, Math.max(VARIETY_MIN, Math.round(value)));
    onchange(edge === 'low' ? { targetVarietyLow: clamped } : { targetVarietyHigh: clamped });
  }

  function commitDuration(): void {
    const seconds = parseTargetDuration(durationText);
    // Drop the draft first, so the field re-reads the store's canonical
    // formatting ("3:07", not "3:7") once the save lands.
    durationDraft = null;
    onchange({ targetDurationSeconds: seconds });
  }

  function commitFillerWords(): void {
    const words = parseFillerWords(fillerText);
    fillerDraft = null;
    onchange({ customFillerWords: words });
  }

  function setGoal<K extends keyof CoachingSettings['goals']>(
    key: K,
    value: CoachingSettings['goals'][K],
  ): void {
    onchange({ goals: { ...coaching.goals, [key]: value } });
  }

  function setGoalThreshold(
    key: 'maxFillersPerMinute' | 'maxFillersPerHundredWords',
    text: string,
  ): void {
    const value = Number(text);
    setGoal(key, Number.isFinite(value) && value > 0 ? value : null);
  }

  function resetCalibration(): void {
    // §30.1. A tombstone rather than a button with nowhere to write: anything
    // learned before this instant is invalid and gets relearned.
    onchange({ personalCalibrationResetAtEpochMs: Date.now() });
  }

  const MODULE_ROWS: Array<{ key: keyof CoachingSettings['modules']; label: string; hint: string }> =
    [
      { key: 'paceNumber', label: 'Pace number', hint: 'The live words-per-minute figure.' },
      { key: 'paceStatus', label: 'Pace status', hint: '“On target”, “slightly fast”, and so on.' },
      {
        key: 'targetDurationStatus',
        label: 'Target-duration status',
        hint: 'Whether you are on track to finish inside the target.',
      },
      {
        key: 'varietyScore',
        label: 'Numeric variety score',
        hint: 'The 0–100 figure. Hidden, variety still shows as a word.',
      },
      { key: 'fillerCount', label: 'Filler count', hint: 'Confirmed fillers this take.' },
      {
        key: 'fillerRibbon',
        label: 'Event ribbon',
        hint: 'The thin strip of recent events under the rail.',
      },
      {
        key: 'inlineGutterMarks',
        label: 'Past-line marks',
        hint: 'Small marks beside lines you have already read.',
      },
      { key: 'liveTips', label: 'Live tips', hint: 'One short tip at a time, never more.' },
    ];
</script>

<div class="fields">
  <div class="field">
    <span class="mini-label">Coaching mode</span>
    <Select
      label=""
      value={coaching.mode}
      options={COACHING_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      onchange={(value) => setMode(value as CoachRailMode)}
    />
    <p class="hint">{modeNote}</p>
  </div>

  {#if !analysisOff}
    <!-- Pace ------------------------------------------------------------- -->
    <div class="field">
      <Select
        label="Pace target"
        value={coaching.pacePreset}
        options={PACE_PRESET_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        onchange={(value) => setPacePreset(value as PaceTargetPreset)}
      />
      <p class="hint">{paceNote}</p>
      {#if coaching.pacePreset === 'custom'}
        <div class="range">
          <TextField
            label="From (wpm)"
            value={String(coaching.targetWpmLow)}
            oninput={(v) => setWpm('low', v)}
          />
          <TextField
            label="To (wpm)"
            value={String(coaching.targetWpmHigh)}
            oninput={(v) => setWpm('high', v)}
          />
        </div>
      {:else}
        <p class="hint measure">Target band: {paceBand.lowWpm}–{paceBand.highWpm} wpm.</p>
      {/if}
    </div>

    <div class="field">
      <TextField
        label="Target duration"
        value={durationText}
        placeholder="none"
        hint="Minutes and seconds, e.g. 3:30. Leave empty for no target."
        oninput={(v) => (durationDraft = v)}
        onsubmit={commitDuration}
      />
      <div class="inline-action">
        <Button size="sm" onclick={commitDuration}>Apply duration</Button>
        {#if coaching.targetDurationSeconds !== null}
          <span class="meta">Currently {formatTargetDuration(coaching.targetDurationSeconds)}.</span>
        {:else}
          <span class="meta">No target set.</span>
        {/if}
      </div>
    </div>

    <!-- Vocal style ------------------------------------------------------ -->
    <div class="field">
      <Select
        label="Vocal style"
        value={coaching.deliveryStyle}
        options={DELIVERY_STYLE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        onchange={(value) => onchange({ deliveryStyle: value as DeliveryStyle })}
      />
      <p class="hint">{styleNote} It sets the variety band; it does not change how you are tracked.</p>
      {#if coaching.deliveryStyle === 'custom'}
        <div class="range">
          <TextField
            label="Variety from"
            value={String(coaching.targetVarietyLow)}
            oninput={(v) => setVariety('low', v)}
          />
          <TextField
            label="Variety to"
            value={String(coaching.targetVarietyHigh)}
            oninput={(v) => setVariety('high', v)}
          />
        </div>
        <p class="hint measure">
          0–100 on CandidCue’s own variety scale. It is not a quality score and it is not compared
          with anyone else.
        </p>
      {:else}
        <p class="hint measure">Variety band: {varietyBand.low}–{varietyBand.high}.</p>
      {/if}
    </div>

    <!-- Filler detection ------------------------------------------------- -->
    <div class="field">
      <Select
        label="Filler detection"
        value={coaching.precisionTranscriptionMode}
        options={PRECISION_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        onchange={(value) =>
          onchange({ precisionTranscriptionMode: value as PrecisionTranscriptionMode })}
      />
      <p class="hint">{precisionNote}</p>
    </div>

    <div class="field">
      <span class="mini-label">What counts as a filler</span>
      <SegmentedControl
        label="What counts as a filler"
        value={coaching.fillerDetectionScope}
        options={FILLER_SCOPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        onchange={(value) => onchange({ fillerDetectionScope: value as FillerDetectionScope })}
      />
      <p class="hint">{scopeNote}</p>
    </div>

    {#if !compact}
      <div class="field">
        <TextField
          label="Your own filler words"
          value={fillerText}
          placeholder="basically, so yeah, I mean"
          hint="Comma-separated. These are counted alongside the built-in list."
          oninput={(v) => (fillerDraft = v)}
          onsubmit={commitFillerWords}
        />
        <div class="inline-action">
          <Button size="sm" onclick={commitFillerWords}>Apply words</Button>
          <span class="meta">
            {coaching.customFillerWords.length === 0
              ? 'None yet.'
              : `${coaching.customFillerWords.length} word${coaching.customFillerWords.length === 1 ? '' : 's'} of your own.`}
          </span>
        </div>
      </div>
    {/if}

    <Toggle
      checked={coaching.trackRepeatedOpeners}
      label="Track repeated openers"
      description="Notices when several sentences in a row start the same way. Contextual, so it needs higher confidence before it says anything."
      onchange={(value) => onchange({ trackRepeatedOpeners: value })}
    />

    <!-- Tips ------------------------------------------------------------- -->
    <div class="field">
      <span class="mini-label">Tip frequency</span>
      <SegmentedControl
        label="Tip frequency"
        value={coaching.liveTipFrequency}
        options={TIP_FREQUENCY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        onchange={(value) => onchange({ liveTipFrequency: value as 'low' | 'normal' | 'high' })}
      />
      <p class="hint">
        {TIP_FREQUENCY_OPTIONS.find((o) => o.value === coaching.liveTipFrequency)?.description ?? ''}
        Only one tip is ever on screen.
      </p>
    </div>

    <Toggle
      checked={coaching.positiveReinforcementEnabled}
      label="Positive feedback"
      description="Occasionally says when something went well. Off by default."
      onchange={(value) => onchange({ positiveReinforcementEnabled: value })}
    />

    <!-- Rail modules ----------------------------------------------------- -->
    {#if !compact}
      <div class="group">
        <span class="mini-label">What the rail shows</span>
        {#if !customModules}
          <p class="hint">
            {COACHING_MODE_OPTIONS.find((o) => o.value === coaching.mode)?.label} decides these.
            Choose <strong>Custom</strong> to set them yourself.
          </p>
        {/if}
        <div class="modules">
          {#each MODULE_ROWS as row (row.key)}
            <Toggle
              checked={coaching.modules[row.key]}
              label={row.label}
              description={row.hint}
              disabled={!customModules}
              onchange={(value) => setModule(row.key, value)}
            />
          {/each}
        </div>
      </div>
    {/if}

    <!-- Goals ------------------------------------------------------------ -->
    <div class="group">
      <span class="mini-label">Goals</span>
      <p class="hint">
        Goals shape the tips you get and the post-take review. They never change how the script is
        tracked or where it scrolls.
      </p>

      <div class="goal-row">
        <Toggle
          checked={coaching.goals.maxFillersPerMinute !== null}
          label="Fewer than N fillers a minute"
          onchange={(value) => setGoal('maxFillersPerMinute', value ? 3 : null)}
        />
        {#if coaching.goals.maxFillersPerMinute !== null}
          <div class="goal-value">
            <TextField
              label="Fillers a minute"
              value={String(coaching.goals.maxFillersPerMinute)}
              oninput={(v) => setGoalThreshold('maxFillersPerMinute', v)}
            />
          </div>
        {/if}
      </div>

      <div class="goal-row">
        <Toggle
          checked={coaching.goals.maxFillersPerHundredWords !== null}
          label="Fewer than N fillers per 100 words"
          onchange={(value) => setGoal('maxFillersPerHundredWords', value ? 2 : null)}
        />
        {#if coaching.goals.maxFillersPerHundredWords !== null}
          <div class="goal-value">
            <TextField
              label="Fillers per 100 words"
              value={String(coaching.goals.maxFillersPerHundredWords)}
              oninput={(v) => setGoalThreshold('maxFillersPerHundredWords', v)}
            />
          </div>
        {/if}
      </div>

      <Toggle
        checked={coaching.goals.paceWithinTargetRange}
        label="Stay inside the pace range"
        description={`${paceBand.lowWpm}–${paceBand.highWpm} wpm.`}
        onchange={(value) => setGoal('paceWithinTargetRange', value)}
      />
      <Toggle
        checked={coaching.goals.finishWithinTargetDuration}
        label="Finish within the target duration"
        description={coaching.targetDurationSeconds === null
          ? 'Set a target duration above to use this.'
          : `Target ${formatTargetDuration(coaching.targetDurationSeconds)}.`}
        disabled={coaching.targetDurationSeconds === null}
        onchange={(value) => setGoal('finishWithinTargetDuration', value)}
      />
      <Toggle
        checked={coaching.goals.varietyWithinTargetBand}
        label="Keep variety inside the band"
        description={`${varietyBand.low}–${varietyBand.high}.`}
        onchange={(value) => setGoal('varietyWithinTargetBand', value)}
      />
      <Toggle
        checked={coaching.mode === 'review_only'}
        label="Review only — nothing live"
        description="Everything is still measured and waiting in the report. This is the Review only coaching mode."
        onchange={(value) => setMode(value ? 'review_only' : 'coach')}
      />
    </div>
  {/if}

  <!-- Retention ---------------------------------------------------------- -->
  <div class="group">
    <span class="mini-label">What is kept</span>
    <Toggle
      checked={coaching.postTakeReportEnabled}
      label="Save the post-take report"
      description="Your measurements for each take: pace, fillers, variety, tips shown."
      onchange={(value) => onchange({ postTakeReportEnabled: value })}
    />
    <Toggle
      checked={coaching.retainAudioRecordingEnabled}
      label="Keep an audio recording"
      description="Off by default. Saving a report does not save audio."
      onchange={(value) => onchange({ retainAudioRecordingEnabled: value })}
    />
    <div class="statement">
      {#each retentionLines as line (line)}
        <p class="statement-line">{line}</p>
      {/each}
      <p class="statement-line strong">
        Turning either of these off deletes what earlier takes already saved. It does not only stop
        saving from now on.
      </p>
    </div>
  </div>

  {#if !compact}
    <div class="group">
      <span class="mini-label">Personal calibration</span>
      <Toggle
        checked={coaching.personalCalibrationEnabled}
        label="Remember my voice between sessions"
        description="Learns your usual pitch range and loudness so variety is measured against you, not an average. Stored on this device and never sent anywhere."
        onchange={(value) => onchange({ personalCalibrationEnabled: value })}
      />
      <div class="inline-action">
        <Button size="sm" onclick={resetCalibration}>Reset personal calibration</Button>
        <span class="meta">
          {coaching.personalCalibrationResetAtEpochMs === null
            ? 'Never reset.'
            : `Last reset ${new Date(coaching.personalCalibrationResetAtEpochMs).toLocaleString()}.`}
        </span>
      </div>
      <p class="hint measure">
        Resetting discards what CandidCue has learned about your voice. It relearns from the next
        take; live adaptation works either way.
      </p>
    </div>
  {/if}
</div>

<style>
  .fields {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }
  .mini-label {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-secondary);
  }
  .hint {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    max-width: var(--prose-measure-narrow);
  }
  .measure {
    color: var(--text-secondary);
  }
  .range {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
    margin-top: var(--space-1);
  }
  .modules {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .goal-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .goal-value {
    max-width: 180px;
  }
  .inline-action {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .meta {
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  /* §32.2 statement. Leading rule is an inset ::before bar — never a
     one-sided border on a rounded box. */
  .statement {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    padding-inline-start: calc(var(--space-4) + 4px);
    border-radius: var(--radius-sm);
    background: var(--bg-secondary);
  }
  .statement::before {
    content: '';
    position: absolute;
    inset: var(--space-2) auto var(--space-2) var(--space-2);
    width: 2px;
    border-radius: var(--radius-pill);
    background: var(--accent);
  }
  .statement-line {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
    max-width: var(--prose-measure-narrow);
  }
  .statement-line.strong {
    color: var(--accent-strong);
    font-weight: 600;
  }
</style>
