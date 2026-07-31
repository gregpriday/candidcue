<!--
  Keyboard-shortcut reference (spec §19). Cmd on macOS, Ctrl elsewhere.

  Grouped by the screen that answers each key, and grouped from
  `SHORTCUT_OWNERSHIP` rather than from a scope typed into each row here. This
  page used to read as one flat list of app-wide keys with "(during Live)" added
  by hand to four of the thirteen that needed it — so it promised most of the
  transport on every screen, and the resolver swallowed those keys to keep the
  promise. Reading the grouping from the table the window listener obeys is what
  makes the help and the keyboard the same fact rather than two that agree until
  somebody edits one.
-->
<script lang="ts">
  import Dialog from './Dialog.svelte';
  import Button from './Button.svelte';
  import {
    isMacPlatform,
    presentationModeShortcutLabel,
    SHORTCUT_OWNERSHIP,
    type ShortcutAction,
    type ShortcutOwnership,
    type ShortcutScope,
  } from '../lib/shortcuts';

  interface Props {
    open: boolean;
    onclose: () => void;
  }
  let { open, onclose }: Props = $props();

  const mod = isMacPlatform() ? '⌘' : 'Ctrl+';

  interface ShortcutRow {
    label: string;
    keys: string;
    /**
     * The commands this row documents — what places it in a group.
     *
     * A row can name two: a pair like back/forward is one line on the page and
     * two entries in the resolver, and naming both is what lets the completeness
     * test prove every command is documented somewhere.
     */
    actions: ShortcutAction[];
  }

  const rows: ShortcutRow[] = [
    { label: 'Command help', keys: `${mod}/`, actions: ['command-help'] },
    { label: 'New script', keys: `${mod}N`, actions: ['new-script'] },
    { label: 'Open quick search', keys: `${mod}K`, actions: ['quick-search'] },
    { label: 'Save', keys: `${mod}S`, actions: ['save'] },
    { label: 'Present current script', keys: `${mod}Enter`, actions: ['present'] },
    { label: 'Start / Pause / Resume', keys: 'Space (when not typing)', actions: ['play-pause'] },
    { label: 'Hard pause', keys: `${mod}Shift+Space`, actions: ['hard-pause'] },
    // §115: one verb. This key raises "End the session?" — the help calling the
    // same action "Stop session" is the vocabulary split that issue names.
    { label: 'End session', keys: `${mod}.`, actions: ['stop-session'] },
    {
      label: 'Back / forward one sentence',
      keys: 'Alt+← / Alt+→',
      actions: ['back-sentence', 'forward-sentence'],
    },
    {
      label: 'Previous / next chapter',
      keys: 'Alt+↑ / Alt+↓',
      actions: ['prev-chapter', 'next-chapter'],
    },
    {
      label: 'Increase / decrease stage text',
      keys: `${mod}= / ${mod}-`,
      actions: ['stage-text-up', 'stage-text-down'],
    },
    { label: 'Toggle horizontal mirror', keys: `${mod}Shift+M`, actions: ['toggle-mirror'] },
    // The "(during Live)" these four used to carry is the group caption now.
    { label: 'Blank stage', keys: 'B', actions: ['blank-stage'] },
    { label: 'Add take marker', keys: 'T', actions: ['take-marker'] },
    { label: 'Auto-scroll on / off', keys: 'A', actions: ['toggle-auto-scroll'] },
    {
      label: 'Auto-scroll slower / faster',
      keys: '[ / ]',
      actions: ['auto-scroll-slower', 'auto-scroll-faster'],
    },
    // The label comes from `shortcuts.ts` rather than being written out here,
    // because this is the one chord whose shape differs between platforms by more
    // than the modifier `mod` stands in for.
    {
      label: 'Full display / reading window',
      keys: presentationModeShortcutLabel(),
      actions: ['toggle-presentation-mode'],
    },
    // Twice, and from either window — the stage answers it when the presenter
    // is in front of it, this window when the operator is at the desk.
    { label: 'End the take and close the stage', keys: 'Esc Esc', actions: ['escape'] },
  ];

  /**
   * The two keys CodeMirror answers itself, listed but not owned by the table.
   *
   * They never pass through the window listener: bold and italic need the
   * editing surface's focus and its current selection, so they are bound inside
   * the editor and belong to whatever has focus there. Giving them
   * `ShortcutAction` entries would put two commands in the resolver that no
   * screen subscribes to, purely so they could be printed here.
   */
  const editorLocalRows: Array<Pick<ShortcutRow, 'label' | 'keys'>> = [
    { label: 'Bold', keys: `${mod}B` },
    { label: 'Italic', keys: `${mod}I` },
  ];

  /**
   * Strict membership — `global` is its own group, not a member of every one.
   *
   * Widened off the table's literal type on the way in. `SHORTCUT_OWNERSHIP` is
   * `as const`, so each entry narrows to its own readonly tuple, and asking a
   * union of those whether it `includes` a route name intersects the parameter
   * down to `never`.
   */
  function ownedBy(action: ShortcutAction, scope: ShortcutScope): boolean {
    const ownership: ShortcutOwnership = SHORTCUT_OWNERSHIP[action];
    if (scope === 'global') return ownership === 'global';
    return ownership !== 'global' && ownership.includes(scope);
  }

  function rowsFor(scope: ShortcutScope): ShortcutRow[] {
    return rows.filter((row) => row.actions.every((action) => ownedBy(action, scope)));
  }

  /**
   * The name each scope wears on the page.
   *
   * Exhaustive over `ShortcutScope`, which is the point. Listing the four
   * groups that happen to have keys today would repeat this issue one level up:
   * a command handed to Settings would be owned by the table, claimed by the
   * listener on that screen, and printed in no section at all — a working key
   * documented nowhere. Sections with nothing in them are dropped below, so
   * naming a screen here costs a line and buys the guarantee.
   */
  const GROUP_CAPTIONS = {
    global: 'Everywhere',
    library: 'Library',
    editor: 'Editor',
    live: 'During a take',
    welcome: 'Welcome',
    settings: 'Settings',
    calibrate: 'Calibrate',
  } as const satisfies Record<ShortcutScope, string>;

  /** Everywhere first, then the screens roughly in the order they are met. */
  const GROUP_ORDER = [
    'global',
    'library',
    'editor',
    'live',
    'welcome',
    'settings',
    'calibrate',
  ] as const satisfies readonly ShortcutScope[];

  /*
   * Present appears under both Library and Editor, because both screens answer
   * it — a duplicated line is the honest rendering of a key with two owners.
   *
   * `data-actions` carries what the resolver calls each row so the suite can
   * check the rendered page against `SHORTCUT_OWNERSHIP` pair by pair, rather
   * than counting rows and hoping. The editor's own keys carry none: they are
   * not in the table, which is exactly what the empty value says.
   */
  const groups = GROUP_ORDER.map((scope) => ({
    scope,
    caption: GROUP_CAPTIONS[scope],
    note:
      scope === 'editor' ? 'Bold and italic apply while the script text has focus.' : undefined,
    rows: [
      ...rowsFor(scope).map((row) => ({
        label: row.label,
        keys: row.keys,
        actions: row.actions.join(' '),
      })),
      ...(scope === 'editor' ? editorLocalRows.map((row) => ({ ...row, actions: '' })) : []),
    ],
  })).filter((group) => group.rows.length > 0);
</script>

<Dialog {open} title="Keyboard shortcuts" {onclose}>
  <!--
    Focus lands here rather than on Done, and `tabindex="-1"` keeps it out of the
    Tab order while still being a thing `focus()` can reach.

    The reference is now four tables tall — past the panel's max height, so the
    panel scrolls. Dialog focuses the first control it finds, which is the Done
    button in the footer, and focusing the footer of a scrolled panel scrolls the
    list to its end: the help would have opened on its last few rows with the
    title out of sight. A static line at the top is also what long dialogs are
    supposed to open on.
  -->
  <p class="intro" data-autofocus tabindex="-1">
    Every key the app answers, and the screen that answers it.
  </p>
  {#each groups as group (group.scope)}
    <table class="shortcuts">
      <caption>
        <span class="group">{group.caption}</span>
        {#if group.note}<span class="note">{group.note}</span>{/if}
      </caption>
      <thead>
        <tr>
          <th scope="col">Action</th>
          <th scope="col" class="keys">Shortcut</th>
        </tr>
      </thead>
      <tbody>
        {#each group.rows as row (row.label)}
          <tr data-actions={row.actions}>
            <td class="action">{row.label}</td>
            <td class="keys">{row.keys}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/each}
  {#snippet footer()}
    <Button variant="primary" onclick={onclose}>Done</Button>
  {/snippet}
</Dialog>

<style>
  .shortcuts {
    width: 100%;
    border-collapse: collapse;
  }
  .intro {
    margin: 0;
    color: var(--text-secondary);
  }
  /* Focused on open, and never wearing a ring for it — the panel carries the
     modality, and an accent outline on a paragraph would read as an error. */
  .intro:focus {
    outline: none;
  }
  caption {
    text-align: left;
    padding-bottom: var(--space-1);
  }
  .group {
    /* The group name reads as a heading for the rows under it, so it carries the
       weight rather than the accent — the dialog's own title is the only voice
       raised on this panel. */
    font-size: var(--text-sm);
    font-weight: 650;
    color: var(--text-primary);
  }
  .note {
    display: block;
    font-weight: 400;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  th {
    padding: var(--space-1) 0;
    font-size: var(--text-xs);
    font-weight: 500;
    text-align: left;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: var(--space-1) 0;
    font-size: var(--text-sm);
  }
  .action {
    color: var(--text-primary);
  }
  .keys {
    text-align: right;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
