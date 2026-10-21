<!--
  The external-change conflict sheet (F.8): "This script changed on disk".

  The author meets this mid-sentence. Another program rewrote the file, every
  autosave since has been refused, and the text in front of them exists nowhere
  else. The sheet has three jobs, in this order: say that saving has stopped
  and the text is safe in this window, show how the two versions actually
  differ, and say — before the click — where the version that is not kept
  will be.

  It used to do only the last, in one monospaced paragraph, and asked for a
  choice between two versions it never showed.

  THE COMPARISON
  The disk version is on the left and the editor's on the right: the order a
  compare view uses, and the order of the two buttons below. Each paragraph
  that differs is one row under the heading it sits in, with the words only
  that version has marked. The preview trims each paragraph to the sentences
  that changed and shows the first few places; one control shows every place
  whole, so nothing a choice affects is out of reach. The consequence of each
  choice closes its column, under the version it keeps, and starts with the
  button's own label.

  The file is read when the sheet opens. Neither choice is offered until it
  has been, because both arms read it first and would fail the same way; a
  read that fails offers a retry and a way to take the text out instead.

  THE FOOTER
  One band, as in the revision browser: what is happening on the left — the
  arm in flight, why the last one failed, or whether the text was copied — and
  the way out and the choices on the right.

  The arms themselves live in the editor route, which owns the toasts and the
  navigation that report them; this owns what the author sees while deciding.
-->
<script lang="ts" module>
  export type ConflictArm = 'disk' | 'keep';

  /** Why an arm did not land, as the footer band reports it. */
  export interface ConflictFailure {
    /**
     * `warning` when nothing went wrong but the ground moved (the file changed
     * again); `danger` when an arm itself failed.
     */
    tone: 'warning' | 'danger';
    title: string;
    detail: string;
  }
</script>

<script lang="ts">
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import { compareVersions, type Passage } from '../lib/version-diff';
  import { describeError } from '../services/errors';
  import * as scriptsService from '../services/scripts';

  interface Props {
    open: boolean;
    scriptId: string;
    /** The editor's title and text — the only copy of the text until an arm lands. */
    title: string;
    source: string;
    /** What the editor's text is filed as if the disk version wins. */
    copyName: string;
    /** The arm in flight, if any. */
    busy: ConflictArm | null;
    /** Why the last arm failed. The sheet stays up with this beside the choice. */
    failure: ConflictFailure | null;
    /** Bumped by the route when the file must be read again (it changed again). */
    reread: number;
    /** Each arm is handed the disk text the author was shown, so it can refuse a different one. */
    onusedisk: (reviewed: string) => void;
    onkeep: (reviewed: string) => void;
    onclose: () => void;
  }

  let {
    open,
    scriptId,
    title,
    source,
    copyName,
    busy,
    failure,
    reread,
    onusedisk,
    onkeep,
    onclose,
  }: Props = $props();

  const uid = $props.id();

  type DiskRead =
    | { status: 'loading' }
    | { status: 'ready'; title: string; source: string }
    | { status: 'failed'; reason: string };

  /*
   * The file as it is now.
   *
   * `get_script` is what both arms call first anyway, and reading it is what
   * records the external version as a revision — so describing it here costs
   * nothing the choice was not already going to do. It is read, never adopted:
   * the editor's buffer is untouched until an arm succeeds.
   */
  let disk = $state<DiskRead>({ status: 'loading' });
  let generation = 0;
  /** Every place, every paragraph whole — or the trimmed preview. */
  let expanded = $state(false);
  let copied = $state<'idle' | 'copied' | 'failed'>('idle');
  let lead = $state<HTMLElement | null>(null);

  function read(id: string): void {
    const mine = ++generation;
    disk = { status: 'loading' };
    copied = 'idle';
    scriptsService.getScript(id).then(
      (doc) => {
        if (mine === generation) disk = { status: 'ready', title: doc.title, source: doc.source };
      },
      (err: unknown) => {
        if (mine === generation) disk = { status: 'failed', reason: describeError(err) };
      },
    );
  }

  $effect(() => {
    if (!open) return;
    void reread;
    expanded = false;
    read(scriptId);
  });

  /** Try again removes the button that was pressed; the reading position is the lead. */
  function retry(): void {
    read(scriptId);
    lead?.focus();
  }

  /*
   * Copy the editor's text out, and say so HERE.
   *
   * The route's own copy reports through a toast, which sits outside this
   * modal; at the moment the file cannot be read, whether this worked is the
   * one thing the author most needs to see.
   */
  async function copyText(): Promise<void> {
    try {
      await navigator.clipboard.writeText(source);
      copied = 'copied';
    } catch {
      copied = 'failed';
    }
  }

  const comparison = $derived(
    disk.status === 'ready'
      ? compareVersions(
          { title: disk.title, source: disk.source },
          { title, source },
          expanded ? { limit: Number.POSITIVE_INFINITY, full: true } : {},
        )
      : null,
  );
  const identical = $derived(comparison?.identical ?? false);
  const shown = $derived(comparison?.differences.length ?? 0);
  const total = $derived(comparison?.total ?? 0);
  /** The preview leaves something out, so the control to see it all is offered. */
  const partial = $derived(comparison !== null && (total > shown || comparison.trimmed));
  const reviewed = $derived(disk.status === 'ready' ? disk.source : null);
  const locked = $derived(busy !== null);

  const working = $derived(
    busy === 'disk'
      ? identical
        ? 'Picking up the file…'
        : 'Saving a copy of your edits…'
      : busy === 'keep'
        ? 'Saving your edits to the file…'
        : '',
  );

  function places(n: number): string {
    return n === 1 ? 'one place' : `${n} places`;
  }

  /** What the polite region says: the work in hand, else the copy, else the read. */
  const announcement = $derived.by(() => {
    if (working) return working;
    if (copied === 'copied') return 'Your text is on the clipboard.';
    if (copied === 'failed') return 'Couldn’t copy to the clipboard.';
    if (disk.status === 'loading') return 'Reading the version on disk…';
    if (disk.status === 'failed') return 'The file couldn’t be read.';
    if (identical) return 'The file already holds exactly your text.';
    return `The versions differ in ${places(total)}.`;
  });

  /*
   * The comparison scrolls on its own so the choices stay in view, and when it
   * does it is a stop on the Tab path — a region the keyboard can scroll — with
   * a fade at the cut edge to say there is more. When everything fits it is
   * neither, and Tab goes straight from the lead to the controls.
   */
  let scroller = $state<HTMLElement | null>(null);
  let overflowing = $state(false);
  let atEnd = $state(true);

  function measure(): void {
    if (!scroller) return;
    overflowing = scroller.scrollHeight > scroller.clientHeight + 1;
    atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  }

  $effect(() => {
    if (!scroller) return undefined;
    void comparison;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    for (const child of scroller.children) observer.observe(child);
    return () => observer.disconnect();
  });
</script>

{#snippet passageText(passage: Passage | null)}
  {#if passage === null}
    <span class="absent">Not in this version</span>
  {:else}
    {#if passage.clippedStart}<span class="clip">…&#8239;</span>{/if}{#each passage.segments as segment, i (i)}{#if segment.changed}<mark>{segment.text}</mark>{:else}{segment.text}{/if}{/each}{#if passage.clippedEnd}<span class="clip">&#8239;…</span>{/if}
  {/if}
{/snippet}

<Dialog {open} size="lg" title="This script changed on disk" {onclose}>
  <!--
    Where focus lands, and not on a button: the sheet has to be read before
    either button means anything, and a reflexive Return should choose nothing.
    Tab goes on to the first control.
  -->
  <p class="lead" tabindex="-1" data-autofocus bind:this={lead}>
    {#if identical}
      Another app saved <span class="script-name">“{title}”</span> with exactly the text you have
      open, so there’s nothing to choose between. Continue editing to resume saving.
    {:else if disk.status === 'failed'}
      The file behind <span class="script-name">“{title}”</span> changed outside Speaking Glass while you
      were writing, so saving is paused. Your latest edits are still safe in this window.
    {:else}
      Another app changed <span class="script-name">“{title}”</span> while you were writing, so
      saving is paused. Your latest edits are safe in this window, but not on disk until you choose
      a version.
    {/if}
  </p>

  {#if disk.status === 'failed'}
    <div class="unreadable">
      <p class="unreadable-title">The file can’t be read right now, so the versions can’t be compared.</p>
      <p>
        {disk.reason} Try again, or copy your text to the clipboard to keep it somewhere else.
      </p>
    </div>
  {:else if !identical}
    <section class="compare" aria-labelledby="{uid}-compare">
      <h3 class="sr-only" id="{uid}-compare">Where the versions differ</h3>
      <div class="columns heads" aria-hidden="true">
        <div class="head">
          <p class="name">Version on disk</p>
          <p class="where">Changed outside Speaking Glass</p>
        </div>
        <div class="head">
          <p class="name">Your edits</p>
          <p class="where">In this window, not saved yet</p>
        </div>
      </div>

      <!-- The frame carries the closing rule, so the scroll fade cannot take it too. -->
      <div class="rows-frame">
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="rows"
        class:more={overflowing && !atEnd}
        class:scrolls={overflowing}
        class:expanded
        role="region"
        aria-label="Where the versions differ"
        aria-busy={disk.status === 'loading'}
        tabindex={overflowing ? 0 : undefined}
        bind:this={scroller}
        onscroll={measure}
      >
        {#if disk.status === 'loading'}
          <p class="note">Reading the version on disk…</p>
        {:else if comparison && comparison.differences.length === 0}
          <p class="note">They differ only in spacing and line breaks.</p>
        {:else if comparison}
          {#each comparison.differences as difference, i (i)}
            {@const previous = i > 0 ? comparison.differences[i - 1] : undefined}
            {@const repeat =
              previous !== undefined &&
              previous.diskSection === difference.diskSection &&
              previous.editorSection === difference.editorSection}
            <div class="columns row" class:continues={repeat}>
              {#if !repeat}
                {#if difference.diskSection === difference.editorSection}
                  {#if difference.diskSection}
                    <p class="section shared">{difference.diskSection}</p>
                  {/if}
                {:else}
                  <!-- A renamed heading: each version's paragraphs sit under their own. -->
                  <p class="section">{difference.diskSection ?? ''}</p>
                  <p class="section">{difference.editorSection ?? ''}</p>
                {/if}
              {/if}
              <p class="passage">
                <span class="sr-only">Version on disk: </span>{@render passageText(difference.disk)}
              </p>
              <p class="passage">
                <span class="sr-only">Your edits: </span>{@render passageText(difference.editor)}
              </p>
              {#if difference.spacingOnly}
                <p class="row-note">Same words — only the spacing or line breaks differ here.</p>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
      </div>

      {#if partial || expanded}
        <div class="scope">
          <p class="scope-text">
            {#if expanded}
              All {places(total)}, every paragraph whole.
            {:else if total > shown}
              The first {shown} of {total} places, trimmed to the sentences that changed.
            {:else}
              Trimmed to the sentences that changed.
            {/if}
          </p>
          <Button size="sm" variant="ghost" disabled={locked} onclick={() => (expanded = !expanded)}>
            {expanded ? 'Show less' : 'Show all in full'}
          </Button>
        </div>
      {/if}

      <div class="columns outcomes">
        <p class="outcome" id="{uid}-disk">
          <span class="label">Use disk version</span> — your edits are saved to the Library as
          <span class="copy-name">“{copyName}”</span>.
        </p>
        <p class="outcome" id="{uid}-keep">
          <span class="label">Keep my edits</span> — the disk version is kept in this script’s
          revision history, under Script actions › Revision history.
        </p>
      </div>
    </section>
  {/if}

  <!-- Announced, always mounted: a region inserted with its message is read unreliably. -->
  <p class="sr-only" role="status" aria-live="polite">{announcement}</p>
  <p class="sr-only" role="alert">{failure ? `${failure.title} ${failure.detail}` : ''}</p>

  {#snippet footer()}
    <div class="bar">
      {#if locked}
        <p class="status">{working}</p>
      {:else if failure}
        <!-- Full width, above the choices: a reason squeezed beside three buttons broke into
             a column of short lines. -->
        <div class="notice {failure.tone}">
          <span class="notice-icon"><Icon name="alert" size={16} /></span>
          <div class="notice-text">
            <p class="notice-title">{failure.title}</p>
            <p class="notice-body">{failure.detail}</p>
          </div>
        </div>
      {:else if copied === 'copied'}
        <p class="status">
          <span class="status-icon done"><Icon name="check" size={15} /></span>
          Your text is on the clipboard.
        </p>
      {:else if copied === 'failed'}
        <p class="status">
          <span class="status-icon danger"><Icon name="alert" size={15} /></span>
          Couldn’t copy to the clipboard. Go back to the script and copy it from the editor.
        </p>
      {/if}
      <div class="bar-actions">
        {#if disk.status === 'failed'}
          <Button variant="ghost" onclick={onclose}>Back to the script</Button>
          <Button onclick={() => void copyText()}>Copy all text</Button>
          <Button variant="primary" onclick={retry}>Try again</Button>
        {:else if identical}
          <Button
            variant="primary"
            disabled={locked}
            onclick={() => reviewed !== null && onusedisk(reviewed)}
          >
            Continue editing
          </Button>
        {:else}
          <Button variant="ghost" disabled={locked} onclick={onclose}>Back to the script</Button>
          <Button
            disabled={locked || reviewed === null}
            describedby="{uid}-disk"
            onclick={() => reviewed !== null && onusedisk(reviewed)}
          >
            Use disk version
          </Button>
          <Button
            variant="primary"
            disabled={locked || reviewed === null}
            describedby="{uid}-keep"
            onclick={() => reviewed !== null && onkeep(reviewed)}
          >
            Keep my edits
          </Button>
        {/if}
      </div>
    </div>
  {/snippet}
</Dialog>

<style>
  .lead {
    margin: 0;
    flex: 0 0 auto;
    max-width: 68ch;
    font-size: var(--text-sm);
    line-height: 1.6;
    color: var(--text-secondary);
    text-wrap: pretty;
  }
  /* A reading position, not a control. */
  .lead:focus {
    outline: none;
  }
  .script-name {
    color: var(--text-primary);
    font-weight: 500;
  }

  .unreadable {
    display: grid;
    gap: 2px;
    max-width: 68ch;
    padding: var(--space-2) 0;
    font-size: var(--text-sm);
    line-height: 1.6;
    color: var(--text-secondary);
  }
  .unreadable p {
    margin: 0;
  }
  .unreadable-title {
    color: var(--text-primary);
    font-weight: 600;
  }

  /*
   * Gives up height before anything else does: on a short window the rows
   * shrink and scroll, and the consequences and the footer stay on screen.
   * (The lg Dialog body is a column that clips rather than scrolls.)
   */
  .compare {
    flex: 0 1 auto;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .columns {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    column-gap: var(--space-8);
  }

  .heads {
    flex: 0 0 auto;
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--divider);
  }
  .head {
    min-width: 0;
  }
  .name,
  .where {
    margin: 0;
  }
  .name {
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-primary);
  }
  .where {
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  .rows-frame {
    flex: 0 1 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-bottom: 1px solid var(--divider);
  }
  .rows {
    flex: 0 1 auto;
    min-height: 96px;
    max-height: 320px;
    overflow-y: auto;
  }
  /* Asked for everything: room for more of it before the rows scroll. */
  .rows.expanded {
    max-height: 460px;
  }
  /*
   * Functional, not atmosphere: the last visible line is cut by the scroll
   * edge, and the fade says it continues rather than leaving a half-line that
   * reads as a rendering fault.
   */
  .rows.more {
    -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 32px), transparent);
    mask-image: linear-gradient(to bottom, #000 calc(100% - 32px), transparent);
  }
  /* The surface focus edge (--focus-quiet), never the accent ring. */
  .rows.scrolls:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--focus-quiet);
    border-radius: var(--radius-sm);
  }

  .row {
    padding: var(--space-3) 0;
  }
  .row + .row {
    border-top: 1px solid var(--divider);
  }
  /*
   * A second paragraph under the same heading: no rule, only the gap a
   * paragraph would have, so a section reads as one group and a rule always
   * means a new heading.
   */
  .row.continues {
    padding-top: 0;
    border-top: none;
  }
  .section {
    margin: 0 0 var(--space-1);
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    font-weight: 600;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .section.shared {
    grid-column: 1 / -1;
  }
  .row-note {
    grid-column: 1 / -1;
    margin: var(--space-1) 0 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }
  .passage {
    margin: 0;
    min-width: 0;
    font-family: var(--font-prose);
    font-size: var(--text-sm);
    line-height: 1.6;
    color: var(--text-secondary);
    overflow-wrap: anywhere;
    /* Line breaks inside a paragraph are part of the text being compared. */
    white-space: pre-line;
  }
  /*
   * The words only this version has: weight and ink as well as the tint, so
   * the difference does not rest on colour alone.
   */
  /* No side padding: a mark at the start of a line stays on the column edge. */
  .passage mark {
    padding: 1px 0;
    border-radius: 2px;
    background: var(--warning-soft);
    color: var(--text-primary);
    font-weight: 500;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }
  .absent,
  .clip {
    color: var(--text-faint);
  }
  .absent {
    font-style: italic;
  }

  .note {
    margin: 0;
    padding: var(--space-4) 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
  }

  .scope {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding-top: var(--space-2);
  }
  /*
   * The ghost button keeps its own inset, as the footer's do. Pulling its label
   * onto the column edge with a negative margin pushed it past the Dialog
   * body, which clips rather than scrolls — and focusing it then slid the
   * whole body sideways under the clip.
   */
  .scope-text {
    margin: 0;
    min-width: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  .outcomes {
    flex: 0 0 auto;
    padding-top: var(--space-3);
  }
  .outcome {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    text-wrap: pretty;
  }
  .label {
    color: var(--text-primary);
    font-weight: 600;
  }
  .copy-name {
    color: var(--text-primary);
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  /* ---- Footer band (the revision browser's) ---- */
  .bar {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    column-gap: var(--space-3);
    row-gap: var(--space-3);
    min-height: 52px;
    padding: var(--space-2) 0;
  }
  .status {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
  }
  .status-icon {
    flex: 0 0 auto;
    display: grid;
  }
  .status-icon.done {
    color: var(--success);
  }
  .status-icon.danger,
  .notice.danger .notice-icon {
    color: var(--danger);
  }
  .notice.warning .notice-icon {
    color: var(--warning);
  }
  /* The revision browser's refused band: warm canvas, the reason beside its mark. */
  .notice {
    flex: 1 1 100%;
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--bg-canvas);
  }
  .notice-icon {
    flex: 0 0 auto;
    display: grid;
    /* Level with the title's first line, not centred on the block. */
    margin-top: 1px;
  }
  .notice-text {
    min-width: 0;
  }
  .notice-text p {
    margin: 0;
  }
  .notice-title {
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-primary);
  }
  .notice-body {
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
  }
  .bar-actions {
    flex: 0 0 auto;
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--space-2);
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
