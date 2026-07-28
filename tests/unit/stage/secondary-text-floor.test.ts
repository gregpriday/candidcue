/**
 * The secondary-text floor on the presenter's glass.
 *
 * Everything on stage that is not body copy — take markers, cue chips, code,
 * tables, silent direction, the fallbacks that stand in for media — was sized
 * in fractions of an em chosen against a laptop at desk distance: 0.42em for a
 * take marker, 0.55em for a cue, 0.6em for a code block. Two metres away
 * through a beamsplitter those are shapes, not words, which makes them
 * decoration masquerading as information: the operator put them in the script
 * because the presenter needs them.
 *
 * So each of those rules is now `max(--stage-secondary-min, <proportion>)`.
 * The proportion is the typographic intent; `--stage-secondary-min` is the
 * absolute pixel size the script layer resolves from the rig's optics
 * (`secondaryTextFloorPx`), which is what stops the intent from putting text
 * under the angular size at which reading works — and, because `em` compounds,
 * stops a cue inside a silent block from being two multiplications below the
 * size anybody signed off on.
 *
 * Asserted against the stylesheets because that is where the rule lives: SSR
 * emits no styles, and jsdom has no cascade for `max()`. The rendered end of
 * this — that the layer sets the property at all — belongs to the script layer.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function styles(relative: string): string {
  const text = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  return text.slice(text.indexOf('<style>')).replace(/\/\*[\s\S]*?\*\//g, '');
}

const sheets = {
  BlockView: styles('../../../src/stage/renderer/BlockView.svelte'),
  InlineNodes: styles('../../../src/stage/renderer/InlineNodes.svelte'),
};

function ruleBody(sheet: string, selector: string): string {
  const at = sheet.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return sheet.slice(sheet.indexOf('{', at) + 1, sheet.indexOf('}', at));
}

function fontSize(sheet: string, selector: string): string {
  return /font-size:\s*([^;]+);/.exec(ruleBody(sheet, selector))?.[1]?.trim() ?? '';
}

/**
 * Every readable secondary element, with the proportion it must not fall below.
 * The numbers are what each element is worth relative to body text once you
 * accept that it has to be read from where the presenter is standing.
 */
const READABLE: { sheet: keyof typeof sheets; selector: string; atLeastEm: number }[] = [
  { sheet: 'BlockView', selector: '.cue-row', atLeastEm: 0.9 },
  { sheet: 'BlockView', selector: '.take-marker', atLeastEm: 0.67 },
  { sheet: 'BlockView', selector: '.unspoken', atLeastEm: 0.8 },
  { sheet: 'BlockView', selector: '.code', atLeastEm: 0.75 },
  { sheet: 'BlockView', selector: '.table-card', atLeastEm: 0.75 },
  { sheet: 'BlockView', selector: '.image-fallback', atLeastEm: 0.75 },
  { sheet: 'BlockView', selector: '.visual-fallback', atLeastEm: 0.75 },
  { sheet: 'InlineNodes', selector: '.cue', atLeastEm: 0.67 },
  { sheet: 'InlineNodes', selector: '.inline-table', atLeastEm: 0.67 },
  { sheet: 'InlineNodes', selector: '.m-code', atLeastEm: 0.67 },
];

describe('readable secondary text', () => {
  for (const { sheet, selector, atLeastEm } of READABLE) {
    it(`${selector} is floored and at least ${atLeastEm}em`, () => {
      const declared = fontSize(sheets[sheet], selector);
      const parsed = /^max\(var\(--stage-secondary-min,\s*[\d.]+em\),\s*([\d.]+)em\)$/.exec(
        declared,
      );
      expect(parsed, `${selector}: font-size is not a floored proportion (${declared})`).not.toBe(
        null,
      );
      expect(Number.parseFloat(parsed![1]!)).toBeGreaterThanOrEqual(atLeastEm);
    });
  }

  it('leaves no text on the glass below body size without a floor', () => {
    /*
     * The rule that survives the next person adding a component here. A bare
     * sub-em `font-size` is exactly how every one of the sizes above got there
     * — each one reasonable on its own, none of them checked against the
     * distance the text is read from.
     */
    for (const [name, sheet] of Object.entries(sheets)) {
      for (const declaration of sheet.matchAll(/font-size:\s*([^;]+);/g)) {
        const value = declaration[1]!.trim();
        if (/^[\d.]+em$/.test(value)) {
          // A size at or above body needs no floor: it cannot be the reason
          // something became unreadable.
          expect(
            Number.parseFloat(value),
            `${name}: unfloored font-size below body size (${value})`,
          ).toBeGreaterThanOrEqual(1);
        } else {
          expect(value, `${name}: font-size ignores the floor (${value})`).toContain(
            '--stage-secondary-min',
          );
        }
      }
    }
  });

  it('falls back to two thirds of body when the rig has resolved nothing', () => {
    // An uncalibrated stage still prompts (`resolveStageGeometry` is total), so
    // the fallback in every `var()` has to be a usable proportion rather than a
    // zero that would collapse the text.
    for (const sheet of Object.values(sheets)) {
      for (const use of sheet.matchAll(/var\(--stage-secondary-min,\s*([^)]+)\)/g)) {
        expect(use[1]!.trim()).toBe('0.67em');
      }
    }
  });

  it('does not drag decoration up with the text', () => {
    // The divider rule and the list bullet are drawn, not read. A floor on
    // either would grow a graphic to the size of a word for no reason.
    for (const selector of ['.divider', '.bullet']) {
      expect(ruleBody(sheets.BlockView, selector)).not.toContain('font-size');
    }
  });
});
