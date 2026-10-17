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

  The page is two indexes of one keyboard, side by side: the menu bar's keys as
  the menus print them, and the keys each screen relies on again by screen,
  with the take's own keys that no menu lists. Laid out as two columns of the
  large panel, like the script syntax reference beside it in the Help menu, so
  the take's keys are on screen the moment it opens rather than at the foot of
  one long strip.
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
  import {
    commandsByCategory,
    formatAccelerator,
    type CommandCategory,
    type CommandContext,
  } from '../lib/commands';
  import { route } from '../stores/router';
  import { session } from '../stores/session';

  interface Props {
    open: boolean;
    onclose: () => void;
  }
  let { open, onclose }: Props = $props();

  const uid = $props.id();
  const mac = isMacPlatform();

  /**
   * What to press: one or more alternatives (back / forward), each a sequence
   * of one or more chords (Esc, then Esc again).
   *
   * Every chord is spelled by `formatAccelerator`, the function the menu half
   * of this page and the File menu itself spell keys with. The transport rows
   * used to be typed out by hand — "Alt+←" and "⌘Shift+Space" — which on a Mac
   * printed Windows words beside the ⌥← the Session menu table showed for the
   * same key two tables up.
   */
  type Keys = string[][];
  const spell = (accelerator: string): string => formatAccelerator(accelerator, mac);
  const one = (accelerator: string): Keys => [[spell(accelerator)]];
  const either = (a: string, b: string): Keys => [[spell(a)], [spell(b)]];

  interface ShortcutRow {
    label: string;
    keys: Keys;
    /**
     * The commands this row documents — what places it in a group.
     *
     * A row can name two: a pair like back/forward is one line on the page and
     * two entries in the resolver, and naming both is what lets the completeness
     * test prove every command is documented somewhere.
     */
    actions: ShortcutAction[];
    /**
     * The menu commands this row is the SAME key as (§6.1).
     *
     * Some keys are documented twice on this page on purpose: the native menu
     * half lists "Previous Sentence — ⌥←" because that is what the Session menu
     * says, and the screen-scoped half lists "Previous / next sentence" because
     * that is where the key works. One chord, one meaning, two sentences about
     * it.
     *
     * Naming the commands rather than letting the duplicate pass silently is
     * what keeps the page's own conflict check sharp: a chord printed twice is
     * a defect unless the two rows say here that they are the same thing. That
     * check is what found Insert › Link and the Library's quick search both
     * claiming ⌘K, and the editor's zoom keys eating the stage type size.
     */
    mirrors?: string[];
    /**
     * When the key does nothing even on its own screen, said under the label.
     *
     * Only for a condition that belongs to this row alone; one a whole group
     * shares is the group's note.
     */
    when?: string;
  }

  const rows: ShortcutRow[] = [
    /*
     * Named exactly as the Help menu names it. The registry half of this page
     * prints "Keyboard Shortcuts" for the same ⌘/, and calling it "Command
     * help" here was the vocabulary split §6.1 is about — two names, one key,
     * and a reader with no way to know they are the same thing.
     */
    {
      label: 'Keyboard Shortcuts',
      keys: one('Mod+/'),
      actions: ['command-help'],
      mirrors: ['help.keyboard-shortcuts'],
    },
    { label: 'New Script', keys: one('Mod+N'), actions: ['new-script'], mirrors: ['file.new-script'] },
    // Edit › Find in Library… — the menu's own name for ⌘F on this screen.
    {
      label: 'Find in Library…',
      keys: one('Mod+F'),
      actions: ['find-in-list'],
      mirrors: ['edit.find'],
    },
    { label: 'Save', keys: one('Mod+S'), actions: ['save'], mirrors: ['file.save'] },
    { label: 'Present', keys: one('Mod+Return'), actions: ['present'], mirrors: ['file.present'] },
    /*
     * The take's keys, in the order somebody mid-take reaches for them: the
     * transport and the blank first, then moving through the script, then the
     * pace, and the stage's own settings last. Nothing on this list is learnt
     * mid-take, but it is LOOKED UP mid-take, and the first rows are the ones a
     * presenter is hunting for with a camera rolling.
     *
     * Space's "when not typing" is the group's note now, which covers every
     * plain key in the group rather than this one alone.
     */
    { label: 'Start / Pause / Resume', keys: one('Space'), actions: ['play-pause'] },
    // The "(during Live)" these rows used to carry is the group caption now.
    { label: 'Blank stage', keys: one('B'), actions: ['blank-stage'] },
    // Worded the way the Session menu words the same keys — "Previous
    // Sentence", "Previous Section" — so the two halves of the page agree.
    {
      label: 'Previous / next sentence',
      keys: either('Alt+Left', 'Alt+Right'),
      actions: ['back-sentence', 'forward-sentence'],
      mirrors: ['session.previous-sentence', 'session.next-sentence'],
    },
    {
      label: 'Previous / next section',
      keys: either('Alt+Up', 'Alt+Down'),
      actions: ['prev-chapter', 'next-chapter'],
      mirrors: ['session.previous-chapter', 'session.next-chapter'],
    },
    // §115: one verb. This key raises "End the session?" — the help calling the
    // same action "Stop session" is the vocabulary split that issue names.
    {
      label: 'End Take',
      keys: one('Mod+.'),
      actions: ['stop-session'],
      mirrors: ['session.end-take'],
    },
    // Twice, and from either window — the stage answers it when the presenter
    // is in front of it, this window when the operator is at the desk. A
    // sequence rather than a chord, so it reads "Esc, then Esc".
    { label: 'End the take and close the stage', keys: [['Esc', 'Esc']], actions: ['escape'] },
    { label: 'Hard pause', keys: one('Mod+Shift+Space'), actions: ['hard-pause'] },
    { label: 'Auto-scroll on / off', keys: one('A'), actions: ['toggle-auto-scroll'] },
    {
      label: 'Auto-scroll slower / faster',
      keys: either('[', ']'),
      actions: ['auto-scroll-slower', 'auto-scroll-faster'],
    },
    /*
     * Most takes size their type for the display they land on — automatically,
     * or from a calibration — and then these keys have nothing to move: Live
     * answers them with a toast saying so. Printing them bare would promise a
     * key that, on most rigs, only explains itself.
     */
    {
      label: 'Larger / smaller stage text',
      keys: either('Mod+=', 'Mod+-'),
      actions: ['stage-text-up', 'stage-text-down'],
      mirrors: ['view.zoom-in', 'view.zoom-out'],
      when: 'Unless the display sizes its own text',
    },
    // Named as the Session menu names the same command, "Mirror Stage".
    { label: 'Mirror stage', keys: one('Mod+Shift+M'), actions: ['toggle-mirror'] },
    // The label comes from `shortcuts.ts` rather than being written out here,
    // because this is the one chord whose shape differs between platforms by more
    // than the modifier stands in for.
    //
    // Named for the switch it is. "Full display" read as making the window
    // bigger; what the key does is change the take's presentation mode, which
    // from a reading window can move it onto the pinned prompter panel and
    // apply that panel's optics and mirroring — the stage dock's menu names the
    // same switch from whichever side of it the take is on.
    {
      label: 'Switch between reading window and teleprompter',
      keys: [[presentationModeShortcutLabel(mac)]],
      actions: ['toggle-presentation-mode'],
    },
  ];

  /**
   * The keys the STAGE answers itself, listed but not owned by the table.
   *
   * The editor's bold and italic below, one surface over. The stage listens on
   * its own window (`StageApp.svelte`, `onKeyDown` and `onWheel`) and moves the
   * script by hand for these, so they never pass through `resolveShortcut` and
   * have no `ShortcutAction` to be grouped by. Leaving them off the page made
   * the help silent about the most ordinary thing a reader does with a
   * keyboard; giving them actions would put commands in the resolver that no
   * screen subscribes to, purely so they could be printed here.
   *
   * Only keys the stage actually answers.
   *
   * The wheel is a gesture, not a key, so it is written out in words rather
   * than drawn as a cap somebody would go looking for on the keyboard.
   */
  const stageLocalRows: Array<Pick<ShortcutRow, 'label' | 'keys'> & { gesture?: string }> = [
    { label: 'Move the script one line', keys: either('Up', 'Down') },
    { label: 'Move the script about a screen', keys: either('Page Up', 'Page Down') },
    { label: 'Go to the start or end of the script', keys: either('Home', 'End') },
    { label: 'Scroll the script', keys: [], gesture: 'Mouse wheel or trackpad' },
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
    { label: 'Bold', keys: one('Mod+B') },
    { label: 'Italic', keys: one('Mod+I') },
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

  /**
   * The condition a group's keys share, said once under its name rather than
   * stapled to one key in it.
   *
   * The take's note used to be "(when not typing)" inside Space's key cell —
   * which put a sentence where a key belongs and implied Space was the only
   * key that stands down. `resolveShortcut` holds back every unmodified letter
   * and bracket in the group too, and not only while a text field has focus: a
   * focused button, switch, tab or link answers those keys itself, so the take
   * does not. Escape stands down for typing only — it ends a take whatever
   * button has focus. The note names the keys rather than saying "single keys"
   * because F11 is one and does NOT stand down: a function key types nothing,
   * so a field has no claim on it.
   *
   * The stage's own movement keys stand down too, for the stage's reasons
   * rather than the resolver's: `StageApp.svelte` ignores every key but Escape
   * while a panel is open over it or a control on it has the keyboard — and on
   * the focused Take-menu trigger the arrows open the menu instead.
   */
  const GROUP_NOTES: Partial<Record<ShortcutScope, string>> = {
    editor: 'Bold and italic apply while the script text has focus.',
    live:
      'Space, B, A, [, ], the arrows and the page keys do nothing while you are typing or a ' +
      'control has focus. Esc does nothing while you are typing.',
  };

  /**
   * The menu commands, READ FROM THE REGISTRY (§6.1).
   *
   * ---------------------------------------------------------------------------
   * WHY THIS SECTION EXISTS SEPARATELY FROM THE TABLE ABOVE
   * ---------------------------------------------------------------------------
   * This page used to be built entirely from `rows` — a hand-written list keyed
   * to `ShortcutAction`. That was right while every key in the app went through
   * the window listener. It stopped being the whole story when the native menu
   * arrived: File › Duplicate, View › Show Outline, Insert › Cue and two dozen
   * others carry accelerators that `resolveShortcut` has never heard of, because
   * the OS dispatches them. None of them could appear here, so the page called
   * "every key the app answers" was missing most of them.
   *
   * So the menu's half is DERIVED — from `COMMANDS`, and through the same
   * `formatAccelerator` that spells a chord for this platform. A command cannot
   * gain a key without appearing here, and cannot appear here with a key it does
   * not have.
   *
   * The native menu itself is NOT built from `COMMANDS`: `menu.rs` is Rust and
   * writes the ids, labels and accelerators out again. What stops the two from
   * drifting is `menu_accelerators_match_the_typescript_registry`, which
   * compares the accelerator sets in both directions.
   *
   * The transport table is still hand-written, and still necessary: Space, B,
   * A and the bracket keys have no menu item and no command id — they are plain
   * keys owned by the screen that is up, which is exactly what
   * `SHORTCUT_OWNERSHIP` describes. Folding those into the registry is the
   * remaining half of §6.1.
   */
  const MENU_CAPTIONS: Record<CommandCategory, string> = {
    file: 'File',
    edit: 'Edit',
    insert: 'Insert',
    view: 'View',
    session: 'Session',
    window: 'Window',
    help: 'Help',
  };

  /*
   * Each command named as the menu bar names it RIGHT NOW, ellipsis and all. A
   * few labels follow the screen — ⌘W is Close Script in the editor and Close
   * Window everywhere else, ⌘F is Find in Library… in the Library, ⌘+ is
   * Larger Stage Text during a take — and printing the static label beside the
   * key told the Library that ⌘W closes a script, when it closes the window.
   *
   * The labels are the registry's own `dynamicLabel` rules, fed the facts they
   * read. This dialog cannot see App's whole `CommandContext`, so it supplies
   * the screen and whether a take is running, which is everything the labels
   * of commands WITH a key depend on today. The moment a take is starting is
   * left out: the cover that spans it sits over this dialog anyway.
   */
  const labelFacts = $derived({
    route: $route,
    sessionActive: $session.active,
    takeStarting: false,
  } as CommandContext);

  const menuGroups = $derived(
    commandsByCategory()
      .map((group) => ({
        category: group.category,
        caption: MENU_CAPTIONS[group.category],
        rows: group.commands
          .filter((command) => command.accelerator !== undefined)
          .map((command) => ({
            label: command.dynamicLabel?.(labelFacts) ?? command.label,
            keys: one(command.accelerator!),
            id: command.id,
          })),
      }))
      .filter((group) => group.rows.length > 0),
  );

  /*
   * Present appears under both Library and Editor, because both screens answer
   * it — a duplicated line is the honest rendering of a key with two owners.
   *
   * `data-actions` carries what the resolver calls each row so the suite can
   * check the rendered page against `SHORTCUT_OWNERSHIP` pair by pair, rather
   * than counting rows and hoping. The editor's and the stage's own keys carry
   * none: they are not in the table, which is exactly what the empty value says.
   */
  interface RenderedRow {
    label: string;
    keys: Keys;
    /** Written out in place of the caps, for a row that is not a key at all. */
    gesture?: string;
    when: string | undefined;
    actions: string;
    mirrors: string;
  }

  /**
   * The stage's own rows, placed with the other ways of moving through the
   * script rather than after the stage's settings, because the take's table is
   * ordered by what somebody mid-take is hunting for. After the section row
   * when there is one; at the end otherwise, so a reworded table can move them
   * but never lose them.
   */
  function withStageRows(rows: RenderedRow[]): RenderedRow[] {
    const stage: RenderedRow[] = stageLocalRows.map((row) => ({
      ...row,
      when: undefined,
      actions: '',
      mirrors: '',
    }));
    const after = rows.findIndex((row) => row.actions.split(' ').includes('next-chapter'));
    if (after === -1) return [...rows, ...stage];
    return [...rows.slice(0, after + 1), ...stage, ...rows.slice(after + 1)];
  }

  const groups = GROUP_ORDER.map((scope) => {
    const owned: RenderedRow[] = rowsFor(scope).map((row) => ({
      label: row.label,
      keys: row.keys,
      when: row.when,
      actions: row.actions.join(' '),
      mirrors: row.mirrors?.join(' ') ?? '',
    }));
    const editor: RenderedRow[] =
      scope === 'editor'
        ? editorLocalRows.map((row) => ({
            ...row,
            when: undefined,
            actions: '',
            mirrors: 'insert.bold insert.italic',
          }))
        : [];
    return {
      scope,
      caption: GROUP_CAPTIONS[scope],
      note: GROUP_NOTES[scope],
      rows: scope === 'live' ? withStageRows(owned) : [...owned, ...editor],
    };
  }).filter((group) => group.rows.length > 0);

  /**
   * One chord as the keys you hold: "⇧⌘Space" is ⇧, ⌘ and Space.
   *
   * Split back out of the spelled string rather than built alongside it, so
   * the caps can never say anything the string does not — joined up again
   * (with the `+` Windows prints between them) they ARE that string, which is
   * what the suite compares against the registry.
   */
  const MAC_MODIFIERS = new Set(['⌃', '⌥', '⇧', '⌘']);
  function capsOf(chord: string): string[] {
    if (mac) {
      const caps: string[] = [];
      let rest = chord;
      while (rest.length > 1 && MAC_MODIFIERS.has(rest.charAt(0))) {
        caps.push(rest.charAt(0));
        rest = rest.slice(1);
      }
      return [...caps, rest];
    }
    // `Ctrl++` is Ctrl and the plus key, so the key is whatever follows the
    // last modifier — never a split on every `+`.
    const match = /^((?:(?:Ctrl|Alt|Shift)\+)*)(.+)$/.exec(chord);
    if (!match) return [chord];
    return [...(match[1] ?? '').split('+').filter(Boolean), match[2] ?? ''];
  }

  /**
   * A cap holding one mark rather than a word or letter — ⌘, ⇧, ., /, [ — is
   * set a size up, because at the caps' own size a full stop is a speck in an
   * empty box.
   */
  const isMark = (cap: string): boolean => cap.length === 1 && !/[A-Za-z0-9]/.test(cap);

  /**
   * What a key is called out loud.
   *
   * The caps are glyphs and punctuation, and a screen reader's reading of "⇧⌘."
   * is up to its symbol tables — some say "shift command period", some skip
   * the full stop. So each key cell carries its keys in words, and a mark's
   * cap carries its name for the pointer that lingers on it.
   */
  const KEY_NAMES: Record<string, string> = {
    '⌃': 'Control',
    '⌥': 'Option',
    '⇧': 'Shift',
    '⌘': 'Command',
    '⏎': 'Return',
    '←': 'Left Arrow',
    '→': 'Right Arrow',
    '↑': 'Up Arrow',
    '↓': 'Down Arrow',
    '.': 'Period',
    ',': 'Comma',
    '/': 'Slash',
    '-': 'Minus',
    '+': 'Plus',
    '[': 'Left Bracket',
    ']': 'Right Bracket',
    Ctrl: 'Control',
    Esc: 'Escape',
  };

  /** "Option Left Arrow, or Option Right Arrow"; "Escape, then Escape". */
  function spoken(keys: Keys): string {
    return keys
      .map((presses) =>
        presses
          .map((press) =>
            capsOf(press)
              .map((cap) => KEY_NAMES[cap] ?? cap)
              .join(' '),
          )
          .join(', then '),
      )
      .join(', or ');
  }

  /** A take is running, so the take's keys get one more note. */
  const live = $derived($session.active);

  /*
   * Whether rows are hidden above or below the scroll region, so its edge can
   * say so. The title and Done sit outside the region, and a row sliced by its
   * edge with nothing marking the edge read as the end of the list.
   */
  let scroller: HTMLElement | null = $state(null);
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
</script>

<!--
  The caps are written on one line on purpose. A line break between these tags
  would be a space in the cell's text, and the cell's text is the key as the
  registry spells it — "⌘N", not "⌘ N".
-->
{#snippet chord(spelled: string)}<kbd class="chord">{#each capsOf(spelled) as cap, i (i)}{#if i > 0 && !mac}<span class="plus">+</span>{/if}<kbd class="cap" class:mark={isMark(cap)} title={isMark(cap) ? KEY_NAMES[cap] : undefined}>{cap}</kbd>{/each}</kbd>{/snippet}

{#snippet keycaps(keys: Keys)}{#each keys as presses, a (a)}{#if a > 0}<span class="or">{' / '}</span>{/if}{#each presses as press, p (p)}{#if p > 0}<span class="then">{' then '}</span>{/if}{@render chord(press)}{/each}{/each}{/snippet}

<Dialog {open} size="lg" title="Keyboard shortcuts" {onclose}>
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
    <!--
      Focus lands here rather than on Done, and `tabindex="-1"` keeps it out of
      the Tab order while still being a thing `focus()` can reach.

      Dialog focuses the first control it finds, which is the Done button in
      the footer. When the whole panel scrolled, that opened the help on its
      last few rows with the title out of sight; Done sits outside the scroll
      region now, but a static line at the top is still what a long dialog
      opens on, and it is where a screen reader should start reading.
    -->
    <p class="intro" data-autofocus tabindex="-1">
      Every key the app answers, listed by menu, with the ones each screen relies on repeated by
      screen.
    </p>

    <div class="indexes">
      <!--
        The menu's own keys, derived from the command registry — see
        `menuGroups`. `data-command` carries the id so the suite can check the
        rendered page against `COMMANDS` entry by entry rather than counting
        rows.
      -->
      <section class="index" aria-labelledby="{uid}-menus">
        <header class="index-head">
          <h3 class="index-title" id="{uid}-menus">By menu</h3>
          <p class="index-note">As the menu bar prints them, wherever the command works.</p>
        </header>
        {#each menuGroups as group (group.category)}
          <table class="shortcuts">
            <!-- A heading as well as a caption, so a screen reader can jump
                 between groups the way the eye does. -->
            <caption>
              <h4 class="group">{group.caption}<span class="hidden">{' menu'}</span></h4>
            </caption>
            <thead class="hidden">
              <tr>
                <th scope="col">Command</th>
                <th scope="col">Shortcut</th>
              </tr>
            </thead>
            <tbody>
              {#each group.rows as row (row.id)}
                <tr data-command={row.id}>
                  <td class="action">{row.label}</td>
                  <td class="keys" aria-label={spoken(row.keys)}>{@render keycaps(row.keys)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/each}
      </section>

      <section class="index" aria-labelledby="{uid}-screens">
        <header class="index-head">
          <h3 class="index-title" id="{uid}-screens">By screen</h3>
          <p class="index-note">The keys each screen relies on, plus keys no menu lists.</p>
        </header>
        <!--
          The take's table is the last in the document and the first in its
          column. The document order is the page's contract — the screens in
          the order they are met, the take last — and the column order is the
          reader's: mid-take, the transport is the one group anybody is hunting
          for. Nothing here is a Tab stop, and every group is a heading, so a
          screen reader moves between them by heading rather than by position.
        -->
        {#each groups as group (group.scope)}
          <table class="shortcuts" class:take={group.scope === 'live'}>
            <caption>
              <h4 class="group">{group.caption}</h4>
              {#if group.note}<span class="note">{group.note}</span>{/if}
              <!-- The dialog owns the keyboard while it is open, Escape
                   included, so none of these reach the take until it closes. -->
              {#if group.scope === 'live' && live}
                <span class="note">Close this reference to use them. Esc closes it.</span>
              {/if}
            </caption>
            <thead class="hidden">
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Shortcut</th>
              </tr>
            </thead>
            <tbody>
              {#each group.rows as row (row.label)}
                <tr data-actions={row.actions} data-mirrors={row.mirrors}>
                  <td class="action">
                    {row.label}{#if row.when}{' '}<span class="when">{row.when}</span>{/if}
                  </td>
                  <td class="keys" aria-label={row.gesture ?? spoken(row.keys)}>{#if row.gesture}<span class="gesture">{row.gesture}</span>{:else}{@render keycaps(row.keys)}{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/each}
      </section>
    </div>
  </div>
  {#snippet footer()}
    <Button variant="primary" onclick={onclose}>Done</Button>
  {/snippet}
</Dialog>

<style>
  .scroll {
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    /* Room for the scrollbar, so it never sits on the keys. */
    padding-right: var(--space-2);
    /* A hairline where rows run on past the edge, and nothing where they do
       not: the line is the "there is more" a sliced row cannot say. Always
       present as transparent, so it never shifts the content by a pixel. */
    border-block: 1px solid transparent;
    transition: border-color var(--dur-fast) var(--ease-out);
  }
  .scroll.more-above {
    border-top-color: var(--border);
  }
  .scroll.more-below {
    border-bottom-color: var(--border);
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

  .indexes {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    column-gap: var(--space-8);
    align-items: start;
  }
  .index {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    min-width: 0;
  }
  .index-head {
    /* Ahead of the take's table, which is lifted to the top of its column. */
    order: -2;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .take {
    order: -1;
  }
  .index-title {
    margin: 0;
    font-size: var(--text-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--ls-caps);
    color: var(--text-muted);
  }
  .index-note {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .shortcuts {
    width: 100%;
    border-collapse: collapse;
  }
  caption {
    text-align: left;
    padding-bottom: var(--space-1);
  }
  .group {
    /* The group name reads as a heading for the rows under it, so it carries the
       weight rather than the accent — the dialog's own title is the only voice
       raised on this panel. */
    margin: 0;
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
  td {
    padding: var(--space-1) 0;
    font-size: var(--text-sm);
    vertical-align: middle;
    border-top: 1px solid var(--border-faint);
  }
  .action {
    padding-right: var(--space-3);
    color: var(--text-primary);
  }
  .when {
    display: block;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  td.keys {
    text-align: right;
    white-space: nowrap;
  }

  /* ---- Key notation ----
     Flat caps, the house's own idiom: no gradient, no lip, no shadow. A chord
     is its caps side by side; Windows keeps the `+` it prints between them. */
  .chord {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font: inherit;
    vertical-align: middle;
  }
  .cap {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    min-width: 20px;
    height: 20px;
    padding: 0 var(--space-1);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    font-weight: 500;
    line-height: 1;
    color: var(--text-primary);
    background: var(--bg-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  /* A single mark — a modifier glyph, an arrow, a full stop — a size up. */
  .cap.mark {
    padding: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }
  /* A gesture is not a key, so it gets words in the caps' column, not a cap. */
  .gesture {
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .plus,
  .or,
  .then {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .or,
  .then {
    white-space: pre;
  }

  /* Announced, never drawn: the column headers are for a screen reader, and
     " menu" finishes a caption the index heading already says out loud. */
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

  /* One column once the panel is too narrow to hold the two indexes side by
     side — a browser window; the app's own window never gets this small. */
  @media (max-width: 720px) {
    .indexes {
      grid-template-columns: minmax(0, 1fr);
      row-gap: var(--space-8);
    }
  }
</style>
