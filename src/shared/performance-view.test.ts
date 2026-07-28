/**
 * The performance projection, checked on the two things it can get wrong.
 *
 * The first is catastrophic and silent: moving a spoken token. The aligner's
 * indices come from the compiler, so a projection that dropped or renumbered one
 * would leave tracking following a script the presenter is not reading — the
 * display confidently in the wrong place, with nothing on screen looking broken.
 * Every assertion about that is made over a document the REAL compiler produced,
 * because a hand-built block cannot carry the case that actually bites (an image
 * whose alt text became spoken tokens whose render nodes were discarded).
 *
 * The second is the ordinary one: a projection nothing renders. So the cue is
 * asserted through `BlockView`, the component that has to draw it, rather than
 * through the block object the projection returns.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import BlockView from '../stage/renderer/BlockView.svelte';
import { compile } from './markdown';
import type { CompiledBlock, CompiledScript, SafeRenderNode } from './contracts';
import {
  PERFORMANCE_CUE_LABELS,
  PERFORMANCE_CUE_TYPE,
  performanceCueKind,
  projectForPerformance,
} from './performance-view';

const SOURCE = [
  '# Opening',
  '',
  'Welcome to the [quarterly walkthrough](https://example.com/q3) — here is what changed.',
  '',
  '![Pipeline overview](assets/pipeline.png)',
  '',
  '| Metric | Before | After |',
  '|---|---:|---:|',
  '| Takes per video | 14 | 3 |',
  '| Editing hours | 6 | 1.5 |',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  A --> B',
  '```',
  '',
  '> The line I always quote, and always say out loud.',
  '',
  ':::stage',
  '![Shot list](assets/shots.png)',
  ':::',
  '',
  ':::stage',
  '| Shot | Board |',
  '|---|---|',
  '| Wide | [storyboard](https://example.com/board) |',
  ':::',
  '',
  '## Closing',
  '',
  'That is the whole story, and I am done.',
  '',
].join('\n');

function compiled(options: { readHeadings?: boolean; readImageAltText?: boolean } = {}) {
  return compile(SOURCE, { scriptId: 'performance-view', ...options });
}

const script = compiled();
const take = projectForPerformance(script.blocks, 'take');

function blockOfKind(blocks: readonly CompiledBlock[], kind: CompiledBlock['kind']): CompiledBlock {
  const found = blocks.find((b) => b.kind === kind);
  if (!found) throw new Error(`no ${kind} block in the fixture`);
  return found;
}

/**
 * Every spoken token the render tree anchors, in document order, tagged with
 * the block that carries it. This is the sequence tracking positions itself
 * against: the `data-t` anchors `InlineNodes` emits come from exactly these.
 */
function anchoredSequence(blocks: readonly CompiledBlock[]): string[] {
  const out: string[] = [];
  const walk = (blockId: string, nodes: readonly SafeRenderNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'text') {
        for (const index of node.tokenIndexes ?? []) out.push(`${blockId}#${index}`);
      } else if (node.type === 'link') {
        walk(blockId, node.label);
      } else if (node.type === 'table') {
        for (const row of node.rows) for (const cell of row) walk(blockId, cell);
      }
    }
  };
  for (const block of blocks) walk(block.id, block.renderNodes);
  return out;
}

/** Whether a `link` wrapper survives anywhere in a render tree, table cells
 *  included — the one place the unwrap has to reach through a structure. */
function hasLink(nodes: readonly SafeRenderNode[]): boolean {
  for (const node of nodes) {
    if (node.type === 'link') return true;
    if (node.type === 'table') {
      for (const row of node.rows) for (const cell of row) if (hasLink(cell)) return true;
    }
  }
  return false;
}

/** The block-level token ranges, which are what the stage seeks by. */
function ranges(blocks: readonly CompiledBlock[]): string[] {
  return blocks.map((b) => `${b.id}:${b.startTokenIndex ?? '-'}..${b.endTokenIndex ?? '-'}`);
}

function html(block: CompiledBlock, props: Record<string, unknown> = {}): string {
  return render(BlockView, {
    props: { block, zone: 'current', performanceMode: 'take', ...props },
  }).body;
}

/** Visible text: every word is wrapped in its own anchored span. */
function text(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('spoken tokens survive the projection', () => {
  it('leaves the anchored token sequence identical', () => {
    expect(anchoredSequence(take)).toEqual(anchoredSequence(script.blocks));
  });

  it('leaves every block token range identical', () => {
    expect(ranges(take)).toEqual(ranges(script.blocks));
  });

  it('keeps a block for every spoken token the compiler emitted', () => {
    const byId = new Map(take.map((b) => [b.id, b]));
    expect(script.spokenTokens.length).toBeGreaterThan(0);
    for (const token of script.spokenTokens) {
      const block = byId.get(token.blockId);
      expect(block, `token ${token.index} lost its block`).toBeDefined();
      expect(block!.startTokenIndex).toBeLessThanOrEqual(token.index);
      expect(block!.endTokenIndex).toBeGreaterThanOrEqual(token.index);
    }
  });

  it('never lets a replacement carry a spoken token', () => {
    const cues = take.filter((b) => performanceCueKind(b) !== null);
    expect(cues.length).toBeGreaterThan(0);
    for (const cue of cues) {
      expect(cue.startTokenIndex).toBeUndefined();
      expect(cue.endTokenIndex).toBeUndefined();
      expect(cue.spoken).toBe(false);
      expect(anchoredSequence([cue])).toEqual([]);
    }
  });

  it('leaves an image alone when its alt text became spoken tokens', () => {
    // `readImageAltText` puts the alt text in the alignment stream while the
    // block stays `spoken: false` and its tokens' render nodes are discarded —
    // so the render tree looks token-free and the index range is the only thing
    // that knows otherwise. Replacing this block would delete real tokens.
    const spokenAlt = compiled({ readImageAltText: true });
    const image = blockOfKind(spokenAlt.blocks, 'image');
    expect(image.startTokenIndex).toBeDefined();
    const projected = projectForPerformance(spokenAlt.blocks, 'take');
    expect(anchoredSequence(projected)).toEqual(anchoredSequence(spokenAlt.blocks));
    expect(ranges(projected)).toEqual(ranges(spokenAlt.blocks));
    expect(projected.find((b) => b.id === image.id)!.kind).toBe('image');
  });
});

describe('rehearsal is the identity', () => {
  it('returns the same blocks, in the same order, by reference', () => {
    const rehearsal = projectForPerformance(script.blocks, 'rehearsal');
    expect(rehearsal).toHaveLength(script.blocks.length);
    for (let i = 0; i < rehearsal.length; i++) expect(rehearsal[i]).toBe(script.blocks[i]);
  });
});

describe('what a take replaces', () => {
  const KINDS = ['image', 'table', 'code', 'diagram'] as const;
  /** The word each cue has to say, held apart from the labels themselves. */
  const NAMES: Record<(typeof KINDS)[number], string> = {
    image: 'IMAGE',
    table: 'TABLE',
    code: 'CODE',
    diagram: 'DIAGRAM',
  };

  const cueFor = (kind: CompiledBlock['kind']) => {
    const source = blockOfKind(script.blocks, kind);
    const projected = take.find((b) => b.id === source.id)!;
    return { source, projected };
  };

  it('replaces the four visual kinds with their cue', () => {
    for (const kind of KINDS) {
      const { projected } = cueFor(kind);
      expect(performanceCueKind(projected)).toBe(kind);
      expect(projected.kind).toBe('cue');
      expect(text(html(projected))).toContain(PERFORMANCE_CUE_LABELS[kind]);
    }
  });

  it('names the thing it replaced, and never one of the others', () => {
    /*
     * Reading the label back out of `PERFORMANCE_CUE_LABELS` — which the
     * assertion above does — proves it reached the glass but not that it is
     * the RIGHT one: swap two entries in that record and the check still
     * passes while the presenter is told a table is an image. The word is
     * asserted independently of the record for exactly that mutation.
     */
    for (const kind of KINDS) {
      const drawn = text(html(cueFor(kind).projected));
      expect(drawn, `${kind} cue does not name itself`).toContain(NAMES[kind]);
      for (const other of KINDS) {
        if (other !== kind) expect(drawn, `${kind} cue says ${other}`).not.toContain(NAMES[other]);
      }
    }
  });

  it('drops the asset the block no longer draws', () => {
    const { source, projected } = cueFor('image');
    expect(source.assetIds).toHaveLength(1);
    expect(projected.assetIds).toBeUndefined();
  });

  it('keeps the block id, so nothing anchored to it is orphaned', () => {
    const { source, projected } = cueFor('table');
    expect(projected.id).toBe(source.id);
    expect(projected.source).toEqual(source.source);
  });

  it('keeps an image the author marked as presenter reference', () => {
    const reference = blockOfKind(script.blocks, 'stage_only');
    expect(reference.layoutHints?.['innerKind']).toBe('image');
    const projected = take.find((b) => b.id === reference.id)!;
    expect(projected).toBe(reference);
  });

  it('keeps the words of a blockquote, which are usually spoken', () => {
    const quote = blockOfKind(script.blocks, 'blockquote');
    expect(quote.spoken).toBe(true);
    const projected = take.find((b) => b.id === quote.id)!;
    expect(text(html(projected))).toContain('The line I always quote');
  });

  it('renders a link as its label, with no link element left', () => {
    const paragraph = script.blocks.find((b) =>
      b.renderNodes.some((node) => node.type === 'link'),
    )!;
    const projected = take.find((b) => b.id === paragraph.id)!;
    expect(projected.renderNodes.some((node) => node.type === 'link')).toBe(false);
    expect(text(html(projected))).toContain('quarterly walkthrough');
    expect(html(projected)).not.toContain('class="link');
    // The label's text nodes come through by reference, which is what makes the
    // unwrap safe on a block that IS spoken.
    expect(anchoredSequence([projected])).toEqual(anchoredSequence([paragraph]));
  });

  it('reaches a link inside a table the author kept on the glass', () => {
    // A `:::stage` table survives the projection whole, which makes its cells
    // the only place the unwrap has to walk THROUGH a structure to find a
    // link — and the only place a walk that stops at the table would be wrong.
    const kept = script.blocks.find(
      (b) => b.kind === 'stage_only' && b.layoutHints?.['innerKind'] === 'table',
    );
    expect(kept, 'no stage-only table in the fixture').toBeDefined();
    expect(hasLink(kept!.renderNodes)).toBe(true);
    const projected = take.find((b) => b.id === kept!.id)!;
    expect(projected.kind).toBe('stage_only');
    expect(hasLink(projected.renderNodes)).toBe(false);
    expect(text(html(projected))).toContain('storyboard');
    expect(anchoredSequence([projected])).toEqual(anchoredSequence([kept!]));
    // And the rows have to be drawn somewhere a parser will leave them: an
    // open `<p>` is closed BEFORE a `<table>`, so the browser would rebuild
    // this block into a shape the stage never measured.
    expect(html(projected)).not.toMatch(/<p\b[^>]*>[\s\S]*?<table\b/);
  });
});

describe('the stage draws what the projection decided', () => {
  it('draws a cue chip rather than the card the block used to be', () => {
    const table = take.find((b) => performanceCueKind(b) === 'table')!;
    const markup = html(table);
    expect(markup).toContain('data-performance-cue="table"');
    expect(markup).not.toContain('<table');
    // The stage's own cue chip, not a shrunken card of its own invention.
    expect(markup).toContain(`data-cue-type="${PERFORMANCE_CUE_TYPE}"`);
  });

  it('still draws the projected cue when cues are hidden', () => {
    // Hiding cues turns off the author's asides. It must not delete the only
    // evidence the presenter has that a table exists.
    const table = take.find((b) => performanceCueKind(b) === 'table')!;
    expect(text(html(table, { showCues: false }))).toContain(PERFORMANCE_CUE_LABELS.table);
  });

  it('still hides an authored cue when cues are hidden', () => {
    const authored: CompiledBlock = {
      id: 'authored',
      kind: 'cue',
      renderNodes: [{ type: 'cue', cueType: 'beat', label: 'Beat' }],
      source: { utf16Start: 0, utf16End: 0 },
      spoken: false,
    };
    expect(text(html(authored, { showCues: false }))).toBe('');
    expect(text(html(authored))).toContain('Beat');
  });

  it('renders the rich block in rehearsal', () => {
    const rehearsal = projectForPerformance(script.blocks, 'rehearsal');
    const table = blockOfKind(rehearsal, 'table');
    const markup = html(table, { performanceMode: 'rehearsal' });
    expect(markup).toContain('<table');
    expect(text(markup)).toContain('Takes per video');
  });

  it('compacts an unspoken heading in a take and only in a take', () => {
    const heading = blockOfKind(take, 'heading');
    expect(heading.spoken).toBe(false);
    expect(html(heading)).toContain('compact');
    expect(html(heading, { performanceMode: 'rehearsal' })).not.toContain('compact');
  });

  it('leaves a spoken heading at reading size', () => {
    // `readHeadings` makes the heading a line the presenter says out loud, so
    // shrinking it would be shrinking body copy.
    const spokenHeadings = projectForPerformance(
      compiled({ readHeadings: true }).blocks,
      'take',
    );
    const heading = blockOfKind(spokenHeadings, 'heading');
    expect(heading.spoken).toBe(true);
    expect(html(heading)).not.toContain('compact');
  });
});

describe('the compact heading wins at every level', () => {
  /*
   * The `compact` class landing on the element is only half of it — the rule
   * still has to beat the level rule sitting next to it, and `:not()` carries
   * the specificity of its argument (Selectors L4), so the level-3-and-up rule
   * counts as a class plus two attributes. Against a bare `.heading.compact`
   * it wins, and the failure is silent and inverted: h3 to h6 keep display
   * size while h1 and h2 shrink, so a subheading comes out LARGER than the
   * section title above it. Markdown reaches level 6, so this is not a corner.
   *
   * Asserted against the stylesheet, like `secondary-text-floor.test.ts`: SSR
   * emits no styles and the node environment has no cascade to ask.
   */
  const css = readFileSync(
    fileURLToPath(new URL('../stage/renderer/BlockView.svelte', import.meta.url)),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  /** The class column of a selector's specificity: classes plus attribute
   *  selectors, counting the ones `:not()` wraps — which is the whole point. */
  function weight(selector: string): number {
    return (
      (selector.match(/\.[a-zA-Z][\w-]*/g) ?? []).length +
      (selector.match(/\[[^\]]*\]/g) ?? []).length
    );
  }

  const sizing = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1]!.trim(), body: m[2]!, at: m.index }))
    .filter((rule) => rule.selector.startsWith('.heading') && /font-size:/.test(rule.body));

  it('outranks every other rule that sizes a heading', () => {
    // Vacuous if the level rules ever move or are renamed, so pin the shape.
    expect(sizing.length).toBeGreaterThanOrEqual(4);
    const compact = sizing.find((rule) => rule.selector.includes('.compact'));
    expect(compact, 'no compact heading rule in BlockView').toBeDefined();
    for (const rule of sizing) {
      if (rule === compact) continue;
      const decided = weight(compact!.selector) - weight(rule.selector);
      expect(decided, `.compact is out-specified by ${rule.selector}`).toBeGreaterThanOrEqual(0);
      if (decided === 0) {
        expect(compact!.at, `.compact must sit below ${rule.selector}`).toBeGreaterThan(rule.at);
      }
    }
  });
});

describe('it is a projection, not a compile step', () => {
  it('does not mutate the blocks it was given', () => {
    const before = JSON.stringify(script.blocks);
    projectForPerformance(script.blocks, 'take');
    expect(JSON.stringify(script.blocks)).toBe(before);
  });

  it('is deterministic', () => {
    const again = projectForPerformance(script.blocks, 'take');
    expect(JSON.stringify(again)).toBe(JSON.stringify(take));
  });

  it('is stable under recompilation of the same source', () => {
    const other: CompiledScript = compiled();
    expect(JSON.stringify(projectForPerformance(other.blocks, 'take'))).toBe(JSON.stringify(take));
  });
});
