<!--
  Rendered preview of CompiledScript blocks (spec §13.2). Consumes only the
  compiler contract's SafeRenderNode structure — never raw HTML.
-->
<script lang="ts" module>
  /** Where a click in the preview asked to go. */
  export interface PreviewBlockClick {
    /** The rendered block, measured before the editor takes its place. */
    element: HTMLElement;
    /** The spoken token under the pointer, when the click was on a word. */
    tokenIndex?: number;
    /** Viewport y of the click, when there was one (the keyboard has none). */
    clientY?: number;
  }
</script>

<script lang="ts">
  import type { CompileDiagnostic, CompiledBlock, SafeRenderNode } from '../../shared/contracts';
  import type { PreviewImages } from '../lib/preview-images';
  import { listMarker, listMarkerGeometry } from '../../shared/list-marker';
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';
  import RenderNodes from './RenderNodes.svelte';

  interface Props {
    blocks: CompiledBlock[];
    /** What is known about each image, by asset id (#250). */
    images?: PreviewImages;
    /**
     * Problems the compiler found in a block, by block id (§23.8): drawn where
     * they are, so a broken directive is not just a line of faint source text
     * with its explanation somewhere else on the screen.
     */
    problems?: ReadonlyMap<string, readonly CompileDiagnostic[]>;
    onblockclick?: (block: CompiledBlock, at: PreviewBlockClick) => void;
    onproblemclick?: (problem: CompileDiagnostic) => void;
  }

  let { blocks, images, problems, onblockclick, onproblemclick }: Props = $props();

  function headingLevel(block: CompiledBlock): number {
    const hint = block.layoutHints?.['level'];
    const level = typeof hint === 'number' ? hint : 2;
    return Math.min(6, Math.max(1, level));
  }

  function nodesOf(block: CompiledBlock): SafeRenderNode[] {
    return block.renderNodes;
  }

  /*
   * The same marker the stage draws, from the same function, so the preview and
   * the glass agree about what a list item is. Its widths are in `em` of the
   * item's own type (`.list-item` sets it), which is what keeps the proportions
   * the stage's line planner relies on — though nothing plans lines here.
   */
  function markerOf(block: CompiledBlock) {
    const marker = listMarker(block.layoutHints);
    return { marker, geometry: listMarkerGeometry(marker) };
  }

  /**
   * A line that is nothing but part breaks: `[Take: Opening]` on its own.
   *
   * It divides the script, so it is drawn as a divider with the part's name
   * on it — not as the amber chip a cue wears, which made "Opening" and
   * "look at the lens" the same kind of thing to the eye.
   */
  function partBreakLabel(block: CompiledBlock): string | null {
    if (block.kind !== 'cue') return null;
    const cues = block.renderNodes.filter((n) => n.type === 'cue');
    if (cues.length === 0 || cues.some((n) => n.cueType !== 'take')) return null;
    return cues.map((n) => n.label).join(' · ');
  }

  /*
   * Lists, as lists — nested ones included.
   *
   * Each list item is a block of its own — that is what lets one be clicked —
   * so consecutive items are gathered back into the `<ul>`/`<ol>` they came
   * from, and a deeper item into a list inside the item above it, so a
   * subordinate point is not announced as a peer of its parent. A change
   * between numbered and unnumbered at one depth starts a new list, which is
   * what two adjacent source lists of different kinds are.
   */
  interface ListGroup {
    kind: 'list';
    key: string;
    ordered: boolean;
    depth: number;
    items: ListEntry[];
  }
  interface ListEntry {
    block: CompiledBlock;
    children: ListGroup[];
  }
  type Group = { kind: 'block'; key: string; block: CompiledBlock } | ListGroup;

  const groups = $derived.by((): Group[] => {
    const out: Group[] = [];
    // The open lists, outermost first.
    let open: ListGroup[] = [];
    const newList = (block: CompiledBlock, depth: number, ordered: boolean): ListGroup => ({
      kind: 'list',
      key: block.id,
      ordered,
      depth,
      items: [],
    });
    for (const block of blocks) {
      if (block.kind !== 'list_item') {
        out.push({ kind: 'block', key: block.id, block });
        open = [];
        continue;
      }
      const { depth, kind } = listMarker(block.layoutHints);
      const ordered = kind === 'number';
      while (open.length > 0 && open[open.length - 1]!.depth > depth) open.pop();
      const top = open[open.length - 1];
      if (top && top.depth === depth && top.ordered === ordered) {
        top.items.push({ block, children: [] });
        continue;
      }
      const list = newList(block, depth, ordered);
      list.items.push({ block, children: [] });
      if (top && top.depth === depth) open.pop();
      const enclosing = open[open.length - 1];
      const parent = enclosing?.items[enclosing.items.length - 1];
      if (parent) parent.children.push(list);
      else out.push(list);
      open.push(list);
    }
    return out;
  });

  const NOUNS: Record<CompiledBlock['kind'], string> = {
    paragraph: 'paragraph',
    heading: 'heading',
    list_item: 'list item',
    blockquote: 'quote',
    image: 'image',
    table: 'table',
    diagram: 'diagram',
    cue: 'cue',
    silent: 'silent block',
    stage_only: 'stage block',
    code: 'code',
    divider: 'divider',
  };

  function plainText(nodes: SafeRenderNode[]): string {
    return nodes
      .map((node) => {
        switch (node.type) {
          case 'text':
            return node.text;
          case 'link':
            return plainText(node.label);
          case 'cue':
            return node.label;
          case 'image':
            return node.alt;
          case 'table':
            return node.rows.flat().map(plainText).join(' ');
          default:
            return ' ';
        }
      })
      .join('');
  }

  /**
   * The edit button's name: what it does, and to what, in a few words.
   *
   * Short on purpose. The block itself used to be the button, so its name was
   * the whole paragraph — read out in full on every Tab.
   */
  function editLabel(block: CompiledBlock): string {
    const noun = partBreakLabel(block) !== null ? 'part break' : NOUNS[block.kind];
    const words = plainText(block.renderNodes).trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return `Edit ${noun}`;
    const excerpt = words.slice(0, 6).join(' ');
    return `Edit ${noun}: ${excerpt}${words.length > 6 ? '…' : ''}`;
  }

  function problemsOf(block: CompiledBlock): readonly CompileDiagnostic[] {
    return problems?.get(block.id) ?? [];
  }

  /**
   * The word under the pointer, as a spoken token.
   *
   * `RenderNodes` writes each run's word-to-token map onto its span; the caret
   * position the browser reports for the click says which word of the run it
   * fell in. A word with no token of its own (an em dash, a cue) takes the
   * nearest spoken word before it, then after it.
   */
  function tokenAtPoint(x: number, y: number): number | undefined {
    let node: Node | null = null;
    let offset = 0;
    const position = document.caretPositionFromPoint?.(x, y);
    if (position) {
      node = position.offsetNode;
      offset = position.offset;
    } else {
      const range = document.caretRangeFromPoint?.(x, y);
      if (range) {
        node = range.startContainer;
        offset = range.startOffset;
      }
    }
    if (!node || node.nodeType !== Node.TEXT_NODE) return undefined;
    const run = node.parentElement?.closest<HTMLElement>('[data-words]');
    if (!run?.dataset['words']) return undefined;
    const before = (node.textContent ?? '').slice(0, offset);
    const counted = before.split(/\s+/).filter(Boolean).length;
    const wordIndex = Math.max(0, counted - (/\S$/.test(before) ? 1 : 0));
    const tokens = run.dataset['words'].split(',').map((t) => (t === '' ? null : Number(t)));
    for (let i = Math.min(wordIndex, tokens.length - 1); i >= 0; i--) {
      if (tokens[i] !== null) return tokens[i]!;
    }
    return tokens.find((t): t is number => t !== null);
  }

  /**
   * A click anywhere on a block goes to its source — unless it ended a text
   * selection. Dragging across a passage to copy it used to throw the reader
   * into the editor the moment they let go.
   */
  function pointerActivate(event: MouseEvent, block: CompiledBlock): void {
    if (!onblockclick) return;
    // A nested list item sits inside its parent item; only the innermost goes.
    event.stopPropagation();
    const element = event.currentTarget as HTMLElement;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim() !== '') {
      const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      if (range && element.contains(range.commonAncestorContainer)) return;
      if (range && range.intersectsNode(element)) return;
    }
    onblockclick(block, {
      element,
      tokenIndex: tokenAtPoint(event.clientX, event.clientY),
      clientY: event.clientY,
    });
  }

  function keyboardActivate(event: MouseEvent, block: CompiledBlock): void {
    // The button sits inside the block, whose own click would go again.
    event.stopPropagation();
    const element = (event.currentTarget as HTMLElement).closest<HTMLElement>('.block');
    if (element) onblockclick?.(block, { element });
  }
</script>

{#snippet content(block: CompiledBlock)}
  {@const partLabel = partBreakLabel(block)}
  {#if block.kind === 'heading'}
    {@const level = headingLevel(block)}
    <!-- The authored level, so the outline a screen reader builds has the
         script's depth; the type stops getting smaller at the third. -->
    <svelte:element this={`h${level}`} class="h h{Math.min(level, 3)}"
      ><RenderNodes nodes={nodesOf(block)} {images} /></svelte:element
    >
  {:else if partLabel !== null}
    <div class="part-break" role="separator" aria-label="Part break: {partLabel}">
      <span class="part-glyph"><Icon name="flag" size={14} /></span>
      <span class="part-kind">Part</span>
      <span class="part-name">{partLabel}</span>
      <span class="part-rule"></span>
    </div>
  {:else if block.kind === 'cue'}
    <p class="cue-row"><RenderNodes nodes={nodesOf(block)} {images} /></p>
  {:else if block.kind === 'divider'}
    <hr class="divider" />
  {:else if block.kind === 'code'}
    <pre class="code"><RenderNodes nodes={nodesOf(block)} {images} /></pre>
  {:else if block.kind === 'diagram'}
    <!-- Its source, labelled as such: the glass draws a diagram as its source
         text too (BlockView's `.visual-fallback`), so the preview promises
         nothing the prompter will not show — but it must not pass for a code
         sample the presenter is meant to read. -->
    <figure class="code-figure">
      <figcaption class="block-label">Diagram source</figcaption>
      <pre class="code"><RenderNodes nodes={nodesOf(block)} {images} /></pre>
    </figure>
  {:else if block.kind === 'blockquote'}
    <blockquote class="quote"><RenderNodes nodes={nodesOf(block)} {images} /></blockquote>
  {:else if block.kind === 'image'}
    <!-- A picture on its own line is a figure, as on the stage, not a
         paragraph: it takes none of the prose size or line height. -->
    <div class="figure">
      <RenderNodes nodes={nodesOf(block)} {images} />
    </div>
  {:else if block.kind === 'silent' || block.kind === 'stage_only'}
    <!-- Notes for you (the syntax reference's own grouping): one family, told
         apart by name. Not a `<p>`: a block keeps whatever it wrapped, and a
         table inside a paragraph is taken apart by the HTML parser. -->
    <div class="note" class:silent-note={block.kind === 'silent'}>
      <p class="block-label">
        {block.kind === 'silent' ? 'Silent block' : 'Stage block'}<span class="label-hint"
          >{' · not spoken'}</span
        >
      </p>
      <div class="note-body"><RenderNodes nodes={nodesOf(block)} {images} /></div>
    </div>
  {:else if block.kind === 'table'}
    <!-- Not wrapped in <p>: a table inside a paragraph is invalid HTML and
         the browser breaks it out of the element, so the card must be its
         own scroll container. -->
    <div class="table-card"><RenderNodes nodes={nodesOf(block)} {images} /></div>
  {:else}
    <p class="para"><RenderNodes nodes={nodesOf(block)} {images} /></p>
  {/if}
{/snippet}

{#snippet listItem(block: CompiledBlock)}
  {@const { marker, geometry } = markerOf(block)}
  <!-- The marker is drawn, never read: `aria-hidden`, and outside the
       words, as on the stage. A task's state is read instead. -->
  <div
    class="list-item"
    data-marker={marker.kind}
    data-depth={marker.depth}
    style:padding-left="{geometry.indentEm}em"
    style:column-gap="{geometry.gapEm}em"
  >
    {#if marker.kind === 'number'}
      <span class="marker number" aria-hidden="true" style:width="{geometry.markerEm}em">{marker.label}</span>
    {:else if marker.kind === 'task'}
      <span
        class="marker checkbox"
        class:checked={marker.checked}
        aria-hidden="true"
        data-checked={marker.checked ? 'true' : 'false'}
        style:width="{geometry.markerEm}em"
        style:height="{geometry.markerEm}em"
      ></span>
    {:else}
      <span
        class="marker bullet"
        aria-hidden="true"
        style:width="{geometry.markerEm}em"
        style:height="{geometry.markerEm}em"
      ></span>
    {/if}
    <p class="para list-body">
      {#if marker.kind === 'task'}<span class="sr-only">{marker.checked ? 'Done: ' : 'To do: '}</span>{/if}<RenderNodes
        nodes={nodesOf(block)}
        {images}
      />
    </p>
  </div>
{/snippet}

{#snippet listGroup(group: ListGroup)}
  <!-- `role="list"` is not redundant here: WebKit drops a list's semantics
       once its markers are styled away, and these draw their own. -->
  <svelte:element this={group.ordered ? 'ol' : 'ul'} class="list" role="list">
    {#each group.items as entry (entry.block.id)}
      {@render blockView(entry.block, 'li', entry.children)}
    {/each}
  </svelte:element>
{/snippet}

{#snippet blockView(block: CompiledBlock, tag: 'div' | 'li', children: ListGroup[] = [])}
  <!--
    The block is a plain container, not a button.

    It was `role="button"`, and a button's children are presentational: every
    heading, list and table inside it left the accessibility tree, and its name
    was the whole paragraph. Now the content keeps its own semantics, the
    keyboard reaches a real, briefly named button inside it (drawn by the block,
    `data-focus="delegate"`), and the pointer can still click anywhere.
  -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions, a11y_no_noninteractive_element_interactions -->
  <svelte:element
    this={tag}
    class="block kind-{block.kind}"
    class:editable={!!onblockclick}
    class:quiet={block.kind === 'divider'}
    data-block-id={block.id}
    onclick={(event: MouseEvent) => pointerActivate(event, block)}
  >
    {#if block.kind === 'list_item'}
      {@render listItem(block)}
    {:else}
      {@render content(block)}
    {/if}
    {#each problemsOf(block) as problem, index (index)}
      <div class="problem" class:blocking={problem.blocking}>
        <span class="problem-glyph"><Icon name="alert" size={14} /></span>
        <p class="problem-text">{problem.message}</p>
        {#if onproblemclick}
          <Button
            size="sm"
            onclick={(event) => {
              event.stopPropagation();
              onproblemclick(problem);
            }}
          >
            Show in editor
          </Button>
        {/if}
      </div>
    {/each}
    {#if onblockclick}
      <button
        type="button"
        class="edit sr-only"
        data-focus="delegate"
        aria-label={editLabel(block)}
        onclick={(event) => keyboardActivate(event, block)}
      ></button>
    {/if}
    {#each children as child (child.key)}
      {@render listGroup(child)}
    {/each}
  </svelte:element>
{/snippet}

<div class="doc">
  {#each groups as group (group.key)}
    {#if group.kind === 'list'}
      {@render listGroup(group)}
    {:else}
      {@render blockView(group.block, 'div')}
    {/if}
  {/each}
</div>

<style>
  /*
   * Every size here is multiplied by `--doc-scale`, which the Editor sets from
   * View › Larger / Smaller Editor Text. CodeMirror already followed it; the
   * rendered preview kept fixed pixel sizes, so Both drew the same script at
   * two scales. Outside the Editor nothing sets it and it falls back to 1.
   */
  .doc {
    /* The full measure, not the content's: inside the pane's centring column a
       short document shrank to its own width, so a lone title sat in the middle
       and moved left as text was added under it. */
    width: 100%;
    max-width: var(--prose-measure);
    display: flex;
    flex-direction: column;
    gap: calc(var(--space-4) * var(--doc-scale, 1));
  }

  /*
   * The click surface reaches past the words rather than stopping at them: a
   * highlight that began at the first glyph made every line touch its edge, and
   * the inset focus edge ran through the letters. The negative margin keeps the
   * text exactly where it was.
   */
  .block {
    position: relative;
    min-width: 0;
  }
  .block.editable {
    --bleed-y: calc(var(--space-1) * var(--doc-scale, 1));
    --bleed-x: calc(var(--space-2) * var(--doc-scale, 1));
    padding: var(--bleed-y) var(--bleed-x);
    margin: calc(-1 * var(--bleed-y)) calc(-1 * var(--bleed-x));
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: background var(--dur-fast) var(--ease-out);
  }
  /* The innermost block only: a nested list item sits inside its parent's. */
  .block.editable:hover:not(:has(.block:hover)) {
    background: var(--bg-hover-surface);
  }
  /* The keyboard's focus is on the edit button inside; the block draws it, as
     the quiet inset edge the focus policy gives every surface. */
  .block.editable:has(> .edit:focus-visible) {
    background: var(--bg-hover-surface);
    outline: 2px solid var(--focus-quiet);
    outline-offset: -2px;
  }

  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    /* Items of one list sit closer than blocks do, so a list reads as one
       thing. The block gap still separates it from what is around it. */
    gap: calc(var(--space-1) * var(--doc-scale, 1));
  }
  /* A nested list follows its parent item's words at the same close pitch. */
  .list .list {
    margin-top: calc(var(--space-1) * var(--doc-scale, 1));
  }

  .h {
    margin: 0;
    color: var(--text-primary);
    letter-spacing: var(--ls-title);
    font-weight: 650;
  }
  .h1 {
    font-family: var(--font-ui);
    font-size: calc(var(--text-3xl) * var(--doc-scale, 1));
    line-height: 1.25;
    margin-top: calc(var(--space-4) * var(--doc-scale, 1));
  }
  .h2 {
    font-size: calc(var(--text-2xl) * var(--doc-scale, 1));
    line-height: 1.3;
    margin-top: calc(var(--space-3) * var(--doc-scale, 1));
  }
  .h3 {
    font-size: calc(var(--text-xl) * var(--doc-scale, 1));
    line-height: calc(var(--lh-section) * var(--doc-scale, 1));
  }
  /* The document's first heading opens it; it needs no air above. */
  .doc > .block:first-child .h {
    margin-top: 0;
  }

  .para {
    margin: 0;
    font-size: calc(var(--text-lg) * var(--doc-scale, 1));
    line-height: calc(var(--lh-transcript) * var(--doc-scale, 1));
    color: var(--prose-text-warm);
    letter-spacing: var(--ls-prose);
  }

  /*
   * A list item, drawn as the stage draws it: the marker and its widths come
   * from `list-marker.ts`, in `em` of the prose size set here. The colours are
   * the control window's own, because this is the control window.
   */
  .list-item {
    display: flex;
    align-items: baseline;
    font-size: calc(var(--text-lg) * var(--doc-scale, 1));
    line-height: calc(var(--lh-transcript) * var(--doc-scale, 1));
  }
  .marker {
    flex: none;
  }
  .bullet {
    border-radius: 50%;
    background: var(--text-muted);
    transform: translateY(-0.18em);
  }
  .number {
    display: flex;
    justify-content: flex-end;
    white-space: nowrap;
    color: var(--text-secondary);
    letter-spacing: var(--ls-prose);
  }
  .checkbox {
    position: relative;
    box-sizing: border-box;
    border: 1.5px solid var(--text-muted);
    border-radius: 0.16em;
    transform: translateY(0.04em);
  }
  /* A ticked box in the accent, as a checked control is everywhere else in
     the window; the tick takes the accent's own contrast colour. */
  .checkbox.checked {
    border-color: var(--accent);
    background: var(--accent);
  }
  .checkbox.checked::after {
    content: '';
    position: absolute;
    left: 33%;
    top: 12%;
    width: 30%;
    height: 54%;
    box-sizing: border-box;
    border-style: solid;
    border-color: var(--accent-contrast);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }
  .list-body {
    flex: 1;
    min-width: 0;
  }

  /* A line of cues — visually distinct, clearly not spoken text (§23.2). The
     chips are the inline chips, at the size they are inside a sentence, so a
     cue looks the same wherever it was written. */
  .cue-row {
    margin: 0;
    font-size: calc(var(--text-lg) * var(--doc-scale, 1));
    line-height: calc(var(--lh-transcript) * var(--doc-scale, 1));
  }

  /*
   * A part break (§23.3): a named divider across the column. Neutral, because
   * it is structure rather than direction, and marked with the flag the Insert
   * toolbar already uses for it.
   */
  .part-break {
    display: flex;
    align-items: center;
    gap: calc(var(--space-2) * var(--doc-scale, 1));
    min-height: calc(var(--lh-transcript) * var(--doc-scale, 1));
    color: var(--text-secondary);
    font-size: calc(var(--text-sm) * var(--doc-scale, 1));
  }
  .part-glyph {
    display: inline-flex;
    color: var(--text-muted);
  }
  /* Sized with the label beside it, so a larger document text keeps the
     flag in proportion. */
  .part-glyph :global(svg) {
    width: 1.1em;
    height: 1.1em;
  }
  .part-kind {
    font-size: calc(var(--text-2xs) * var(--doc-scale, 1));
    font-weight: 650;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .part-name {
    font-weight: 650;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .part-rule {
    flex: 1 1 auto;
    min-width: var(--space-6);
    height: 1px;
    background: var(--border);
  }

  /* A small caption over a block that is not the script itself. */
  .block-label {
    margin: 0;
    font-size: calc(var(--text-2xs) * var(--doc-scale, 1));
    line-height: calc(var(--lh-meta) * var(--doc-scale, 1));
    font-weight: 650;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .label-hint {
    font-weight: 500;
    letter-spacing: normal;
    text-transform: none;
  }

  /*
   * Silent and stage blocks: a note card, not a faded paragraph. Fading them
   * took their text under 4.5:1 and left the two looking like each other and
   * like any paragraph that happened to be quiet. The card says what they are;
   * the text stays readable. A silent block reads as direction (italic); a
   * stage block's text is shown as written.
   */
  .note {
    display: flex;
    flex-direction: column;
    gap: calc(var(--space-1) * var(--doc-scale, 1));
    padding: calc(var(--space-3) * var(--doc-scale, 1)) calc(var(--space-4) * var(--doc-scale, 1));
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
  }
  .note-body {
    font-size: calc(var(--text-base) * var(--doc-scale, 1));
    line-height: calc(var(--lh-body) * var(--doc-scale, 1));
    color: var(--prose-secondary-warm);
    letter-spacing: var(--ls-prose);
  }
  .silent-note .note-body {
    font-style: italic;
  }

  .quote {
    margin: 0;
    position: relative;
    padding-left: calc(var(--space-4) * var(--doc-scale, 1));
    font-size: calc(var(--text-lg) * var(--doc-scale, 1));
    line-height: calc(var(--lh-transcript) * var(--doc-scale, 1));
    color: var(--prose-secondary-warm);
    letter-spacing: var(--ls-prose);
    font-style: italic;
  }
  /* Leading rule as an inset bar — never a one-sided border on a rounded box. */
  .quote::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.2em;
    bottom: 0.2em;
    width: 3px;
    border-radius: var(--radius-pill);
    background: var(--border-strong);
  }

  .code {
    margin: 0;
    padding: calc(var(--space-3) * var(--doc-scale, 1)) calc(var(--space-4) * var(--doc-scale, 1));
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
    border: 1px solid var(--border-faint);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: calc(var(--text-sm) * var(--doc-scale, 1));
    line-height: 1.55;
    overflow-x: auto;
  }
  .code-figure {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: calc(var(--space-1) * var(--doc-scale, 1));
  }

  .figure {
    text-align: center;
  }

  .table-card {
    overflow-x: auto;
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
  }

  .divider {
    border: none;
    height: 1px;
    background: var(--border);
    margin: calc(var(--space-2) * var(--doc-scale, 1)) 0;
  }
  /* Decoration, and quiet like it on the stage. */
  .quiet > :global(*) {
    opacity: 0.62;
  }

  /*
   * A problem the compiler found in this block (§23.8), where it is. The same
   * family as an image that could not be found: the danger wash and a firmer
   * edge all the way round. A warning that does not stop presenting takes the
   * warning tone instead.
   */
  .problem {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: calc(var(--space-1) * var(--doc-scale, 1)) calc(var(--space-2) * var(--doc-scale, 1));
    margin-top: calc(var(--space-2) * var(--doc-scale, 1));
    padding: calc(var(--space-1) * var(--doc-scale, 1)) calc(var(--space-1) * var(--doc-scale, 1)) calc(var(--space-1) * var(--doc-scale, 1))
      calc(var(--space-3) * var(--doc-scale, 1));
    border-radius: var(--radius-sm);
    border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent);
    background: var(--warning-soft);
    color: var(--warning);
    font-size: calc(var(--text-sm) * var(--doc-scale, 1));
    line-height: calc(var(--lh-label) * var(--doc-scale, 1));
  }
  .problem.blocking {
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
    background: var(--danger-soft);
    color: var(--danger);
  }
  .problem-glyph {
    display: inline-flex;
  }
  .problem-glyph :global(svg) {
    width: 1.1em;
    height: 1.1em;
  }
  .problem-text {
    flex: 1 1 16em;
    margin: 0;
    font-weight: 600;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>
