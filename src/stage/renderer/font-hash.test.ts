/**
 * Two things are pinned here, because they are one thing.
 *
 * `fontHash` only earns its place in the layout fingerprint if it moves when
 * the face moves, and the face can only move because a stack names a family
 * that may or may not be there. So the same file covers the hash's behaviour
 * AND the bundle it is watching: that `fonts.css` declares exactly the family
 * `stageFontStack` asks for, that the woff2 files it points at exist, and that
 * the declarations are reachable from the module that hands out the stack. A
 * stack claiming a font nobody ships degrades in silence, which is precisely
 * the class of bug the hash exists to make loud — testing one without the other
 * would leave the loudest instance of it untested.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FONT_HASH_PROBES,
  FONT_HASH_UNAVAILABLE,
  fontHash,
  namedFamilies,
  resetFontHashContext,
  type FaceMeasurer,
  type FaceProbeRequest,
  type FamilyAvailability,
} from './font-hash';
import { FONT_METRICS_PROSE_SAMPLE } from './fontMetrics';
import { stageFontStack } from './text';

const STACK = "'Atkinson Hyperlegible Next', 'Atkinson Hyperlegible', Seravek, sans-serif";

/**
 * A face with known proportions, as fractions of the em so it scales with
 * whatever reference size the module picks. Bold is wider, which is how the
 * weight test tells two calls apart.
 *
 * `widthOf` and `ascentOf` move ONE probe and leave the rest alone. Every probe
 * in the set is there to catch a face the others miss, so each needs a test
 * that changes only what that probe sees — otherwise dropping it from the set
 * costs nothing and the probe is decoration.
 */
function fakeFace(
  options: {
    advance?: number;
    descender?: number;
    boldAdvance?: number;
    /** Width multiplier for individual probes, keyed by the probe string. */
    widthOf?: Record<string, number>;
    /** Ink height above the baseline per probe, as a fraction of the em. */
    ascentOf?: Record<string, number>;
  } = {},
): { measure: FaceMeasurer; calls: FaceProbeRequest[] } {
  const advance = options.advance ?? 0.5;
  const descender = options.descender ?? 0.21;
  const calls: FaceProbeRequest[] = [];
  const measure: FaceMeasurer = (request) => {
    calls.push(request);
    const em = request.fontSizePx;
    const perChar = request.fontWeight >= 600 ? (options.boldAdvance ?? advance) : advance;
    const widthScale = options.widthOf?.[request.text] ?? 1;
    return {
      widthPx: perChar * em * request.text.length * widthScale,
      ascentPx: (options.ascentOf?.[request.text] ?? 0.72) * em,
      descentPx: request.text === 'gjp' ? descender * em : 0,
    };
  };
  return { measure, calls };
}

const allPresent: FamilyAvailability = () => true;
const nonePresent: FamilyAvailability = () => false;

/** The hash of a face with the given proportions, every family present. */
function hashOf(options: Parameters<typeof fakeFace>[0] = {}, fontWeight?: number): string {
  return fontHash(STACK, { measure: fakeFace(options).measure, available: allPresent, fontWeight });
}

beforeEach(() => {
  resetFontHashContext();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetFontHashContext();
});

/**
 * A `document` just real enough to be wrong in the ways a browser is.
 *
 * The default measurer and the default availability check are otherwise
 * unreachable from a node runner, and they are where the platform-shaped
 * mistakes live: a 2D context silently ignores a font shorthand it cannot
 * parse and keeps answering about the previous face, which is how one font's
 * metrics get reported under another's name. So the fake honours that rule
 * rather than accepting every assignment.
 */
function fakeDocument(options: {
  advance: number;
  available: boolean | 'throws';
  /** False models an engine older than `actualBoundingBox*`, which omits them. */
  inkMetrics?: boolean;
}) {
  let current = '';
  const ctx = {
    set font(value: string) {
      // The browser's rule: parse or leave the previous value in force. An
      // unbalanced quote in the family list is the parse failure a settings
      // document can actually produce, so the fake fails on it too.
      const quotes = (value.match(/['"]/g) ?? []).length;
      if (/^(\d+\s+)?\d+px\s+\S/.test(value) && quotes % 2 === 0) current = value;
    },
    get font() {
      return current;
    },
    textBaseline: 'alphabetic',
    measureText(text: string) {
      const em = Number(/(\d+)px/.exec(current)?.[1] ?? 10);
      const width = text.length * options.advance * em;
      if (options.inkMetrics === false) return { width };
      return {
        width,
        actualBoundingBoxAscent: 0.72 * em,
        actualBoundingBoxDescent: text === 'gjp' ? 0.21 * em : 0,
      };
    },
  };
  return {
    createElement: () => ({ getContext: () => ctx }),
    fonts: {
      check() {
        if (options.available === 'throws') throw new Error('not implemented');
        return options.available;
      },
    },
  };
}

describe('fontHash with no platform to ask', () => {
  it('returns the constant sentinel under a node runner', () => {
    // No `document`, so neither channel can answer. This is also the SSR case.
    expect(fontHash(STACK)).toBe(FONT_HASH_UNAVAILABLE);
  });

  it('returns the same sentinel on every call', () => {
    // A value that varied per call would report a font swap on every rebuild
    // and turn every coverage-only rebuild into a full semantic re-anchor.
    expect(fontHash(STACK)).toBe(fontHash(STACK));
    expect(fontHash(stageFontStack('system-sans'))).toBe(FONT_HASH_UNAVAILABLE);
  });

  it('treats an empty or non-string stack as nothing known', () => {
    expect(fontHash('')).toBe(FONT_HASH_UNAVAILABLE);
    expect(fontHash('   ')).toBe(FONT_HASH_UNAVAILABLE);
    expect(fontHash(undefined as unknown as string)).toBe(FONT_HASH_UNAVAILABLE);
  });
});

describe('fontHash stability', () => {
  it('is equal across calls in an unchanged environment', () => {
    const a = fontHash(STACK, { measure: fakeFace().measure, available: allPresent });
    const b = fontHash(STACK, { measure: fakeFace().measure, available: allPresent });
    expect(a).toBe(b);
    expect(a).not.toBe(FONT_HASH_UNAVAILABLE);
  });

  it('measures every probe at the requested weight', () => {
    const { measure, calls } = fakeFace();
    fontHash(STACK, { measure, available: allPresent, fontWeight: 620 });
    expect(calls.map((call) => call.text)).toEqual([...FONT_HASH_PROBES]);
    expect(calls.every((call) => call.fontWeight === 620)).toBe(true);
    expect(calls.every((call) => call.fontStack === STACK)).toBe(true);
  });
});

describe('fontHash discrimination', () => {
  it('moves when the resolved face has different advances', () => {
    expect(hashOf({ advance: 0.5 })).not.toBe(hashOf({ advance: 0.47 }));
  });

  it('moves when two faces differ by a thousandth of a pixel', () => {
    // Far too small to move a line break, and still evidence the face changed.
    // At the 200px reference this is a single unit of the last recorded decimal
    // — rounding the readings any coarser calls these two the same font.
    expect(hashOf({ advance: 0.5 })).not.toBe(hashOf({ advance: 0.500005 }));
  });

  it('moves when only the confusables differ', () => {
    // The case the whole high-legibility choice is about: a face that spends
    // width separating I, l and 1 against one that does not. Everything else
    // about these two faces measures identically.
    expect(hashOf({ widthOf: { Il1: 1.3 } })).not.toBe(hashOf({}));
  });

  it('moves when only the descender differs', () => {
    // Ascent-only fingerprints call a single-storey and a double-storey g the
    // same font; the descent probe is why this one does not.
    expect(hashOf({ descender: 0.24 })).not.toBe(hashOf({ descender: 0.19 }));
  });

  it('moves when only the cap height differs', () => {
    // Two faces at one advance and two cap heights is the ordinary shape of a
    // fallback standing in for a bundled face, and the ink height is the only
    // channel that sees it. Width-only readings hash them alike.
    expect(hashOf({ ascentOf: { H: 0.7 } })).not.toBe(hashOf({}));
  });

  it('moves when only the x-height differs', () => {
    // Equal caps, different x-height: where a humanist and a grotesque part
    // company, and invisible to every other probe in the set.
    expect(hashOf({ ascentOf: { x: 0.5 } })).not.toBe(hashOf({ ascentOf: { x: 0.53 } }));
  });

  it('moves when only the zero differs', () => {
    // Slashed, dotted or bare: the digit that most often differs while the
    // letters match, which is why it is probed on its own.
    expect(hashOf({ widthOf: { '0': 1.08 } })).not.toBe(hashOf({}));
  });

  it('moves when only the shaped prose differs', () => {
    // Kerning and shaping live in the whole-sentence probe and nowhere else: a
    // face with identical single-glyph advances and different pair kerning
    // re-wraps every line, and only this reading notices. The sample is the one
    // `fontMetrics.ts` averages over, so the two modules read the same thing.
    expect(FONT_HASH_PROBES).toContain(FONT_METRICS_PROSE_SAMPLE);
    expect(hashOf({ widthOf: { [FONT_METRICS_PROSE_SAMPLE]: 1.01 } })).not.toBe(hashOf({}));
  });

  it('separates two stacks that name different families', () => {
    // Not merely different NUMBERS of families: a record that carried only the
    // yes/no answers made every three-family stack the same three bits, so the
    // serif and humanist stacks were one value on any platform where the
    // measurement is the channel that cannot answer.
    const blind: FaceMeasurer = () => null;
    const opts = { measure: blind, available: allPresent };
    expect(fontHash(stageFontStack('serif'), opts)).not.toBe(
      fontHash(stageFontStack('humanist-sans'), opts),
    );
    expect(fontHash("'Alpha One', 'Beta Two'", opts)).not.toBe(
      fontHash("'Gamma Three', 'Delta Four'", opts),
    );
  });

  it('moves when a variable face is rendered at a different weight', () => {
    // The bundled face is variable over 200-800, so these are two fonts.
    const face = { advance: 0.5, boldAdvance: 0.56 };
    expect(hashOf(face, 400)).not.toBe(hashOf(face, 700));
  });

  it('moves when the bundled family lands, even if the measurement cannot tell', () => {
    /*
     * The event this unit was built for: a woff2 that resolves after the stage
     * has already drawn a fallback. `measure` is held identical here on purpose
     * — if the availability record were not in the hash, these two would be the
     * same value and the relayout would be classified coverage-only.
     */
    const before = fontHash(STACK, { measure: fakeFace().measure, available: nonePresent });
    const after = fontHash(STACK, { measure: fakeFace().measure, available: allPresent });
    expect(before).not.toBe(after);
  });

  it('moves when one family in the cascade changes availability', () => {
    const first: FamilyAvailability = (family) => family.includes('Next');
    const second: FamilyAvailability = (family) => !family.includes('Next');
    expect(fontHash(STACK, { measure: fakeFace().measure, available: first })).not.toBe(
      fontHash(STACK, { measure: fakeFace().measure, available: second }),
    );
  });

  it('separates a stack whose families differ', () => {
    const measure = fakeFace().measure;
    const opts = { measure, available: allPresent };
    const highLegibility = fontHash(stageFontStack('high-legibility'), opts);
    const humanist = fontHash(stageFontStack('humanist-sans'), opts);
    // Same fake face for both, so the only thing that can separate them is the
    // set of families asked about — which is what the stage actually changes
    // when the operator picks a different font.
    expect(highLegibility).not.toBe(humanist);
  });
});

describe('fontHash provenance', () => {
  it('tags an availability-only answer apart from a measured one', () => {
    const unmeasurable: FaceMeasurer = () => null;
    const blind = fontHash(STACK, { measure: unmeasurable, available: allPresent });
    const measured = fontHash(STACK, { measure: fakeFace().measure, available: allPresent });

    expect(blind).not.toBe(FONT_HASH_UNAVAILABLE);
    expect(blind.startsWith('face:u:')).toBe(true);
    expect(measured.startsWith('face:m:')).toBe(true);
    // "these families exist" and "this is the face" must never collide: the
    // first is a much weaker claim and downstream treats them identically.
    expect(blind).not.toBe(measured);
  });

  it('falls back to the sentinel when neither channel answers', () => {
    const unmeasurable: FaceMeasurer = () => null;
    const unknown: FamilyAvailability = () => null;
    expect(fontHash(STACK, { measure: unmeasurable, available: unknown })).toBe(
      FONT_HASH_UNAVAILABLE,
    );
  });

  it('refuses a partial measurement rather than hashing a shorter one', () => {
    // A probe set that silently shrinks reads downstream as a font swap. All or
    // nothing: one failed probe demotes the whole answer to availability-only.
    const partial: FaceMeasurer = (request) =>
      request.text === 'Il1' ? null : { widthPx: 10, ascentPx: 5, descentPx: 1 };
    expect(fontHash(STACK, { measure: partial, available: allPresent }).startsWith('face:u:')).toBe(
      true,
    );
  });
});

describe('fontHash against a real platform', () => {
  it('measures through the canvas when one exists, with no seams injected', () => {
    vi.stubGlobal('document', fakeDocument({ advance: 0.5, available: true }));
    resetFontHashContext();

    const hash = fontHash(STACK, { fontWeight: 500 });
    expect(hash).not.toBe(FONT_HASH_UNAVAILABLE);
    expect(hash.startsWith('face:m:')).toBe(true);
    expect(fontHash(STACK, { fontWeight: 500 })).toBe(hash);
  });

  it('separates two faces the default path resolves differently', () => {
    vi.stubGlobal('document', fakeDocument({ advance: 0.5, available: true }));
    resetFontHashContext();
    const wide = fontHash(STACK);

    vi.stubGlobal('document', fakeDocument({ advance: 0.46, available: true }));
    resetFontHashContext();
    expect(fontHash(STACK)).not.toBe(wide);
  });

  it('survives a FontFaceSet that refuses to answer', () => {
    // jsdom throws "not implemented" for the whole FontFaceSet, and a browser
    // throws on a shorthand it cannot parse. Neither is a reason to give up the
    // measurement, which is the stronger of the two signals anyway.
    vi.stubGlobal('document', fakeDocument({ advance: 0.5, available: 'throws' }));
    resetFontHashContext();

    const hash = fontHash(STACK);
    expect(hash.startsWith('face:m:')).toBe(true);
  });

  it('never reports the sentinel font under a family it could not parse', () => {
    /*
     * The failure the whole canvas measurer is built around: assigning an
     * unparseable shorthand is a silent no-op, so `measureText` keeps answering
     * about the previous face. Unchecked, this returns the 10px monospace
     * sentinel's proportions wearing a `face:m:` tag — one font's metrics
     * reported under another's name, which is exactly what this module exists
     * to detect rather than commit.
     */
    vi.stubGlobal('document', fakeDocument({ advance: 0.5, available: true }));
    resetFontHashContext();

    const unquotable = fontHash("Helvetica' Neue", { fontWeight: 500 });
    expect(unquotable.startsWith('face:u:')).toBe(true);
  });

  it('refuses a measurement from an engine with no ink metrics', () => {
    // `actualBoundingBox*` is undefined on engines that predate it. Reading
    // that as zero measures a font with no cap height and no descender and
    // calls it a reading.
    vi.stubGlobal('document', fakeDocument({ advance: 0.5, available: true, inkMetrics: false }));
    resetFontHashContext();
    expect(fontHash(STACK).startsWith('face:u:')).toBe(true);
  });

  it('reports nothing known when the platform has no canvas at all', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
    resetFontHashContext();
    expect(fontHash(STACK)).toBe(FONT_HASH_UNAVAILABLE);
  });
});

describe('namedFamilies', () => {
  it('keeps the named faces in cascade order and drops the generics', () => {
    expect(namedFamilies(STACK)).toEqual([
      "'Atkinson Hyperlegible Next'",
      "'Atkinson Hyperlegible'",
      'Seravek',
    ]);
  });

  it('drops every generic the stage stacks actually use', () => {
    // `system-ui` and `ui-monospace` are always available, so asking about them
    // adds a constant to the record and no signal.
    expect(namedFamilies(stageFontStack('system-sans'))).not.toContain('system-ui');
    expect(namedFamilies(stageFontStack('monospace'))).not.toContain('ui-monospace');
    expect(namedFamilies('serif')).toEqual([]);
    expect(namedFamilies(undefined as unknown as string)).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * The bundle the hash is watching
 * ------------------------------------------------------------------------- */

const FONTS_CSS_PATH = fileURLToPath(new URL('../../styles/fonts.css', import.meta.url));
const TEXT_TS_PATH = fileURLToPath(new URL('./text.ts', import.meta.url));
const fontsCss = readFileSync(FONTS_CSS_PATH, 'utf8');

/** Every @font-face rule in a stylesheet, as source text. */
function faceRules(css: string): string[] {
  return css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
}

/** Every `font-family:` value declared by an @font-face rule, unquoted. */
function declaredFaces(css: string): string[] {
  const families: string[] = [];
  for (const rule of faceRules(css)) {
    const match = /font-family:\s*(['"]?)([^;'"]+)\1\s*;/.exec(rule);
    if (match?.[2]) families.push(match[2].trim());
  }
  return families;
}

/** The first named family of the high-legibility stack, quotes stripped. */
function familyTheStackAsksFor(): string {
  const wanted = namedFamilies(stageFontStack('high-legibility'))[0];
  expect(wanted).toBeDefined();
  return wanted!.replace(/^['"]|['"]$/g, '');
}

/** Every `url(...)` an @font-face rule points at, as a repo path. */
function declaredSources(css: string): string[] {
  const urls = css.match(/url\((['"]?)([^)'"]+)\1\)/g) ?? [];
  return urls.map((raw) => {
    const inner = /url\((['"]?)([^)'"]+)\1\)/.exec(raw)?.[2] ?? '';
    return fileURLToPath(new URL(inner, new URL('../../styles/', import.meta.url)));
  });
}

describe('the bundled high-legibility face', () => {
  it('declares the family the stack asks for, spelled identically', () => {
    /*
     * The failure this catches is invisible on the glass: rename the family in
     * either file and the stage keeps rendering, in the fallback, with nothing
     * to show the operator that the face they chose is not the face they got.
     * (fontsource ships this family as 'Atkinson Hyperlegible Next Variable',
     * which is exactly the kind of near-miss meant here.)
     */
    // Every rule under one family, too: a subset declared under a near-miss
    // name is dead weight the stack never reaches, and reads as bundled.
    expect(new Set(declaredFaces(fontsCss))).toEqual(new Set([familyTheStackAsksFor()]));
  });

  it('points every declaration at a font file that is actually in the repo', () => {
    const sources = declaredSources(fontsCss);
    expect(sources.length).toBe(faceRules(fontsCss).length);
    // Distinct files: two rules sharing one binary is how an italic rule ends
    // up serving the upright, which is a synthesised oblique by a longer route.
    expect(new Set(sources).size).toBe(sources.length);
    for (const source of sources) {
      // Read rather than stat: a zero-byte placeholder passes existence and
      // fails to render, which is the same silent degradation by another route.
      const bytes = readFileSync(source);
      expect(bytes.byteLength).toBeGreaterThan(1024);
      // `wOF2`. A woff (v1) or a raw ttf renamed to .woff2 is rejected by every
      // engine that would then quietly use the fallback.
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
  });

  it('covers the whole weight range the optical resolver can ask for', () => {
    // `optical-resolve.ts` clamps fontWeight to 300-800; a static instance or a
    // narrower axis would snap the operator's weight without saying so.
    const ranges = fontsCss.match(/font-weight:\s*(\d+)\s+(\d+)\s*;/g) ?? [];
    expect(ranges.length).toBe(declaredFaces(fontsCss).length);
    for (const range of ranges) {
      const [, low, high] = /font-weight:\s*(\d+)\s+(\d+)/.exec(range)!;
      expect(Number(low)).toBeLessThanOrEqual(300);
      expect(Number(high)).toBeGreaterThanOrEqual(800);
    }
  });

  it('declares an italic of that family, because emphasis renders italic', () => {
    // A synthesised oblique is a shear with different advances, which would make
    // markdown emphasis a layout input that no measurement predicts. An italic
    // declared under some other family is the same miss by a longer route.
    const italics = faceRules(fontsCss).filter((rule) => /font-style:\s*italic\s*;/.test(rule));
    expect(italics.length).toBeGreaterThan(0);
    for (const rule of italics) expect(declaredFaces(rule)).toEqual([familyTheStackAsksFor()]);
  });

  it('blocks on the face rather than painting the fallback first', () => {
    /*
     * `swap` paints the fallback and then re-wraps every line under the
     * presenter mid-take — the reflow the layout fingerprint has to chase, and
     * the one this whole unit exists to keep out of a take. The files are
     * local, so blocking costs a frame or two and a genuine load failure errors
     * immediately rather than waiting the period out.
     */
    const displays = fontsCss.match(/font-display:\s*([a-z-]+)\s*;/g) ?? [];
    expect(displays.length).toBe(faceRules(fontsCss).length);
    for (const declaration of displays) expect(declaration).toContain('block');
  });

  it('reaches the app through the module that hands out the stack', () => {
    /*
     * The wiring, asserted at the source rather than the module graph: under
     * `test.css: false` a CSS import evaluates to an empty module, so importing
     * `text.ts` here would prove nothing. This is the edge that matters — every
     * surface that renders the stage font goes through `stageFontStack`, so as
     * long as its module pulls in the declarations, no entry point can pick up
     * the stack and miss the face.
     */
    expect(readFileSync(TEXT_TS_PATH, 'utf8')).toContain("import '../../styles/fonts.css';");
  });
});
