<!--
  The editor's find and replace bar (see find-panel.ts for why it replaces
  CodeMirror's own). Drawn from the app's controls: the Library's search
  field, the flat Button, the Lucide set at its one stroke. CodeMirror owns
  the query and the commands; this reads a snapshot and dispatches.

  Two rows in one panel, because Find and Replace are one panel
  (MarkdownEditor.svelte). Both rows share one grid, so the two fields are one
  width and the two groups of actions start at one x however wide the pane is.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { runScopeHandlers, type EditorView } from '@codemirror/view';
  import { SearchQuery, closeSearchPanel, replaceAll, replaceNext, setSearchQuery } from '@codemirror/search';
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';
  import type { IconName } from './icon-names';
  import { formatAccelerator } from '../lib/commands';
  import { detectPlatform } from '../lib/platform';
  import { landOn, stepMatch, type FindSnapshot } from './find-panel';

  interface Props {
    view: EditorView;
    initial: FindSnapshot;
  }

  let { view, initial }: Props = $props();

  // svelte-ignore state_referenced_locally
  let snap = $state<FindSnapshot>(initial);

  /** CodeMirror hands the panel a fresh snapshot on every relevant update. */
  export function sync(next: FindSnapshot): void {
    snap = next;
  }

  /*
   * CodeMirror finds the search field by a bare `main-field` attribute:
   * `openSearchPanel` focuses and selects it when Find is chosen with the bar
   * already open. Spread rather than written inline, because Svelte's element
   * types have no such attribute and svelte-check rejects it as a literal.
   */
  const MAIN_FIELD = { 'main-field': 'true' };

  const uid = $props.id();
  const mac = detectPlatform() === 'macos';
  const keys = (accelerator: string) => formatAccelerator(accelerator, mac);

  const found = $derived(snap.total > 0);
  const replaceable = $derived(snap.replaceable > 0);
  const invalid = $derived(snap.status.kind === 'invalid');
  const matches = (n: number) => `${n} ${n === 1 ? 'match' : 'matches'}`;

  const statusText = $derived.by(() => {
    const status = snap.status;
    switch (status.kind) {
      case 'idle':
        return '';
      case 'invalid':
        // The engine's own reason ("Missing )"), which is what makes it fixable.
        return status.reason;
      case 'none':
        return 'No results';
      case 'replaced':
        return `${status.count} replaced`;
      case 'found':
        return status.current === null ? matches(status.total) : `${status.current} of ${status.total}`;
    }
  });

  const replaceAllTitle = $derived(
    replaceable ? `Replace all ${matches(snap.replaceable)} in this script (one undo)` : 'Replace all',
  );

  let host: HTMLElement;

  /**
   * Keep keyboard focus in the bar after an action.
   *
   * Replace all — and Replace on the last hit — disables the very button that
   * was pressed, and a focused button that becomes disabled drops focus to the
   * page: the next keystroke goes nowhere and Escape no longer closes the bar.
   * The find field is where the next thing happens (a new search, or Escape).
   */
  async function act(action: (target: EditorView) => boolean): Promise<void> {
    action(view);
    await tick();
    if (!host.contains(document.activeElement)) {
      host.querySelector<HTMLInputElement>('[main-field]')?.focus();
    }
  }

  function commit(change: Partial<FindSnapshot>, jump: boolean): void {
    const query = new SearchQuery({
      search: change.search ?? snap.search,
      replace: change.replace ?? snap.replace,
      caseSensitive: change.caseSensitive ?? snap.caseSensitive,
      wholeWord: change.wholeWord ?? snap.wholeWord,
      regexp: change.regexp ?? snap.regexp,
    });
    view.dispatch({ effects: setSearchQuery.of(query) });
    if (jump) landOn(view, query);
  }

  function onSearchInput(event: Event): void {
    commit({ search: (event.currentTarget as HTMLInputElement).value }, true);
  }

  function onReplaceInput(event: Event): void {
    commit({ replace: (event.currentTarget as HTMLInputElement).value }, false);
  }

  type Option = 'caseSensitive' | 'wholeWord' | 'regexp';

  function toggle(option: Option): void {
    commit({ [option]: !snap[option] }, true);
  }

  const OPTIONS: Array<{ option: Option; name: string; label: string; accelerator: string; icon: IconName }> = [
    { option: 'caseSensitive', name: 'case', label: 'Match case', accelerator: 'Mod+Alt+C', icon: 'match-case' },
    { option: 'wholeWord', name: 'word', label: 'Whole words', accelerator: 'Mod+Alt+W', icon: 'whole-word' },
    { option: 'regexp', name: 're', label: 'Regular expression', accelerator: 'Mod+Alt+R', icon: 'regex' },
  ];

  /*
   * ⌥⌘C / ⌥⌘W / ⌥⌘R flip the options from either field — the chords the other
   * Mac editors use. Matched on `code`, because ⌥ turns `key` into ç, ∑ and ®.
   * Only while focus is in this panel, so they claim nothing anywhere else.
   */
  const OPTION_KEYS: Record<string, Option> = {
    KeyC: 'caseSensitive',
    KeyW: 'wholeWord',
    KeyR: 'regexp',
  };

  function onKeydown(event: KeyboardEvent): void {
    // The editor's own panel-scoped bindings first: Escape, ⌘G, and the ⌘↩
    // reservation that keeps Present from also running Replace.
    if (runScopeHandlers(view, event, 'search-panel')) {
      event.preventDefault();
      return;
    }
    const primary = mac ? event.metaKey : event.ctrlKey;
    const option = OPTION_KEYS[event.code];
    if (option && primary && event.altKey && !event.shiftKey) {
      event.preventDefault();
      toggle(option);
      return;
    }
    if (event.key !== 'Enter') return;
    const target = event.target as HTMLInputElement;
    if (target.name === 'search') {
      event.preventDefault();
      stepMatch(view, event.shiftKey ? -1 : 1);
    } else if (target.name === 'replace') {
      event.preventDefault();
      void act(replaceNext);
    }
  }
</script>

<!--
  `role="search"` names the region for a screen reader. It is not a dialog and
  traps nothing: the document stays editable with the bar open.
-->
<div class="host" bind:this={host}>
  <!-- The keydown is the fields' and buttons', caught once as it bubbles. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="find" role="search" aria-label="Find and replace" onkeydown={onKeydown}>
    <div class="field find-field" class:invalid>
      <span class="lead" aria-hidden="true"><Icon name="search" size={14} /></span>
      <input
        class="input"
        name="search"
        {...MAIN_FIELD}
        type="text"
        placeholder="Find in script"
        aria-label="Find"
        aria-describedby="{uid}-status"
        aria-invalid={invalid ? 'true' : undefined}
        autocomplete="off"
        spellcheck="false"
        value={snap.search}
        oninput={onSearchInput}
      />
    </div>

    <!--
      The two fields are next to each other in the focus order — one Tab from
      what to find to what to put there — and the controls follow.
    -->
    <div class="field replace-field">
      <input
        class="input"
        name="replace"
        type="text"
        placeholder="Replace with"
        aria-label="Replace with"
        autocomplete="off"
        spellcheck="false"
        value={snap.replace}
        oninput={onReplaceInput}
      />
    </div>

    <!--
      The options sit inside the field they change, overlaid on its trailing
      end — a grid item sharing the field's area rather than a child of it, so
      a narrow pane can move them to a row of their own.
    -->
    <div class="options" role="group" aria-label="Search options">
      {#each OPTIONS as item (item.option)}
        <button
          type="button"
          class="option"
          name={item.name}
          data-focus="control"
          aria-label={item.label}
          aria-pressed={snap[item.option] ? 'true' : 'false'}
          title={`${item.label} (${keys(item.accelerator)})`}
          onclick={() => toggle(item.option)}
        >
          <Icon name={item.icon} size={16} />
        </button>
      {/each}
    </div>

    <div class="nav">
      <button
        type="button"
        class="step"
        name="prev"
        data-focus="control"
        aria-label="Previous match"
        title={`Previous match (${keys('Mod+Shift+G')})`}
        disabled={!found}
        onclick={() => stepMatch(view, -1)}
      >
        <Icon name="chevron-up" size={16} />
      </button>
      <button
        type="button"
        class="step"
        name="next"
        data-focus="control"
        aria-label="Next match"
        title={`Next match (${keys('Mod+G')})`}
        disabled={!found}
        onclick={() => stepMatch(view, 1)}
      >
        <Icon name="chevron-down" size={16} />
      </button>
    </div>

    <span
      id="{uid}-status"
      class="status {snap.status.kind}"
      role="status"
      title={snap.status.kind === 'replaced' ? `Undo with ${keys('Mod+Z')}` : undefined}
    >
      {#if snap.status.kind === 'replaced'}<Icon name="check" size={13} />{/if}
      {#if snap.status.kind === 'invalid'}<Icon name="alert" size={13} />{/if}
      <span class="status-text">{statusText}</span>
    </span>

    <button
      type="button"
      class="step close"
      data-focus="control"
      aria-label="Close find"
      title="Close (Esc)"
      onclick={() => closeSearchPanel(view)}
    >
      <Icon name="x" size={16} />
    </button>

    <div class="replace-actions">
      <Button
        size="sm"
        title="Replace this match and find the next (↩)"
        disabled={!replaceable}
        onclick={() => act(replaceNext)}
      >
        Replace
      </Button>
      <!--
        A narrow pane shows "All" beside "Replace" — read as a pair, that is
        "Replace / Replace all" — while the full name stays the accessible one.
      -->
      <Button size="sm" title={replaceAllTitle} disabled={!replaceable} onclick={() => act(replaceAll)}>
        <span class="all-long">Replace all</span>
        <span class="all-short" aria-hidden="true">All</span>
        <!-- The scope, on the button that acts on it. -->
        {#if replaceable}<span class="action-count">{snap.replaceable}</span>{/if}
      </Button>
    </div>
  </div>
</div>

<style>
  .host {
    container: find / inline-size;
  }

  /*
   * A band of the editor's chrome, not a card on the document: the toolbar's
   * own fill, edge to edge, ending at one divider (drawn by `.cm-panels` in
   * cm-theme.ts). The fields start at the page inset — the same x as the
   * formatting row's first control and the script's first letter.
   */
  .find {
    display: grid;
    grid-template-columns: minmax(0, 360px) auto auto minmax(0, 1fr) auto;
    /* The steppers sit right after the field they step through, and the count
       after them, so a long message grows into the spare column and moves
       nothing. The replace actions run on into that column too, so their width
       never widens the steppers' column. */
    grid-template-areas:
      'find nav status . close'
      'repl actions actions actions .';
    align-items: center;
    column-gap: var(--space-2);
    row-gap: 6px;
    padding: 6px var(--page-x);
    background: var(--bg-toolbar);
    color: var(--text-primary);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
  }

  .find-field {
    grid-area: find;
  }
  /* Positioned and lifted: the field is positioned too, and would otherwise
     paint over the options and take their clicks. */
  .options {
    grid-area: find;
    justify-self: end;
    position: relative;
    z-index: 1;
    display: flex;
    /* Off the field's edge, so the last plate has the air the others do. */
    margin-right: 2px;
  }
  .status {
    grid-area: status;
  }
  .nav {
    grid-area: nav;
    display: flex;
    gap: 2px;
  }
  .close {
    grid-area: close;
  }
  .replace-field {
    grid-area: repl;
  }
  .replace-actions {
    grid-area: actions;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  /* The Library's search field, at the same 28px toolbar tier. */
  .field {
    position: relative;
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .lead {
    position: absolute;
    left: var(--space-2);
    display: inline-flex;
    color: var(--text-muted);
    pointer-events: none;
  }
  .input {
    width: 100%;
    min-width: 0;
    height: var(--toolbar-control-h);
    padding: 0 var(--space-2);
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
  /* Room for the glass on the left and the three options on the right. */
  .find-field .input {
    padding: 0 calc(3 * var(--toolbar-control-h) + 6px) 0 26px;
  }
  .input::placeholder {
    color: var(--text-faint);
  }
  .input:hover {
    border-color: var(--border-strong);
  }
  /* Quiet focus, per the house rule: the inset edge comes from tokens.css. */
  .input:focus,
  .input:focus-visible {
    border-color: var(--border-strong);
    background: var(--bg-elevated);
  }
  /* A pattern that does not parse says so on the field, focused or not: a
     2px red edge, with the quiet focus ring stepped inside it rather than
     drawn over it — red outermost, so the error is what reads first. */
  .invalid .input,
  .invalid .input:focus {
    border-color: var(--danger);
    box-shadow: inset 0 0 0 1px var(--danger);
  }
  .invalid .input:focus-visible {
    outline-offset: -4px;
  }

  /*
   * IconButton's toggle, at the 28px toolbar tier. The button is the full
   * 28px square — that is the target — and the visible plate is drawn 3px
   * inside it, so three of them fit inside a 28px field with air between
   * them and around them.
   *
   * Off, a quiet glyph; on, the seated white pill with the glyph in clay. The
   * pill's edge is `--border-state` rather than IconButton's `--border`: here
   * it sits on the white field, where a shadow alone would not show it, and
   * the state edge is what carries "on" at 3:1 without leaning on colour.
   */
  .option {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--toolbar-control-h);
    height: var(--toolbar-control-h);
    padding: 0;
    border: none;
    /* Never painted — it rounds the focus ring to the plate's shape. */
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    transition: color var(--dur-fast) var(--ease-out);
  }
  .option::before {
    content: '';
    position: absolute;
    inset: 3px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }
  /* The glyph above the plate. */
  .option :global(.lucide-icon) {
    position: relative;
  }
  /* The focus ring hugs the plate (inset 3px) rather than the larger
     target, and so stays clear of the field's own border. */
  .option:focus-visible {
    outline-offset: -3px;
  }
  .option:hover {
    color: var(--text-primary);
  }
  .option:hover::before {
    background: var(--bg-hover-chrome);
  }
  .option[aria-pressed='true'] {
    color: var(--accent-strong);
  }
  .option[aria-pressed='true']::before {
    background: var(--bg-panel);
    border-color: var(--border-state);
    box-shadow: var(--shadow-card);
  }
  /* A press reads as pushed in, on or off — after the toggled rules so the
     seated pill's lift does not win over it. */
  .option:active::before,
  .option[aria-pressed='true']:active::before {
    background: var(--bg-hover-chrome);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.16);
  }

  /*
   * Where you are, in words, with tabular figures. Last in its row, so "9 of
   * 12" becoming "10 of 12" — or an error appearing — moves nothing.
   */
  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    min-width: 0;
    max-width: 240px;
    padding-left: var(--space-1);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .status-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status.none {
    color: var(--text-muted);
  }
  .status.invalid {
    color: var(--danger);
    font-weight: 600;
  }
  .status.replaced :global(.lucide-icon) {
    color: var(--success);
  }

  .action-count {
    color: var(--text-muted);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .step {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--toolbar-control-h);
    height: var(--toolbar-control-h);
    flex: 0 0 auto;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .step:hover:not(:disabled) {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }
  .step:active:not(:disabled) {
    background: var(--bg-hover-chrome);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.16);
  }
  .step:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .all-short {
    display: none;
  }

  /*
   * The narrow pane: the split editor at the smallest window is about 245px.
   * Three options inside a field that narrow would leave no room to type, so
   * they move to a third row with the count. That row spans every column, so
   * a long regex error there can never widen the steppers' columns and take
   * the width back from the fields. The steppers and the close button share
   * the find row; Replace and All share the replace row beneath them.
   */
  @container find (width < 480px) {
    .find {
      grid-template-columns: minmax(0, 1fr) auto auto;
      grid-template-areas:
        'find nav close'
        'repl actions actions'
        'meta meta meta';
      padding-inline: var(--space-3);
    }
    .options {
      grid-area: meta;
      justify-self: start;
      margin-right: 0;
    }
    .find-field .input {
      padding-right: var(--space-2);
    }
    /* Ends where the close button's glyph ends, not its 28px box. */
    .status {
      grid-area: meta;
      justify-self: end;
      justify-content: flex-end;
      padding-right: 6px;
      /* The options' three 28px buttons and a gap, kept clear. */
      max-width: calc(100% - 3 * var(--toolbar-control-h) - var(--space-3));
    }
    .replace-actions {
      gap: var(--space-1);
    }
    .replace-actions :global(.button) {
      padding-inline: var(--space-2);
    }
    .action-count {
      display: none;
    }
    .all-short {
      display: inline;
    }
    .all-long {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }
</style>
