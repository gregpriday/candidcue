<!--
  Live control screen (spec §15) in the dark studio theme: top status bar,
  outline / stage preview / diagnostics regions, always-visible bottom
  transport, §15.3 pause semantics, F.17 end-of-session summary.
-->
<script lang="ts">
  import Button from '../components/Button.svelte';
  import Dialog from '../components/Dialog.svelte';
  import FollowControls from '../components/FollowControls.svelte';
  import FollowDiagnostics from '../components/FollowDiagnostics.svelte';
  import FollowStatePanel from '../components/FollowStatePanel.svelte';
  import Icon from '../components/Icon.svelte';
  import IconButton from '../components/IconButton.svelte';
  import OverflowMenu from '../components/OverflowMenu.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import Slider from '../components/Slider.svelte';
  import { formatClock } from '../lib/format';
  import { onShortcut } from '../lib/shortcuts';
  import * as stageService from '../services/stage';
  import { requestConfirm } from '../stores/confirm';
  import { navigate } from '../stores/router';
  import {
    addTakeMarker,
    adjustStageFontSize,
    clearSession,
    hardPause,
    liveStatusLabel,
    moveSentences,
    pauseListening,
    restartParagraph,
    resumeSession,
    session,
    startPrompting,
    stopSession,
    toggleBlankStage,
    toggleListenerVisible,
    togglePlayPause,
    toggleStageMirror,
    toggleVoiceFollow,
  } from '../stores/session';
  import { settings } from '../stores/settings';
  import { smoothFollow, type FollowNotice } from '../stores/smooth-follow';
  import { showToast } from '../stores/toasts';
  import type { OutlineNode } from '../../shared/contracts';

  interface Props {
    sessionId: string;
    scriptId: string;
  }
  let { sessionId, scriptId }: Props = $props();

  let costOpen = $state(false);
  let manualWpm = $state(150);

  const stageFontSize = $derived($session.stageFontSizePx);

  const snapshot = $derived($session.snapshot);
  const modeLabel = $derived(
    $session.mode === 'voice' ? 'Voice' : $session.mode === 'manual' ? 'Manual' : 'Fixed',
  );

  const flatOutline = $derived(flatten($session.outline));
  const currentSectionIndex = $derived(
    snapshot
      ? flatOutline.reduce(
          (acc, entry, index) => (entry.node.startTokenIndex <= snapshot.tokenIndex ? index : acc),
          -1,
        )
      : -1,
  );

  const sentenceIndex = $derived(
    snapshot ? $session.sentences.findIndex((s) => s.id === snapshot.sentenceId) : -1,
  );

  const previewWindow = $derived.by(() => {
    if ($session.sentences.length === 0 || sentenceIndex < 0) return [];
    const start = Math.max(0, sentenceIndex - 2);
    return $session.sentences.slice(start, sentenceIndex + 4).map((sentence, i) => ({
      sentence,
      offset: start + i - sentenceIndex,
    }));
  });

  const estimatedCost = $derived(
    (Math.round(($session.elapsedSeconds / 60) * 0.6) / 100).toFixed(2),
  );

  const currentSectionTitle = $derived(
    currentSectionIndex >= 0 ? (flatOutline[currentSectionIndex]?.node.title ?? null) : null,
  );

  /** Degraded-state actions (Part XI) offered next to the notice itself. */
  function handleNoticeAction(action: NonNullable<FollowNotice['action']>): void {
    if (action.id === 'rebuild_layout') {
      smoothFollow.requestLayoutRebuild();
      return;
    }
    void navigate({ name: 'settings', section: 'following' });
  }

  function flatten(nodes: OutlineNode[], depth = 0): Array<{ node: OutlineNode; depth: number }> {
    const out: Array<{ node: OutlineNode; depth: number }> = [];
    for (const node of nodes) {
      out.push({ node, depth });
      out.push(...flatten(node.children, depth + 1));
    }
    return out;
  }

  function jumpToSection(node: OutlineNode): void {
    if ($session.sentences.length === 0 || sentenceIndex < 0) return;
    const targetIndex = $session.sentences.findIndex(
      (s) => s.startTokenIndex >= node.startTokenIndex,
    );
    if (targetIndex >= 0) {
      moveSentences(targetIndex - sentenceIndex);
      showToast(node.title, 'info');
    }
  }

  async function requestStop(): Promise<void> {
    if ($settings.general.confirmEndSession) {
      const accepted = await requestConfirm({
        title: 'Stop the session?',
        body: 'The realtime connection closes and the stage leaves full screen. Your script keeps its place.',
        confirmLabel: 'Stop session',
        danger: true,
      });
      if (!accepted) return;
    }
    stopSession();
  }

  function adjustFontSize(delta: number): void {
    const next = adjustStageFontSize(delta);
    showToast(`Text ${next} px`, 'info', { durationMs: 1600 });
  }

  function toggleMirror(): void {
    toggleStageMirror('x');
    showToast('Text mirrored', 'info', { durationMs: 1600 });
  }

  function toggleListener(): void {
    const visible = toggleListenerVisible();
    showToast(visible ? 'Listener on' : 'Listener off', 'info', { durationMs: 1600 });
  }

  $effect(() =>
    onShortcut((action) => {
      switch (action) {
        case 'play-pause':
          togglePlayPause();
          break;
        case 'hard-pause':
          hardPause();
          break;
        case 'stop-session':
          void requestStop();
          break;
        case 'back-sentence':
          moveSentences(-1);
          break;
        case 'forward-sentence':
          moveSentences(1);
          break;
        case 'prev-chapter':
          if (currentSectionIndex > 0) jumpToSection(flatOutline[currentSectionIndex - 1]!.node);
          break;
        case 'next-chapter':
          if (currentSectionIndex < flatOutline.length - 1)
            jumpToSection(flatOutline[currentSectionIndex + 1]!.node);
          break;
        case 'stage-text-up':
          adjustFontSize(2);
          break;
        case 'stage-text-down':
          adjustFontSize(-2);
          break;
        case 'toggle-mirror':
          toggleMirror();
          break;
        case 'blank-stage':
          toggleBlankStage();
          break;
        case 'toggle-listener':
          toggleListener();
          break;
        case 'take-marker':
          addTakeMarker();
          showToast('Take marker added', 'info', { durationMs: 1600 });
          break;
        default:
          break;
      }
    }),
  );

  async function presentAgain(): Promise<void> {
    clearSession();
    await navigate({ name: 'preflight', scriptId });
  }

  async function returnToEditor(): Promise<void> {
    clearSession();
    await navigate({ name: 'editor', scriptId });
  }

  async function closeStageAndFinish(): Promise<void> {
    await stageService.closeStage(sessionId);
    clearSession();
    await navigate({ name: 'library', view: 'all' });
  }
</script>

<div class="live">
  <!-- Top status bar (§15.1) -->
  <header class="statusbar">
    <div class="status-left">
      <span class="live-dot" class:paused={$session.paused !== 'none' || !$session.prompting}></span>
      <span class="script-title">{$session.scriptTitle}</span>
      <span class="elapsed">{formatClock($session.elapsedSeconds)}</span>
      <!-- F.11 session status; the follow state itself lives in the Tracking panel. -->
      <span class="session-status" role="status" aria-live="polite">{$liveStatusLabel}</span>
    </div>
    <div class="status-right">
      <StatusPill tone="accent" label={modeLabel} dot={false} />
      <StatusPill
        tone={$session.connection === 'connected' ? 'success' : 'warning'}
        label={$session.connection === 'connected' ? 'Connected' : 'Reconnecting'}
      />
      <StatusPill
        tone={$session.micState === 'live' ? 'success' : $session.micState === 'muted' ? 'neutral' : 'danger'}
        label={$session.micState === 'live' ? 'Mic live' : $session.micState === 'muted' ? 'Mic off' : 'Mic lost'}
      />
      <span class="display-name">{$session.displayLabel}</span>
      <div class="cost">
        <IconButton icon="info" label="Estimated session cost" active={costOpen} onclick={() => (costOpen = !costOpen)} />
        {#if costOpen}
          <div class="cost-pop">
            <p class="cost-line">Estimated OpenAI transcription cost</p>
            <p class="cost-value">≈ ${estimatedCost}</p>
            <p class="cost-note">An estimate based on elapsed realtime minutes. Rates can change.</p>
          </div>
        {/if}
      </div>
    </div>
  </header>

  <!-- Main three-region area (§15.1) -->
  <div class="main">
    <aside class="outline" aria-label="Sections">
      <p class="region-label">Sections</p>
      {#if flatOutline.length > 0}
        <ul class="outline-list">
          {#each flatOutline as entry, index (entry.node.id)}
            <li>
              <button
                type="button"
                class="outline-item"
                class:current={index === currentSectionIndex}
                style="padding-left: {10 + entry.depth * 12}px"
                onclick={() => jumpToSection(entry.node)}
              >
                {entry.node.title}
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="region-empty">No headings in this script.</p>
      {/if}
    </aside>

    <section class="preview" aria-label="Stage preview">
      {#if $session.stageBlanked}
        <div class="blanked">
          <Icon name="eye-off" size={22} />
          <p>Stage blanked</p>
        </div>
      {:else if previewWindow.length > 0}
        <div class="preview-text">
          {#each previewWindow as entry (entry.sentence.id)}
            <p
              class="preview-sentence"
              class:past={entry.offset < 0}
              class:current={entry.offset === 0}
            >
              {entry.sentence.normalizedText}
            </p>
          {/each}
        </div>
      {:else}
        <div class="preview-placeholder">
          <p class="ph-title">Stage preview</p>
          <p class="ph-note">
            The scaled stage view appears here once the compiled script is available.
            {#if snapshot}Cursor at token {snapshot.tokenIndex}.{/if}
          </p>
        </div>
      {/if}
    </section>

    <aside class="diagnostics" aria-label="Tracking">
      <p class="region-label">Tracking</p>
      <FollowStatePanel
        follow={$smoothFollow}
        sectionTitle={currentSectionTitle}
        onnoticeaction={handleNoticeAction}
      />

      <p class="region-label">Following</p>
      <FollowControls follow={$smoothFollow} />

      <FollowDiagnostics
        follow={$smoothFollow}
        developerMode={$settings.following.developerDiagnostics}
      />

      <p class="region-label">Transcript</p>
      {#if $session.transcriptTail.length > 0}
        <div class="transcript-tail">
          {#each $session.transcriptTail as line, index (index)}
            <p class="tail-line" class:latest={index === $session.transcriptTail.length - 1}>{line}</p>
          {/each}
        </div>
      {:else}
        <p class="region-empty">Speak and the latest transcript appears here.</p>
      {/if}

      <p class="region-label">Stage</p>
      <div class="quick-controls">
        <div class="font-row">
          <IconButton icon="chevron-down" label="Decrease stage text" onclick={() => adjustFontSize(-2)} />
          <span class="font-value">{stageFontSize} px</span>
          <IconButton icon="chevron-up" label="Increase stage text" onclick={() => adjustFontSize(2)} />
        </div>
        <Button size="sm" onclick={() => toggleMirror()}>Mirror text</Button>
        <Button size="sm" onclick={() => toggleListener()}>Listener</Button>
      </div>

      {#if $session.mode !== 'voice' || !$session.voiceFollow}
        <Slider label="Manual speed" bind:value={manualWpm} min={60} max={260} format={(v) => `${v} wpm`} />
      {/if}
    </aside>
  </div>

  <!-- Bottom transport (§15.1) — always visible -->
  <footer class="transport">
    <div class="transport-left">
      {#if !$session.prompting}
        <Button variant="primary" onclick={() => startPrompting()}>
          <Icon name="play" size={16} />
          Start
        </Button>
      {:else if $session.paused === 'none'}
        <div class="pause-split">
          <Button onclick={() => pauseListening()}>
            <Icon name="pause" size={16} />
            Pause
          </Button>
          <OverflowMenu
            label="Pause options"
            items={[
              {
                label: 'Hard pause — mic off, resume by click only',
                onselect: () => hardPause(),
              },
            ]}
          />
        </div>
      {:else}
        <Button variant="primary" onclick={() => resumeSession()}>
          <Icon name="play" size={16} />
          Resume
        </Button>
      {/if}
      <Button variant="danger" onclick={() => requestStop()}>
        <Icon name="stop" size={14} />
        Stop session
      </Button>
    </div>

    <div class="transport-center">
      <IconButton icon="chevron-left" label="Back one sentence" onclick={() => moveSentences(-1)} />
      <IconButton icon="chevron-right" label="Forward one sentence" onclick={() => moveSentences(1)} />
      <IconButton icon="restore" label="Restart paragraph" onclick={() => restartParagraph()} />
      <IconButton
        icon="flag"
        label="Add take marker"
        onclick={() => {
          addTakeMarker();
          showToast('Take marker added', 'info', { durationMs: 1600 });
        }}
      />
      <IconButton
        icon="eye-off"
        label={$session.stageBlanked ? 'Unblank stage' : 'Blank stage'}
        active={$session.stageBlanked}
        onclick={() => toggleBlankStage()}
      />
    </div>

    <div class="transport-right">
      <label class="voice-follow">
        <input
          type="checkbox"
          checked={$session.voiceFollow}
          onchange={() => toggleVoiceFollow()}
        />
        <span>Voice follow</span>
      </label>
    </div>
  </footer>
</div>

<!-- End-of-session summary (F.17) -->
<Dialog
  open={!$session.active && $session.summary !== null}
  title="Session complete"
  onclose={() => void returnToEditor()}
>
  {#if $session.summary}
    {@const summary = $session.summary}
    <dl class="summary-grid">
      <dt>Duration</dt>
      <dd>{formatClock(summary.durationSeconds)}</dd>
      <dt>Mode</dt>
      <dd>{summary.mode === 'voice' ? 'Voice follow' : summary.mode === 'manual' ? 'Manual' : 'Fixed speed'}</dd>
      <dt>Sections reached</dt>
      <dd>{summary.sectionsReached}</dd>
      <dt>Retakes</dt>
      <dd>{summary.retakes}</dd>
      <dt>Commands</dt>
      <dd>{summary.commands}</dd>
      <dt>Reconnects</dt>
      <dd>{summary.reconnects}</dd>
      <dt>Ending location</dt>
      <dd>{summary.endingLocation}</dd>
      <dt>OpenAI cost</dt>
      <dd>≈ ${summary.estimatedCostUsd.toFixed(2)} (estimate)</dd>
      <dt>Transcript</dt>
      <dd>Not saved</dd>
    </dl>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => void closeStageAndFinish()}>Close stage</Button>
    <Button onclick={() => void returnToEditor()}>Return to editor</Button>
    <Button variant="primary" onclick={() => void presentAgain()}>Present again</Button>
  {/snippet}
</Dialog>

<style>
  .live {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-app);
    color: var(--text-primary);
  }

  /* --- status bar --- */
  .statusbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-5);
    background: var(--bg-chrome);
    border-bottom: 1px solid var(--border);
  }
  .status-left {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .live-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--live);
    flex: 0 0 auto;
  }
  .live-dot.paused {
    background: var(--text-faint);
  }
  .script-title {
    font-size: var(--text-base);
    font-weight: 650;
    letter-spacing: var(--ls-title);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .elapsed {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .status-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 0 0 auto;
  }
  .display-name {
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .cost {
    position: relative;
  }
  .cost-pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    width: 240px;
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-pop);
  }
  .cost-line {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .cost-value {
    margin: var(--space-1) 0;
    font-size: var(--text-2xl);
    font-weight: 650;
    font-variant-numeric: tabular-nums;
  }
  .cost-note {
    margin: 0;
    font-size: var(--text-2xs);
    color: var(--text-muted);
    line-height: 1.4;
  }

  /* --- main regions --- */
  .main {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr) 304px;
  }
  @media (max-width: 1100px) {
    .main {
      grid-template-columns: minmax(0, 1fr) 288px;
    }
    .outline {
      display: none;
    }
  }

  .region-label {
    margin: 0 0 var(--space-2);
    font-size: var(--text-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--ls-caps);
    color: var(--text-muted);
  }
  .region-empty {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-faint);
    line-height: 1.5;
  }

  .outline {
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-4);
    background: var(--bg-chrome);
    border-right: 1px solid var(--border);
  }
  .outline-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .outline-item {
    position: relative;
    display: block;
    width: 100%;
    min-height: 30px;
    padding: var(--space-1) 10px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .outline-item:hover {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }
  /* Current section: inset accent bar (never a one-sided border on the box). */
  .outline-item.current {
    background: var(--bg-selected);
    color: var(--text-primary);
    font-weight: 600;
  }
  .outline-item.current::before {
    content: '';
    position: absolute;
    left: 3px;
    top: 6px;
    bottom: 6px;
    width: 3px;
    border-radius: var(--radius-pill);
    background: var(--accent);
  }

  /* --- stage preview --- */
  .preview {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-6);
    background: var(--bg-sunken);
  }
  .preview-text {
    max-width: var(--prose-measure-narrow);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .preview-sentence {
    margin: 0;
    font-size: var(--text-live-question);
    line-height: var(--text-live-question-leading);
    font-weight: 500;
    color: var(--text-secondary);
    transition: color var(--dur-med) var(--ease-out), opacity var(--dur-med) var(--ease-out);
  }
  .preview-sentence.past {
    opacity: 0.4;
  }
  .preview-sentence.current {
    color: var(--text-primary);
  }

  .preview-placeholder {
    text-align: center;
    max-width: 340px;
  }
  .ph-title {
    margin: 0 0 var(--space-2);
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-secondary);
  }
  .ph-note {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
    line-height: var(--lh-label);
  }

  .blanked {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-faint);
  }
  .blanked p {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  /* --- diagnostics --- */
  .diagnostics {
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--bg-chrome);
    border-left: 1px solid var(--border);
  }
  .session-status {
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .transcript-tail {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .tail-line {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-muted);
  }
  .tail-line.latest {
    color: var(--prose-text-warm);
  }

  .quick-controls {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .font-row {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }
  .font-value {
    min-width: 46px;
    text-align: center;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  /* --- transport --- */
  .transport {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-5);
    background: var(--bg-chrome);
    border-top: 1px solid var(--border);
    box-shadow: var(--shadow-transport);
  }
  .transport-left,
  .transport-center,
  .transport-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .pause-split {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .voice-follow {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--space-1) var(--space-5);
    margin: 0;
  }
  .summary-grid dt {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .summary-grid dd {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }
</style>
