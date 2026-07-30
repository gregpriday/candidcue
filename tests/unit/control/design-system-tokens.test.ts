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

const SOURCE = readFileSync(
  fileURLToPath(new URL('../../../src/styles/tokens.css', import.meta.url)),
  'utf8',
);

/*
 * Comments are stripped before anything else looks at the file.
 *
 * tokens.css is heavily commented — deliberately, since it is where the design
 * decisions are recorded — and a commented-out declaration is invisible to the
 * browser but not to a regex. Left in, a commented copy of a token sitting
 * beneath a failing live value would hand the parser the safe one, and the
 * whole suite would pass while the product failed AA. Stripping first also
 * stops the header comment's mention of the theme selectors from being mistaken
 * for the rules themselves.
 */
const TOKENS = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');

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

/*
 * Known answers for the maths itself, before it is trusted to judge anything.
 *
 * The first draft of this file linearised red and green but not blue, so every
 * ratio was wrong and a good many assertions still passed. A test whose own
 * arithmetic is unverified is not a guard, so these pin the formula against
 * hand-checkable values — including one that is ALL blue, which is exactly the
 * case that slipped through.
 */
describe('the contrast maths', () => {
  it('matches known relative luminances', () => {
    expect(luminance('#000000')).toBeCloseTo(0, 10);
    expect(luminance('#ffffff')).toBeCloseTo(1, 10);
    // Primaries, straight from the sRGB coefficients.
    expect(luminance('#ff0000')).toBeCloseTo(0.2126, 6);
    expect(luminance('#00ff00')).toBeCloseTo(0.7152, 6);
    expect(luminance('#0000ff')).toBeCloseTo(0.0722, 6);
    // Navy — a channel below the 0.03928 linear-segment threshold would still
    // land near here, so this also exercises the non-linear branch on blue.
    expect(luminance('#000080')).toBeCloseTo(0.0155851, 6);
  });

  it('matches known contrast ratios', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 6);
    expect(contrast('#000000', '#000000')).toBeCloseTo(1, 6);
    expect(contrast('#ffffff', '#000080')).toBeCloseTo(16.0097, 3);
    // Order must not matter — the ratio is symmetric.
    expect(contrast('#000080', '#ffffff')).toBeCloseTo(contrast('#ffffff', '#000080'), 10);
  });
});

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

  it('the filled danger button can be read at both its fill and its hover', () => {
    const label = resolve(block, '--danger-contrast');
    for (const fill of ['--danger', '--danger-strong']) {
      expect(
        contrast(label, resolve(block, fill)),
        `--danger-contrast (${label}) on ${fill} (${resolve(block, fill)})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the filled primary button can be read at both its fill and its hover', () => {
    const label = resolve(block, '--accent-contrast');
    for (const fill of ['--accent', '--accent-strong']) {
      expect(
        contrast(label, resolve(block, fill)),
        `--accent-contrast (${label}) on ${fill} (${resolve(block, fill)})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  /*
   * 1.4.11 Non-text Contrast, AA. Both focus treatments ARE the state signal
   * for the things that wear them, so each owes 3:1 against the surface it is
   * drawn against. For the quiet edge this is what stops somebody "simplifying"
   * it back to --border-strong, which is 2.74:1 on the light canvas and 1.86:1
   * on the dark elevated surface.
   *
   * The accent ring is included because nothing else checks it: the browser
   * test asserts a control's outline EQUALS --focus-ring, which stays true
   * however low-contrast that token becomes. (`--focus-ring` is an alias
   * declared once on :root; the per-theme value it resolves to is `--focus`.)
   */
  it('both focus treatments carry 3:1 against every opaque surface', () => {
    for (const token of ['--focus-quiet', '--focus']) {
      const hex = resolve(block, token);
      for (const surface of surfaces) {
        expect(
          contrast(hex, surface.hex),
          `${token} (${hex}) on ${surface.name} (${surface.hex})`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('the accent ring is still the themed focus colour', () => {
    // --focus-ring lives on :root and aliases --focus; if that indirection is
    // ever broken the assertion above would be checking a token nothing uses.
    expect(TOKENS).toMatch(/--focus-ring:\s*var\(--focus\)/);
  });

  /*
   * Keeps the inventory above honest. A surface added to tokens.css but not to
   * SURFACE_TOKENS is a surface nothing is ever checked against, and the
   * omission is invisible — every existing assertion goes on passing.
   */
  it('checks every opaque surface the theme declares', () => {
    const declared = [...block.keys()].filter(
      (name) => name.startsWith('--bg-') && /^#[0-9a-f]{6}$/i.test(resolve(block, name)),
    );
    expect([...declared].sort()).toEqual([...SURFACE_TOKENS].sort());
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
   * The heart of #126: the accent ring must be OPT-IN. If any rule anywhere in
   * this file gives a bare `button` the accent ring again, every row and tile
   * built from a raw button silently inherits the bug the policy exists to
   * prevent — and no visual test would catch it, because the screens that show
   * it are the ones nobody re-screenshots.
   *
   * So this enumerates EVERY top-level rule and inspects the ones that assign
   * --focus-ring, rather than pattern-matching the single rule that happens to
   * be correct today. Adding a second, unsafe rule beside a safe one has to
   * fail, and against a regex looking for the good rule it would not.
   */
  type Rule = { selectors: string[]; body: string };

  const rules: Rule[] = [...TOKENS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({
      selectors: m[1]!.split(',').map((s) => s.trim()).filter(Boolean),
      body: m[2]!,
    }))
    .filter((r) => r.selectors.length > 0);

  const assigning = (token: string): Rule[] =>
    rules.filter((r) => new RegExp(`outline:[^;]*var\\(${token}\\)`).test(r.body));

  /** Does this selector catch a plain <button> that carries no data-focus? */
  const catchesBareButton = (selector: string): boolean =>
    selector
      .replace(/^:where\(/, '')
      .replace(/\)?:focus-visible.*$/, '')
      .split(',')
      .map((s) => s.trim())
      .some((s) => s === 'button' || /^button(?!:not\(\[data-focus)/.test(s));

  it('never hands the accent ring to an unmarked button, in any rule', () => {
    const accentRules = assigning('--focus-ring');
    expect(accentRules.length, 'some rule must still draw the accent ring').toBeGreaterThan(0);

    for (const rule of accentRules) {
      for (const selector of rule.selectors) {
        // The range thumb is exempt: it is a pseudo-element on a control, not a
        // surface, and it is the part that actually moves.
        if (selector.includes('slider-thumb')) continue;
        expect(
          catchesBareButton(selector),
          `"${selector}" would give an unmarked button the accent ring`,
        ).toBe(false);
      }
    }
  });

  it('gives unmarked buttons the quiet edge', () => {
    const quiet = assigning('--focus-quiet');
    expect(
      quiet.some((r) => r.selectors.some((s) => s.includes("button:not([data-focus])"))),
      'no rule claims the unmarked button for the quiet treatment',
    ).toBe(true);
  });

  it('lets a delegating child hand focus to its container', () => {
    const delegate = rules.find(
      (r) =>
        r.selectors.some((s) => s.includes("[data-focus='delegate']")) &&
        /outline:\s*none/.test(r.body),
    );
    expect(delegate, 'a delegating child must draw nothing itself').toBeDefined();
  });

  /*
   * The three treatments must stay MUTUALLY EXCLUSIVE. They have equal
   * specificity, so an element matching two of them is resolved by source
   * order — a silent dependency on the order of a block whose comments invite
   * rearranging. Every native branch is therefore `:not([data-focus])`, and
   * this is the assertion that says so.
   */
  it('claims each element by its tag or its marker, never both', () => {
    const nativeBranch = /(^|,)\s*(button|input|textarea|select|a)\b/;
    for (const token of ['--focus-quiet', '--focus-ring']) {
      for (const rule of assigning(token)) {
        for (const selector of rule.selectors) {
          if (selector.includes('slider-thumb')) continue;
          for (const part of selector.replace(/^:where\(/, '').split(',')) {
            const branch = part.trim();
            if (!nativeBranch.test(branch)) continue;
            expect(
              branch.includes(':not([data-focus])'),
              `"${branch}" must exclude marked elements, or a marker and a tag both claim it`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

describe('the filled danger variant', () => {
  const button = readFileSync(
    fileURLToPath(new URL('../../../src/control/components/Button.svelte', import.meta.url)),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  /** The declarations of one rule, by exact selector. */
  const rule = (selector: string): string => {
    const match = new RegExp(`(^|\\})\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm').exec(
      button,
    );
    expect(match, `Button.svelte must still declare ${selector}`).not.toBeNull();
    return match![2]!;
  };

  /*
   * Asserted against the parsed RULE, not the file text: a `toContain` on the
   * whole file passes on a comment or a dead rule, and deleting the variant
   * outright would leave the class-name test in tests/dom/button.test.ts green
   * because the class is applied from a prop either way.
   */
  it('is filled, lipped and labelled from the danger tokens', () => {
    const filled = rule('.danger-primary');
    expect(filled).toMatch(/background:\s*var\(--danger\)/);
    expect(filled).toMatch(/border-color:\s*var\(--danger-strong\)/);
    expect(filled).toMatch(/color:\s*var\(--danger-contrast\)/);
    // The 15px hero label, same as .primary — that is what makes it read as the
    // action being asked about rather than a second Cancel.
    expect(filled).toMatch(/font-size:\s*var\(--text-base\)/);
  });

  /*
   * The plain danger variant must stay LOW emphasis. Filling it would put a
   * permanent red block next to the real primary on the Live transport, in
   * Settings' mic test and in the Library header — three screens with two
   * competing hero actions.
   */
  it('leaves the plain danger trigger transparent', () => {
    const trigger = rule('.danger');
    expect(trigger).toMatch(/background:\s*transparent/);
    expect(trigger).toMatch(/color:\s*var\(--danger\)/);
  });
});

describe('tokens that used to be spelled out by hand', () => {
  const read = (path: string): string =>
    readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );

  it('the dialog scrim is a token, and still a dark veil', () => {
    expect(read('src/control/components/Dialog.svelte')).toContain('background: var(--dialog-scrim)');
    const scrim = /--dialog-scrim:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(TOKENS);
    expect(scrim, '--dialog-scrim must be declared as an rgba veil').not.toBeNull();
    // It has to actually veil: a transparent or near-transparent value would
    // satisfy "is an rgba" while pushing nothing back.
    expect(Number(scrim![4])).toBeGreaterThan(0.2);
    // And it must be DARK in both themes — a light veil over the workspace
    // theme does not read as modality, which is why it is not var(--bg-app).
    expect(luminance(`#${[1, 2, 3].map((i) => Number(scrim![i]).toString(16).padStart(2, '0')).join('')}`)).toBeLessThan(0.05);
  });

  it("the toggle's lit knob uses the accent's own contrast colour", () => {
    const toggle = read('src/control/components/Toggle.svelte');
    // Literal white was only 2.63:1 on the dark theme's accent fill — under the
    // 3:1 a non-text indicator owes. Any spelling of white is the same bug.
    expect(toggle).not.toMatch(/background:\s*(#fff\b|#ffffff\b|white\b|rgb\(255,\s*255,\s*255\))/i);
    expect(toggle).toContain('background: var(--accent-contrast)');
  });

  it("the sidebar's hover lift uses the shared shadow", () => {
    const sidebar = read('src/control/components/Sidebar.svelte');
    expect(sidebar).not.toMatch(/box-shadow: 0 3px 10px rgba\(/);
    expect(sidebar).toContain('box-shadow: var(--shadow-hover)');
  });
});
