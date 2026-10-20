/**
 * The glass, checked by arithmetic rather than by eye.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CONTRAST FLOOR IS
 * ---------------------------------------------------------------------------
 * A glass fill has no single background: what is behind it is whatever the
 * menu, toast or drawer happens to float over, and that includes a script's
 * images — a screenshot or a diagram can be a field of solid white wider than
 * any blur, and a dark photo one of near black. So the check is against both
 * extremes: the fill composited over solid black and over solid white must
 * still carry every text colour that is drawn on glass at 4.5:1, the house
 * rule for every opaque surface (`design-system-tokens.test.ts`). The greys,
 * the danger red a destructive menu row is set in, and the strong accent of a
 * menu's check mark.
 *
 * What shows through a real window is checked on real pixels; this is the
 * floor that keeps a retune from quietly sliding the fills toward clear.
 *
 * ---------------------------------------------------------------------------
 * WHAT ELSE IT PINS
 * ---------------------------------------------------------------------------
 * - Every palette declares the whole material, so no surface inherits another
 *   palette's glass (the paper drawer must not wear the desk's).
 * - Components paint glass through the policy names (`--glass-fill`,
 *   `--glass-backdrop`), never the raw tints or optics — a component that read
 *   `--glass-tint` directly would stay translucent under Reduce Transparency.
 * - No literal blur anywhere: the optics live in tokens.css.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/* Comments stripped first, for the reason design-system-tokens.test.ts gives. */
const TOKENS = read('src/styles/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');

function blockAt(selector: string): Map<string, string> {
  const start = TOKENS.indexOf(selector);
  expect(start, `tokens.css must declare ${selector}`).toBeGreaterThanOrEqual(0);
  const open = TOKENS.indexOf('{', start);
  const body = TOKENS.slice(open + 1, TOKENS.indexOf('\n}', open));
  const declarations = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1]!, match[2]!.trim());
  }
  return declarations;
}

const STUDIO = blockAt(":root,\n[data-theme='studio'] {");
const WORKSPACE = blockAt("[data-theme='workspace'] {");
const PAPER = blockAt("[data-theme='paper'] {");
/* The dark desk declares only what it retunes; the rest is the light block's. */
const DARK_DESK = new Map([
  ...WORKSPACE,
  ...blockAt("[data-appearance='dark'] [data-theme='workspace'],"),
]);

const PALETTES = [
  { name: 'studio (a take)', block: STUDIO, dark: true },
  { name: 'the light desk', block: WORKSPACE, dark: false },
  { name: 'the dark desk', block: DARK_DESK, dark: true },
  { name: 'paper (a paper take)', block: PAPER, dark: false },
];

const MATERIAL = [
  '--glass-tint',
  '--glass-tint-thick',
  '--glass-solid',
  '--glass-rim',
  '--glass-edge',
  '--glass-shadow',
  '--material-tint',
  '--material-hover',
  '--material-rule',
];

/* Every colour text is set in on a glass surface: labels and descriptions in
   the greys, a destructive row in danger, a menu's check in the strong accent. */
const GLASS_TEXT = [
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--text-faint',
  '--danger',
  '--accent-strong',
];

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

function value(block: Map<string, string>, name: string): string {
  const raw = block.get(name);
  expect(raw, `${name} must be declared`).toBeDefined();
  const alias = /^var\((--[\w-]+)\)$/.exec(raw!);
  return alias ? value(block, alias[1]!) : raw!;
}

function hex(text: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(text.trim());
  expect(m, `${text} must be a 6-digit hex colour`).not.toBeNull();
  const n = parseInt(m![1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgba(text: string): Rgba {
  const m = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(text.trim());
  expect(m, `${text} must be an rgba() colour`).not.toBeNull();
  return [Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4])];
}

const over = ([r, g, b, a]: Rgba, under: Rgb): Rgb => [
  r * a + under[0] * (1 - a),
  g * a + under[1] * (1 - a),
  b * a + under[2] * (1 - a),
];

const mix = (a: Rgb, b: Rgb): Rgb => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

function channel(eightBit: number): number {
  const c = eightBit / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const luminance = ([r, g, b]: Rgb): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('the arithmetic', () => {
  it('composites and mixes as expected', () => {
    expect(over([255, 255, 255, 0.5], [0, 0, 0])).toEqual([127.5, 127.5, 127.5]);
    expect(mix([0, 0, 0], [255, 255, 255])).toEqual([127.5, 127.5, 127.5]);
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
  });
});

describe.each(PALETTES)('glass on $name', ({ block, dark }) => {
  it('declares the whole material', () => {
    for (const name of MATERIAL) expect(block.has(name), `${name}`).toBe(true);
  });

  it('falls back to an opaque surface', () => {
    hex(value(block, '--glass-solid'));
  });

  /*
   * The floor. Both weights, over both extremes, for every text colour glass
   * carries.
   */
  it.each(['--glass-tint', '--glass-tint-thick'])(
    '%s keeps every text colour on glass at 4.5:1 over solid black and solid white',
    (fill) => {
      for (const backdrop of [[0, 0, 0], [255, 255, 255]] as Rgb[]) {
        const surface = over(rgba(value(block, fill)), backdrop);
        for (const token of GLASS_TEXT) {
          const ratio = contrast(hex(value(block, token)), surface);
          expect(ratio, `${token} on ${fill} over rgb(${backdrop.join(', ')})`).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );

  it('is a fill, not a wash: the tints are mostly opaque', () => {
    // Below this a glass surface stops reading as a surface at all, whatever
    // the arithmetic above says about one backdrop.
    expect(rgba(value(block, '--glass-tint'))[3]).toBeGreaterThanOrEqual(0.75);
    expect(rgba(value(block, '--glass-tint-thick'))[3]).toBeGreaterThanOrEqual(0.75);
  });

  /*
   * The window's chrome on the system's own material: the sidebar and, under
   * the overlay titlebar, the toolbar band. Its backdrop is the system's
   * material over whatever is behind the window, which no token can know, so
   * the bound is measured: on macOS 26 the light sidebar material stayed
   * between 232 and 237 grey with solid black and solid white behind the
   * window, the dark one between 38 and 56 (Mica sits inside both). Checked
   * here past those — 224 and 64 — with the palette's tint laid over, for
   * every colour the rail and the toolbar set text in: the greys, a save
   * failure's danger and warning, and the accent of the current row's icon.
   */
  it("keeps the chrome's text legible over the system material at its least helpful", () => {
    const material: Rgb = dark ? [64, 64, 64] : [224, 224, 224];
    const chrome = over(rgba(value(block, '--material-tint')), material);
    for (const token of [...GLASS_TEXT, '--warning']) {
      expect(contrast(hex(value(block, token)), chrome), token).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('the glass policy', () => {
  it('turns every glass solid when the system asks for less transparency or more contrast', () => {
    for (const query of ['prefers-reduced-transparency: reduce', 'prefers-contrast: more']) {
      const at = TOKENS.indexOf(`@media (${query})`);
      expect(at, query).toBeGreaterThanOrEqual(0);
      const rule = TOKENS.slice(at, TOKENS.indexOf('\n}', at));
      expect(rule, query).toContain('--glass-fill: var(--glass-solid)');
      expect(rule, query).toContain('--glass-fill-thick: var(--glass-solid)');
      expect(rule, query).toContain('--glass-backdrop: none');
    }
  });

  it('resolves the fills on every palette root, not once on :root', () => {
    expect(TOKENS).toMatch(/:root,\s*\[data-theme\]\s*\{\s*--glass-fill: var\(--glass-tint\);/);
  });

  it('falls back to the opaque surface where nothing can be blurred', () => {
    const at = TOKENS.indexOf('@supports not ((backdrop-filter: blur(1px))');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(TOKENS.slice(at, TOKENS.indexOf('\n}', at))).toContain('--glass-fill: var(--glass-solid)');
  });
});

function svelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const path = join(dir, entry);
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...svelteFiles(path));
    else if (entry.endsWith('.svelte')) out.push(path);
  }
  return out;
}

describe('components draw glass through the policy', () => {
  const files = ['src/control', 'src/stage', 'src/preferences'].flatMap(svelteFiles);

  it('finds the components to check', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(files)('%s never reads the raw tints or optics', (path) => {
    const source = read(path);
    expect(source).not.toMatch(/var\(--glass-tint/);
    expect(source).not.toMatch(/var\(--glass-filter/);
  });

  it.each(files)('%s blurs only through the backdrop tokens', (path) => {
    const styles = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of styles.matchAll(/^\s*(?:-webkit-)?backdrop-filter:\s*([^;]+);/gm)) {
      expect(match[1]!.trim(), path).toMatch(/^(var\(--glass-backdrop(-thin|-thick)?\)|none)$/);
    }
  });
});
