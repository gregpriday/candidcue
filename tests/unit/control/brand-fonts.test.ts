/**
 * The bundled brand face, and the wall between it and the stage.
 *
 * `--font-brand` names a family; `brand-fonts.css` is the only thing that
 * provides it. The two degrade in silence when they drift — rename either one,
 * point a rule at a file that is not there, or let the build inline something
 * that is not a woff2, and the wordmark sets itself in system-ui with nothing
 * on screen to say so. That half mirrors what `font-hash.test.ts` does for the
 * stage face.
 *
 * The other half is the reason this face has a file of its own. The stage must
 * never wait on, inherit or fall back through the brand family, and the way
 * that stays true is the import graph: the control entry loads this file, and
 * nothing on the stage's side does. So the wiring is asserted at the source —
 * under `test.css: false` a CSS import evaluates to an empty module, and
 * importing the entry would prove nothing.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STYLES = new URL('../../../src/styles/', import.meta.url);

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

const BRAND_CSS_PATH = 'src/styles/brand-fonts.css';
const brandCss = read(BRAND_CSS_PATH);

/** Comments out, so prose can never satisfy (or trip) a check on code. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Every @font-face rule in a stylesheet, as source text. */
function faceRules(css: string): string[] {
  return code(css).match(/@font-face\s*\{[^}]*\}/g) ?? [];
}

/** One descriptor's value in a rule, or undefined. */
function descriptor(rule: string, name: string): string | undefined {
  return new RegExp(`(?:^|[\\s{;])${name}:\\s*([^;]+);`).exec(rule)?.[1]?.trim();
}

function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** Every `url(...)` a rule points at, exactly as written. */
function urlsIn(rule: string): string[] {
  return [...rule.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)].map((match) => match[2]!);
}

/** The first family `--font-brand` names in `tokens.css`, quotes stripped. */
function familyTheTokenAsksFor(): string {
  const value = /--font-brand:\s*([^;]+);/.exec(code(read('src/styles/tokens.css')))?.[1];
  expect(value).toBeDefined();
  return unquote(value!.split(',')[0]!);
}

/** Every file under a directory, repo-relative and spelled with `/`. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const path = `${dir}/${entry}`;
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

/** True when a source file imports `brand-fonts.css` (JS/TS import or CSS @import). */
function importsBrandFonts(text: string): boolean {
  const body = code(text);
  return (
    /\bimport\s*(?:\(\s*)?['"][^'"]*brand-fonts\.css['"]/.test(body) ||
    /@import\s+(?:url\(\s*)?['"]?[^'")\s]*brand-fonts\.css/.test(body) ||
    /<link\b[^>]*brand-fonts\.css/.test(body)
  );
}

/**
 * The two subsets vendored from `@fontsource-variable/archivo@5.3.0`, each with
 * the range that package declares for it. A rule dropped, or a range clipped,
 * leaves accented names to the fallback mid-word — the files stay in the
 * bundle and nothing else notices.
 */
const SUBSETS = new Map([
  [
    'archivo-latin-ext-wght-normal.woff2',
    'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,' +
      'U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,' +
      'U+2C60-2C7F,U+A720-A7FF',
  ],
  [
    'archivo-latin-wght-normal.woff2',
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,' +
      'U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  ],
]);

const basename = (path: string): string => path.split(/[\\/]/).pop()!;

const SOURCE_FILE = /\.(?:ts|js|mjs|svelte|css|html)$/;
const ENTRY_HTML = ['control.html', 'stage.html', 'identify.html', 'preferences.html'];

describe('the bundled brand face', () => {
  it('declares only the family --font-brand asks for, upright, across the whole weight axis', () => {
    // fontsource ships this family as 'Archivo Variable' — the near-miss that
    // would leave the token resolving past it into system-ui.
    expect(familyTheTokenAsksFor()).toBe('Archivo');
    const rules = faceRules(brandCss);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(unquote(descriptor(rule, 'font-family') ?? '')).toBe(familyTheTokenAsksFor());
      expect(descriptor(rule, 'font-weight')).toMatch(/^100\s+900$/);
      expect(descriptor(rule, 'font-style')).toBe('normal');
    }
  });

  it('registers exactly the vendored subsets, each over the range its file covers', () => {
    const declared = new Map(
      faceRules(brandCss).map((rule) => [
        basename(urlsIn(rule)[0] ?? ''),
        (descriptor(rule, 'unicode-range') ?? '').replace(/\s+/g, ''),
      ]),
    );
    expect(declared).toEqual(SUBSETS);
  });

  it('blocks on the face rather than re-setting the wordmark after a fallback paint', () => {
    for (const rule of faceRules(brandCss)) expect(descriptor(rule, 'font-display')).toBe('block');
  });

  it('points every rule at a distinct, real woff2 by a relative url', () => {
    const rules = faceRules(brandCss);
    const files: string[] = [];
    for (const rule of rules) {
      const urls = urlsIn(rule);
      expect(urls).toHaveLength(1);
      const url = urls[0]!;
      // Relative, because the repository gate resolves relative urls and skips
      // absolute ones — `/assets/...` would let a missing file through.
      expect(url).not.toMatch(/^(?:\/|[a-z]+:)/i);
      files.push(fileURLToPath(new URL(url, STYLES)));
    }
    expect(new Set(files).size).toBe(files.length);
    for (const file of files) {
      expect(existsSync(file)).toBe(true);
      // Read rather than stat: a zero-byte placeholder passes existence and
      // fails to render. `wOF2` rules out a woff (v1) or a renamed ttf.
      const bytes = readFileSync(file);
      expect(bytes.byteLength).toBeGreaterThan(1024);
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
  });

  it('keeps the asset record in the header true of the files it describes', () => {
    // "Unmodified" is a claim about bytes, so the header names each file's
    // size and digest and this holds it to them. Replacing a binary means
    // re-recording.
    for (const rule of faceRules(brandCss)) {
      const file = fileURLToPath(new URL(urlsIn(rule)[0]!, STYLES));
      const bytes = readFileSync(file);
      const name = basename(file).replace(/\./g, '\\.');
      const record = new RegExp(`${name}\\s+(\\d+) B\\s+sha256\\s+([0-9a-f]{64})`).exec(brandCss);
      expect(record, basename(file)).not.toBeNull();
      expect(Number(record![1])).toBe(bytes.byteLength);
      expect(record![2]).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });
});

describe('the wall between the brand face and the stage', () => {
  const importers = [
    ...walk('src').filter((path) => SOURCE_FILE.test(path)),
    ...ENTRY_HTML.filter((path) => existsSync(join(ROOT, path))),
  ].filter((path) => importsBrandFonts(read(path)));

  it('is loaded by the control entry', () => {
    expect(importsBrandFonts(read('src/control/main.ts'))).toBe(true);
  });

  it('is loaded by nothing else — not the stage, its stylesheets, or Settings', () => {
    expect(importers).toEqual(['src/control/main.ts']);
    for (const path of [
      'src/stage/main.ts',
      'src/styles/stage.css',
      'src/styles/fonts.css',
      'src/preferences/main.ts',
    ]) {
      expect(importsBrandFonts(read(path)), path).toBe(false);
    }
  });

  it('is named by nothing on the stage side, so nothing there can fall through it', () => {
    // A @font-face is only fetched when rendered text resolves to it (or a
    // script loads it by name). As long as no stage source names the token or
    // the family, the stage never starts an Archivo load of its own. This does
    // not cover the desk: in single-window presentation the two share one
    // `document.fonts`, which is why the stylesheet's header asks that nothing
    // rendered during a take name `--font-brand`. Tests are left out: they
    // render nothing, and one is entitled to name the family it is keeping out.
    const stageSide = [
      ...walk('src/stage').filter((path) => SOURCE_FILE.test(path) && !/\.test\.ts$/.test(path)),
      'src/styles/stage.css',
      'src/styles/fonts.css',
    ];
    for (const path of stageSide) {
      const body = code(read(path));
      expect(body.includes('--font-brand'), path).toBe(false);
      expect(/\bArchivo\b/.test(body), path).toBe(false);
    }
  });
});

describe('the font licence that ships beside the binaries', () => {
  const licence = read('assets/fonts/LICENSE.txt');

  it('carries both bundled faces’ copyright notices over one OFL text', () => {
    expect(licence).toContain(
      'Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors (https://github.com/googlefonts/atkinson-hyperlegible-next)',
    );
    expect(licence).toContain(
      'Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)',
    );
    expect(licence.match(/SIL OPEN FONT LICENSE Version 1\.1 - 26 February 2007/g)).toHaveLength(1);
  });

  it('names every bundled woff2 under the notice that covers it', () => {
    // A face added to the folder without a notice here is redistributed
    // without the copyright line the OFL requires to travel with it.
    const families = readdirSync(join(ROOT, 'assets/fonts'))
      .filter((name) => name.endsWith('.woff2'))
      .map((name) => name.replace(/-(?:latin|latin-ext|vietnamese)-.*$/, ''));
    for (const family of new Set(families)) expect(licence).toContain(`(${family}-*.woff2):`);
  });
});
