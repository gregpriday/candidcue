<!--
  The end-of-session summary (F.17), and it is deliberately NOT part of the Live
  route any more.

  ---------------------------------------------------------------------------
  WHY IT MOVED OUT OF LIVE
  ---------------------------------------------------------------------------
  A take now ends by going back to the editor. That is the whole point: the
  three things anybody wants when a take stops are this report, the script they
  just read, and another go — and the operator console Live falls back to when
  no session is running answered none of them. It was laid out for a two-window
  rig, so its centre pane is a scaled mirror of a prompter that was in this very
  window, and half its controls (Start, End session, Resume following, Nudge)
  offer to drive a take that is over.

  Nobody ever saw it during a take, because presentation mounts the stage over
  the whole window. It only appeared for the seconds between a take ending and
  somebody pressing one of these buttons — which is the one moment it has
  nothing useful to say.

  So `endTake` navigates to the editor under its own cover, and this report has
  to outlive that navigation. Hence: an app-level host beside ToastRegion and
  ConfirmHost, not a dialog owned by the route that raised it.

  ---------------------------------------------------------------------------
  IT READS THE SESSION; IT DOES NOT HOLD ONE
  ---------------------------------------------------------------------------
  `stopSession()` leaves `summary` populated, `active` false and everything else
  — script id, title — intact, and `clearSession()` is what finally puts the
  store back. That makes dismissal the thing that clears, whichever way it is
  dismissed, and means "Present again" can read the script id straight off the
  session that just ended rather than being handed one by a route.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import { clearSession, session } from '../stores/session';
  import { coverIsUp, presentingPhase } from '../stores/presenting';
  import { navigate } from '../stores/router';
  import { startTake } from '../lib/start-take';
  import { formatClock } from '../lib/format';
  import Disclosure from './Disclosure.svelte';
  import { sessionModeLabel } from '../../shared/take-vocabulary';
  import { FOLLOW_HEALTH_LABELS, resolveTakeOutcome } from '../lib/take-outcome';

  /*
   * Dismissal is a plain close, because the screen behind this dialog is
   * already the destination. It used to be a navigation — "Return to editor" —
   * and that was the right answer while the summary opened over an operator
   * console nobody wanted to be left on.
   */
  function dismiss(): void {
    clearSession();
  }

  async function returnToLibrary(): Promise<void> {
    // `navigate` resolves false when a guard refuses. Clearing anyway would
    // destroy the summary and leave the presenter on the screen they were not
    // allowed to leave, with nothing on it.
    if (await navigate({ name: 'library', view: 'all' })) clearSession();
  }

  /**
   * Straight into another take, from wherever this is being read.
   *
   * `startTake` navigates to the live route itself, so this does not — and it
   * REPORTS FAILURE rather than throwing. It catches the ordinary ones (the
   * script will not load, the compile fails, the window will not present),
   * toasts them and returns false without changing the route, which is now
   * exactly right: the summary is gone and the editor is already underneath.
   */
  async function presentAgain(): Promise<void> {
    const scriptId = $session.scriptId;
    clearSession();
    if (scriptId !== null) await startTake(scriptId);
  }

  /**
   * The conclusion, drawn once (CCUX-006).
   *
   * The measurements below it are unchanged and still exact — support and QA
   * need every one, and several exist because a specific failure was invisible
   * without them. What changed is that the presenter is no longer the one
   * expected to derive "did it hear me, and did it follow" from nineteen rows
   * while standing up from a camera.
   */
  const outcome = $derived(
    $session.summary === null
      ? null
      : resolveTakeOutcome({
          mode: $session.summary.mode,
          wordsHeard: $session.summary.wordsHeard,
          wordsInFlight: $session.summary.wordsInFlight,
          followingShare: $session.summary.followingShare,
          reconnects: $session.summary.reconnects,
          manualJumps: $session.summary.manualJumps,
          durationSeconds: $session.summary.durationSeconds,
          endingLocation: $session.summary.endingLocation,
        }),
  );
</script>

<!--
  NOT while the cover is up.

  `stopSession()` populates `summary` and clears `active` synchronously, so this
  condition becomes true the instant `endTake` starts — several awaits before
  the un-present finishes and the cover comes down. The cover is opaque and
  `pointer-events: none`, so a dialog mounted underneath it is invisible AND
  fully live: it traps focus, it answers Escape, and clicks land on its scrim.
  An Escape during the closing transition would have cleared the session under a
  black plate, before the presenter had seen a word of the report.

  So the summary waits for the transition it is the destination of.
-->
<Dialog
  open={!$session.active && $session.summary !== null && !coverIsUp($presentingPhase)}
  title="Take complete"
  onclose={dismiss}
>
  {#if $session.summary}
    {@const summary = $session.summary}

    <!--
      THE ANSWER, ABOVE THE EVIDENCE (CCUX-006).

      Nothing here judges the delivery, and it must stay that way: CandidCue can
      report whether it heard and whether it followed, and the two lanes that
      would bear on how the take went are documented as incomplete. Praise would
      be an invented measurement.
    -->
    {#if outcome}
      <div class="outcome {outcome.tone}">
        <p class="outcome-headline">{outcome.headline}</p>
        <p class="outcome-detail">{outcome.detail}</p>
        {#if outcome.suggestion}
          <p class="outcome-suggestion">{outcome.suggestion}</p>
        {/if}
      </div>

      <!--
        The five facts a presenter actually reads, in front of the disclosure.
        Everything else is instrumentation.
      -->
      <dl class="take-facts">
        <dt>Duration</dt>
        <dd>{formatClock(summary.durationSeconds)}</dd>
        <dt>Mode</dt>
        <dd>{sessionModeLabel(summary.mode)}</dd>
        <dt>Ended in</dt>
        <dd>{summary.endingLocation}</dd>
        <dt>Following</dt>
        <dd>{FOLLOW_HEALTH_LABELS[outcome.health]}</dd>
        {#if summary.transcriptSaved || summary.transcriptPartial}
          <!--
            Shown only when there IS a transcript to account for. "Not saved" on
            every take of a product whose default is not to save reports a
            setting working correctly as though it were an outcome.
          -->
          <dt>Transcript</dt>
          <dd>
            {summary.transcriptPartial ? 'Partly saved — some of it could not be written' : 'Saved'}
          </dd>
        {/if}
      </dl>
    {/if}

    <!--
      EVERY ORIGINAL ROW, INTACT (CCUX-007).

      Collapsed, not culled. These are the numbers that separate "the aligner
      lost you" from "the aligner followed you and the glass discarded every
      update" — unrelated faults with one symptom — and a support request is
      unanswerable without them.
    -->
    <Disclosure label="Take details">
    <dl class="summary-grid">
      <dt>Duration</dt>
      <dd>{formatClock(summary.durationSeconds)}</dd>
      <dt>Mode</dt>
      <!-- Named from the shared vocabulary, so the take the presenter just ran
           is called what the control that ran it was called. -->
      <dd>{sessionModeLabel(summary.mode)}</dd>
      <!-- The two rows that answer "did it actually work". Everything else
           here reads the same whether the microphone was live or the take was
           nine seconds of silence, which is why a take could look complete and
           have heard nothing at all. -->
      <dt>Words heard</dt>
      <dd>
        {summary.wordsHeard}
        {#if summary.wordsInFlight > 0}
          <!-- Finals only. A continuous read leaves the last utterance open,
               and the summary is taken before `endTurn` closes it — so this
               said "11" for a passage heard in full. -->
          + {summary.wordsInFlight} still being transcribed
        {/if}
        {#if summary.mode === 'voice' && summary.wordsHeard === 0 && summary.wordsInFlight === 0}
          <span class="summary-warn">— nothing was transcribed</span>
        {/if}
      </dd>
      <dt>Script followed</dt>
      <dd>
        {summary.wordsFollowed} of {summary.scriptWords} words
        {#if summary.scriptWords > 0}
          ({Math.round((summary.wordsFollowed / summary.scriptWords) * 100)}%)
        {/if}
      </dd>
      <!--
        THE NEXT THREE ROWS ONLY MEAN ANYTHING ACROSS A WINDOW BOUNDARY.
        ---------------------------------------------------------------------
        Stage updates, document travel and the transcript relay are all measured
        over the control→stage bridge, and that bridge is only built when the
        stage has its own window. Single-window presentation runs at stage
        generation 0, where `startStageBridge` returns immediately: directives
        are a documented no-op, no motion acks come back, no transcript taps are
        emitted. So on the configuration most takes actually run in, all three
        read empty — and the summary accused the app of three separate failures
        ("the stage did not report back", "the stage did not report a position",
        "words were heard but never offered to the stage") on every single
        healthy embedded take.

        Standing false alarms are worse than no diagnostic: they train the
        presenter to ignore the rows that would matter on the rig where these
        numbers are real. One honest line instead, and the real rows are kept
        intact for the case they were written for.
      -->
      {#if !summary.stageTelemetryExpected}
        <dt>Stage diagnostics</dt>
        <dd>Not applicable — the stage shared this window</dd>
      {:else}
        <!--
          The row that tells a lost aligner apart from a stage that ignored it.
          Both of the rows above are measured on the control side and agreed
          perfectly through a take where the script never moved.
        -->
        <dt>Stage updates</dt>
        <dd>
          {#if summary.stageApplied === null}
            {summary.updatesSent} sent — the stage did not report back
          {:else}
            {summary.stageApplied} of {summary.updatesSent} applied
            {#if summary.updatesSent - summary.stageApplied >= 4}
              <span class="summary-warn">— the stage was not following control</span>
            {/if}
          {/if}
        </dd>
        <!--
          The only row measured on the GLASS. Everything above it is control's own
          bookkeeping, which is how a take reported words heard, words followed
          and snapshots applied — all healthy — while the script never moved.
        -->
        <dt>Script moved</dt>
        <dd>
          {#if summary.documentTravelPx === null}
            the stage did not report a position
          {:else}
            {Math.round(summary.documentTravelPx)} px
            {#if summary.targetTravelPx !== null}
              (aimed at {Math.round(summary.targetTravelPx)} px)
            {/if}
            {#if summary.documentTravelPx < 20 && (summary.targetTravelPx ?? 0) >= 20}
              <span class="summary-warn">— the document never followed its target</span>
            {:else if summary.documentTravelPx < 20 && summary.wordsFollowed > 5}
              <span class="summary-warn">— the script did not move</span>
            {/if}
          {/if}
        </dd>
        <!--
          Whether the recogniser's own words reached the stage's transcript bar.
          The bar read "listening — no words yet" through a take that heard
          eleven, and nothing anywhere said which side dropped them.
        -->
        <dt>Transcript to stage</dt>
        <dd>
          {summary.transcriptTapsEmitted} of {summary.transcriptTapsSeen} sent
          {#if summary.transcriptTapFault !== null}
            <span class="summary-warn">— dropped: {summary.transcriptTapFault}</span>
          {:else if summary.transcriptTapsSeen === 0 && summary.wordsHeard > 0}
            <span class="summary-warn">— words were heard but never offered to the stage</span>
          {/if}
        </dd>
      {/if}
      <!--
        How hard following actually worked.

        Everything else on this list describes the take; these two describe the
        APP's part in it, which is the question somebody has walking back from
        the camera and the one the summary could not answer. A take that
        transcribed a thousand words and held for half its length reads exactly
        like a clean one on every other row here.
      -->
      <dt>Followed</dt>
      <dd>
        {#if summary.followingShare === null}
          No tracking this take
        {:else}
          {Math.round(summary.followingShare * 100)}% of the take
          {#if summary.followingShare < 0.6}
            <span class="summary-warn">— the stage spent most of it holding</span>
          {/if}
        {/if}
      </dd>
      <dt>Manual jumps</dt>
      <dd>{summary.manualJumps}</dd>
      <dt>Sections reached</dt>
      <dd>{summary.sectionsReached}</dd>
      <dt>Retakes</dt>
      <dd>{summary.retakes}</dd>
      <dt>Reconnects</dt>
      <dd>{summary.reconnects}</dd>
      <dt>Ending location</dt>
      <dd>{summary.endingLocation}</dd>
      <dt>Transcript</dt>
      <!--
        Read from the take, not hard-coded. `transcriptSaved` has been on the
        summary and correctly computed from the retention setting since the
        session record was wired up; this row simply never asked for it, so a
        presenter who had deliberately turned transcript saving ON was still
        told every take that nothing had been kept.
      -->
      <!--
        Three answers, not two. "Saved" used to be the RETENTION SETTING, so a
        take whose appends failed reported it over a transcript with a hole in
        it — and this screen is where somebody would ever find out.
      -->
      <dd>
        {summary.transcriptPartial
          ? 'Partly saved — some of it could not be written'
          : summary.transcriptSaved
            ? 'Saved'
            : 'Not saved'}
      </dd>
    </dl>
    </Disclosure>
  {/if}

  {#snippet footer()}
    <!--
      Two destinations and a dismissal, which is one fewer than this had.
      "Return to editor" named a place the presenter is now already standing in,
      so it did nothing visible and read as the safe default — the worst
      combination available for the button most people were going to press.
    -->
    <Button variant="ghost" onclick={() => void returnToLibrary()}>Return to library</Button>
    <Button onclick={dismiss}>Back to the script</Button>
    <Button variant="primary" onclick={() => void presentAgain()}>Present again</Button>
  {/snippet}
</Dialog>

<style>
  /* "Nothing was transcribed" is the one line here that is a problem rather
     than a statistic, so it reads as one. */
  .summary-warn {
    /*
     * `--text-danger` has never existed, so every warning span on this summary
     * fell through to the fallback and rendered in the brand accent — the same
     * warm terracotta the mode pill and the primary button use. The app's way
     * of saying "this take did not work" was indistinguishable from its way of
     * saying "this is CandidCue". `--danger` is the real token and is defined
     * in both themes.
     */
    color: var(--danger);
    font-weight: 550;
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

  /*
   * The outcome card (CCUX-006).
   *
   * It carries the conclusion, so it is the one element on this dialog with any
   * weight. The tones are deliberately restrained — `attention` is warm rather
   * than red, because "following needed help" and "the connection dropped" are
   * conditions to understand, not failures to be alarmed by, and the product's
   * whole posture is that holding is the system working.
   */
  .outcome {
    position: relative;
    padding: var(--space-3) var(--space-4) var(--space-3) var(--space-5);
    margin-bottom: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
  }
  /* Inset bar, never a one-sided border on a rounded box. */
  .outcome::before {
    content: '';
    position: absolute;
    left: 6px;
    top: var(--space-3);
    bottom: var(--space-3);
    width: 3px;
    border-radius: var(--radius-pill);
    background: var(--text-faint);
  }
  .outcome.good::before {
    background: var(--success);
  }
  .outcome.attention::before {
    background: var(--accent);
  }
  .outcome-headline {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 650;
    color: var(--text-primary);
  }
  .outcome-detail {
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm);
    line-height: 1.45;
    color: var(--text-secondary);
  }
  .outcome-suggestion {
    margin: var(--space-2) 0 0;
    font-size: var(--text-sm);
    line-height: 1.45;
    color: var(--text-muted);
  }

  .take-facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--space-1) var(--space-5);
    margin: 0 0 var(--space-3);
  }
  .take-facts dt {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .take-facts dd {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
</style>
