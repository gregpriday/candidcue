<!--
  The script syntax reference (#305): every construct Speaking Glass adds to
  Markdown, what it looks like on the glass and what following does with it.

  Rendered from `SYNTAX_REFERENCE` and nothing else. That table's examples are
  compiled by its own test against the real compiler, so the page cannot teach
  a form the compiler has stopped accepting. The examples are text
  interpolations, never `{@html}`: a reference full of brackets, braces and
  fences must show them exactly as typed.

  It is opened mid-script to look one thing up, so it opens on a search field
  and every entry answers the same three questions in the same places: what to
  type (left), what the glass shows (drawn by compiling the example, not
  described), and the words following listens for (the asserted
  `expect.spoken`, not a paraphrase of it).

  Bundled with the app rather than linked, so it answers offline.
-->
<script lang="ts">
  import Dialog from './Dialog.svelte';
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';
  import IconButton from './IconButton.svelte';
  import SegmentedControl from './SegmentedControl.svelte';
  import SyntaxSpecimen from './SyntaxSpecimen.svelte';
  import {
    SYNTAX_REFERENCE,
    syntaxEntries,
    type SyntaxCase,
    type SyntaxEntry,
  } from '../../shared/markdown/syntax-reference';
  import {
    exampleForms,
    exampleLines,
    filterReference,
    formForQuery,
    proseRuns,
    type ExampleForm,
    type ExampleLine,
  } from '../lib/syntax-reference-view';
  import { loadSpecimens, type Specimens } from '../lib/syntax-specimens';
  import { showToast } from '../stores/toasts';

  interface Props {
    open: boolean;
    onclose: () => void;
  }
  let { open, onclose }: Props = $props();

  const uid = $props.id();

  let query = $state('');
  let searchInput: HTMLInputElement | null = $state(null);
  let scroller: HTMLElement | null = $state(null);
  let copied: string | null = $state(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The form picked by hand in an entry that offers several. Without a pick, a
   * search shows the form it named (`formForQuery`), so "italic" opens on the
   * italic example rather than the list it shares an entry with.
   */
  let chosen: Record<string, number> = $state({});
  const groups = $derived(filterReference(SYNTAX_REFERENCE, query));
  const matched = $derived(groups.reduce((count, group) => count + group.entries.length, 0));
  const searching = $derived(query.trim() !== '');

  /** How many entries a search left, as a count rather than a position in them. */
  const matchCount = $derived(
    matched === 0 ? 'No matches' : matched === 1 ? '1 match' : `${matched} matches`,
  );

  /** Announced without moving focus; the field shows the same count. */
  const searchStatus = $derived(
    !searching ? '' : matched === 0 ? `No syntax matches ${query.trim()}` : matchCount,
  );

  function clearSearch(): void {
    query = '';
    searchInput?.focus();
  }

  /**
   * The results scroll from the search field, so the keyboard never has to
   * leave it to read on: the arrows by a line, Page Up and Page Down by a
   * screen. A single-line field has no use for them, and on macOS Tab may not
   * reach anything in the list at all unless full keyboard access is on.
   */
  function scrollFromSearch(event: KeyboardEvent): void {
    if (!scroller) return;
    const page = scroller.clientHeight - 48;
    const by =
      event.key === 'ArrowDown'
        ? 40
        : event.key === 'ArrowUp'
          ? -40
          : event.key === 'PageDown'
            ? page
            : event.key === 'PageUp'
              ? -page
              : 0;
    if (by === 0) return;
    event.preventDefault();
    scroller.scrollBy({ top: by });
  }

  /*
   * Whether entries are hidden above or below the scroll region, so its edge
   * can say so — the same hairline Keyboard Shortcuts draws. Without it a
   * window that happened to end between two entries looked like the whole
   * reference.
   */
  let edges = $state({ above: false, below: false });

  function measureEdges(): void {
    if (!scroller) return;
    const { scrollTop, scrollHeight, clientHeight } = scroller;
    edges = { above: scrollTop > 0, below: scrollTop + clientHeight < scrollHeight - 1 };
  }

  $effect(() => {
    if (!scroller) return undefined;
    measureEdges();
    // The window resizing changes what fits. jsdom has no ResizeObserver.
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measureEdges);
    observer.observe(scroller);
    return () => observer.disconnect();
  });

  // A new search starts its results at the top, each entry on the form it asks for.
  $effect(() => {
    void groups;
    chosen = {};
    if (!scroller) return;
    scroller.scrollTop = 0;
    measureEdges();
  });

  // Each opening starts afresh.
  $effect(() => {
    if (!open) {
      query = '';
      copied = null;
      chosen = {};
    }
  });

  /** The glass, drawn by the compiler once it has loaded; until then each entry has its caption alone. */
  let specimens: Specimens | null = $state(null);
  $effect(() => {
    if (!open || specimens) return undefined;
    let current = true;
    loadSpecimens().then(
      (loaded) => {
        if (current) specimens = loaded;
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  });

  /** What goes wrong with an entry, worst first. */
  function problemsOf(entry: SyntaxEntry): Array<SyntaxCase & { problem: string }> {
    return (entry.cases ?? [])
      .filter((c): c is SyntaxCase & { problem: string } => c.problem !== undefined)
      .sort((a, b) => Number(b.blocking === true) - Number(a.blocking === true));
  }

  /** The source itself, not the page's text: the page sets syntax apart, the clipboard must not. */
  async function copyExample(entry: SyntaxEntry, form: ExampleForm): Promise<void> {
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) {
        throw new Error('clipboard unavailable');
      }
      await navigator.clipboard.writeText(form.source);
      copied = entry.id;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        copied = null;
      }, 1600);
    } catch {
      showToast('Could not copy to the clipboard', 'danger');
    }
  }

  const copiedStatus = $derived.by(() => {
    const entry = copied === null ? undefined : syntaxEntries().find((e) => e.id === copied);
    return entry ? `Copied the ${copyName(entry)} example` : '';
  });

  /** What Copy copies, by the name the reader sees: the entry, or the form showing in it. */
  function copyName(entry: SyntaxEntry): string {
    const forms = exampleForms(entry);
    const active = chosen[entry.id] ?? formForQuery(entry, query);
    return active === 0 ? entry.title : (forms[active]?.label ?? entry.title).toLowerCase();
  }
</script>

{#snippet runs(line: ExampleLine)}{#each line as run, r (r)}{#if run.syntax}<span class="syntax">{run.text}</span>{:else}{run.text}{/if}{/each}{/snippet}

{#snippet prose(text: string)}{#each proseRuns(text) as run, i (i)}{#if run.code}<code class="inline-code">{run.text}</code>{:else}{run.text}{/if}{/each}{/snippet}

<Dialog {open} size="lg" title="Script syntax reference" {onclose}>
  <div class="find">
    <div class="search">
      <span class="search-icon"><Icon name="search" size={14} /></span>
      <!-- Focus opens here, so the first keystroke is already a search. -->
      <input
        class="search-input"
        type="search"
        placeholder="Find syntax, like pause, note or :::"
        aria-label="Find syntax"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        data-autofocus
        bind:value={query}
        bind:this={searchInput}
        onkeydown={scrollFromSearch}
      />
      {#if query !== ''}
        <span class="count" aria-hidden="true">{matchCount}</span>
        <span class="search-clear">
          <IconButton icon="x" label="Clear search" size={14} onclick={clearSearch} />
        </span>
      {/if}
    </div>
  </div>
  <p class="hidden" role="status">{searchStatus}</p>
  <p class="hidden" role="status">{copiedStatus}</p>

  <!--
    The large panel hands the scroll boundary to its content, so this region
    owns it, and the footer's Done stays in view however long the page grows.
  -->
  <div
    class="scroll"
    class:more-above={edges.above}
    class:more-below={edges.below}
    bind:this={scroller}
    onscroll={measureEdges}
  >
    {#each groups as group (group.id)}
      <section class="group" aria-labelledby="{uid}-{group.id}">
        <!-- Sticks while its entries scroll under it, so a page halfway down
             still says which kind of thing it is showing. -->
        <h3 class="group-title" id="{uid}-{group.id}">{group.title}</h3>
        {#if group.note}<p class="group-note">{@render prose(group.note)}</p>{/if}
        {#each group.entries as entry (entry.id)}
          {@const forms = exampleForms(entry)}
          {@const active = chosen[entry.id] ?? formForQuery(entry, query)}
          {@const form = forms[active] ?? forms[0]!}
          {@const lines = exampleLines(form.source)}
          {@const notes = entry.notes ?? []}
          {@const problems = problemsOf(entry)}
          {@const blocks = specimens?.get(entry.id)?.[active]}
          <article class="entry" data-entry={entry.id} aria-labelledby="{uid}-{entry.id}">
            <div class="entry-head">
              <h4 class="name" id="{uid}-{entry.id}">{entry.title}</h4>
              <span class="copy">
                <Button size="sm" variant="ghost" onclick={() => copyExample(entry, form)}>
                  {#if copied === entry.id}<Icon name="check" size={13} />Copied{:else}Copy{/if}<span
                    class="hidden">{` the ${copyName(entry)} example`}</span
                  >
                </Button>
              </span>
            </div>

            <div class="source">
              {#if forms.length > 1}
                <!-- The other ways to write it, each an asserted case. The
                     picked form is what the glass, the words and Copy show. -->
                <SegmentedControl
                  size="sm"
                  label="{entry.title}: example"
                  options={forms.map((f, i) => ({ value: String(i), label: f.label }))}
                  value={String(active)}
                  onchange={(value) => (chosen = { ...chosen, [entry.id]: Number(value) })}
                />
              {/if}
              <!-- One block per source line, so a line that wraps hangs under
                   itself instead of passing for the next line. The newlines
                   stay in the text, hidden, so it reads back exactly. -->
              <pre class="example"><code>{#each lines as line, i (i)}<span class="line" class:blank={line.length === 0}>{@render runs(line)}</span>{#if i < lines.length - 1}<span class="newline">{'\n'}</span>{/if}{/each}</code></pre>
              {#if notes.length > 0}
                <ul class="notes">
                  {#each notes as note, i (i)}<li>{@render prose(note)}</li>{/each}
                </ul>
              {/if}
              {#if problems.length > 0}
                <!-- Severity is the case's own asserted `blocking`, in words
                     and weight rather than a coloured card. -->
                <dl class="problems">
                  {#each problems as problem (problem.what)}
                    <dt class:blocking={problem.blocking}>
                      {problem.blocking ? 'Stops presenting' : 'Warning'}
                    </dt>
                    <dd>{@render prose(problem.problem)}</dd>
                  {/each}
                </dl>
              {/if}
            </div>

            <dl class="outcome">
              <div class="facet">
                <dt>On the glass</dt>
                <dd>
                  <div class="glass" data-specimen={blocks ? 'ready' : 'loading'}>
                    {#if blocks}<SyntaxSpecimen {blocks} />{/if}
                  </div>
                  <p class="caption">{@render prose(entry.glass)}</p>
                </dd>
              </div>
              <div class="facet">
                <dt>Following listens for</dt>
                <dd>
                  <p class="heard">
                    {#if form.spoken && form.spoken.length > 0}“{form.spoken.join(' ')}”{:else}<span
                        class="nothing">Nothing</span
                      >{/if}
                  </p>
                  <p class="caption">{@render prose(entry.following)}</p>
                </dd>
              </div>
            </dl>
          </article>
        {/each}
      </section>
    {:else}
      <div class="empty">
        <p class="empty-title">No syntax matches “{query.trim()}”.</p>
        <p class="empty-hint">
          Try a piece of syntax, like <code class="inline-code">:::</code> or
          <code class="inline-code">[Cue</code>, or what you want to do, like <em>pause</em> or
          <em>pronounce</em>.
        </p>
        <Button size="sm" onclick={clearSearch}>Clear search</Button>
      </div>
    {/each}
  </div>
  {#snippet footer()}
    <Button variant="primary" onclick={onclose}>Done</Button>
  {/snippet}
</Dialog>

<style>
  /* ---- Search ---- */
  /* Held in by the scroller's scrollbar room, so the field and the entries
     share a right edge. */
  .find {
    display: flex;
    padding-right: var(--space-2);
  }
  /* The Library's search field, at the dialog's control height. */
  .search {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
  }
  .search-icon {
    position: absolute;
    left: var(--space-3);
    display: inline-flex;
    color: var(--text-muted);
    pointer-events: none;
  }
  .search-clear {
    position: absolute;
    right: 0;
    display: inline-flex;
  }
  .search-input {
    width: 100%;
    height: var(--control-h);
    padding: 0 112px 0 32px;
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-sm);
    transition:
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }
  .search-input::placeholder {
    color: var(--text-faint);
  }
  .search-input:hover {
    border-color: var(--border-strong);
  }
  /* Quiet focus — never an accent ring. The inset edge comes from the focus
     policy in tokens.css; this firms the border and lifts the fill. */
  .search-input:focus,
  .search-input:focus-visible {
    border-color: var(--border-strong);
    background: var(--bg-elevated);
  }
  .search-input::-webkit-search-cancel-button {
    display: none;
  }
  /* Inside the field, ahead of the clear button, while a search is typed. */
  .count {
    position: absolute;
    right: 36px;
    pointer-events: none;
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* ---- Results ---- */
  .scroll {
    /*
     * Asks for more height than any window has and shrinks to what the panel
     * allows, so the panel stays the same size whatever a search leaves in it.
     * Sized to its results, it re-centred on every keystroke and moved the
     * field being typed into.
     */
    height: 100vh;
    min-height: 0;
    overflow-y: auto;
    /* A jump to an entry, or Tab onto its Copy, lands below the sticky group
       heading rather than under it. */
    scroll-padding-top: 44px;
    /* The real end rests clear of the edge, so it never reads as a cut. */
    padding-bottom: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    /* Room for the scrollbar, so it never sits on the examples. */
    padding-right: var(--space-2);
    /* A hairline where entries run on past the edge, and nothing where they
       do not. Always present as transparent, so it never shifts a pixel. */
    border-block: 1px solid transparent;
    transition: border-color var(--dur-fast) var(--ease-out);
  }
  .scroll.more-above {
    border-top-color: var(--border);
  }
  .scroll.more-below {
    border-bottom-color: var(--border);
  }

  .group {
    display: flex;
    flex-direction: column;
  }
  .group-title {
    position: sticky;
    top: 0;
    z-index: 1;
    margin: 0;
    padding: var(--space-2) 0;
    background: var(--bg-panel);
    font-size: var(--text-base);
    line-height: var(--lh-label);
    font-weight: 650;
    color: var(--text-primary);
  }
  /* A short fade under the heading, so an entry scrolling beneath it passes
     under rather than stopping flush against it. White on white at rest. */
  .group-title::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    height: var(--space-2);
    background: linear-gradient(var(--bg-panel), transparent);
    pointer-events: none;
  }
  .group-note {
    margin: 0 0 var(--space-2);
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  .entry {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-areas:
      'head head'
      'source outcome';
    column-gap: var(--space-6);
    row-gap: var(--space-2);
    padding: var(--space-4) 0;
    border-top: 1px solid var(--border-faint);
  }
  .entry:first-of-type {
    padding-top: var(--space-2);
    border-top: 0;
  }
  .entry:last-child {
    padding-bottom: 0;
  }

  .entry-head {
    grid-area: head;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-height: 28px;
  }
  .name {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 650;
    color: var(--text-primary);
  }
  /* Room for "Copied" with its tick, so the title never moves when it shows. */
  .copy {
    flex: none;
    display: flex;
    justify-content: flex-end;
    min-width: 88px;
  }

  /* ---- What to type ---- */
  .source {
    grid-area: source;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .example {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    background: var(--bg-sunken);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: 1.6;
    color: var(--text-secondary);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  /* The UA sheet gives <code> its own `font-family: monospace`, which is
     Courier in WebKit; the example's face is the one set on the <pre>. */
  .example code {
    font: inherit;
  }
  .line {
    display: block;
    /* A wrapped line hangs two characters in under its own start. */
    padding-left: 2ch;
    text-indent: -2ch;
  }
  .line.blank {
    min-height: 1.6em;
  }
  .newline {
    display: none;
  }
  /* The characters that make the construct, set apart from your own words. */
  .syntax {
    color: var(--text-primary);
    font-weight: 600;
  }

  .notes {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
  }
  .notes li {
    position: relative;
    padding-left: var(--space-3);
  }
  .notes li::before {
    content: '';
    position: absolute;
    left: 2px;
    top: 0.62em;
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--text-muted);
  }

  /* The severity column is as wide as its longest label in every entry, so
     the descriptions line up from one entry to the next. */
  .problems {
    margin: 0;
    display: grid;
    grid-template-columns: 8.5em minmax(0, 1fr);
    column-gap: var(--space-3);
    row-gap: var(--space-1);
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
  }
  .problems dt {
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
  }
  .problems dt.blocking {
    color: var(--danger);
  }
  .problems dd {
    margin: 0;
    color: var(--text-secondary);
  }

  /* ---- What it does ---- */
  .outcome {
    grid-area: outcome;
    min-width: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .facet dt {
    margin-bottom: var(--space-1);
    font-size: var(--text-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--ls-caps);
    color: var(--text-muted);
  }
  .facet dd {
    margin: 0;
  }
  /* Holds a line's height while the compiler loads, so nothing jumps. */
  .glass {
    min-height: 22px;
  }
  .heard {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-primary);
  }
  .nothing {
    color: var(--text-muted);
  }
  .caption {
    margin: 2px 0 0;
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  .inline-code {
    font-family: var(--font-mono);
    font-size: 0.95em;
    color: var(--text-primary);
    white-space: nowrap;
  }

  /* ---- Nothing found ---- */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-6) 0;
  }
  .empty p {
    margin: 0;
  }
  .empty-title {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .empty-hint {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  /* Announced, never drawn. */
  .hidden {
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

  /* One column once the panel is too narrow for an example beside its outcome. */
  @media (max-width: 720px) {
    .entry {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas:
        'head'
        'source'
        'outcome';
    }
  }
</style>
