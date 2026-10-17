<!--
  Revision browser (spec §21.4).

  CandidCue has been writing revision snapshots since the scripts repo landed —
  on the first save, on the 5-minute cadence, before a session, when the file
  changes outside the app — and until now nothing could read one back. This is
  the reader: list, preview, restore.

  Restoring is undoable, and the guarantee is Rust's: `restore_revision` routes
  through `save_script` with `revisionReason: "before_restore"`, so the text it
  replaces is snapshotted under the per-script lock first.

  ---------------------------------------------------------------------------
  ONE FRAME FOR EVERY STATE
  ---------------------------------------------------------------------------
  The browser is a fixed frame — a warm-paper rail of revisions beside a white
  reading pane, over a footer band of constant height — and every state renders
  inside it: loading fills the frame with placeholder rows, an empty or failed
  list centres its message in it, a failed preview keeps the list, and asking to
  restore turns the footer band into the question. The dialog used to collapse
  to a single line for the quiet states and grow when the question appeared,
  which made each of them look like a different window.

  The reading pane is typeset like the editor (cm-theme.ts: the prose face,
  1.73 leading, a 70ch measure), not as code: what you read here is exactly the
  text a restore puts back in front of you, and an earlier draft has to be
  readable at length to be judged.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import EmptyState from './EmptyState.svelte';
  import Icon from './Icon.svelte';
  import {
    RESTORE_SAFETY_NOTE,
    revisionReasonLabel,
    revisionWordDelta,
  } from '../lib/revision-format';
  import { relativeTime } from '../lib/format';
  import { describeError, errorCode } from '../services/errors';
  import { BackendUnavailableError } from '../services/ipc';
  import * as revisionsService from '../services/revisions';
  import type { RevisionDocument, RevisionSummary } from '../services/revisions';

  interface Props {
    open: boolean;
    scriptId: string;
    /** Script revision the editor believes it holds (compare-and-swap input). */
    expectedRevision: number;
    /** Spoken word count of the text currently open, for the delta column. */
    currentWordCount: number;
    onclose: () => void;
    /** Fired after a successful restore so the editor can reload the script. */
    onrestored: () => void;
  }

  let { open, scriptId, expectedRevision, currentWordCount, onclose, onrestored }: Props =
    $props();

  const uid = $props.id();

  let loading = $state(false);
  let listError = $state<{ title: string; body: string; retry: boolean } | null>(null);
  let revisions = $state<RevisionSummary[]>([]);
  let selectedId = $state<string | null>(null);
  /*
   * The last document that arrived — NOT necessarily the selected one.
   *
   * Moving to another revision keeps the reading pane mounted (hidden) until
   * the new text lands, instead of clearing it. Clearing re-mounted the pane,
   * so its scroll snapped to the top and a passage could not be compared from
   * one version to the next. The old text is never SHOWN under the new
   * header, though: that would be the wrong version's words under the right
   * version's name.
   */
  let preview = $state<RevisionDocument | null>(null);
  let previewError = $state<string | null>(null);
  let restoring = $state(false);
  let confirming = $state(false);
  /** Why the last restore was refused. Kept apart from the preview's own
      failure, so a refused restore no longer wipes the text being considered. */
  let restoreError = $state<{ title: string; body: string } | null>(null);
  /*
   * The script revision a restore was refused at for being stale. Until the
   * editor hands over a newer one, asking again cannot succeed — so Restore
   * repeats why instead of walking back into the same question.
   */
  let staleAt = $state<number | null>(null);
  /**
   * What the always-mounted assertive region says. Inserting a live region
   * together with its message is announced unreliably; changing the text of
   * one that is already there is not.
   */
  let refusal = $state('');

  /*
   * The two footer buttons the confirm step swaps between.
   *
   * Asking to restore replaces the button that was focused with a different
   * pair, so focus fell to the body: the keyboard was left nowhere, and a
   * screen reader was told nothing at all — the question appeared as a
   * paragraph no one was reading. Focus is therefore moved deliberately, onto
   * Cancel rather than Restore so the destructive key is never the one already
   * under a waiting Return.
   */
  let cancelButton = $state<HTMLButtonElement | null>(null);
  let restoreButton = $state<HTMLButtonElement | null>(null);
  let listElement = $state<HTMLElement | null>(null);
  let bodyElement = $state<HTMLElement | null>(null);

  const selected = $derived(revisions.find((r) => r.id === selectedId) ?? null);
  /** The selected revision's text has arrived and is what the pane shows. */
  const previewReady = $derived(preview !== null && preview.id === selectedId);
  const groups = $derived(groupByDay(revisions));
  const lines = $derived(preview ? sourceLines(preview.source) : []);

  /*
   * One polite status line for everything asynchronous. The confirm question
   * keeps its own alert and a refused restore its own assertive region; this
   * covers the rest, which used to change silently.
   */
  const status = $derived.by(() => {
    if (loading) return 'Loading revisions…';
    if (listError) return listError.title;
    if (revisions.length === 0) return 'No revisions yet.';
    if (restoring) return 'Restoring…';
    if (previewError) return 'This revision could not be opened.';
    if (selected && !previewReady) return `Loading the revision from ${clockTime(selected.createdAt)}…`;
    return `${countLabel(revisions.length)}.`;
  });

  $effect(() => {
    if (!open) return;
    // A reopened dialog must not still be holding a half-answered question.
    confirming = false;
    restoreError = null;
    refusal = '';
    staleAt = null;
    void load(scriptId);
  });

  /** Say the refusal again — cleared first so an identical message is re-read. */
  async function announceRefusal(): Promise<void> {
    refusal = '';
    await tick();
    if (restoreError) refusal = `${restoreError.title}. ${restoreError.body}`;
  }

  async function askToRestore(): Promise<void> {
    if (!previewReady || restoring) return;
    if (staleAt !== null && staleAt === expectedRevision && restoreError) {
      void announceRefusal();
      return;
    }
    restoreError = null;
    refusal = '';
    confirming = true;
    await tick();
    cancelButton?.focus();
  }

  async function cancelRestore(): Promise<void> {
    confirming = false;
    await tick();
    restoreButton?.focus();
  }

  async function load(id: string): Promise<void> {
    loading = true;
    listError = null;
    preview = null;
    previewError = null;
    selectedId = null;
    try {
      revisions = await revisionsService.listRevisions(id);
      if (revisions.length > 0) void select(revisions[0]!.id);
    } catch (err) {
      revisions = [];
      listError =
        err instanceof BackendUnavailableError
          ? {
              title: 'Revision history needs the desktop app',
              body: 'Revisions are kept by the CandidCue desktop app, so there are none to show here.',
              retry: false,
            }
          : { title: 'Revision history could not be loaded', body: describeError(err), retry: true };
    } finally {
      loading = false;
    }
  }

  async function select(revisionId: string): Promise<void> {
    if (restoring) return;
    // Choosing another version is a change of mind: the question was about the
    // one that was showing, and must never carry over to one not yet read.
    if (revisionId !== selectedId) {
      confirming = false;
      if (staleAt === null) {
        restoreError = null;
        refusal = '';
      }
    }
    const anchor = readingAnchor();
    selectedId = revisionId;
    previewError = null;
    try {
      const doc = await revisionsService.getRevision(scriptId, revisionId);
      // A slower earlier request must not overwrite a newer selection.
      if (selectedId !== revisionId) return;
      preview = doc;
      await tick();
      keepReadingPlace(anchor);
    } catch (err) {
      if (selectedId === revisionId) previewError = describeError(err);
    }
  }

  async function restore(): Promise<void> {
    // Only ever the version on screen, and only once per answer.
    if (!selected || !previewReady || restoring) return;
    restoring = true;
    try {
      await revisionsService.restoreRevision(scriptId, selected.id, expectedRevision);
      confirming = false;
      onrestored();
    } catch (err) {
      const stale = errorCode(err) === 'SCRIPT_CONFLICT';
      staleAt = stale ? expectedRevision : null;
      restoreError = {
        title: 'Nothing was restored',
        body: stale
          ? 'The script changed after this window opened, so restoring now could overwrite newer text. Close revision history, reopen the script, then try again.'
          : describeError(err),
      };
      void announceRefusal();
      // The confirm pair is about to be replaced by the single Restore button
      // again; without this the failure would ALSO drop focus to the body.
      confirming = false;
      restoring = false;
      await tick();
      restoreButton?.focus();
    } finally {
      restoring = false;
    }
  }

  function close(): void {
    if (!restoring) onclose();
  }

  /* --- The list: one tab stop, arrows move the selection (APG listbox) ---- */

  function onListKeydown(event: KeyboardEvent): void {
    if (restoring || revisions.length === 0) return;
    const index = revisions.findIndex((r) => r.id === selectedId);
    const last = revisions.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: Math.min(last, index + 1),
      ArrowUp: Math.max(0, index - 1),
      Home: 0,
      End: last,
      PageDown: Math.min(last, index + 8),
      PageUp: Math.max(0, index - 8),
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = revisions[next];
    if (!target) return;
    if (target.id !== selectedId) void select(target.id);
    void tick().then(() => {
      listElement?.querySelector<HTMLElement>(`[data-revision="${target.id}"]`)?.focus();
    });
  }

  /* --- Keeping your place between versions -------------------------------- */

  interface Anchor {
    /** The first line in view, and how far above the pane's top it starts. */
    index: number;
    text: string;
    offset: number;
    /** The heading that line sits under, for when the line itself changed. */
    heading: string | null;
    scrollTop: number;
  }

  /**
   * What the reader is looking at, in terms of the TEXT rather than pixels. A
   * pixel offset lands somewhere unrelated as soon as an earlier paragraph is
   * longer or shorter in the next version, which is exactly when you are
   * comparing.
   */
  function readingAnchor(): Anchor | null {
    const pane = bodyElement;
    if (!pane || pane.scrollTop <= 0 || !preview) return null;
    const rows = pane.querySelectorAll<HTMLElement>('[data-line]');
    let heading: string | null = null;
    for (const row of rows) {
      const index = Number(row.dataset['line']);
      const line = lines[index];
      if (!line) continue;
      if (line.kind === 'heading') heading = line.text;
      if (line.kind === 'blank') continue;
      if (row.offsetTop + row.offsetHeight > pane.scrollTop) {
        return { index, text: line.text, offset: row.offsetTop - pane.scrollTop, heading, scrollTop: pane.scrollTop };
      }
    }
    return null;
  }

  function keepReadingPlace(anchor: Anchor | null): void {
    const pane = bodyElement;
    if (!pane || !anchor) return;
    const nearest = (kind: Line['kind'] | null, text: string): number => {
      let best = -1;
      lines.forEach((line, index) => {
        if (line.text !== text || (kind && line.kind !== kind)) return;
        if (best < 0 || Math.abs(index - anchor.index) < Math.abs(best - anchor.index)) best = index;
      });
      return best;
    };
    let index = nearest(null, anchor.text);
    let offset = anchor.offset;
    if (index < 0 && anchor.heading) {
      index = nearest('heading', anchor.heading);
      offset = 0;
    }
    if (index < 0) {
      pane.scrollTop = anchor.scrollTop;
      return;
    }
    const row = pane.querySelector<HTMLElement>(`[data-line="${index}"]`);
    if (row) pane.scrollTop = Math.max(0, row.offsetTop - offset);
  }

  /* --- Presentation ------------------------------------------------------- */

  interface DayGroup {
    key: string;
    label: string;
    items: RevisionSummary[];
  }

  /** Newest-first revisions, cut into calendar days the way a log is read. */
  function groupByDay(list: RevisionSummary[], nowMs: number = Date.now()): DayGroup[] {
    const out: DayGroup[] = [];
    for (const revision of list) {
      const date = new Date(Date.parse(revision.createdAt));
      const key = Number.isNaN(date.getTime()) ? 'undated' : date.toDateString();
      let group = out[out.length - 1];
      if (!group || group.key !== key) {
        group = { key, label: dayLabel(date, nowMs), items: [] };
        out.push(group);
      }
      group.items.push(revision);
    }
    return out;
  }

  /** "Today", "Yesterday", "Tuesday 13 October" — always with the date past yesterday. */
  function dayLabel(date: Date, nowMs: number): string {
    if (Number.isNaN(date.getTime())) return 'Undated';
    const today = new Date(nowMs);
    const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOf(today) - startOf(date)) / 86_400_000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return date.toLocaleDateString(undefined, {
      weekday: days < 7 ? 'long' : undefined,
      day: 'numeric',
      month: 'long',
      year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
    });
  }

  /** "4:14 PM" — the row already sits under its day. */
  function clockTime(iso: string): string {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return '';
    return new Date(then).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  /** "Thursday, 15 October, 3:32 PM" — the reading pane names the moment in full. */
  function fullMoment(iso: string): string {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return '';
    const date = new Date(then);
    const day = date.toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    });
    return `${day}, ${clockTime(iso)}`;
  }

  /** Why a revision exists, in a sentence — the label alone does not say. */
  const REASON_NOTES: Record<string, string> = {
    initial: 'The first saved version of this script.',
    autosave_interval: 'Saved automatically while you were editing.',
    external_change: 'The text found after the file was edited outside CandidCue.',
    external_change_preserved:
      'An edit made outside CandidCue, kept when a save from the editor clashed with it.',
    before_restore: 'Your text just before an earlier restore replaced it.',
    pre_session: 'Saved as a session started.',
    import: 'The script as it was imported.',
    recovered: 'Rebuilt from the script’s files; why it was first saved was not kept.',
  };

  function words(count: number): string {
    return `${count.toLocaleString()} ${count === 1 ? 'word' : 'words'}`;
  }

  function countLabel(count: number): string {
    return `${count.toLocaleString()} ${count === 1 ? 'revision' : 'revisions'}`;
  }

  /** "120 more" / "88 fewer" / "same length", against the text open now. */
  function deltaPhrase(revision: RevisionSummary): string {
    const delta = revisionWordDelta(revision.wordCount, currentWordCount);
    if (delta === undefined) return '';
    if (delta === 0) return 'same length';
    return `${Math.abs(delta).toLocaleString()} ${delta > 0 ? 'more' : 'fewer'}`;
  }

  interface Line {
    kind: 'heading' | 'rule' | 'fence' | 'text' | 'blank';
    marker: string;
    text: string;
    /** Heading depth, for the accessible outline (0 for anything else). */
    depth: number;
  }

  /**
   * The source, line by line, with the editor's restraint on Markdown: heading
   * lines carry heading weight and keep their `#` visible but faint, fences and
   * part breaks are quiet. Nothing is rendered away — this is the text a
   * restore puts back, character for character.
   */
  function sourceLines(source: string): Line[] {
    return source
      .replace(/\n$/, '')
      .split('\n')
      .map((line): Line => {
        const heading = /^((#{1,6})\s+)(.*)$/.exec(line);
        if (heading) {
          return { kind: 'heading', marker: heading[1]!, text: heading[3]!, depth: heading[2]!.length };
        }
        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return { kind: 'rule', marker: '', text: line, depth: 0 };
        if (/^\s*(?::::|```)/.test(line)) return { kind: 'fence', marker: '', text: line, depth: 0 };
        if (line.trim() === '') return { kind: 'blank', marker: '', text: '', depth: 0 };
        return { kind: 'text', marker: '', text: line, depth: 0 };
      });
  }
</script>

<Dialog {open} size="lg" title="Revision history" onclose={close}>
  {#if loading}
    <div class="browser" aria-busy="true">
      <div class="rail" aria-hidden="true">
        <div class="rail-head">
          <span class="placeholder count"></span>
          <span class="placeholder caption"></span>
        </div>
        <div class="placeholder-rows">
          <span class="placeholder day"></span>
          {#each Array.from({ length: 7 }) as _, index (index)}
            <span class="placeholder row"></span>
          {/each}
        </div>
      </div>
      <div class="reader" aria-hidden="true">
        <div class="reader-head">
          <span class="placeholder title"></span>
          <span class="placeholder meta"></span>
          <span class="placeholder meta short"></span>
        </div>
        <div class="placeholder-lines">
          {#each [92, 100, 96, 61, 0, 98, 88, 94, 40] as width, index (index)}
            <span class="placeholder line" style:width="{width}%"></span>
          {/each}
        </div>
      </div>
    </div>
  {:else if listError}
    <div class="browser centred" data-state="list-error">
      <EmptyState title={listError.title} body={listError.body}>
        {#snippet actions()}
          {#if listError?.retry}
            <Button variant="primary" onclick={() => void load(scriptId)}>Try again</Button>
          {/if}
        {/snippet}
      </EmptyState>
    </div>
  {:else if revisions.length === 0}
    <div class="browser centred" data-state="empty">
      <EmptyState
        title="No revisions yet"
        body="CandidCue keeps a revision the first time a script is saved, every five minutes or so while you edit, and just before every session. They will be listed here."
      />
    </div>
  {:else}
    <div class="browser">
      <div class="rail">
        <div class="rail-head">
          <p class="rail-count">{countLabel(revisions.length)}</p>
          <p class="rail-caption">Compared with your current {words(currentWordCount)}</p>
        </div>
        <!-- One tab stop: arrows, Home/End and Page keys move the selection. -->
        <div
          class="list"
          role="listbox"
          tabindex="-1"
          aria-label="Revisions"
          bind:this={listElement}
          onkeydown={onListKeydown}
        >
          {#each groups as group, g (group.key)}
            <div class="day" role="group" aria-labelledby="{uid}-day-{g}">
              <div class="day-label" role="presentation" id="{uid}-day-{g}">{group.label}</div>
              {#each group.items as revision (revision.id)}
                {@const active = revision.id === selectedId}
                <button
                  type="button"
                  class="row"
                  class:active
                  role="option"
                  data-revision={revision.id}
                  tabindex={active ? 0 : -1}
                  aria-selected={active}
                  disabled={restoring}
                  onclick={() => void select(revision.id)}
                >
                  <span class="row-top">
                    <span class="row-reason">{revisionReasonLabel(revision.reason)}</span>
                    <span class="row-time">{clockTime(revision.createdAt)}</span>
                  </span>
                  <span class="row-meta">
                    {#if revision.wordCount !== undefined}
                      {words(revision.wordCount)}{#if deltaPhrase(revision)}<span class="row-delta"
                          >&ensp;·&ensp;{deltaPhrase(revision)}</span
                        >{/if}
                    {:else}
                      Word count not recorded
                    {/if}
                  </span>
                </button>
              {/each}
            </div>
          {/each}
        </div>
      </div>

      <section class="reader" aria-label="Revision preview" aria-busy={!previewReady && !previewError}>
        {#if selected}
          <header class="reader-head">
            <h3 class="reader-title">{revisionReasonLabel(selected.reason)}</h3>
            <p class="reader-when">
              {fullMoment(selected.createdAt)}<span class="reader-age">&ensp;·&ensp;{relativeTime(selected.createdAt)}</span>
            </p>
            {#if REASON_NOTES[selected.reason]}
              <p class="reader-note">{REASON_NOTES[selected.reason]}</p>
            {/if}
            {#if selected.wordCount !== undefined}
              <p class="reader-size">
                <strong>{words(selected.wordCount)}</strong>{#if deltaPhrase(selected)}&ensp;·&ensp;{deltaPhrase(
                    selected,
                  ) === 'same length'
                    ? 'the same length as your current text'
                    : `${deltaPhrase(selected)} than your current text`}{/if}
              </p>
            {/if}
          </header>

          <div class="reader-body">
            {#if previewError}
              <div class="reader-message" data-state="preview-error">
                <span class="message-icon"><Icon name="alert" size={16} /></span>
                <div class="message-text">
                  <p class="message-title">This revision could not be opened</p>
                  <p class="message-body">{previewError}</p>
                </div>
                <Button size="sm" onclick={() => selectedId && void select(selectedId)}>Try again</Button>
              </div>
            {:else if preview}
              {#if !previewReady}
                <div class="placeholder-lines pending" aria-hidden="true">
                  {#each [94, 100, 97, 58, 0, 99, 90, 95, 44] as width, index (index)}
                    <span class="placeholder line" style:width="{width}%"></span>
                  {/each}
                </div>
              {/if}
              <div
                class="preview-body"
                class:hidden={!previewReady}
                tabindex={previewReady ? 0 : -1}
                role="document"
                aria-label="Text of this revision"
                aria-hidden={!previewReady}
                data-focus="surface"
                bind:this={bodyElement}
              >
                {#each lines as line, index (index)}
                  {#if line.kind === 'heading'}
                    <!-- Real headings for the outline a screen reader walks,
                         nested under the dialog's h2 and the pane's h3. The
                         `#` marker is source, not part of the name. -->
                    <div
                      class="line heading"
                      role="heading"
                      aria-level={Math.min(6, line.depth + 3)}
                      data-line={index}
                    ><span class="md" aria-hidden="true">{line.marker}</span>{line.text}</div>
                  {:else if line.kind === 'blank'}
                    <div class="line blank" data-line={index}>&nbsp;</div>
                  {:else}
                    <div class="line {line.kind}" data-line={index}>{line.text}</div>
                  {/if}
                {/each}
              </div>
            {:else}
              <div class="placeholder-lines" aria-hidden="true">
                {#each [94, 100, 97, 58, 0, 99, 90, 95, 44] as width, index (index)}
                  <span class="placeholder line" style:width="{width}%"></span>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </section>
    </div>
  {/if}
  <p class="sr-only" role="status">{status}</p>
  <p class="sr-only" aria-live="assertive" aria-atomic="true">{refusal}</p>

  {#snippet footer()}
    <div class="bar" class:asking={confirming} class:refused={restoreError !== null && !confirming}>
      {#if confirming && selected}
        <span class="bar-icon"><Icon name="restore" size={18} /></span>
        <!-- role="alert" so the question is spoken when it appears. Without it
             the confirm step was a silent paragraph and the only signal that
             anything had happened was visual. -->
        <div class="bar-text" role="alert" aria-atomic="true">
          <p class="bar-title">
            {#if restoring}
              Restoring the version from {clockTime(selected.createdAt)}…
            {:else}
              Replace the script with the version from {fullMoment(selected.createdAt)}?
            {/if}
          </p>
          <p class="bar-body">
            {#if selected.wordCount !== undefined}
              The {words(currentWordCount)} in the editor become this version’s {selected.wordCount.toLocaleString()}.
            {:else}
              The text in the editor is replaced with this version.
            {/if}
            {RESTORE_SAFETY_NOTE}
          </p>
        </div>
        <div class="bar-actions">
          <Button bind:element={cancelButton} variant="ghost" disabled={restoring} onclick={() => void cancelRestore()}>
            Cancel
          </Button>
          <Button variant="danger-primary" disabled={restoring} onclick={() => void restore()}>
            Restore this version
          </Button>
        </div>
      {:else}
        {#if restoreError}
          <span class="bar-icon danger"><Icon name="alert" size={18} /></span>
          <div class="bar-text">
            <p class="bar-title">{restoreError.title}</p>
            <p class="bar-body">{restoreError.body}</p>
          </div>
        {:else if previewReady}
          <p class="bar-hint">Restoring replaces the text in the editor. It can be undone.</p>
        {/if}
        <div class="bar-actions">
          <Button variant="ghost" disabled={restoring} onclick={close}>Close</Button>
          {#if loading || revisions.length > 0}
            <Button
              bind:element={restoreButton}
              variant="primary"
              disabled={!previewReady || restoring}
              onclick={() => void askToRestore()}
            >
              Restore this version
            </Button>
          {/if}
        </div>
      {/if}
    </div>
  {/snippet}
</Dialog>

<style>
  /*
   * The frame. Tall enough to read a draft in, and allowed to shrink: the
   * Dialog body is a flex column that gives up height once the panel reaches
   * its max-height, so this fills a tall window and still fits a 680px one —
   * at the same size in every state.
   */
  .browser {
    display: flex;
    gap: var(--space-5);
    flex: 1 1 auto;
    height: 640px;
    min-height: 0;
  }
  .browser.centred {
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    background: var(--bg-canvas);
  }

  /* ---- The rail: warm paper, recessed beside the white reading pane ---- */
  .rail {
    flex: 0 0 288px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-radius: var(--radius-sm);
    background: var(--bg-canvas);
    overflow: hidden;
  }
  .rail-head {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-3) var(--space-4) var(--space-2);
    border-bottom: 1px solid var(--border-faint);
  }
  .rail-count {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 650;
    color: var(--text-primary);
  }
  .rail-caption {
    margin: 0;
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  .list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 0 var(--space-2) var(--space-2);
  }
  .list:focus {
    outline: none;
  }
  .day {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  /* Day landmarks stay pinned while their rows scroll under them. */
  .day-label {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: var(--space-3) var(--space-2) var(--space-1);
    background: var(--bg-canvas);
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .row {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    padding: 7px var(--space-3) 7px var(--space-4);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
    color: var(--text-primary);
    transition: background var(--dur-fast) var(--ease-out);
  }
  .row:hover:not(:disabled) {
    background: var(--bg-hover-chrome);
  }
  .row:disabled {
    cursor: default;
  }
  /*
   * Selected: the Library's grammar — a tonal fill and an inset marker. Inset,
   * never a one-sided border on a rounded box. No white card: on warm paper a
   * raised white pill reads as a web nav (Sidebar.svelte retired it).
   */
  .row.active,
  .row.active:hover {
    background: var(--bg-row-selected);
  }
  .row.active::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 8px;
    bottom: 8px;
    width: 3px;
    border-radius: var(--radius-pill);
    background: var(--accent);
  }

  .row-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .row-reason {
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-time {
    flex: 0 0 auto;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .row-meta {
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .row.active .row-meta {
    color: var(--text-secondary);
  }

  /* ---- The reading pane ---- */
  .reader {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .reader-head {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-1) 0 var(--space-3);
    border-bottom: 1px solid var(--divider);
  }
  .reader-title {
    margin: 0 0 2px;
    font-size: var(--text-lg);
    line-height: var(--lh-section);
    font-weight: 650;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
  }
  .reader-when,
  .reader-note,
  .reader-size {
    margin: 0;
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
  }
  .reader-age,
  .reader-note {
    color: var(--text-muted);
  }
  .reader-size strong {
    font-weight: 600;
    color: var(--text-primary);
  }

  .reader-body {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* Typeset like the editor (cm-theme.ts), so the draft reads as itself. */
  .preview-body {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-4) var(--space-2) var(--space-6) 0;
    font-family: var(--font-prose);
    font-size: var(--text-base);
    line-height: 1.73;
    letter-spacing: var(--ls-prose);
    color: var(--prose-text-warm);
    overflow-wrap: break-word;
    transition: opacity var(--dur-fast) var(--ease-out);
  }
  /* Still the version that was selected before; the new one is on its way.
     Hidden rather than unmounted, so the reading position survives. */
  .preview-body.hidden {
    visibility: hidden;
  }
  /*
   * Placeholders over the hidden pane — only once a load is slow enough to
   * notice. A local read normally lands within a frame, and a placeholder
   * flashed on every arrow key would be noise. A one-shot entrance with a
   * delay, not a loop.
   */
  .placeholder-lines.pending {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    opacity: 0;
    animation: pending-in var(--dur-fast) var(--ease-out) 180ms forwards;
    pointer-events: none;
  }
  @keyframes pending-in {
    to {
      opacity: 1;
    }
  }
  .line {
    max-width: var(--prose-measure);
    white-space: pre-wrap;
  }
  .line.heading {
    font-weight: 650;
    color: var(--text-primary);
  }
  .line .md,
  .line.rule,
  .line.fence {
    font-weight: 400;
    color: var(--text-faint);
  }

  .reader-message {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    margin-top: var(--space-4);
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--bg-canvas);
  }
  .message-icon {
    flex: 0 0 auto;
    display: inline-flex;
    margin-top: 1px;
    color: var(--danger);
  }
  .message-text {
    flex: 1 1 auto;
    min-width: 0;
  }
  .message-title {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-primary);
  }
  .message-body {
    margin: 2px 0 0;
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
  }

  /* ---- Placeholders: static tints, never a shimmer (no perpetual motion) ---- */
  .placeholder {
    display: block;
    border-radius: 3px;
    background: var(--bg-hover-chrome);
  }
  .placeholder.count {
    width: 88px;
    height: 12px;
    margin: 3px 0;
  }
  .placeholder.caption {
    width: 196px;
    height: 9px;
    margin: 4px 0 3px;
  }
  .placeholder-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: var(--space-3) var(--space-2);
  }
  .placeholder.day {
    width: 52px;
    height: 9px;
    margin: 2px var(--space-2) 6px;
  }
  .placeholder.row {
    height: 42px;
    border-radius: var(--radius-sm);
    opacity: 0.55;
  }
  .placeholder.title {
    width: 150px;
    height: 16px;
    margin: 5px 0 8px;
  }
  .placeholder.meta {
    width: 260px;
    height: 9px;
    margin: 4px 0;
  }
  .placeholder.meta.short {
    width: 180px;
  }
  .placeholder-lines {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding-top: var(--space-5);
    max-width: var(--prose-measure);
  }
  .placeholder.line {
    height: 10px;
    background: var(--bg-hover-surface);
    box-shadow: inset 0 0 0 1px var(--border-faint);
  }

  /*
   * ---- The footer band ----
   *
   * Always the same height, so neither the question nor a refusal moves the
   * frame above it. Asking turns the band into the decision: the question,
   * what it replaces and both answers in one place where the Restore button
   * was, rather than a paragraph appearing above a footer that rearranged
   * itself.
   */
  .bar {
    flex: 1 1 auto;
    min-width: 0;
    /* Room for the question's three lines in every state, so asking, restoring
       and a refusal never take height from the frame above. */
    min-height: 72px;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    transition: background var(--dur-fast) var(--ease-out);
  }
  .bar.asking,
  .bar.refused {
    background: var(--bg-canvas);
  }
  .bar-actions {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-left: auto;
  }
  .bar-icon {
    flex: 0 0 auto;
    display: inline-flex;
    align-self: flex-start;
    margin-top: 2px;
    color: var(--accent-strong);
  }
  .bar-icon.danger {
    color: var(--danger);
  }
  .bar-text {
    flex: 1 1 auto;
    min-width: 0;
  }
  .bar-title {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 650;
    color: var(--text-primary);
  }
  .bar.refused .bar-title {
    color: var(--danger);
  }
  .bar-body {
    margin: 2px 0 0;
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
  }
  .bar-hint {
    margin: 0;
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
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
