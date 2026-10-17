<!--
  The conditional take-readiness sheet (CCUX-013).

  ---------------------------------------------------------------------------
  WHY THIS IS A DIALOG AND NOT A PAGE
  ---------------------------------------------------------------------------
  The Preflight PAGE was removed on purpose — it repeated one-time choices,
  people skipped it, and it became a gate nobody understood. Nothing here brings
  it back: this cannot be reached on a healthy setup, it never asks for a value
  Settings already owns, and every row is a statement of something that is
  already true rather than a control to fill in.

  It appears only when `resolveReadiness` says so, which on an ordinary take is
  never. That restraint is the feature; the rows are just how it explains
  itself when it does appear.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import { openMicrophonePrivacySettings, openSettingsWindow } from '../lib/open-settings';
  import { summariseReadiness, type ReadinessVerdict } from '../lib/take-readiness';

  interface Props {
    verdict: ReadinessVerdict | null;
    /** Launch anyway. Absent for a blocked take — there is nothing to launch. */
    onstart?: () => void;
    /** Ask the OS for the microphone, then check again (#303). */
    onallowmicrophone?: () => Promise<void>;
    /** Check this launch again — after a change made in System Settings. */
    onrecheck?: () => Promise<void>;
    onclose: () => void;
  }

  let { verdict, onstart, onallowmicrophone, onrecheck, onclose }: Props = $props();

  /*
   * One microphone action at a time. "Allow" can hold the OS prompt open for as
   * long as the user takes to answer it, and a second click would queue a
   * second request behind it.
   */
  let micBusy = $state(false);

  async function runMicrophoneAction(action: (() => Promise<void>) | undefined): Promise<void> {
    if (!action || micBusy) return;
    micBusy = true;
    try {
      await action();
    } finally {
      micBusy = false;
    }
  }
</script>

<Dialog open={verdict !== null && verdict.show} title="Before this take" onclose={onclose}>
  {#if verdict}
    <p class="lead">{summariseReadiness(verdict)}</p>

    {#if verdict.findings.length > 0}
      <ul class="findings">
        {#each verdict.findings as finding (finding.id)}
          <li class="finding {finding.severity}">
            <p class="finding-label">{finding.label}</p>
            <p class="finding-detail">{finding.detail}</p>
            {#if finding.action?.settingsSection}
              {@const section = finding.action.settingsSection}
              <Button size="sm" onclick={() => void openSettingsWindow(section)}>
                {finding.action.label}
              </Button>
            {:else if finding.action?.microphone === 'allow'}
              <Button
                size="sm"
                disabled={micBusy}
                onclick={() => void runMicrophoneAction(onallowmicrophone)}
              >
                {finding.action.label}
              </Button>
            {:else if finding.action?.microphone === 'privacy'}
              <!--
                #303. The pane is where a refusal is undone, and the user comes
                back here afterwards — so the re-check sits beside it.
              -->
              <div class="finding-actions">
                <Button size="sm" onclick={() => void openMicrophonePrivacySettings()}>
                  {finding.action.label}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={micBusy}
                  onclick={() => void runMicrophoneAction(onrecheck)}
                >
                  Try again
                </Button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>Back to the script</Button>
    <!--
      "Start anyway" whenever continuing is safe, which is the guide's rule and
      also the difference between this and a gate. A blocked take offers no such
      button because there is genuinely nothing to start — a take with no spoken
      words would open a stage over an empty token list and report health the
      whole way through.
    -->
    {#if verdict && !verdict.blocked && onstart}
      <Button variant="primary" onclick={onstart}>Start anyway</Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .lead {
    margin: 0 0 var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .findings {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* Inset bar, never a one-sided border on a rounded box. */
  .finding {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
  }
  .finding::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 8px;
    bottom: 8px;
    width: 3px;
    border-radius: var(--radius-pill);
    background: var(--text-faint);
  }
  /*
   * A warning is warm, not red. Every warning row here describes a take that
   * will still run — differently, and knowably — and colouring "your model is
   * not installed" as danger would make the sheet read as a wall.
   */
  .finding.warning::before {
    background: var(--accent);
  }
  .finding.blocking::before {
    background: var(--danger);
  }

  .finding-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .finding-label {
    margin: 0;
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: var(--ls-caps);
    color: var(--text-faint);
  }
  .finding-detail {
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.45;
    color: var(--text-primary);
  }
</style>
