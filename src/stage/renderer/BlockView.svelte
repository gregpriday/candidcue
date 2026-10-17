<!--
  One compiled block on stage (spec §16.2): headings and take markers, cue
  rows, silent/stage-only treatment, images, and ordinary spoken text.
  Past/current/future zoning is applied per block; the current block also
  receives per-token treatment through `cursor`.
-->
<script lang="ts">
  import type { CompiledBlock } from '../../shared/contracts';
  import { performanceCueKind, type PerformanceMode } from '../../shared/performance-view';
  import { listMarker, listMarkerGeometry } from '../../shared/list-marker';
  import InlineNodes from './InlineNodes.svelte';

  let {
    block,
    zone,
    cursor = null,
    assets = {},
    showCues = true,
    gapPx = 0,
    dimFrozen = false,
    dimRollback = false,
    performanceMode = 'rehearsal',
    breakAfterTokens = null,
    reader = false,
  }: {
    block: CompiledBlock;
    zone: 'past' | 'current' | 'future';
    cursor?: number | null;
    assets?: Record<string, { url: string; mime: string; width?: number; height?: number }>;
    showCues?: boolean;
    gapPx?: number;
    /**
     * Passed straight through to the words: alignment is not following, so the
     * per-word ramp holds where it is. Block-level zoning is deliberately NOT
     * frozen with it — zoning follows the block the engine last placed the
     * reader in, which is a claim it still stands behind while it searches.
     */
    dimFrozen?: boolean;
    /** Allows an explicitly withdrawn provisional ramp to brighten again. */
    dimRollback?: boolean;
    /**
     * Which view of the script this is (`shared/performance-view.ts`).
     *
     * The division of labour with `projectForPerformance` is deliberate: the
     * projection decides WHAT is on the glass — it replaces the blocks a
     * presenter cannot read at prompting distance — and this prop decides how
     * big the structure that survived reads. Presentation that the block model
     * has no business carrying stays out of the block model.
     *
     * `rehearsal` is the default so every existing mount site (and every test)
     * renders exactly what it rendered before this existed.
     */
    performanceMode?: PerformanceMode;
    /**
     * Spoken tokens after which a line ends, from the stage's line breaker.
     *
     * Handed only to the prose runs — the ones `wrap-plan.ts` plans. A table
     * cell, a code block and a cue chip lay themselves out, and applying
     * English phrase rules to them would be answering a question they did not
     * ask. `null` means nothing was planned and the browser wraps, which is
     * what happened before the breaker existed.
     */
    breakAfterTokens?: ReadonlySet<number> | null;
    /**
     * This stage is a reading window rather than a teleprompter.
     *
     * A separate fact from `performanceMode`, and it has to be: a reading window
     * shows the whole document, so it already arrives here as `rehearsal` — but
     * so does a practice on the prompter and a Diagnostic Take, and those keep
     * the prompter's headings exactly. What this changes is how a HEADING reads
     * (see `readerHeading`); nothing else on the glass looks at it.
     *
     * `false` by default for the same reason `performanceMode` defaults to
     * `rehearsal`: every mount site that predates it renders what it always did.
     */
    reader?: boolean;
  } = $props();

  const headingLevel = $derived(
    typeof block.layoutHints?.level === 'number' ? (block.layoutHints.level as number) : 2,
  );
  const takeLabel = $derived(
    typeof block.layoutHints?.takeLabel === 'string'
      ? (block.layoutHints.takeLabel as string)
      : block.layoutHints?.take
        ? 'Take'
        : null,
  );
  const perfCue = $derived(performanceCueKind(block));
  /**
   * A performance cue is NOT hidden by "hide cues".
   *
   * That setting turns off the author's asides — [Beat], [Cue: to camera] — and
   * the script reads fine without them. A projected cue is the opposite: it is
   * standing in for a block that has been taken off the glass, so hiding it
   * deletes the presenter's only evidence that the table exists at all. Content
   * that vanishes with nothing to say it was ever there is the one outcome the
   * media fallbacks below are also written to avoid.
   */
  const hidden = $derived(block.kind === 'cue' && !showCues && perfCue === null);
  /**
   * Compact section cue.
   *
   * A heading in a take is a landmark rather than a title: what it has to do is
   * tell the presenter where they are, and every pixel it spends at display size
   * is script pushed off a nine-inch glass. A SPOKEN heading is exempt, because
   * `readHeadings` makes it a line the presenter reads aloud — shrinking that
   * would be shrinking body copy.
   */
  const compactHeading = $derived(
    !reader && performanceMode === 'take' && block.kind === 'heading' && !block.spoken,
  );
  /**
   * A heading in a reading window reads as a heading, spoken or not.
   *
   * On the prompter an unspoken heading is quiet on purpose — a landmark the
   * presenter glances at, at 0.8em and 0.45 opacity, or the compact gold label
   * in a take — because every line it spends at display size is script pushed
   * off a small glass. A reading window is read at a desk, as a document, and
   * there the same treatment inverts the hierarchy: an H1 came out barely larger
   * than body text at under half its brightness, so the page's structure was
   * the faintest thing on it. Whether the follower listens for a heading's words
   * is a fact about following, not about how important the heading is.
   *
   * So here a heading is never `.unspoken` and never compact. It keeps the level
   * sizes below at the reading colour, takes only the zone opacity every block
   * takes, and gets more room above it than below (`.reader-heading`) so it
   * sits with the passage it introduces.
   */
  const readerHeading = $derived(reader && block.kind === 'heading');
  const unspoken = $derived(!block.spoken && block.kind !== 'cue' && !readerHeading);
  const marker = $derived(block.kind === 'list_item' ? listMarker(block.layoutHints) : null);
  const markerGeometry = $derived(marker ? listMarkerGeometry(marker) : null);
</script>

{#if !hidden}
  <div
    class="block k-{block.kind}"
    class:zone-past={zone === 'past'}
    class:zone-future={zone === 'future'}
    class:unspoken
    class:reader-heading={readerHeading}
    data-heading-level={readerHeading ? headingLevel : undefined}
    data-block-id={block.id}
    style:padding-bottom="{gapPx}px"
  >
    {#if takeLabel}
      <span class="take-marker">{takeLabel}</span>
    {/if}

    {#if perfCue !== null}
      <!-- The block the projection took off the glass, said in the stage's own
           cue vocabulary: the same chip an authored [Beat] draws, so it reads as
           direction rather than as a card that lost its contents. -->
      <div class="perf-cue" data-performance-cue={perfCue}>
        <InlineNodes nodes={block.renderNodes} {assets} showCues={true} {dimFrozen} {dimRollback} />
      </div>
    {:else if block.kind === 'heading'}
      <div class="heading" data-level={headingLevel} class:compact={compactHeading}>
        <InlineNodes nodes={block.renderNodes} {cursor} {assets} {showCues} {dimFrozen} {dimRollback} />
      </div>
    {:else if block.kind === 'cue'}
      <div class="cue-row">
        <InlineNodes nodes={block.renderNodes} {cursor} {assets} showCues={true} {dimFrozen} {dimRollback} />
      </div>
    {:else if block.kind === 'divider'}
      <div class="divider" aria-hidden="true"></div>
    {:else if block.kind === 'image'}
      <div class="figure">
        {#each block.renderNodes as node}
          {#if node.type === 'image'}
            {#if assets[node.assetId]}
              <img src={assets[node.assetId]?.url} alt={node.alt} draggable="false" />
            {:else}
              <!-- An unresolved asset must never vanish silently: the operator
                   needs to know something was meant to be here, and the alt
                   text is the only description we have. -->
              <p class="image-fallback">{node.alt || 'Image unavailable'}</p>
            {/if}
          {/if}
        {/each}
      </div>
    {:else if block.kind === 'code'}
      <pre class="code"><InlineNodes nodes={block.renderNodes} {cursor} {assets} {showCues} {dimFrozen} {dimRollback} /></pre>
    {:else if block.kind === 'blockquote'}
      <div class="quote">
        <InlineNodes nodes={block.renderNodes} {cursor} {assets} {showCues} {dimFrozen} {dimRollback} {breakAfterTokens} />
      </div>
    {:else if block.kind === 'list_item' && marker && markerGeometry}
      <!-- The marker carries no `data-t`, and nothing inside it can: the motion
           path measures anchored spans only, and `3.` is not a word anybody
           says. Its widths come from `list-marker.ts`, which the line planner
           reads too, so the column it planned is the column drawn. -->
      <div
        class="list-item"
        data-marker={marker.kind}
        data-depth={marker.depth}
        style:padding-left="{markerGeometry.indentEm}em"
        style:column-gap="{markerGeometry.gapEm}em"
      >
        {#if marker.kind === 'number'}
          <span class="marker number" aria-hidden="true" style:width="{markerGeometry.markerEm}em">{marker.label}</span>
        {:else if marker.kind === 'task'}
          <span
            class="marker checkbox"
            class:checked={marker.checked}
            aria-hidden="true"
            data-checked={marker.checked ? 'true' : 'false'}
            style:width="{markerGeometry.markerEm}em"
            style:height="{markerGeometry.markerEm}em"
          ></span>
        {:else}
          <span
            class="marker bullet"
            aria-hidden="true"
            style:width="{markerGeometry.markerEm}em"
            style:height="{markerGeometry.markerEm}em"
          ></span>
        {/if}
        <span class="list-body"><InlineNodes nodes={block.renderNodes} {cursor} {assets} {showCues} {dimFrozen} {dimRollback} {breakAfterTokens} /></span>
      </div>
    {:else if block.kind === 'table'}
      <!-- Tables are structured reference cards on stage (§24.6): real rows,
           never a flattened inline fallback that renders as an empty box. -->
      <div class="table-card">
        {#each block.renderNodes as node}
          {#if node.type === 'table'}
            <table class="stage-table">
              {#each node.rows as row, rowIndex}
                {#if rowIndex === 0 && node.headerRow}
                  <thead>
                    <tr>
                      {#each row as cell, colIndex}
                        <th style:text-align={node.align[colIndex] ?? 'left'}>
                          <InlineNodes nodes={cell} {assets} {showCues} />
                        </th>
                      {/each}
                    </tr>
                  </thead>
                {/if}
              {/each}
              <tbody>
                {#each node.rows as row, rowIndex}
                  {#if !(rowIndex === 0 && node.headerRow)}
                    <tr>
                      {#each row as cell, colIndex}
                        <td style:text-align={node.align[colIndex] ?? 'left'}>
                          <InlineNodes nodes={cell} {assets} {showCues} />
                        </td>
                      {/each}
                    </tr>
                  {/if}
                {/each}
              </tbody>
            </table>
          {/if}
        {/each}
      </div>
    {:else if block.kind === 'diagram'}
      <div class="visual-fallback">
        <InlineNodes nodes={block.renderNodes} {cursor} {assets} {showCues} {dimFrozen} {dimRollback} />
      </div>
    {:else if block.kind === 'silent' || block.kind === 'stage_only'}
      <!-- Not a `<p>`. `:::silent` and `:::stage` keep whatever they wrapped
           (`innerKind`), so a table can land here — and an HTML parser closes an
           open `<p>` before a `<table>`, which leaves the stage measuring a
           shape the browser then takes apart underneath it. -->
      <div class="para"><InlineNodes nodes={block.renderNodes} {cursor} {assets} {showCues} {dimFrozen} {dimRollback} /></div>
    {:else}
      <!-- paragraph -->
      <p class="para"><InlineNodes nodes={block.renderNodes} {cursor} {assets} {showCues} {dimFrozen} {dimRollback} {breakAfterTokens} /></p>
    {/if}
  </div>
{:else if reader}
  <!-- A hidden cue still holds its place among its siblings in a reading window.
       `.reader-heading:not(:first-child)` reads "is this the first block of the
       document" off the DOM, and a block that rendered nothing would let a
       heading below it be first while the window starts at the top and stop
       being first once virtualization put a spacer there — padding that comes
       and goes under the reader's eye as they scroll. Empty, unmeasured (no
       `data-block-id`) and `display: none`, so it holds the position and
       nothing else. The prompter never needs it and never draws it. -->
  <div class="hidden-block" hidden></div>
{/if}

<style>
  .block {
    position: relative;
  }
  /* Past/future zoning (spec §11.3): applied to whole blocks; the current
     block's words are zoned individually in InlineNodes. */
  .zone-past {
    opacity: var(--stage-past-opacity, 0.42);
  }
  .zone-future {
    opacity: var(--stage-future-opacity, 0.92);
  }
  /* The zoning opacities above are a reading aid and always apply; the fade
     between them is an effect, and §61 turns it off under frame pressure by
     zeroing `--stage-fx-ms` on the script layer. */
  .block {
    transition-property: opacity;
    transition-duration: var(--stage-fx-ms, 300ms);
    transition-timing-function: var(--ease-out, ease-out);
  }

  /*
   * THE SECONDARY-TEXT FLOOR.
   *
   * Every rule below that sizes text a presenter has to READ is written as
   * `max(--stage-secondary-min, <proportion>)`. The proportion is the
   * typographic intent; the floor is an absolute pixel size the script layer
   * resolves from the rig's optics (`secondaryTextFloorPx`), and it is what
   * stops that intent from putting the words under the angular size at which
   * reading works at all.
   *
   * The proportions themselves were also wrong, not merely unfloored. They were
   * chosen against a laptop screen at desk distance — a take marker at 0.42em, a
   * code block at 0.6em — which at two metres through a beamsplitter is a shape
   * rather than a word. What is on the glass is either worth reading from where
   * the presenter is standing, in which case it is sized for that, or it is not
   * worth drawing.
   *
   * The floor is absolute rather than relative because `em` compounds: a cue
   * inside a silent block is two multiplications away from body, and each factor
   * was picked on its own against body text.
   */

  /* Silent / stage-only material reads as quiet stage direction. It is still
     direction someone has to act on, so it is quiet by OPACITY and only
     slightly smaller — dropping it to 0.7em made "look at camera" the least
     legible thing on a screen whose whole job is legibility. */
  .unspoken {
    opacity: 0.45;
    font-size: max(var(--stage-secondary-min, 0.67em), 0.8em);
    line-height: 1.35;
  }

  .take-marker {
    display: inline-block;
    color: var(--stage-cue);
    font-size: max(var(--stage-secondary-min, 0.67em), 0.67em);
    font-weight: 650;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 0.2em 0.9em;
    border-radius: 999px;
    background: color-mix(in srgb, var(--stage-cue) 14%, transparent);
    margin-bottom: 0.45em;
  }

  /*
   * More room above a heading than below it, in a reading window.
   *
   * The space below is the paragraph gap every block ends with; this adds to
   * the gap above, so a heading reads as the start of what follows rather than
   * the end of what came before. PADDING, on the block itself, and that is not
   * a style choice: the stage measures each block's box to place every block
   * after it, and a margin would sit outside that box (and collapse into its
   * neighbour's), leaving the measured offsets short of where the text really
   * is. Nothing above the first block on the glass, where there is no passage
   * to separate it from.
   */
  .reader-heading:not(:first-child) {
    padding-top: 0.6em;
  }
  .reader-heading[data-heading-level='2']:not(:first-child) {
    padding-top: 0.8em;
  }
  .reader-heading[data-heading-level='1']:not(:first-child) {
    padding-top: 1em;
  }

  .heading {
    font-weight: 640;
    letter-spacing: -0.012em;
  }
  .heading[data-level='1'] {
    font-size: 1.3em;
    line-height: 1.18;
  }
  .heading[data-level='2'] {
    font-size: 1.16em;
    line-height: 1.2;
  }
  .heading:not([data-level='1']):not([data-level='2']) {
    font-size: 1.05em;
    line-height: 1.22;
  }
  /*
   * The take-mode heading: one size for every level, because at prompting
   * distance the level is not information the presenter can act on — where the
   * section starts is. It is coloured like the other stage direction and is
   * deliberately NOT uppercased the way the cue chips are: a chip is a word, a
   * heading is a phrase, and capitals cost more than they buy over a phrase.
   *
   * `[data-level]` is in the selector for the cascade, not to narrow the match
   * — the attribute is always written. `:not()` carries the specificity of its
   * argument, so the level-3-and-up rule above counts as a class plus two
   * attributes, and a bare `.heading.compact` loses to it outright: h3 to h6
   * would have kept 1.05em and come out LARGER in a take than the compacted h1
   * above them. With the attribute the two tie and source order decides, which
   * is why this rule still has to stay BELOW all three.
   */
  .heading.compact[data-level] {
    font-size: max(var(--stage-secondary-min, 0.67em), 0.9em);
    line-height: 1.3;
    letter-spacing: 0.04em;
    color: var(--stage-cue);
  }

  /*
   * A projected cue replaces a WHOLE block, so its wrapper does not shrink.
   *
   * That is the whole rule: the chip inside is then exactly one multiplication
   * away from body text, the same as an authored inline cue. Routing it through
   * `.cue-row` would have made it two — 0.67 of 0.9 — which is precisely the
   * compounding the floor above exists to catch, and the cheapest place to not
   * have it is here.
   */
  .perf-cue {
    font-size: 1em;
    line-height: 1.4;
  }

  .cue-row {
    font-size: max(var(--stage-secondary-min, 0.67em), 0.9em);
  }

  .divider {
    height: 2px;
    width: 22%;
    margin: 0.3em auto;
    border-radius: 999px;
    background: color-mix(in srgb, var(--stage-text) 22%, transparent);
  }

  .figure img {
    display: block;
    max-width: 100%;
    max-height: var(--stage-image-max-h, 78vh);
    margin: 0 auto;
    border-radius: 16px;
  }

  .code {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: max(var(--stage-secondary-min, 0.67em), 0.75em);
    line-height: 1.5;
    white-space: pre-wrap;
    margin: 0;
    padding: 0.8em 1em;
    border-radius: 12px;
    background: color-mix(in srgb, var(--stage-text) 7%, transparent);
  }

  /* Leading rule as an inset bar, never a one-sided border on a rounded box. */
  .quote {
    position: relative;
    padding-left: 0.85em;
    font-style: italic;
  }
  .quote::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.18em;
    bottom: 0.18em;
    width: 0.09em;
    border-radius: 999px;
    background: color-mix(in srgb, var(--stage-text) 30%, transparent);
  }

  /*
   * A list item: its nesting, its marker, its text.
   *
   * Every width here — the indent, the marker column, the gap — is written
   * inline from `list-marker.ts` rather than in this sheet, because the line
   * planner reads the same function to know how much of the column the text
   * gets. What stays here is how a marker LOOKS, which the planner has no use
   * for. No marker sets a font size: the dot and the box are drawn, and the
   * number is read at the size of the words it numbers.
   */
  .list-item {
    display: flex;
    align-items: baseline;
  }
  .marker {
    flex: none;
  }
  .bullet {
    border-radius: 50%;
    background: color-mix(in srgb, var(--stage-text) 55%, transparent);
    transform: translateY(-0.18em);
  }
  /* Right-aligned so the full stops line up down a list. The column is sized
     to hold its label (`list-marker.ts`); a flex box rather than `text-align:
     right` so that, in a face wider than the one it was sized for, the label
     overflows to the LEFT and the text it numbers stays where it was planned. */
  .number {
    display: flex;
    justify-content: flex-end;
    white-space: nowrap;
    color: color-mix(in srgb, var(--stage-text) 72%, transparent);
  }
  /* Drawn, not a glyph: the stage face has no ballot-box characters, and a
     fallback face's box would sit at a size nobody chose. Sits on the baseline
     about a capital high. */
  .checkbox {
    position: relative;
    box-sizing: border-box;
    border: 0.08em solid color-mix(in srgb, var(--stage-text) 62%, transparent);
    border-radius: 0.16em;
    transform: translateY(0.04em);
  }
  .checkbox.checked {
    background: color-mix(in srgb, var(--stage-text) 62%, transparent);
  }
  /* The tick: two edges of an unrounded box, turned. */
  .checkbox.checked::after {
    content: '';
    position: absolute;
    left: 33%;
    top: 12%;
    width: 30%;
    height: 54%;
    box-sizing: border-box;
    border-style: solid;
    border-color: var(--stage-bg);
    border-width: 0 0.09em 0.09em 0;
    transform: rotate(45deg);
  }
  .list-body {
    flex: 1;
    min-width: 0;
  }

  /* A diagram that could not be drawn falls back to its own source text, which
     is the only description of it anyone has — so it is sized like the other
     two reference cards rather than like a caption. */
  .visual-fallback {
    padding: 0.5em 0.8em;
    border-radius: 12px;
    background: color-mix(in srgb, var(--stage-text) 6%, transparent);
    font-size: max(var(--stage-secondary-min, 0.67em), 0.75em);
    line-height: 1.4;
  }

  .image-fallback {
    margin: 0;
    padding: 0.5em 0.8em;
    border-radius: 12px;
    background: color-mix(in srgb, var(--stage-text) 6%, transparent);
    color: color-mix(in srgb, var(--stage-text) 70%, transparent);
    font-size: max(var(--stage-secondary-min, 0.67em), 0.75em);
    line-height: 1.4;
    text-align: center;
  }

  .table-card {
    padding: 0.5em 0.8em;
    border-radius: 12px;
    background: color-mix(in srgb, var(--stage-text) 6%, transparent);
    font-size: max(var(--stage-secondary-min, 0.67em), 0.75em);
    line-height: 1.4;
    overflow-x: auto;
  }
  .stage-table {
    width: 100%;
    border-collapse: collapse;
  }
  .stage-table th,
  .stage-table td {
    padding: 0.35em 0.6em;
    vertical-align: baseline;
  }
  .stage-table th {
    font-weight: 650;
    letter-spacing: 0.02em;
  }
  /* Row separation without a border-inside-border: a background band. */
  .stage-table tbody tr:nth-child(odd) {
    background: color-mix(in srgb, var(--stage-text) 5%, transparent);
  }

  .para {
    margin: 0;
  }
</style>
