<!--
  The conditional take-readiness sheet (CCUX-013).

  ---------------------------------------------------------------------------
  WHY THIS IS A DIALOG AND NOT A PAGE
  ---------------------------------------------------------------------------
  The Preflight PAGE was removed on purpose — it repeated one-time choices,
  people skipped it, and it became a gate nobody understood. Nothing here brings
  it back: a healthy setup reaches this only when somebody asks to review it,
  it never asks for a value Settings already owns, and every row is a statement
  of something that is already true rather than a control to fill in.

  It appears only when `resolveReadiness` says so, which on an ordinary take is
  never. That restraint is the feature; the rows are just how it explains
  itself when it does appear.

  ---------------------------------------------------------------------------
  READ TOP DOWN: VERDICT, THEN WHAT IS WRONG, THEN WHAT TO DO
  ---------------------------------------------------------------------------
  Somebody reading this is usually already in position. So the verdict leads —
  can this take start, yes, yes-but or no — with a mark whose SHAPE says which
  (a check, a triangle, a cross), because colour alone is not allowed to carry
  it. Each row then repeats its own severity the same way, and the one kind of
  row that stops the take also says so in words, so it can never read as one
  more warning.

  Headings over each kind were tried and cost the 980×680 window its footer:
  the densest blocked sheet scrolled "Back to the script" — its only way out —
  below the panel's height cap.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import StatusPill from './StatusPill.svelte';
  import { openMicrophonePrivacySettings, openSettingsWindow } from '../lib/open-settings';
  import { osCopy } from '../lib/os-copy';
  import {
    hasReadinessWarnings,
    summariseReadiness,
    type ReadinessFinding,
    type ReadinessSeverity,
    type ReadinessVerdict,
  } from '../lib/take-readiness';

  interface Props {
    verdict: ReadinessVerdict | null;
    /** Launch the held take. Never offered for a blocked one — there is nothing to launch. */
    onstart?: () => void;
    /**
     * Ask for the microphone, then check again (#303) — both "Allow microphone"
     * and the "Try again" beside a refusal, which must ask too: only a real
     * request can tell an allowed switch from a still-refused app.
     */
    onallowmicrophone?: () => Promise<void>;
    onclose: () => void;
  }

  let { verdict, onstart, onallowmicrophone, onclose }: Props = $props();

  const open = $derived(verdict !== null && verdict.show);

  /** What the sheet as a whole is saying. */
  type Tone = 'ready' | 'warning' | 'blocked';
  const tone: Tone = $derived(
    verdict?.blocked ? 'blocked' : verdict && hasReadinessWarnings(verdict) ? 'warning' : 'ready',
  );

  /*
   * Most severe first. The readiness module happens to emit them that way today;
   * the sheet does not rely on it, because a blocker below the fold of a long
   * list is exactly the mistake this surface exists to prevent.
   */
  const RANK: Record<ReadinessSeverity, number> = { blocking: 0, warning: 1, info: 2 };
  const findings = $derived(
    verdict === null
      ? []
      : [...verdict.findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]),
  );

  /*
   * The findings that leave a take with nothing following the voice. A pinned
   * microphone that is missing does not: the take falls back to the system
   * input. Nor does a microphone that has never been asked for — starting
   * anyway asks then, over the prompter, and an answer of yes still follows.
   */
  const VOICE_LOST = new Set([
    'model_missing',
    'model_installing',
    'model_damaged',
    'model_unsupported',
    'mic_permission_denied',
    'mic_permission_restricted',
  ]);

  /*
   * Said as the glass says it. A take with nothing following the voice does
   * NOT roll on its own — it holds until it is scrolled, or until A starts the
   * set-pace scroll (the stage's own "A — Auto-scroll" hint).
   */
  const voiceLost = $derived(tone === 'warning' && findings.some((f) => VOICE_LOST.has(f.id)));

  /** The verdict's second line: what happens next, said for this sheet. */
  const nextStep = $derived.by(() => {
    if (tone === 'ready') return 'Present when you’re in position.';
    if (tone === 'blocked') {
      if (findings.some((f) => f.id === 'script_silent')) {
        return 'Give the script something to read aloud, then present again.';
      }
      if (findings.some((f) => f.id === 'script_blocked')) {
        return 'Fix the script so it renders, then present again.';
      }
      return 'Fix what stops it, then present again.';
    }
    return findings.length === 1
      ? 'Fix it here, or start anyway as things are.'
      : 'Fix them here, or start anyway as things are.';
  });

  /*
   * A menu path is one thing to find — "System Settings → Privacy & Security →
   * Microphone" — and a line that starts with "& Security" reads as two. Keep
   * the ampersand with its words and each arrow with the step before it; the
   * line may still break after an arrow.
   */
  function keepPathsTogether(text: string): string {
    return text.replaceAll(' & ', '\u00a0&\u00a0').replaceAll(' → ', '\u00a0→ ');
  }

  const SEVERITY_WORD: Record<ReadinessSeverity, string> = {
    blocking: 'Stops this take',
    warning: 'Warning',
    info: 'Note',
  };
  const SEVERITY_ICON = { blocking: 'x', warning: 'alert', info: 'info' } as const;
  const VERDICT_ICON = { ready: 'check', warning: 'alert', blocked: 'x' } as const;

  /*
   * One microphone action at a time. "Allow" can hold the OS prompt open for as
   * long as the user takes to answer it, and a second click would queue a
   * second request behind it.
   */
  let micBusy = $state(false);
  /** Which remedy is waiting, so only its own button says so. */
  let micAsking: 'allow' | 'retry' | null = $state(null);
  /** What the last answer did, said beside the result rather than inferred from a row vanishing. */
  let micOutcome: 'allowed' | 'still-refused' | null = $state(null);
  /** The live announcement. Persistent, so a change to it is what gets read. */
  let announcement = $state('');
  /** Whose prompt "Allow" waits on — macOS asks; Windows never does. */
  const os = osCopy();

  let verdictEl: HTMLElement | null = $state(null);

  function micFinding(): ReadinessFinding | undefined {
    return verdict?.findings.find((f) => f.action?.microphone !== undefined);
  }

  async function runMicrophoneAction(
    kind: 'allow' | 'retry',
    action: (() => Promise<void>) | undefined,
  ): Promise<void> {
    if (!action || micBusy) return;
    const asked = verdict;
    const before = micFinding()?.id;
    micBusy = true;
    micAsking = kind;
    micOutcome = null;
    announcement = kind === 'allow' ? os.micPromptAnnouncement : 'Checking the microphone again.';
    try {
      await action();
    } finally {
      micBusy = false;
      micAsking = null;
    }
    // The re-check has replaced the verdict, or launched and closed the sheet.
    await tick();
    if (!open) return;
    /*
     * No new verdict means no answer: the microphone could not be opened at all
     * (nothing plugged in, or held by another app), which the caller reports as
     * a toast. Saying "still not allowed" over that would invent a refusal.
     */
    if (verdict === asked) {
      announcement = '';
      return;
    }
    const after = micFinding();
    if (after === undefined) {
      micOutcome = 'allowed';
      announcement = 'Microphone access allowed.';
    } else if (after.id === before) {
      micOutcome = 'still-refused';
      announcement = 'The microphone is still not allowed.';
    } else {
      announcement = after.detail;
    }
    /*
     * The remedy that had focus may be gone with its row. Focus then falls to
     * the body, where Tab and a screen reader both lose their place; the
     * verdict is the one element every version of the sheet still has.
     */
    const active = document.activeElement;
    if (verdictEl && (active === null || active === document.body || !active.isConnected)) {
      verdictEl.focus();
    }
  }

  // A sheet opened later starts clean.
  $effect(() => {
    if (!open) {
      micOutcome = null;
      announcement = '';
    }
  });
</script>

<Dialog {open} title="Before this take" onclose={onclose}>
  {#if verdict}
    <!--
      Focusable but never in the Tab order. The sheet opens here in every
      state: the verdict is what has to be read before any button means
      anything, and the alternatives were worse — the first remedy (which
      cannot unblock a blocked take), or "Back to the script" on a healthy
      review, the opposite of the decision being offered. Tab goes on to the
      first control. It is also where focus lands if the control that held it
      disappears with its row.
    -->
    <div class="verdict {tone}" tabindex="-1" data-autofocus bind:this={verdictEl}>
      <span class="verdict-mark" aria-hidden="true">
        <Icon name={VERDICT_ICON[tone]} size={tone === 'blocked' ? 18 : 17} />
      </span>
      <div class="verdict-text">
        <p class="verdict-title">{summariseReadiness(verdict)}</p>
        <p class="verdict-next">
          {#if voiceLost}
            Started now, it holds still until you scroll it by hand or press&nbsp;<kbd>A</kbd> for
            a set pace.
          {:else}
            {nextStep}
          {/if}
        </p>
      </div>
    </div>

    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>

    {#if micOutcome === 'allowed'}
      <p class="resolved">
        <span class="resolved-mark" aria-hidden="true"><Icon name="check" size={15} /></span>
        Microphone access allowed.
      </p>
    {/if}

    {#if findings.length > 0}
      <ul class="findings">
        {#each findings as finding (finding.id)}
          <li class="finding {finding.severity}">
            <span class="mark" aria-hidden="true">
              <Icon
                name={SEVERITY_ICON[finding.severity]}
                size={finding.severity === 'blocking' ? 12 : 17}
              />
            </span>
            <div class="finding-body">
              <!--
                The one row that stops the take says so in words, beside its
                name — the cross alone would be colour and shape, and a sheet
                that also holds warnings has to be readable without either.
              -->
              <div class="finding-head">
                <p class="finding-label">
                  {#if finding.severity !== 'blocking'}
                    <span class="sr-only">{SEVERITY_WORD[finding.severity]}: </span>
                  {/if}{finding.label}
                </p>
                {#if finding.severity === 'blocking'}
                  <StatusPill tone="danger" label="Stops this take" dot={false} />
                {/if}
              </div>
              <p class="finding-detail">{keepPathsTogether(finding.detail)}</p>
              {#if finding.action?.settingsSection}
                {@const section = finding.action.settingsSection}
                <div class="finding-actions">
                  <Button size="sm" onclick={() => void openSettingsWindow(section)}>
                    {finding.action.label}
                  </Button>
                </div>
              {:else if finding.action?.microphone === 'allow'}
                <div class="finding-actions" aria-busy={micAsking === 'allow'}>
                  <Button
                    size="sm"
                    disabled={micBusy}
                    onclick={() => void runMicrophoneAction('allow', onallowmicrophone)}
                  >
                    {micAsking === 'allow' ? os.micPromptWaiting : finding.action.label}
                  </Button>
                </div>
                {#if micAsking === 'allow'}
                  <!--
                    No promise to start: a review somebody asked for stays open
                    after the answer, and only a Present with nothing else to
                    say goes straight on.
                  -->
                  <p class="finding-note">{os.micPromptNote}</p>
                {/if}
              {:else if finding.action?.microphone === 'privacy'}
                <!--
                  #303. The pane is where a refusal is undone, and the user comes
                  back here afterwards — so the re-check sits beside it.
                -->
                <div class="finding-actions" aria-busy={micAsking === 'retry'}>
                  <Button size="sm" onclick={() => void openMicrophonePrivacySettings()}>
                    {finding.action.label}
                    <Icon name="external" size={13} />
                  </Button>
                  <Button
                    size="sm"
                    disabled={micBusy}
                    onclick={() => void runMicrophoneAction('retry', onallowmicrophone)}
                  >
                    {micAsking === 'retry' ? 'Checking…' : 'Try again'}
                  </Button>
                </div>
                {#if micOutcome === 'still-refused'}
                  <p class="finding-note">Still not allowed.</p>
                {/if}
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  {#snippet footer()}
    <!--
      The way out is the next step when nothing can start, so there it is a
      real button rather than the quiet one that sits beside a start.
    -->
    <Button variant={verdict?.blocked ? 'default' : 'ghost'} onclick={onclose}>
      Back to the script
    </Button>
    <!--
      A start whenever continuing is safe, which is the guide's rule and also
      the difference between this and a gate. A blocked take offers no such
      button because there is genuinely nothing to start — a take with no spoken
      words would open a stage over an empty token list and report health the
      whole way through.

      "Anyway" only when the sheet is warning about something. Somebody who
      asked to review a healthy setup is told it is ready, and "Start anyway"
      beside that reads as a check they failed (#283).
    -->
    {#if verdict && !verdict.blocked && onstart}
      <Button variant="primary" onclick={onstart}>
        {hasReadinessWarnings(verdict) ? 'Start anyway' : 'Present'}
      </Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  /* ---- Verdict ---- */

  /* Top-aligned: a third line of consequence must not drag the mark away
     from the headline it belongs to. */
  .verdict {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
  }
  /* A reading position, not a control: it takes focus only so a screen reader
     and the next Tab start from the verdict. */
  .verdict:focus {
    outline: none;
  }
  .verdict-mark {
    flex: 0 0 auto;
    /* Centred on a two-line verdict; level with the headline on a longer one. */
    margin-top: 4px;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
  }
  .verdict.ready .verdict-mark {
    background: var(--success-soft);
    color: var(--success);
  }
  .verdict.warning .verdict-mark {
    background: var(--warning-soft);
    color: var(--warning);
  }
  /* Solid, where the others are tinted: the one verdict that is not a choice. */
  .verdict.blocked .verdict-mark {
    background: var(--danger);
    color: var(--danger-contrast);
  }
  .verdict-text {
    min-width: 0;
  }
  .verdict-title {
    margin: 0;
    font-size: var(--text-base);
    line-height: 21px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .verdict-next {
    margin: 2px 0 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    text-wrap: pretty;
  }

  /* On the rows' own columns, so its words start where theirs do. */
  .resolved {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    column-gap: var(--space-3);
    align-items: center;
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--success);
  }

  .resolved-mark {
    display: grid;
    place-items: center;
  }

  /* Keys are words in the UI face here, as the shortcuts reference writes
     them — weight is enough to stop "press A" reading as "press a". */
  kbd {
    font: inherit;
    font-weight: 600;
    color: var(--text-primary);
  }

  /* ---- Findings ---- */

  /* Open rows between hairlines: the dialog is the only frame. */
  .findings {
    list-style: none;
    margin: 0;
    padding: 0;
    border-bottom: 1px solid var(--divider);
  }
  .finding {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    column-gap: var(--space-3);
    padding: 10px 0;
    border-top: 1px solid var(--divider);
  }

  .mark {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    /* Centred on the label's first line. */
    margin-top: -1px;
  }
  .finding.blocking .mark {
    border-radius: 50%;
    background: var(--danger);
    color: var(--danger-contrast);
  }
  /* Its head line is the pill's height; keep the cross on that line's centre. */
  .finding.blocking .mark {
    margin-top: 1px;
  }
  /*
   * A warning is warm, not red. Every warning row here describes a take that
   * will still run — differently, and knowably — and colouring "your model is
   * not installed" as danger would make the sheet read as a wall. Amber with a
   * triangle is how the editor says the same thing beside the script.
   */
  .finding.warning .mark {
    color: var(--warning);
  }
  .finding.info .mark {
    color: var(--text-muted);
  }

  .finding-body {
    min-width: 0;
  }
  .finding-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-2);
  }
  .finding-label {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-primary);
  }
  .finding-detail {
    margin: 2px 0 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    text-wrap: pretty;
  }
  .finding-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }
  .finding-note {
    margin: var(--space-2) 0 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    text-wrap: pretty;
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
</style>
