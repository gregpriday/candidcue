<!--
  One compiled block on stage (spec §16.2): headings and take markers, cue
  rows, silent/stage-only treatment, images, and ordinary spoken text.
  Past/current/future zoning is applied per block; the current block also
  receives per-token treatment through `cursor`.
-->
<script lang="ts">
  import type { CompiledBlock } from '../../shared/contracts';
  import { performanceCueKind, type PerformanceMode } from '../../shared/performance-view';
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
    performanceMode === 'take' && block.kind === 'heading' && !block.spoken,
  );
</script>

{#if !hidden}
  <div
    class="block k-{block.kind}"
    class:zone-past={zone === 'past'}
    class:zone-future={zone === 'future'}
    class:unspoken={!block.spoken && block.kind !== 'cue'}
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
        <InlineNodes nodes={block.renderNodes} {cursor} {assets} {showCues} {dimFrozen} {dimRollback} />
      </div>
    {:else if block.kind === 'list_item'}
      <div class="list-item">
        <span class="bullet" aria-hidden="true"></span>
        <span class="list-body"><InlineNodes nodes={block.renderNodes} {cursor} {assets} {showCues} {dimFrozen} {dimRollback} /></span>
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
      <p class="para"><InlineNodes nodes={block.renderNodes} {cursor} {assets} {showCues} {dimFrozen} {dimRollback} /></p>
    {/if}
  </div>
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

  .list-item {
    display: flex;
    gap: 0.55em;
    align-items: baseline;
  }
  .bullet {
    flex: none;
    width: 0.28em;
    height: 0.28em;
    border-radius: 50%;
    background: color-mix(in srgb, var(--stage-text) 55%, transparent);
    transform: translateY(-0.18em);
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
