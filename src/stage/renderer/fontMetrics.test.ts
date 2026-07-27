import { describe, it, expect, beforeEach } from 'vitest';
import {
  FONT_METRICS_PROSE_SAMPLE,
  clearFontMetricsCache,
  measureFontMetrics,
  type FontMeasureRequest,
  type FontMeasurer,
  type GlyphMeasurement,
} from './fontMetrics';
import { fallbackFontMetrics } from '../../shared/optics';
import { stageFontStack } from './text';

const STACK = "Seravek, 'Segoe UI', sans-serif";

/**
 * A face with known proportions, expressed as fractions of the em so the
 * measurer scales with whatever reference size the module chooses. Bold is
 * wider, which is how the weight-keying test tells the two apart.
 */
function fakeFace(options: {
  cap?: number;
  ex?: number;
  zero?: number;
  advance?: number;
  boldAdvance?: number;
}): { measure: FontMeasurer; calls: FontMeasureRequest[] } {
  const cap = options.cap ?? 0.72;
  const ex = options.ex ?? 0.51;
  const zero = options.zero ?? 0.58;
  const advance = options.advance ?? 0.49;
  const calls: FontMeasureRequest[] = [];
  const measure: FontMeasurer = (request) => {
    calls.push(request);
    const em = request.fontSizePx;
    const perChar = request.fontWeight >= 600 ? (options.boldAdvance ?? advance) : advance;
    if (request.text === 'H') return { ascentPx: cap * em, widthPx: cap * em };
    if (request.text === 'x') return { ascentPx: ex * em, widthPx: perChar * em };
    if (request.text === '0') return { ascentPx: cap * em, widthPx: zero * em };
    return { ascentPx: cap * em, widthPx: perChar * em * request.text.length };
  };
  return { measure, calls };
}

beforeEach(() => {
  clearFontMetricsCache();
});

describe('measureFontMetrics ratios', () => {
  it('reports each measurement as a fraction of the em', () => {
    const { measure } = fakeFace({ cap: 0.72, ex: 0.51, zero: 0.58, advance: 0.49 });
    const metrics = measureFontMetrics(STACK, { measure });

    expect(metrics.measured).toBe(true);
    expect(metrics.capHeightRatio).toBeCloseTo(0.72, 6);
    expect(metrics.xHeightRatio).toBeCloseTo(0.51, 6);
    expect(metrics.zeroAdvanceRatio).toBeCloseTo(0.58, 6);
    expect(metrics.avgCharWidthRatio).toBeCloseTo(0.49, 6);
  });

  it('divides the prose sample by its own length, spaces included', () => {
    // A face whose every character advances 0.4 em must resolve to 0.4 whatever
    // sample this module happens to probe with.
    const calls: string[] = [];
    const measure: FontMeasurer = (request) => {
      calls.push(request.text);
      return {
        ascentPx: 0.7 * request.fontSizePx,
        widthPx: 0.4 * request.fontSizePx * request.text.length,
      };
    };

    const metrics = measureFontMetrics(STACK, { measure });

    expect(metrics.avgCharWidthRatio).toBeCloseTo(0.4, 6);
    expect(calls).toContain(FONT_METRICS_PROSE_SAMPLE);
    expect(FONT_METRICS_PROSE_SAMPLE).toContain(' ');
  });

  it('produces the same ratios at any reference size', () => {
    const { measure } = fakeFace({});
    const small = measureFontMetrics(STACK, { measure, referenceSizePx: 48 });
    const large = measureFontMetrics(STACK, { measure, referenceSizePx: 512 });

    expect(small.capHeightRatio).toBeCloseTo(large.capHeightRatio, 6);
    expect(small.avgCharWidthRatio).toBeCloseTo(large.avgCharWidthRatio, 6);
  });

  it('measures at the weight the stage will render at', () => {
    const { measure } = fakeFace({ advance: 0.49, boldAdvance: 0.56 });
    const regular = measureFontMetrics(STACK, { measure, fontWeight: 400 });
    const bold = measureFontMetrics(STACK, { measure, fontWeight: 700 });

    expect(regular.avgCharWidthRatio).toBeCloseTo(0.49, 6);
    expect(bold.avgCharWidthRatio).toBeCloseTo(0.56, 6);
  });
});

describe('measureFontMetrics refusals', () => {
  it('falls back when the platform cannot measure', () => {
    // The unit suite runs under `environment: 'node'`, so the default canvas
    // measurer has no document at all: the real no-canvas path, unmocked.
    expect(() => measureFontMetrics(STACK)).not.toThrow();
    expect(measureFontMetrics(STACK)).toEqual(fallbackFontMetrics());
  });

  it('falls back when the measurer declines a probe', () => {
    const measure: FontMeasurer = (request) =>
      request.text === '0' ? null : { ascentPx: 140, widthPx: 100 };

    expect(measureFontMetrics(STACK, { measure })).toEqual(fallbackFontMetrics());
  });

  it('falls back on an unmeasured canvas returning zeroes', () => {
    const measure: FontMeasurer = () => ({ ascentPx: 0, widthPx: 0 });

    expect(measureFontMetrics(STACK, { measure })).toEqual(fallbackFontMetrics());
  });

  it('rejects an x-height taller than the cap height', () => {
    const { measure } = fakeFace({ cap: 0.5, ex: 0.8 });

    expect(measureFontMetrics(STACK, { measure })).toEqual(fallbackFontMetrics());
  });

  it('cannot measure an empty stack', () => {
    const { measure, calls } = fakeFace({});

    expect(measureFontMetrics('   ', { measure })).toEqual(fallbackFontMetrics());
    expect(calls).toHaveLength(0);
  });

  it('survives a stack that is not a string at all', () => {
    // The stage renderer must not die because something other than a font id
    // reached this from a persisted document; a lost measurement is recoverable
    // and a thrown exception on the scroll plane is not.
    const { measure, calls } = fakeFace({});

    expect(measureFontMetrics(undefined as unknown as string, { measure })).toEqual(
      fallbackFontMetrics(),
    );
    expect(calls).toHaveLength(0);
  });
});

describe('measureFontMetrics input normalisation', () => {
  it('measures at regular weight when the settings carry none', () => {
    // `StageSettings.fontWeight` is optional, so absent is the common case. An
    // absent weight that reaches the canvas shorthand makes the whole font
    // string unparseable, and the stage then sits on DIN estimates for the rest
    // of the session without anything looking wrong.
    const { measure, calls } = fakeFace({ advance: 0.49, boldAdvance: 0.56 });

    const metrics = measureFontMetrics(STACK, { measure });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.fontWeight === 400)).toBe(true);
    expect(metrics.avgCharWidthRatio).toBeCloseTo(0.49, 6);
  });

  it('keeps a nonsense weight or reference size away from the measurer', () => {
    // A zero reference size divides every ratio by zero, and a non-finite weight
    // produces a font string the canvas cannot parse — which it answers by
    // quietly keeping the previous face. Both have to be repaired before the
    // platform sees them, not after.
    const { measure, calls } = fakeFace({ cap: 0.72 });

    const metrics = measureFontMetrics(STACK, {
      measure,
      fontWeight: Number.NaN,
      referenceSizePx: 0,
    });

    expect(metrics.measured).toBe(true);
    expect(metrics.capHeightRatio).toBeCloseTo(0.72, 6);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(Number.isFinite(call.fontWeight)).toBe(true);
      expect(call.fontWeight).toBeGreaterThan(0);
      expect(call.fontSizePx).toBeGreaterThan(0);
    }
  });
});

describe('measureFontMetrics caching', () => {
  it('measures a stack once', () => {
    const { measure, calls } = fakeFace({});

    const first = measureFontMetrics(STACK, { measure });
    const probes = calls.length;
    const second = measureFontMetrics(STACK, { measure });

    expect(probes).toBeGreaterThan(0);
    expect(calls).toHaveLength(probes);
    expect(second).toEqual(first);
  });

  it('keys the cache by stack, weight and reference size', () => {
    const { measure, calls } = fakeFace({});
    measureFontMetrics(STACK, { measure });
    const perMeasurement = calls.length;

    measureFontMetrics('Georgia, serif', { measure });
    expect(calls).toHaveLength(perMeasurement * 2);

    measureFontMetrics(STACK, { measure, fontWeight: 700 });
    expect(calls).toHaveLength(perMeasurement * 3);

    measureFontMetrics(STACK, { measure, referenceSizePx: 96 });
    expect(calls).toHaveLength(perMeasurement * 4);
  });

  it('re-measures after the cache is cleared, so a late font swap is picked up', () => {
    const { measure, calls } = fakeFace({});
    measureFontMetrics(STACK, { measure });
    const perMeasurement = calls.length;

    clearFontMetricsCache();
    measureFontMetrics(STACK, { measure });

    expect(calls).toHaveLength(perMeasurement * 2);
  });

  /*
   * Both shapes a refusal arrives in, because only one of them reaches the cache
   * guard. A declined probe is refused before any metrics are built, so it can
   * never be cached whatever the guard does. Finite-but-implausible numbers —
   * the zeroes a 2D context answers with before its font has resolved — travel
   * all the way to `normalizeFontMetrics` and are thrown out there, and keeping
   * THAT result out of the cache is the whole of the self-correction: cache it
   * and the DIN estimate is frozen in for the session, on exactly the path the
   * font-loading race takes.
   */
  const refusals: Array<[string, GlyphMeasurement | null]> = [
    ['a declined probe', null],
    ['zeroes from an unresolved face', { ascentPx: 0, widthPx: 0 }],
  ];

  for (const [label, whileAbsent] of refusals) {
    it(`retries after ${label}, so the font-loading race self-corrects`, () => {
      // Absent on the first pass and present on the second: what
      // `document.fonts.ready` resolving after the stage has already laid out
      // looks like from in here.
      let faceLoaded = false;
      const measure: FontMeasurer = (request): GlyphMeasurement | null => {
        if (!faceLoaded) return whileAbsent;
        const em = request.fontSizePx;
        if (request.text === 'H') return { ascentPx: 0.71 * em, widthPx: 0.72 * em };
        if (request.text === 'x') return { ascentPx: 0.52 * em, widthPx: 0.45 * em };
        if (request.text === '0') return { ascentPx: 0.71 * em, widthPx: 0.55 * em };
        return { ascentPx: 0.71 * em, widthPx: 0.47 * em * request.text.length };
      };

      expect(measureFontMetrics(STACK, { measure }).measured).toBe(false);

      faceLoaded = true;
      const settled = measureFontMetrics(STACK, { measure });

      expect(settled.measured).toBe(true);
      expect(settled.capHeightRatio).toBeCloseTo(0.71, 6);
    });
  }
});

/*
 * `stageFontStack` is exercised here rather than in a file of its own because
 * the string it returns is this module's only input. A measurement is no more
 * correct than the stack it was taken on, and an id that silently falls through
 * to the default gets measured, cached and believed like any other.
 */
describe('stageFontStack', () => {
  it('resolves every id the settings panel can write', () => {
    // Settings offers exactly these four, and has always written the long
    // spellings. Two of them used to match nothing here, so half the panel's
    // choices drew system sans while the panel showed the choice as taken.
    expect(stageFontStack('humanist-sans')).toContain('Seravek');
    expect(stageFontStack('serif')).toContain('Georgia');
    expect(stageFontStack('monospace').startsWith('ui-monospace')).toBe(true);
    expect(stageFontStack('system-sans')).toContain('system-ui');

    const systemSans = stageFontStack('system-sans');
    expect(stageFontStack('humanist-sans')).not.toEqual(systemSans);
    expect(stageFontStack('monospace')).not.toEqual(systemSans);
    expect(stageFontStack('serif')).not.toEqual(systemSans);
  });

  it('accepts the short spellings too, so an older document is not reset', () => {
    expect(stageFontStack('humanist')).toEqual(stageFontStack('humanist-sans'));
    expect(stageFontStack('mono')).toEqual(stageFontStack('monospace'));
  });

  it('degrades high legibility into the humanist stack, not the system one', () => {
    // When the face is not bundled, the fallback decides the column measure the
    // optical resolver has already committed to, so it has to be the nearest
    // proportions available rather than whatever `system-ui` happens to be on
    // the machine the rig is plugged into.
    const stack = stageFontStack('high-legibility');

    expect(stack.startsWith("'Atkinson Hyperlegible Next'")).toBe(true);
    expect(stack.endsWith(stageFontStack('humanist-sans'))).toBe(true);
  });

  it('falls back to system sans for an id it does not know', () => {
    expect(stageFontStack('atkinson')).toEqual(stageFontStack('system-sans'));
    expect(stageFontStack('')).toEqual(stageFontStack('system-sans'));
  });
});
