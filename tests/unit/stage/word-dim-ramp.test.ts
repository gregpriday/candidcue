/**
 * The four-word dimming ramp.
 *
 * The stage used to dim past words with a single hard step at the cursor, and
 * that step inherited the exact fault the cursor UNDERLINE was removed for: it
 * asserted a boundary the aligner cannot place to the word. One token of
 * ordinary error dropped a word to the far-past opacity while the presenter was
 * still saying it — a word going grey under your eye mid-sentence is worse than
 * no marking at all, because you stop to look at it.
 *
 * A ramp answers it without giving up the boundary: the same error now costs a
 * shade nobody notices, and the operator's own past opacity is only reached once
 * the reader is four words clear.
 *
 * These render the real component with `svelte/server`, which is where the
 * markup contract lives; the reactive half — that the ramp HOLDS while
 * alignment is not following — needs a mounted component and lives in
 * tests/dom/stage-dim-freeze.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import InlineNodes from '../../../src/stage/renderer/InlineNodes.svelte';
import BlockView from '../../../src/stage/renderer/BlockView.svelte';
import type { CompiledBlock, SafeRenderNode } from '../../../src/shared/contracts';

const source = readFileSync(
  fileURLToPath(new URL('../../../src/stage/renderer/InlineNodes.svelte', import.meta.url)),
  'utf8',
);

/** Eight words, tokens 0-7, so a mid-run cursor has a full ramp behind it. */
const nodes: SafeRenderNode[] = [
  {
    type: 'text',
    text: 'one two three four five six seven eight',
    tokenIndexes: [0, 1, 2, 3, 4, 5, 6, 7],
  },
];

function html(props: Record<string, unknown>): string {
  return render(InlineNodes, { props: { nodes, ...props } }).body;
}

function spanAt(markup: string, token: number): string {
  const match = new RegExp(`<span[^>]*data-t="${token}"`).exec(markup);
  if (!match) throw new Error(`no rendered span for token ${token}`);
  return match[0];
}

/** The ramp step drawn on `token`, or null where the stage makes no claim. */
function dimAt(markup: string, token: number): string | null {
  return /data-dim="([^"]*)"/.exec(spanAt(markup, token))?.[1] ?? null;
}

describe('the per-word dimming ramp', () => {
  const markup = html({ cursor: 5 });

  it('grades the four words behind the cursor', () => {
    expect(dimAt(markup, 4)).toBe('1');
    expect(dimAt(markup, 3)).toBe('2');
    expect(dimAt(markup, 2)).toBe('3');
    expect(dimAt(markup, 1)).toBe('4');
  });

  it('holds every earlier word at the deepest step', () => {
    // The ramp is a boundary treatment, not a gradient over the whole script:
    // once past it, spoken text is uniformly spoken.
    expect(dimAt(markup, 0)).toBe('4');
  });

  it('makes no claim at or after the cursor', () => {
    // Same rule as the underline that was removed: the word the presenter is
    // probably on must render identically to the ones they have not reached.
    expect(dimAt(markup, 5)).toBeNull();
    expect(dimAt(markup, 6)).toBeNull();
    const withoutAnchor = (token: number) => spanAt(markup, token).replace(/ data-t="\d+"/, '');
    expect(withoutAnchor(5)).toBe(withoutAnchor(6));
  });

  it('still marks every spoken word as past, whatever step it is on', () => {
    // `.past` is the far-past binding and the thing block zoning agrees with;
    // the ramp refines it and must never replace it.
    for (const token of [0, 1, 2, 3, 4]) {
      expect(spanAt(markup, token)).toContain('past');
    }
    expect(spanAt(markup, 5)).not.toContain('past');
  });

  it('dims nothing at all before there is a cursor', () => {
    const cold = html({ cursor: null });
    for (const token of [0, 3, 7]) {
      expect(dimAt(cold, token)).toBeNull();
      expect(spanAt(cold, token)).not.toContain('past');
    }
  });

  it('never writes a step no rule can match', () => {
    /*
     * `data-dim` is a key into the stylesheet, so a value off the ramp is not a
     * wrong shade — it is no shade at all, and the word drops straight through
     * to `.past`: the hard boundary the ramp exists to replace, reintroduced
     * silently. A cursor arriving as a fraction of a token is enough to do it.
     */
    const fractional = html({ cursor: 5.4 });
    for (const token of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const step = dimAt(fractional, token);
      expect(step === null || ['1', '2', '3', '4'].includes(step), `step ${step}`).toBe(true);
    }
  });

  it('marks nothing when the cursor is not a position at all', () => {
    // Non-finite arithmetic upstream must read as "nobody knows where the
    // reader is", which is the same answer as no cursor — not as a whole
    // paragraph quietly claimed as spoken.
    const broken = html({ cursor: Number.NaN });
    for (const token of [0, 4, 7]) {
      expect(dimAt(broken, token)).toBeNull();
      expect(spanAt(broken, token)).not.toContain('past');
    }
  });

  it('reaches the words through a block, which is what the stage renders', () => {
    const block: CompiledBlock = {
      id: 'b1',
      kind: 'paragraph',
      renderNodes: nodes,
      startTokenIndex: 0,
      endTokenIndex: 7,
      source: { utf16Start: 0, utf16End: 39 },
      spoken: true,
    };
    const viaBlock = render(BlockView, { props: { block, zone: 'current', cursor: 5 } }).body;
    expect(dimAt(viaBlock, 4)).toBe('1');
    expect(dimAt(viaBlock, 1)).toBe('4');
    expect(dimAt(viaBlock, 5)).toBeNull();
  });
});

describe('what the ramp is allowed to be worth', () => {
  const styles = source.slice(source.indexOf('<style>')).replace(/\/\*[\s\S]*?\*\//g, '');

  function opacityOf(selector: string): string {
    const at = styles.indexOf(`${selector} {`);
    expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
    const body = styles.slice(styles.indexOf('{', at) + 1, styles.indexOf('}', at));
    return /opacity:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? '';
  }

  /** The step's own value, as opposed to the floor it is clamped against. */
  function stepValue(step: string): number {
    const decl = opacityOf(`.w[data-dim='${step}']`);
    const own = new RegExp(`--stage-dim-${step},\\s*([\\d.]+)\\)`).exec(decl)?.[1];
    return Number.parseFloat(own ?? 'NaN');
  }

  it('lightens monotonically toward the cursor', () => {
    expect([stepValue('3'), stepValue('2'), stepValue('1')]).toEqual([0.52, 0.64, 0.78]);
  });

  it('gives the deepest step no rule of its own to drift on', () => {
    // The bottom of the ramp IS the far past, so it falls through to `.past`
    // rather than restating `pastOpacity` in a fourth place that a later edit
    // could move on its own.
    expect(opacityOf('.w.past')).toBe('var(--stage-past-opacity, 0.42)');
    expect(styles).not.toContain("data-dim='4'");
  });

  it('never dims a word further than the operator asked for', () => {
    /*
     * The load-bearing one. `pastOpacity` is not only a taste dial: switching
     * past dimming OFF is encoded as 0.92 (see `buildStageSettings`), so a
     * fixed ladder would have dimmed the four words behind the cursor while the
     * rest of the spoken script stayed bright — the display overruling a
     * setting the operator had gone and turned off. Every step is floored at
     * the setting instead.
     */
    for (const step of ['1', '2', '3']) {
      expect(opacityOf(`.w[data-dim='${step}']`)).toContain('max(var(--stage-past-opacity');
    }
  });

  it('keeps the steps in the stylesheet, not on the elements', () => {
    // An inline per-word opacity would put the ramp beyond the reach of the
    // custom properties the script layer sets — including the §61 degraded
    // rule, which turns every one of these tweens off with a single line.
    expect(source).not.toMatch(/style:opacity/);
    expect(source).not.toMatch(/style="opacity/);
  });
});
