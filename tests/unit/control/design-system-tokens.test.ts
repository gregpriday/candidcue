/**
 * The design tokens, checked by arithmetic rather than by eye.
 *
 * Issue #126's complaint was not really "these two hex values are too light" —
 * it was that the design system is enforced by convention, so a value can drift
 * below AA and nothing says so. Pinning the hex strings would reproduce that
 * problem one layer down: the test would go green for the wrong reason the
 * moment a surface colour moved underneath the text sitting on it.
 *
 * So this computes WCAG 2.x relative luminance from whatever `tokens.css`
 * currently says, pairs every low-emphasis foreground with every opaque surface
 * of its own theme, and fails on the ratio. Change a surface and the test
 * re-derives; change a foreground and it re-derives; there is nothing to keep
 * in sync by hand.
 *
 * Only OPAQUE surfaces take part. The `-soft`/`-wash` fills are alpha over an
 * unknown backdrop, so a ratio against them would be a fiction.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TOKENS = readFileSync(
  fileURLToPath(new URL('../../../src/styles/tokens.css', import.meta.url)),
  'utf8',
);

/**
 * Everything a theme block declares, as `--name` → literal value.
 *
 * Matched WITH its opening brace: both selectors also appear in the file's
 * header comment, and finding that instead parses a block that does not exist.
 */
function themeBlock(selector: string): Map<string, string> {
  const start = TOKENS.indexOf(`${selector} {`);
  expect(start, `tokens.css must still declare ${selector}`).toBeGreaterThanOrEqual(0);
  const open = TOKENS.indexOf('{', start);
  const close = TOKENS.indexOf('\n}', open);
  const body = TOKENS.slice(open + 1, close);

  const declarations = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1]!, match[2]!.trim());
  }
  return declarations;
}

/** Follows one level of `var(--other)` indirection, which the danger tokens use. */
function resolve(block: Map<string, string>, name: string): string {
  const raw = block.get(name);
  expect(raw, `${name} must be declared`).toBeDefined();
  const alias = /^var\((--[\w-]+)\)$/.exec(raw!);
  return alias ? (block.get(alias[1]!) ?? raw!) : raw!;
}

function channel(eightBit: number): number {
  const c = eightBit / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  expect(m, `${hex} must be a 6-digit hex colour`).not.toBeNull();
  const n = parseInt(m![1]!, 16);
  return (
    0.2126 * channel((n >> 16) & 0xff) +
    0.7152 * channel((n >> 8) & 0xff) +
    0.0722 * channel(n & 0xff)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The opaque painted surfaces of a theme — the things text can land on. */
const SURFACE_TOKENS = [
  '--bg-app',
  '--bg-canvas',
  '--bg-chrome',
  '--bg-panel',
  '--bg-panel-header',
  '--bg-secondary',
  '--bg-elevated',
  '--bg-sunken',
  '--bg-hover',
  '--bg-hover-chrome',
  '--bg-hover-surface',
];

const THEMES = [
  { name: 'studio (dark)', selector: ":root,\n[data-theme='studio']" },
  { name: 'workspace (light)', selector: "[data-theme='workspace']" },
];

describe.each(THEMES)('$name tokens', ({ selector }) => {
  const block = themeBlock(selector);
  const surfaces = SURFACE_TOKENS.map((name) => ({ name, hex: resolve(block, name) }));

  // 1.4.3 Contrast (Minimum), AA: 4.5:1 for text below 18.66px bold / 24px.
  // Every one of these labels real information at --text-2xs..--text-sm.
  it.each(['--text-primary', '--text-secondary', '--text-muted', '--text-faint'])(
    '%s clears AA (4.5:1) on every opaque surface',
    (token) => {
      const hex = resolve(block, token);
      for (const surface of surfaces) {
        expect(
          contrast(hex, surface.hex),
          `${token} (${hex}) on ${surface.name} (${surface.hex})`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  /*
   * 1.4.11 Non-text Contrast, AA. The quiet focus edge IS the state signal for
   * every row, tile, input and editor in the product, so it owes 3:1 against
   * the surface it is drawn inside. This is the assertion that stops somebody
   * "simplifying" it back to --border-strong, which is 2.74:1 on the light
   * canvas and 1.86:1 on the dark elevated surface.
   */
  it('--focus-quiet carries 3:1 against every opaque surface', () => {
    const hex = resolve(block, '--focus-quiet');
    for (const surface of surfaces) {
      expect(
        contrast(hex, surface.hex),
        `--focus-quiet (${hex}) on ${surface.name} (${surface.hex})`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it('the filled danger button can be read at both its fill and its hover', () => {
    const label = resolve(block, '--danger-contrast');
    for (const fill of ['--danger', '--danger-strong']) {
      expect(
        contrast(label, resolve(block, fill)),
        `--danger-contrast (${label}) on ${fill} (${resolve(block, fill)})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps muted quieter than faint is loud — the steps stay in order', () => {
    // They converge (the workspace block explains why), but a later edit must
    // not invert them: muted is the stronger of the two on every surface.
    const muted = resolve(block, '--text-muted');
    const faint = resolve(block, '--text-faint');
    const surface = resolve(block, '--bg-panel');
    expect(contrast(muted, surface)).toBeGreaterThanOrEqual(contrast(faint, surface));
  });
});

describe('focus policy', () => {
  /*
   * The heart of #126: the accent ring must be OPT-IN. If a future edit makes
   * a bare `button` selector wear --focus-ring again, every row and tile built
   * from a raw button silently inherits the bug the policy exists to prevent —
   * and no visual test would catch it, because the screens that show it are the
   * ones nobody re-screenshots.
   */
  const policy = TOKENS.slice(TOKENS.indexOf('FOCUS POLICY'));

  it('gives unmarked buttons the quiet edge, not the accent ring', () => {
    expect(policy).toMatch(
      /button:not\(\[data-focus='control'\]\):not\(\[data-focus='delegate'\]\)[\s\S]*?outline: 2px solid var\(--focus-quiet\)/,
    );
  });

  it('reaches the accent ring only through an explicit opt-in', () => {
    const accentRule = /:where\(([^)]*(?:\([^)]*\)[^)]*)*)\):focus-visible\s*\{\s*outline: 2px solid var\(--focus-ring\)/.exec(
      policy,
    );
    expect(accentRule, 'the accent ring rule must still exist').not.toBeNull();
    expect(accentRule![1]).toContain("[data-focus='control']");
    // A bare `button` in the accent selector would re-open the hole.
    expect(accentRule![1]).not.toMatch(/(^|,)\s*button\s*(,|$)/);
  });

  it('lets a delegating child hand focus to its container', () => {
    expect(policy).toMatch(/\[data-focus='delegate'\][\s\S]*?outline: none/);
  });
});

describe('tokens that used to be spelled out by hand', () => {
  const read = (path: string): string =>
    readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

  it('the dialog scrim is a token, not a literal', () => {
    expect(read('src/control/components/Dialog.svelte')).toContain('background: var(--dialog-scrim)');
    expect(TOKENS).toMatch(/--dialog-scrim:\s*rgba\(/);
  });

  it("the toggle's lit knob uses the accent's own contrast colour", () => {
    const toggle = read('src/control/components/Toggle.svelte');
    // Literal white was only 2.63:1 on the dark theme's accent fill.
    expect(toggle).not.toMatch(/background:\s*#fff\b/);
    expect(toggle).toContain('background: var(--accent-contrast)');
  });

  it("the sidebar's hover lift uses the shared shadow", () => {
    const sidebar = read('src/control/components/Sidebar.svelte');
    expect(sidebar).not.toMatch(/box-shadow: 0 3px 10px rgba\(/);
    expect(sidebar).toContain('box-shadow: var(--shadow-hover)');
  });
});
