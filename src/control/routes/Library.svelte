<!--
  The script collection (desktop refinement §10).

  ---------------------------------------------------------------------------
  A DESKTOP COLLECTION, NOT A CARD FEED
  ---------------------------------------------------------------------------
  This route used to be a stack of `ScriptCard` surfaces under a 28px page
  heading, with a search box below the heading and a separate sort select. It
  had a `selectedId` in the store that nothing drew, so "the selected script"
  was a fiction the Present shortcut aimed at and the user could not see.

  What a desktop collection is, and what each part is here for:

    SELECTION      one row is selected, it is drawn, it survives opening a script
                   and coming back, and every File command acts on it. Single
                   click selects; double click (or Enter) opens. That split is
                   what makes selection worth having — click-to-open leaves
                   nothing standing for a menu or an inspector to act on.
    KEYBOARD       arrows, Home/End, PageUp/PageDown, Enter to open, Delete to
                   trash (§10.2), ⌘F to the filter field. A library larger than
                   one 500-row read is reached with Show more, which is a
                   focusable control rather than a scroll sentinel — so the rows
                   past the first page are reachable by keyboard as well as by
                   pointer, and `library.ts` re-reads to the same depth when the
                   route comes back.
    SCROLL         restored per view for the length of the session (see the
                   module block below). Not persisted across launches.
    CONTEXT MENU   right-click selects the row first, then opens (§10.6).
    DROP TARGET    Markdown dropped on the window imports. The paths are handled
                   in Rust — see `windows/drag_drop.rs` for why.
    STATUS BAR     the count lives at the bottom, not under a heading (§10.8).

  ---------------------------------------------------------------------------
  THE ROWS ARE ONE TAB STOP; THE SELECTED ROW'S ACTIONS ARE TWO MORE
  ---------------------------------------------------------------------------
  `role="listbox"` with roving tabindex: exactly one ROW is tabbable, so fifty
  scripts do not mean fifty tab stops and the keyboard can get past the Library.

  The selected row's Present and overflow buttons are also tabbable, and that is
  deliberate rather than an oversight — they are `visibility: hidden` on every
  other row, and a hidden element is not focusable, so the count is three stops
  in total regardless of how long the list is. It does mean this is not a pure
  listbox: ARIA expects `option` descendants to be presentational, and some
  screen readers flatten them. The alternative — actions reachable only through
  the context menu — was judged worse for the far more common case.
-->
<script lang="ts" module>
  /**
   * Where each Library view was scrolled to, for the length of this session.
   *
   * Module-level so it survives the route unmounting — which is exactly what
   * opening a script does — and per view because All, Recent and Trash are
   * different lists whose offsets mean nothing to each other.
   *
   * NOT persisted. It is a within-session position rather than a preference,
   * and restoring a scroll into a collection that changed between launches
   * would land somewhere arbitrary with the confidence of somewhere chosen.
   */
  const scrollOffsets = new Map<string, number>();
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import Button from '../components/Button.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import Icon from '../components/Icon.svelte';
  import IconButton from '../components/IconButton.svelte';
  import OverflowMenu from '../components/OverflowMenu.svelte';
  import ScriptRow from '../components/ScriptRow.svelte';
  import StatusBar from '../components/StatusBar.svelte';
  import type { StatusBarItem } from '../components/status-bar-item';
  import StatusPill from '../components/StatusPill.svelte';
  import Toolbar from '../components/Toolbar.svelte';
  import { formatSpeakingDuration, relativeTime } from '../lib/format';
  import { createAndOpenScript, exportScriptToFile, importMarkdown } from '../lib/app-actions';
  import { formatAccelerator } from '../lib/commands';
  import { onShortcut } from '../lib/shortcuts';
  import { detectPlatform } from '../lib/platform';
  import { checkThenStartTake } from '../lib/check-then-start';
  import * as scriptsService from '../services/scripts';
  import { onRouteCommand } from '../stores/command-bus';
  import { anchorFor, openContextMenu, type ContextMenuItem } from '../stores/context-menu';
  import { requestConfirm } from '../stores/confirm';
  import {
    collectTrashTargets,
    deleteScriptPermanently,
    duplicateScript,
    emptyTrash,
    library,
    loadLibrary,
    moveScriptToTrash,
    restoreScriptFromTrash,
    selectScript,
    loadMoreScripts,
    setLibraryQuery,
    setLibrarySort,
  } from '../stores/library';
  import { navigate } from '../stores/router';
  import { showToast } from '../stores/toasts';
  import { updateWorkspace, workspace } from '../stores/workspace';
  import type { ScriptSummary } from '../../shared/contracts';
  import type { ScriptSort } from '../services/scripts-types';

  let searchInput: HTMLInputElement | null = $state(null);
  let listElement: HTMLElement | null = $state(null);
  /** The element that actually scrolls — see `pageSize`. */
  let scrollElement: HTMLElement | null = $state(null);
  /**
   * A destructive confirmation is open.
   *
   * Holding Delete fires the key handler repeatedly, and `requestConfirm`
   * REPLACES its singleton request without resolving the one it displaced — so
   * the first handler awaited a promise nobody would ever settle, and the second
   * dialog asked about the same row. One at a time.
   */
  let confirmingDelete = $state(false);
  /** True while DOM focus is inside the list — drives the selection tone. */
  let listFocused = $state(false);
  let query = $state($library.query);
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  const sortOptions: Array<{ value: ScriptSort; label: string }> = [
    { value: 'recently_edited', label: 'Recently edited' },
    { value: 'name', label: 'Name' },
    { value: 'created', label: 'Created' },
    { value: 'estimated_length', label: 'Estimated length' },
  ];

  const inTrash = $derived($library.view === 'trash');
  const showsSort = $derived($library.view === 'all');
  const viewTitle = $derived(
    $library.view === 'trash' ? 'Trash' : $library.view === 'recent' ? 'Recent' : 'All scripts',
  );
  const scripts = $derived($library.scripts);
  const selectedIndex = $derived(scripts.findIndex((script) => script.id === $library.selectedId));
  const selected = $derived(selectedIndex >= 0 ? scripts[selectedIndex] : undefined);
  const compact = $derived($workspace.libraryDensity === 'compact');

  const canEmptyTrash = $derived(
    $library.trashTotal === null
      ? $library.scripts.length > 0 || $library.query.trim() !== ''
      : $library.trashTotal > 0,
  );

  const mac = detectPlatform() === 'macos';

  /*
   * Put the list back where it was (§10.2).
   *
   * Opening a script unmounts this route, so returning rebuilt the list at the
   * top — which for anybody with more than a screenful means hunting for the
   * script they were just in. The offset is kept per VIEW, because All, Recent
   * and Trash are different lists and a position in one means nothing in
   * another.
   *
   * Module-level rather than in the workspace store: it is a within-session
   * position, not a preference, and persisting it across launches would restore
   * a scroll into a list that has since changed underneath it.
   */
  $effect(() => {
    const view = $library.view;
    const element = scrollElement;
    if (!element) return;
    const saved = scrollOffsets.get(view);
    if (saved !== undefined && scripts.length > 0) {
      // After the rows exist, or there is nothing to scroll through yet.
      requestAnimationFrame(() => {
        if (scrollElement === element) element.scrollTop = saved;
      });
    }
    const remember = () => scrollOffsets.set(view, element.scrollTop);
    element.addEventListener('scroll', remember, { passive: true });
    return () => {
      remember();
      element.removeEventListener('scroll', remember);
    };
  });

  $effect(() => {
    void loadLibrary();
    /*
     * ⌘F focuses the filter field (§6.1). It arrives as `edit.find` from the
     * command registry rather than as a hand-written shortcut, which is what
     * lets the native Find item say "Find in Library…" and be enabled here —
     * and what stopped the Library and Insert › Link from both claiming ⌘K.
     */
    const unsubscribeCommands = onRouteCommand((command) => {
      if (command === 'edit.find') searchInput?.focus();
    });
    const unsubscribe = onShortcut((action) => {
      if (action === 'find-in-list') searchInput?.focus();
      if (action === 'new-script') void createAndOpenScript('new');
      if (action === 'present') {
        if (inTrash) {
          showToast('Scripts in Trash cannot be presented. Restore one first.', 'info');
          return;
        }
        const id = $library.selectedId;
        if (id === null) {
          showToast('There is no script to present yet.', 'info');
          return;
        }
        void checkThenStartTake(id);
      }
    });
    return () => {
      unsubscribe();
      unsubscribeCommands();
      if (searchDebounce) clearTimeout(searchDebounce);
    };
  });

  /**
   * Keep the selected row on screen when the keyboard moves it.
   *
   * Only for keyboard movement: `scrollIntoView` on every selection change
   * would yank the list under a pointer user who clicked a row that was already
   * half visible, which is a scroll they did not ask for.
   */
  function revealSelected(): void {
    if (!listElement) return;
    const row = listElement.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!row) return;
    /*
     * Feature-tested rather than called.
     *
     * `scrollIntoView` is not implemented in jsdom, so calling it unguarded
     * threw out of a `requestAnimationFrame` callback — which is not a rejected
     * promise anybody catches, it is an uncaught exception in a timer. The DOM
     * suite reported it as an unhandled error and carried on, which is exactly
     * the shape of failure that hides in a green run.
     *
     * Guarded rather than mocked in the test setup, because the same shape
     * protects the real case too: a row removed between the selection changing
     * and this frame arriving.
     */
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
    row.focus();
  }

  function onSearchInput(event: Event): void {
    query = (event.currentTarget as HTMLInputElement).value;
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => setLibraryQuery(query), 180);
  }

  function clearSearch(): void {
    query = '';
    if (searchDebounce) clearTimeout(searchDebounce);
    setLibraryQuery('');
    searchInput?.focus();
  }

  function onSearchKeydown(event: KeyboardEvent): void {
    /* Escape clears before it does anything else — §23.1's layered rule, with
       the field's own content as the most local transient thing. */
    if (event.key === 'Escape' && query !== '') {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'Enter') return;
    if (scripts.length === 0) return;
    event.preventDefault();
    // Down (or Enter) carries you from the box into what it found — and selects
    // the first result rather than merely focusing it, so the next keystroke
    // acts on something.
    selectScript(scripts[0]?.id ?? null);
    requestAnimationFrame(revealSelected);
  }

  function moveSelection(delta: number): void {
    if (scripts.length === 0) return;
    const from = selectedIndex < 0 ? (delta > 0 ? -1 : scripts.length) : selectedIndex;
    const next = Math.min(scripts.length - 1, Math.max(0, from + delta));
    selectScript(scripts[next]?.id ?? null);
    requestAnimationFrame(revealSelected);
  }

  function selectAt(index: number): void {
    if (scripts.length === 0) return;
    const bounded = Math.min(scripts.length - 1, Math.max(0, index));
    selectScript(scripts[bounded]?.id ?? null);
    requestAnimationFrame(revealSelected);
  }

  /**
   * How many rows a Page key moves — a screenful, from the real geometry.
   *
   * Measured against the SCROLLPORT, not the list.
   *
   * `listElement` is the `<div role="listbox">`, whose height is the height of
   * all its rows — it grows without bound and never scrolls. The element that
   * scrolls is `.list-area` around it. Measuring the list meant a library of
   * four hundred scripts computed a "page" of nearly four hundred rows, so
   * PageDown was End and PageUp was Home.
   *
   * The row pitch is read from a real row rather than from the density token,
   * so the separator between rows is included and the arithmetic cannot drift
   * from the stylesheet.
   */
  function pageSize(): number {
    const viewport = scrollElement?.clientHeight ?? 0;
    const firstRow = listElement?.querySelector<HTMLElement>('[role="option"]');
    const pitch = firstRow?.offsetHeight ?? (compact ? 38 : 52);
    const visible = Math.floor(viewport / Math.max(1, pitch));
    // Never zero (an unmeasured list) and never the whole list; one row of
    // overlap is the convention, so the row you were reading stays on screen.
    return Math.max(1, visible - 1);
  }

  /**
   * Put focus back on the list after a mutation removed the focused row.
   *
   * Trashing, restoring or deleting from the keyboard removes the row that had
   * focus. `loadLibrary` picks a surviving row as the new selection, but nothing
   * was focusing it — so focus fell to `document.body` and the arrow keys
   * stopped working, one keystroke into a keyboard-driven workflow.
   *
   * Only when focus was in the list to begin with: a mutation triggered from the
   * toolbar or a context menu should not steal focus into the collection.
   */
  async function restoreFocusAfterMutation(hadFocus: boolean): Promise<void> {
    if (!hadFocus) return;
    await tick();
    revealSelected();
  }

  function listKeydown(event: KeyboardEvent): void {
    /*
     * Keys pressed INSIDE a row's controls are not the list's.
     *
     * `ScriptRow` already declines them, but declining is not stopping: the
     * event still bubbles to this handler on the container. Without this guard,
     * arrowing through an open overflow menu also walked the Library's
     * selection underneath it, and Delete inside that menu trashed the row.
     *
     * The test is "did this land on a row itself", which is true for the row
     * elements (they carry `role="option"`) and false for every button, input
     * and menu item inside one.
     */
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'option') {
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveSelection(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveSelection(-1);
        return;
      case 'Home':
        event.preventDefault();
        selectAt(0);
        return;
      case 'End':
        event.preventDefault();
        selectAt(scripts.length - 1);
        return;
      case 'PageDown':
        event.preventDefault();
        moveSelection(pageSize());
        return;
      case 'PageUp':
        event.preventDefault();
        moveSelection(-pageSize());
        return;
      case 'Delete':
      case 'Backspace': {
        /*
         * Delete moves to Trash, and Trash's Delete deletes permanently — both
         * behind the confirmation the visible action uses. §10.2 asks for the
         * platform semantics, and the platform semantics for a managed library
         * are "the destructive key does the destructive thing, once you have
         * said yes".
         *
         * `confirmingDelete` guards a HELD key: `requestConfirm` replaces its
         * singleton without resolving the request it displaces, so a repeat
         * would strand the first await for ever.
         */
        if (!selected || confirmingDelete) return;
        event.preventDefault();
        if (inTrash) void confirmDeleteForever(selected);
        else void confirmTrash(selected);
        return;
      }
      case 'ContextMenu':
        if (selected && listElement) {
          event.preventDefault();
          const row = listElement.querySelector<HTMLElement>('[aria-selected="true"]');
          if (row) openRowMenu(selected, anchorFor(row), row);
        }
        return;
      default:
        break;
    }
    /*
     * Shift+F10 is the other keyboard context-menu chord, and on a Mac keyboard
     * it is the only one — there is no Menu key.
     */
    if (event.key === 'F10' && event.shiftKey && selected && listElement) {
      event.preventDefault();
      const row = listElement.querySelector<HTMLElement>('[aria-selected="true"]');
      if (row) openRowMenu(selected, anchorFor(row), row);
    }
  }

  function openScript(script: ScriptSummary): void {
    void navigate({ name: 'editor', scriptId: script.id });
  }

  function presentScript(script: ScriptSummary): void {
    void checkThenStartTake(script.id);
  }

  /** True while DOM focus is inside the list, captured before a mutation. */
  function focusWasInList(): boolean {
    return listElement !== null && listElement.contains(document.activeElement);
  }

  async function confirmTrash(script: ScriptSummary): Promise<void> {
    const hadFocus = focusWasInList();
    confirmingDelete = true;
    try {
      const accepted = await requestConfirm({
        // Named. §18.4: "Are you sure?" tells somebody with forty scripts nothing.
        title: 'Move to Trash?',
        body: `“${script.title}” will move to Trash and can be restored for 30 days.`,
        confirmLabel: 'Move to Trash',
        danger: true,
      });
      if (!accepted) return;
      await moveScriptToTrash(script.id);
      await restoreFocusAfterMutation(hadFocus);
    } finally {
      confirmingDelete = false;
    }
  }

  async function confirmDeleteForever(script: ScriptSummary): Promise<void> {
    const hadFocus = focusWasInList();
    confirmingDelete = true;
    try {
      const accepted = await requestConfirm({
        title: 'Delete permanently?',
        body: `“${script.title}” will be deleted permanently, along with its retained revisions and unshared local assets. This cannot be undone.`,
        confirmLabel: 'Delete permanently',
        danger: true,
      });
      if (!accepted) return;
      await deleteScriptPermanently(script.id);
      await restoreFocusAfterMutation(hadFocus);
    } finally {
      confirmingDelete = false;
    }
  }

  async function confirmEmptyTrash(): Promise<void> {
    const targets = await collectTrashTargets();
    if (targets === null) return;
    if (targets.length === 0) {
      showToast('Trash is already empty.', 'info');
      await loadLibrary();
      return;
    }
    const count = targets.length;
    const body =
      count === 1
        ? '1 script in Trash will be deleted permanently, along with its retained revisions and unshared local assets. This cannot be undone.'
        : `${count} scripts in Trash will be deleted permanently, along with their retained revisions and unshared local assets. This cannot be undone.`;
    const accepted = await requestConfirm({
      title: 'Empty Trash?',
      body,
      confirmLabel: 'Empty Trash',
      danger: true,
    });
    if (accepted) await emptyTrash(targets);
  }

  async function exportScript(script: ScriptSummary): Promise<void> {
    await exportScriptToFile(script.id, script.title, 'markdown');
  }

  async function revealScript(script: ScriptSummary): Promise<void> {
    try {
      await scriptsService.revealScriptFolder(script.id);
    } catch {
      showToast('That script’s folder could not be opened.', 'danger');
    }
  }

  const revealLabel = mac ? 'Reveal in Finder' : 'Show in File Explorer';

  /**
   * The row's actions, as one list used by BOTH the context menu and the
   * overflow button.
   *
   * §10.6's last rule — do not duplicate every menu item as a visible row button
   * — is only keepable if the two surfaces share a definition. Two lists drift,
   * and the drift is invisible because nobody opens both.
   */
  function rowMenuItems(script: ScriptSummary): ContextMenuItem[] {
    if (inTrash) {
      return [
        { label: 'Restore', onselect: () => void restoreScriptFromTrash(script.id) },
        {
          label: 'Delete permanently',
          danger: true,
          separated: true,
          onselect: () => void confirmDeleteForever(script),
        },
      ];
    }
    return [
      { label: 'Open', onselect: () => openScript(script) },
      {
        label: 'Present',
        shortcut: formatAccelerator('Mod+Return', mac),
        onselect: () => presentScript(script),
      },
      {
        label: 'Duplicate',
        separated: true,
        shortcut: formatAccelerator('Mod+D', mac),
        onselect: () => void duplicateScript(script.id),
      },
      { label: 'Export Markdown…', onselect: () => void exportScript(script) },
      { label: revealLabel, onselect: () => void revealScript(script) },
      {
        label: 'Move to Trash',
        danger: true,
        separated: true,
        onselect: () => void confirmTrash(script),
      },
    ];
  }

  /**
   * Right-click SELECTS FIRST, then opens (§10.6).
   *
   * Without this the menu acts on a row the user is pointing at while the
   * selection highlight sits somewhere else — so "Move to Trash" appears to be
   * about the highlighted script and is about the one under the cursor.
   */
  function openRowMenu(
    script: ScriptSummary,
    at: { x: number; y: number },
    trigger: HTMLElement | null,
  ): void {
    selectScript(script.id);
    openContextMenu({
      x: at.x,
      y: at.y,
      label: `Actions for ${script.title}`,
      items: rowMenuItems(script),
      trigger,
    });
  }

  function contextMenuFor(script: ScriptSummary, event: MouseEvent): void {
    event.preventDefault();
    openRowMenu(script, { x: event.clientX, y: event.clientY }, event.currentTarget as HTMLElement);
  }

  /** View options: sort and density in one compact menu (§10.4). */
  const viewOptionItems = $derived([
    ...(showsSort
      ? sortOptions.map((option) => ({
          label: option.label,
          checked: $library.sort === option.value,
          onselect: () => setLibrarySort(option.value),
        }))
      : []),
    {
      label: 'Compact rows',
      checked: compact,
      separated: showsSort,
      onselect: () =>
        updateWorkspace({ libraryDensity: compact ? 'comfortable' : 'compact' }),
    },
  ]);

  const statusItems = $derived<StatusBarItem[]>(
    (() => {
      const items: StatusBarItem[] = [];
      const shown = scripts.length;
      const total = $library.total;
      if ($library.loading && shown === 0) {
        items.push({ key: 'loading', label: 'Loading…' });
      } else if (shown < total) {
        // Honest about the page ceiling: the number that matters is how many
        // there are, not where the transport stops.
        items.push({
          key: 'count',
          label: `${shown.toLocaleString()} of ${total.toLocaleString()} scripts`,
        });
      } else {
        items.push({
          key: 'count',
          label: shown === 1 ? '1 script' : `${shown.toLocaleString()} scripts`,
        });
      }
      if ($library.query.trim() !== '') {
        items.push({ key: 'filter', label: `Filtered by “${$library.query.trim()}”` });
      }
      return items;
    })(),
  );

  const trailingStatus = $derived<StatusBarItem[]>(
    selected ? [{ key: 'selected', label: selected.title }] : [],
  );
</script>

<div class="page">
  <Toolbar title={viewTitle}>
    {#snippet leading()}
      <!--
        Search in the PRIMARY toolbar, where it is stable across every Library
        view (§10.4). The ⌘K keycap that used to sit inside the field is gone:
        §10.4 asks for it in the tooltip and the native menu instead, because a
        rendered keycap inside an input is a web command-palette signature.
      -->
      <div class="search">
        <span class="search-icon"><Icon name="search" size={14} /></span>
        <input
          class="search-input"
          type="search"
          placeholder="Search scripts"
          aria-label="Search scripts"
          title={`Search scripts (${formatAccelerator('Mod+F', mac)})`}
          value={query}
          bind:this={searchInput}
          oninput={onSearchInput}
          onkeydown={onSearchKeydown}
        />
        {#if query !== ''}
          <span class="search-clear">
            <IconButton icon="x" label="Clear search" onclick={clearSearch} />
          </span>
        {/if}
      </div>
    {/snippet}

    {#snippet actions()}
      <OverflowMenu items={viewOptionItems} label="View options" />
      {#if inTrash}
        {#if canEmptyTrash}
          <Button variant="danger" onclick={() => confirmEmptyTrash()}>Empty Trash</Button>
        {/if}
      {:else}
        <!--
          Import is secondary and New Script is primary (§10.4) — they used to be
          two equally weighted buttons, which made the toolbar ask a question
          instead of offering a default.
        -->
        <Button onclick={() => importMarkdown()}>Import</Button>
        <Button variant="primary" onclick={() => createAndOpenScript('new')}>
          <Icon name="plus" size={15} />
          New script
        </Button>
      {/if}
    {/snippet}
  </Toolbar>

  <div class="list-area" bind:this={scrollElement}>
    <!--
      A refresh that failed with rows on screen: the list is stale, not wrong, so
      it stays and the failure is reported over it as a persistent bar (§10.7).
      Deliberately not a toast — `danger` toasts never expire, and a debounced
      search that keeps failing would stack one per keystroke.
    -->
    {#if $library.error !== null && scripts.length > 0}
      <div class="stale" role="alert">
        <div class="stale-text">
          <p class="stale-title">Scripts could not be refreshed</p>
          <p class="stale-body">The results below are the previous ones. {$library.error}</p>
        </div>
        <Button size="sm" onclick={() => loadLibrary()}>Try again</Button>
      </div>
    {/if}

    {#if $library.loading && scripts.length === 0}
      <!--
        Row skeletons, not a centred block (§10.7). Replacing the whole workspace
        with "Loading scripts…" makes every launch look like a page navigation;
        rows that are the right shape make it look like a list filling in.
      -->
      <div class="skeletons" aria-hidden="true">
        {#each Array.from({ length: 6 }) as _, index (index)}
          <div class="skeleton" class:compact></div>
        {/each}
      </div>
      <p class="sr-only" role="status">Loading scripts</p>
    {:else if $library.error !== null && scripts.length === 0}
      <EmptyState title="Scripts could not be loaded" body={$library.error}>
        {#snippet actions()}
          <Button variant="primary" onclick={() => loadLibrary()}>Try again</Button>
        {/snippet}
      </EmptyState>
    {:else if scripts.length === 0}
      {#if $library.query.trim() !== ''}
        <EmptyState title="No matching scripts" body="No titles or script text matched your search.">
          {#snippet actions()}
            <Button size="sm" onclick={clearSearch}>Clear search</Button>
          {/snippet}
        </EmptyState>
      {:else if inTrash}
        <EmptyState
          title="Trash is empty"
          body="Deleted scripts stay here for 30 days before they are removed."
        />
      {:else if $library.view === 'recent'}
        <EmptyState
          title="No recent scripts"
          body="Scripts appear here once you have opened them, most recently opened first."
        />
      {:else}
        <!-- The one place the boxed editorial variant is still right: a genuine
             first-use invitation, not a message inside a list. -->
        <EmptyState
          variant="editorial"
          title="Write the words. CandidCue keeps your place."
          body="Create a script, or import Markdown you have already written."
        >
          {#snippet actions()}
            <Button variant="primary" onclick={() => createAndOpenScript('new')}>
              Create a script
            </Button>
            <Button onclick={() => importMarkdown()}>Import Markdown</Button>
            <Button variant="ghost" onclick={() => createAndOpenScript('sample')}>
              Try a sample script
            </Button>
          {/snippet}
        </EmptyState>
      {/if}
    {:else}
      <!--
        ROVING TABINDEX, not `aria-activedescendant` — and the two must not be
        mixed.

        Both are valid listbox patterns and they are mutually exclusive.
        `aria-activedescendant` keeps DOM focus on the CONTAINER and points at
        the active option; roving tabindex moves real focus onto the option
        itself. This list moves real focus (the row is what `revealSelected`
        focuses, and what the context-menu key acts on), so it is the roving
        pattern — and carrying `aria-activedescendant` as well would tell a
        screen reader focus is on the container when it is not.
      -->
      <div
        class="list"
        role="listbox"
        tabindex={-1}
        aria-label={viewTitle}
        bind:this={listElement}
        onkeydown={listKeydown}
        onfocusin={() => (listFocused = true)}
        onfocusout={() => (listFocused = false)}
      >
        {#each scripts as script (script.id)}
          <div class="row-slot" id={`script-row-${script.id}`}>
            <ScriptRow
              title={script.title}
              excerpt={script.previewText || undefined}
              duration={formatSpeakingDuration(script.estimatedDurationSeconds)}
              modified={relativeTime(script.updatedAt)}
              selected={$library.selectedId === script.id}
              {listFocused}
              {compact}
              tabindex={$library.selectedId === script.id ? 0 : -1}
              onselect={() => selectScript(script.id)}
              onopen={inTrash ? undefined : () => openScript(script)}
              oncontextmenu={(event) => contextMenuFor(script, event)}
            >
              {#snippet status()}
                <!-- Shown only when actionable (§10.1): "Prepared" on every
                     healthy row is a badge that carries no information. -->
                {#if script.hasWarnings}
                  <StatusPill tone="warning" label="Needs attention" />
                {/if}
              {/snippet}
              {#snippet actions()}
                {#if inTrash}
                  <Button size="sm" onclick={() => restoreScriptFromTrash(script.id)}>
                    Restore
                  </Button>
                {:else}
                  <Button size="sm" onclick={() => presentScript(script)}>Present</Button>
                {/if}
                <OverflowMenu items={rowMenuItems(script)} label={`Actions for ${script.title}`} />
              {/snippet}
            </ScriptRow>
          </div>
        {/each}
      </div>

      {#if scripts.length < $library.total}
        <!--
          The rest of the collection, reachable (§10.2).

          The count line used to say "Showing 500 of 812" and stop there — an
          honest sentence about 312 scripts no gesture in the product could
          reach. A button rather than infinite scroll: a desktop collection with
          a scrollbar whose length is a lie is worse than one more press, and a
          keyboard user can reach a button.
        -->
        <div class="more">
          <Button
            disabled={$library.loadingMore}
            onclick={() => void loadMoreScripts()}
          >
            {$library.loadingMore
              ? 'Loading…'
              : `Show more (${(($library.total ?? 0) - scripts.length).toLocaleString()} remaining)`}
          </Button>
        </div>
      {/if}
    {/if}
  </div>

  <!--
    The count is announced as well as painted. A search that narrows fifty
    scripts to two is a change a screen-reader user has no other way to learn
    about — the list itself is not a live region, and announcing every row would
    be worse than saying nothing.
  -->
  <StatusBar
    items={statusItems}
    trailing={trailingStatus}
    announcement={$library.loading ? undefined : (statusItems[0]?.label ?? undefined)}
  />
</div>

<style>
  .page {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-canvas);
  }

  /* ---- toolbar search ---- */
  .search {
    position: relative;
    display: flex;
    align-items: center;
    width: 260px;
    max-width: 40vw;
  }
  .search-icon {
    position: absolute;
    left: var(--space-2);
    display: inline-flex;
    color: var(--text-muted);
    pointer-events: none;
  }
  .search-clear {
    position: absolute;
    right: 2px;
    display: inline-flex;
  }
  .search-input {
    width: 100%;
    height: var(--toolbar-control-h);
    padding: 0 30px 0 26px;
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
  /* Quiet focus on a surface — never an accent ring (the house rule). */
  .search-input:focus,
  .search-input:focus-visible {
    outline: none;
    border-color: var(--border-strong);
    background: var(--bg-elevated);
  }
  /* The engine's own clear button would sit under ours. */
  .search-input::-webkit-search-cancel-button {
    display: none;
  }

  /* ---- list ---- */
  .more {
    display: flex;
    justify-content: center;
    padding: var(--space-4) 0 var(--space-2);
  }

  .list-area {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-2) var(--page-x) var(--space-6);
  }

  /*
   * One continuous surface with hairlines between rows — not a stack of cards
   * with gaps. The container has the border and the radius; the rows have
   * neither, which is what makes a run of them read as a table.
   */
  .list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-faint);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    overflow: hidden;
  }
  .list:focus {
    outline: none;
  }
  .row-slot + .row-slot {
    border-top: 1px solid var(--border-faint);
  }

  .skeletons {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-faint);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    overflow: hidden;
  }
  .skeleton {
    height: var(--list-row-h);
    border-bottom: 1px solid var(--border-faint);
    /*
     * A static tint, not a shimmer. §23.5 and §3.2: no perpetual motion, and a
     * sweeping gradient across six rows is the most decorative animation a list
     * can have. It reads as "these rows are not real yet" perfectly well
     * standing still.
     */
    background: var(--bg-hover-surface);
  }
  .skeleton.compact {
    height: var(--list-row-h-compact);
  }
  .skeleton:last-child {
    border-bottom: none;
  }

  .stale {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin-bottom: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--danger);
    border-radius: var(--radius-sm);
    background: var(--danger-soft);
  }
  .stale-text {
    flex: 1 1 auto;
    min-width: 0;
  }
  .stale-title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 650;
    color: var(--text-primary);
  }
  .stale-body {
    margin: 1px 0 0;
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
  }

  /* Announced but not drawn — the skeletons carry the visual half. */
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
