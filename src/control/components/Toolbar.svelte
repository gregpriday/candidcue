<!--
  The compact workspace toolbar (desktop refinement §8).

  ---------------------------------------------------------------------------
  WHAT IT REPLACES, AND WHY
  ---------------------------------------------------------------------------
  `PageHeader.svelte` gave every route a sticky band with a back control on its
  own row, a 28px editorial title, a metadata line, and trailing actions — three
  stacked bands adding up to ~103px of chrome before any content. That is a
  well-made web page header and precisely the pattern that made this application
  read as a sequence of pages: a heading that large says "you have arrived
  somewhere new", and moving between the Library and a script is not arriving
  somewhere new, it is changing the selected document in one workstation.

  This is one 44px row: navigation, identity, spacer, status, actions. The title
  is 15px and reads as a document name rather than a page heading.

  ---------------------------------------------------------------------------
  THE HEIGHT IS FIXED, AND THAT IS A FEATURE
  ---------------------------------------------------------------------------
  §8.1 asks for the toolbar to keep its height when save state, compile status
  or metadata appear and disappear — and this route's status genuinely does come
  and go on every keystroke. A band that resized with it would shove the editor
  under the caret mid-word. So the row is `height: var(--toolbar-h)` rather than
  padded to size, every child is vertically centred in it, and anything that
  cannot fit is truncated or handed to overflow rather than wrapped.

  ---------------------------------------------------------------------------
  THE HEADING STAYS, EVEN THOUGH IT NO LONGER LOOKS LIKE ONE
  ---------------------------------------------------------------------------
  §23.2's rule: reducing a visual page heading must not remove the document's
  heading structure. Screen-reader users navigate by heading, and a route with
  no h1 is a route that announces nothing about what it is. So the title is
  still an `<h1>` — it is simply typeset at document scale instead of hero
  scale.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import { windowTitlebar } from '../lib/window-material';

  interface Props {
    title: string;
    /**
     * A short trailing detail rendered INLINE with the title, not on its own
     * line. §8.1: keep metadata inline where it is continuously useful and move
     * the rest to a status bar. Anything that changes per keystroke belongs in
     * the status bar; this is for things like "Trash" or a display name.
     */
    detail?: string;
    editableTitle?: boolean;
    ontitlechange?: (title: string) => void;
    /** The rendered title input, so File › Rename can focus it. */
    titleElement?: HTMLInputElement | null;
    backLabel?: string;
    onback?: () => void;
    /** Leading controls before the title — a sidebar toggle, say. */
    leading?: Snippet;
    status?: Snippet;
    actions?: Snippet;
    /** A second, thinner row under the toolbar (the editor's formatting strip). */
    secondary?: Snippet;
    /**
     * Whether the secondary row is shown at all.
     *
     * Separate from `secondary` being supplied, because a snippet is a FUNCTION
     * and is therefore always truthy — even when its own body renders nothing.
     * The editor passes a snippet that is empty in Preview, so `{#if secondary}`
     * left Preview with a blank 36px band and a border under the toolbar.
     * Defaults to "show it if it was given", which is right for a caller whose
     * row is unconditional.
     */
    showSecondary?: boolean;
  }

  let {
    title,
    detail,
    editableTitle = false,
    ontitlechange,
    titleElement = $bindable(null),
    backLabel,
    onback,
    leading,
    status,
    actions,
    secondary,
    showSecondary = true,
  }: Props = $props();

  /*
   * The input is a DRAFT of `title`, not the thing itself — carried over from
   * PageHeader, where the reasoning was worked out: binding the element straight
   * to the prop left no saved value to fall back on, so clearing the field
   * committed nothing yet the header went on showing the blank, and Escape had
   * nothing to restore from. `$derived` re-seeds when the saved title changes
   * underneath (a rename from elsewhere, a different script loading).
   */
  /*
   * Under an overlay titlebar (a Mac: `lib/window-material.ts`) the band IS the
   * window's titlebar, so its empty space moves the window — `deep`, so the
   * title and the spacer drag too while every button, field and link inside
   * still clicks (Tauri's drag script never drags from a control). Elsewhere
   * the platform's own titlebar does that, and the band is just a band.
   */
  const dragRegion = windowTitlebar() === 'overlay' ? 'deep' : undefined;

  let draft = $derived(title);

  function commitTitle(): void {
    const next = draft.trim();
    if (!next) {
      draft = title;
      return;
    }
    draft = next;
    if (next !== title) ontitlechange?.(next);
  }

  function titleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      (event.currentTarget as HTMLInputElement).blur();
      return;
    }
    if (event.key === 'Escape') {
      /*
       * Abandon the edit, and stop the key here.
       *
       * §23.1's layered-Escape rule: the most local transient thing wins. An
       * in-progress rename is more local than anything an ancestor would close,
       * so this consumes the key. It still does NOT rescue an editable title
       * placed inside a `Dialog` — that component listens in the capture phase
       * — but no caller nests the two.
       */
      event.preventDefault();
      event.stopPropagation();
      draft = title;
      (event.currentTarget as HTMLInputElement).blur();
    }
  }
</script>

<div class="toolbar-stack">
  <!--
    A NAMED banner landmark (§23.2).

    `<header>` at the top level of a route is ALREADY a banner — the role is
    implicit and writing it out is redundant, which the a11y linter says too.
    What was missing is the NAME: "jump to the banner" in a window that also has
    a navigation rail, a main region, an inspector and a status bar tells you
    nothing about which one you reached. The name is the route's own title, so
    the announcement says which toolbar.
  -->
  <header class="toolbar" aria-label={`${title} toolbar`} data-tauri-drag-region={dragRegion}>
    {#if onback}
      <!--
        In the SAME ROW as the title. §8.1 names the separate back row as the
        pattern to remove: a control on its own line above a heading is a web
        breadcrumb, and it cost 28px of every screen.
      -->
      <button type="button" class="back" data-focus="control" onclick={onback}>
        <Icon name="chevron-left" size={14} />
        <span>{backLabel ?? 'Back'}</span>
      </button>
    {/if}

    {#if leading}<div class="leading">{@render leading()}</div>{/if}

    <div class="identity">
      <h1 class="title" class:editing={editableTitle} aria-label={editableTitle ? title : undefined}>
        {#if editableTitle}
          <!--
            The input lives INSIDE the h1: `input` is phrasing content, so this
            is valid, the heading keeps its accessible name from the saved title
            rather than from whatever is half-typed, and heading navigation
            still finds the route.
          -->
          <input
            class="title-input"
            bind:this={titleElement}
            bind:value={draft}
            aria-label="Script title"
            onblur={commitTitle}
            onkeydown={titleKeydown}
          />
        {:else}
          {title}
        {/if}
      </h1>
      {#if detail}<span class="detail">{detail}</span>{/if}
    </div>

    <div class="spacer"></div>

    {#if status}<div class="status">{@render status()}</div>{/if}
    {#if actions}<div class="actions">{@render actions()}</div>{/if}
  </header>

  {#if secondary && showSecondary}
    <div class="secondary">{@render secondary()}</div>
  {/if}
</div>

<style>
  .toolbar-stack {
    position: sticky;
    top: 0;
    z-index: 5;
    flex: 0 0 auto;
    background: var(--bg-toolbar);
    /*
     * A one-pixel divider, not a decorative border. §5.1: major panes meet with
     * straight dividers, and the toolbar's bottom edge is a pane boundary — the
     * same line the sidebar draws down its trailing edge.
     */
    border-bottom: var(--divider-w) solid var(--divider);
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    /* FIXED, not padded to size — see the note at the top of the file. */
    height: var(--toolbar-h);
    padding-inline: var(--page-x);
    min-width: 0;
  }

  .back {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
    height: var(--toolbar-control-h);
    padding: 0 var(--space-2) 0 var(--space-1);
    margin-left: calc(-1 * var(--space-1));
    border: none;
    background: transparent;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 600;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .back:hover {
    color: var(--text-primary);
    background: var(--bg-hover-chrome);
  }

  .leading {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    flex: 0 0 auto;
  }

  .identity {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
    /* Shrinks before anything else. §21.3: preserve the document title and
       Present at all practical widths — the title truncates, it does not
       disappear, and the actions never give up room to it. */
    flex: 0 1 auto;
  }

  /*
   * 15px, weight 600 — a document name, not a page heading.
   *
   * The old 28px `--text-page-title` is what a marketing page uses to announce a
   * section. Beside a native titlebar carrying the same words it was simply the
   * same information twice, in a larger size.
   */
  .title {
    margin: 0;
    font-size: var(--text-base);
    line-height: 1.2;
    font-weight: 600;
    letter-spacing: -0.006em;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  /*
   * Unclipped while editing. The ellipsis above needs `overflow: hidden`, and
   * the input below sits 8px LEFT of this box on purpose (its padding lives in
   * the gap so its text lines up with the resting title) — so the resting clip
   * cut the field's left border and focus edge off. The input truncates its
   * own text, so nothing here is lost by letting it show.
   */
  .title.editing {
    display: flex;
    min-width: 0;
    flex: 0 1 auto;
    overflow: visible;
    text-overflow: clip;
  }

  /*
   * Editable, but text at rest.
   *
   * §11.2: text-like until hovered or focused, and no permanent pencil icon. A
   * field that always looks like a field turns the document's name into a form
   * control, and the name is the first thing on the screen.
   */
  .title-input {
    margin: 0 0 0 calc(-1 * var(--space-2));
    padding: 0 var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    font-family: inherit;
    font-size: var(--text-base);
    line-height: 1.2;
    font-weight: 600;
    letter-spacing: -0.006em;
    color: var(--text-primary);
    min-width: 0;
    width: 100%;
    height: var(--toolbar-control-h);
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }
  /* At rest the field is the title, so it ends the way the title does: with an
     ellipsis, not a word cut in half. Focus drops it so the caret can scroll. */
  .title-input:not(:focus) {
    text-overflow: ellipsis;
  }
  .title-input:hover {
    background: var(--bg-hover-chrome);
  }
  .title-input:focus {
    background: var(--bg-panel);
    border-color: var(--border-control);
  }

  .detail {
    flex: 0 0 auto;
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .spacer {
    flex: 1 1 auto;
    min-width: var(--space-2);
  }

  .status,
  .actions {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
  }
  .status {
    gap: var(--space-3);
  }
  .actions {
    gap: var(--space-2);
  }

  /*
   * The secondary row: thinner, quieter, and only ever present in one mode.
   *
   * It carries the editor's formatting controls, which exist while editing and
   * not while previewing. Giving it its own band rather than crowding the main
   * toolbar keeps the primary row's five slots stable across every route.
   */
  .secondary {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: var(--toolbar-h-secondary);
    padding-inline: var(--page-x);
    border-top: var(--divider-w) solid var(--divider);
    background: var(--bg-toolbar);
    min-width: 0;
    /*
     * Clipped sideways only. The band never paints into its neighbours, but a
     * 28px control's focus ring reaches 4px above and below it and the band
     * has 3.5px under its hairline — `hidden` shaved the ring's outer edge off
     * top and bottom. `clip` (unlike `hidden`) leaves the other axis visible.
     */
    overflow-x: clip;
    overflow-y: visible;
  }

  /*
   * On the window's material (tokens.css, WINDOW MATERIAL), the toolbar band
   * is the top of the glass frame: the titlebar above it is already the
   * material, and the band continues it down to the document's edge, where
   * its own bottom divider is the line between chrome and paper.
   *
   * The chrome hover is retuned for the band rather than in each control:
   * every control here that hovers on chrome reads `--bg-hover-chrome`, and an
   * opaque grey step on glass is a grey patch rather than a hover.
   */
  /*
   * Under an overlay titlebar with no sidebar drawn, the traffic lights sit at
   * the band's leading end, so the band keeps their width clear. With the
   * sidebar drawn they are on the sidebar's head instead (Sidebar.svelte).
   */
  :global(html[data-titlebar='overlay']:not([data-sidebar])) .toolbar {
    padding-left: var(--traffic-lights-w);
  }

  :global(html[data-window-material][data-material-rail]) .toolbar-stack {
    --bg-hover-chrome: var(--material-hover);
    background: var(--material-tint);
    border-bottom-color: var(--material-rule);
  }
  :global(html[data-window-material][data-material-rail]) .secondary {
    background: transparent;
    border-top-color: var(--material-rule);
  }
</style>
