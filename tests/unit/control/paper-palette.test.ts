/**
 * The paper palette is frozen, and the surfaces that present use it.
 *
 * ---------------------------------------------------------------------------
 * WHY A FROZEN COPY
 * ---------------------------------------------------------------------------
 * Three surfaces that a presenter sees were drawn in the desk's light palette:
 * the take-controls drawer and the appearance sheet over a paper read, and the
 * syntax reference's "On the glass" specimen. They borrowed it by carrying
 * `data-theme="workspace"` — which meant that retuning the desk restyled them
 * too, and nothing would have said so. What is shown during a take must not
 * change because the desk did.
 *
 * So they carry `data-theme="paper"`, and `tokens.css` holds a paper block
 * that is the workspace block exactly as it stood before the desk moved to
 * porcelain, graphite and petrol.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PINS
 * ---------------------------------------------------------------------------
 * 1. The paper block declares every custom property the workspace block does,
 *    and nothing else. A token missing from paper would be inherited from
 *    whatever is around the frozen surface — the desk's value, under a desk
 *    dialog — and a token only paper declared would shadow one the surface
 *    used to inherit. A NEW desk token therefore needs a paper value too: the
 *    one the presentation surface should show, chosen on purpose. (An alias
 *    declared once on :root, like `--focus-ring`, resolves against the
 *    document's palette and is not the block's to give — see tokens.css.)
 *
 * 2. Every value, literally. Elsewhere pinning hex strings is the wrong test
 *    (`design-system-tokens.test.ts` says why): here the literal IS the
 *    contract, because the point of the block is that it does not move.
 *
 * 3. The three surfaces carry `paper`, in their markup and in the selectors
 *    keyed on it, and none of them names `workspace` any more. Whether the
 *    attribute is really there at run time is the DOM suite's to show for the
 *    sheet (`stage-appearance-sheet.test.ts`) and the browser suite's for the
 *    drawer (`reader-paper-theme.spec.ts`); this checks the source.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

/*
 * Comments stripped first, for the reason `design-system-tokens.test.ts`
 * gives: a commented-out declaration is invisible to the browser but not to a
 * regex, and the file's header comment names the theme selectors.
 */
const TOKENS = read('src/styles/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');

const WORKSPACE = "[data-theme='workspace']";
const PAPER = "[data-theme='paper']";

/** One theme block's body, matched WITH its opening brace. */
function blockBody(selector: string): string {
  const start = TOKENS.indexOf(`${selector} {`);
  expect(start, `tokens.css must declare ${selector}`).toBeGreaterThanOrEqual(0);
  const open = TOKENS.indexOf('{', start);
  return TOKENS.slice(open + 1, TOKENS.indexOf('\n}', open));
}

/** Everything a theme block declares, as `--name` → literal value. */
function themeBlock(selector: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const match of blockBody(selector).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1]!, match[2]!.trim());
  }
  return declarations;
}

/**
 * The workspace palette as it stood before the desk retune, verbatim.
 *
 * Do not edit a value here to follow tokens.css. If the paper block and this
 * disagree, the paper block is what changed, and every presentation surface
 * drawn on paper changed with it.
 */
const FROZEN: Record<string, string> = {
  '--bg-app': '#f6f4f0',
  '--bg-canvas': '#f6f4f0',
  '--bg-chrome': '#efebe5',
  '--bg-panel': '#ffffff',
  '--bg-panel-header': '#f3f0ea',
  '--bg-secondary': '#efebe5',
  '--bg-elevated': '#ffffff',
  '--bg-sunken': '#f1eee8',
  '--bg-hover': '#ece8e1',
  '--bg-hover-chrome': '#e8e3db',
  '--bg-hover-surface': '#f7f4ef',
  '--bg-selected': 'rgba(183, 94, 59, 0.1)',
  '--bg-toolbar': '#f1ede7',
  '--bg-statusbar': '#ece8e1',
  '--bg-hover-statusbar': '#e1dbd2',
  '--bg-active-statusbar': '#dcd5cb',
  '--bg-row-selected': 'rgba(24, 25, 29, 0.1)',
  '--bg-source-selected': 'rgba(24, 25, 29, 0.075)',
  '--bg-row-hover': 'rgba(24, 25, 29, 0.03)',
  '--bg-row-selected-quiet': 'rgba(24, 25, 29, 0.055)',
  '--bg-row-selected-quiet-hover': 'rgba(24, 25, 29, 0.07)',
  '--bg-row-selected-hover': 'rgba(24, 25, 29, 0.115)',
  '--bg-row-selected-inactive': '#e8e3db',
  '--divider': '#e2ded6',
  '--divider-hover': '#c7c1b6',
  '--text-primary': '#18191d',
  '--text-secondary': '#5d626c',
  '--text-muted': '#5f636c',
  '--text-faint': '#61656e',
  '--border': '#dedad3',
  '--border-control': '#c7c1b6',
  '--border-strong': '#99948c',
  '--border-state': '#857f76',
  '--border-faint': '#e7e3dc',
  '--border-seam': '#e7e3dc',
  '--accent': '#b35a38',
  '--accent-strong': '#9c4a2c',
  '--accent-contrast': '#ffffff',
  '--accent-soft': '#f6e7df',
  '--accent-wash': 'rgba(179, 90, 56, 0.05)',
  // The filled action: the desk's turned ink, and a paper surface's primary
  // buttons stay exactly the accent they were.
  '--action': '#b35a38',
  '--action-strong': '#9c4a2c',
  '--action-contrast': '#ffffff',
  '--focus': '#b35a38',
  '--focus-quiet': '#7b7771',
  '--success': '#1f6b52',
  '--success-soft': 'rgba(47, 125, 101, 0.12)',
  '--warning': '#7a5310',
  '--warning-soft': 'rgba(154, 103, 22, 0.12)',
  '--danger': '#a6342b',
  '--danger-strong': '#8e2922',
  '--danger-contrast': 'var(--accent-contrast)',
  '--danger-soft': 'rgba(185, 65, 56, 0.1)',
  '--highlight-edge': 'transparent',
  '--highlight-edge-strong': 'transparent',
  '--accent-gradient-top': 'var(--accent)',
  '--accent-gradient-bottom': 'var(--accent)',
  '--accent-glow': 'transparent',
  '--live': '#e05a4f',
  '--live-soft': 'rgba(224, 90, 79, 0.12)',
  '--live-glow': 'transparent',
  '--meter-low': '#2f9e76',
  '--meter-mid': '#c58a2e',
  '--meter-high': '#d2564b',
  '--shadow-panel': 'none',
  '--shadow-well': 'none',
  '--shadow-card': '0 1px 2px rgba(24, 25, 29, 0.06)',
  '--shadow-card-hover': '0 6px 16px rgba(24, 25, 29, 0.1)',
  '--shadow-transport': '0 -2px 12px rgba(24, 25, 29, 0.05)',
  '--shadow-pop': '0 12px 32px rgba(24, 25, 29, 0.16), 0 2px 8px rgba(24, 25, 29, 0.08)',
  '--shadow-hover': '0 4px 12px rgba(24, 25, 29, 0.09)',
  '--shadow-preview': '0 10px 28px rgba(24, 25, 29, 0.14), 0 2px 6px rgba(24, 25, 29, 0.06)',
  // Glass, added with the material (tokens.css, GLASS POLICY): not a desk
  // retune but presentation surfaces that became glass on purpose — the paper
  // drawer and the appearance sheet over a paper read. The thick fill is the
  // warm white the sheet was already frosted in, a point more opaque so its
  // text holds 4.5:1 over solid black. Frozen from here on.
  '--glass-tint': 'rgba(255, 255, 255, 0.9)',
  '--glass-tint-thick': 'rgba(252, 250, 246, 0.91)',
  '--glass-solid': '#ffffff',
  '--glass-rim': 'rgba(24, 25, 29, 0.1)',
  '--glass-edge': 'rgba(255, 255, 255, 0.65)',
  '--glass-shadow': '0 14px 36px rgba(24, 25, 29, 0.14), 0 2px 8px rgba(24, 25, 29, 0.06)',
  '--material-tint': 'rgba(246, 244, 240, 0.35)',
  '--material-hover': 'rgba(24, 25, 29, 0.05)',
  '--material-rule': 'rgba(24, 25, 29, 0.09)',
  '--empty-bg': '#faf1ec',
  '--empty-border': '#dedad3',
  '--empty-text': 'var(--text-secondary)',
  '--empty-text-muted': 'var(--text-muted)',
  '--empty-hover-bg': '#f6e7df',
  '--empty-hover-border': '#e6c8b6',
  '--prose-text-warm': '#2a2b30',
  '--prose-secondary-warm': '#4f535c',
  '--prose-muted-warm': '#6b707a',
  '--editor-selection': 'rgba(183, 94, 59, 0.2)',
  '--editor-selection-inactive': 'rgba(24, 25, 29, 0.1)',
  '--selection': 'rgba(183, 94, 59, 0.16)',
  '--find-match': 'rgba(214, 158, 46, 0.24)',
  '--find-match-edge': '#8f6514',
  '--selection-match': 'rgba(24, 25, 29, 0.07)',
};

describe('the paper palette', () => {
  const workspace = themeBlock(WORKSPACE);
  const paper = themeBlock(PAPER);

  it('declares exactly the custom properties the workspace block declares', () => {
    const missing = [...workspace.keys()].filter((name) => !paper.has(name));
    const extra = [...paper.keys()].filter((name) => !workspace.has(name));
    expect(missing, 'a frozen surface would inherit these from the desk').toEqual([]);
    expect(extra, 'these would shadow what a frozen surface used to inherit').toEqual([]);
    // Guard the guard: two empty blocks would agree perfectly.
    expect(paper.size).toBeGreaterThan(80);
  });

  it('holds every value the workspace block had before the desk retune', () => {
    expect(Object.fromEntries(paper)).toEqual(FROZEN);
  });

  it('is a light palette, declared after the desk so it reads as its own block', () => {
    expect(blockBody(PAPER)).toMatch(/color-scheme:\s*light;/);
    expect(TOKENS.indexOf(`${PAPER} {`)).toBeGreaterThan(TOKENS.indexOf(`${WORKSPACE} {`));
  });

  it('is declared once, so nothing later quietly overrides the frozen values', () => {
    // A second block under the same selector would win by source order, and
    // the checks above read only the first.
    for (const selector of [PAPER, WORKSPACE]) {
      expect(TOKENS.split(`${selector} {`).length - 1, `${selector} blocks`).toBe(1);
    }
  });
});

/**
 * The opening tag of the first element whose class list starts with
 * `className` (as a whole class, so `sheet` is not `sheet-head`), as written in
 * the markup: `{…}` expressions are skipped as units, so a `>` inside one does
 * not end the tag early.
 */
function openingTag(source: string, className: string): string {
  const at = source.search(new RegExp(`class="${className}[\\s"]`));
  expect(at, `no element with class "${className}"`).toBeGreaterThanOrEqual(0);
  const start = source.lastIndexOf('<', at);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated tag for class "${className}"`);
}

/** The `data-theme` attribute of one opening tag, exactly as written. */
function themeAttribute(tag: string): string {
  const attr = /data-theme=(?:"[^"]*"|'[^']*'|\{[^}]*\})/.exec(tag);
  expect(attr, `no data-theme on ${tag.split('\n')[0]}`).not.toBeNull();
  return attr![0];
}

/** The markup with its HTML comments removed, so a commented-out tag is not found. */
const markupOf = (source: string): string => source.replace(/<!--[\s\S]*?-->/g, '');

/** The component's style block with its comments removed. */
const stylesOf = (source: string): string =>
  source.slice(source.lastIndexOf('<style>')).replace(/\/\*[\s\S]*?\*\//g, '');

describe('the surfaces that present are drawn on paper', () => {
  const SURFACES = [
    {
      name: 'the take-controls drawer',
      path: 'src/control/routes/Live.svelte',
      root: 'take-controls',
      // Paper is the branch a paper read takes; every other take stays studio.
      attribute: "data-theme={paperTake ? 'paper' : undefined}",
      selector: ".take-controls[data-theme='paper']",
    },
    {
      name: 'the appearance sheet',
      path: 'src/control/components/StageAppearanceSheet.svelte',
      root: 'sheet',
      attribute: "data-theme={onPaper ? 'paper' : undefined}",
      selector: ".sheet[data-theme='paper']",
    },
    {
      name: 'the "On the glass" specimen',
      path: 'src/control/components/SyntaxSpecimen.svelte',
      root: 'specimen',
      attribute: 'data-theme="paper"',
      selector: null,
    },
  ];

  it.each(SURFACES)('$name carries the paper palette on its root', ({ path, root, attribute }) => {
    expect(themeAttribute(openingTag(markupOf(read(path)), root))).toBe(attribute);
  });

  it.each(SURFACES)('$name keys its own rules on paper, never on the desk', ({ path, selector }) => {
    const source = read(path);
    if (selector) expect(stylesOf(source)).toContain(selector);
    // Neither as a selector nor as an attribute value: a presentation surface
    // that names the desk's palette follows the desk.
    expect(source).not.toMatch(/data-theme=['"]workspace['"]/);
    expect(source).not.toMatch(/\[data-theme=['"]workspace['"]\]/);
    expect(source).not.toMatch(/data-theme=\{[^}]*['"]workspace['"][^}]*\}/);
  });
});
