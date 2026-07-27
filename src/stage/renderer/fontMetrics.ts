/**
 * Measuring the stage font, so the optical model runs on the real face.
 *
 * ---------------------------------------------------------------------------
 * WHY MEASURE AT ALL
 * ---------------------------------------------------------------------------
 * Every number `optics.ts` produces is one ratio away from a physical size: a
 * body size is a cap height in millimetres divided by `capHeightRatio`, and a
 * reading measure is a pixel width divided by `avgCharWidthRatio`. The DIN
 * fallbacks in that module are defensible for "a sans" and wrong for any
 * particular one. Seravek's cap height is not Segoe UI's, and a monospace face
 * advances around 0.6 em where the proportional estimate assumes 0.5 — so on
 * the monospace stack the fallback claims about a fifth more characters per
 * line than the panel can actually hold, and the presenter is told they have a
 * fifth of a line of script that is not there.
 *
 * The measurement is deliberately thin: read four numbers off the face, divide
 * them by the size they were taken at, and hand the result to
 * `normalizeFontMetrics`, which is where an implausible measurement becomes the
 * fallback. That rejection lives in one place on purpose — a half-trusted
 * measurement scattered across call sites is a third set of proportions that
 * nobody tuned against.
 *
 * ---------------------------------------------------------------------------
 * WHY A CANVAS
 * ---------------------------------------------------------------------------
 * `actualBoundingBoxAscent` off a 2D context is the only way to get an ink
 * height out of a browser without rendering a probe element, forcing layout and
 * reading it back — which on the stage would mean touching the DOM the scroll
 * plane is animating, mid-take. The canvas is detached, reused, and never
 * painted.
 *
 * Because every result is divided by the size it was measured at, the canvas
 * backing scale and `devicePixelRatio` cancel out and are irrelevant here.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS SAFE TO CALL OFTEN
 * ---------------------------------------------------------------------------
 * Metrics are an input to the layout fingerprint, so this is reached on every
 * layout-affecting settings change. Successful measurements are cached by
 * stack, weight and reference size; failures are not, which is what makes the
 * font-loading race self-correcting — a measurement taken before the face
 * arrives is refused by `normalizeFontMetrics`, stays out of the cache, and the
 * next call after `document.fonts.ready` measures the real thing.
 */
import { fallbackFontMetrics, normalizeFontMetrics, type FontMetrics } from '../../shared/optics';

/**
 * The size the probes are drawn at, in CSS pixels.
 *
 * Large on purpose: hinting and rounding move an ink edge by a fraction of a
 * pixel regardless of size, so at 16px that noise is a percent or two of the
 * cap height — enough to shift a resolved body size by a visible step — while
 * at 200px it is under a tenth of a percent. Nothing is painted, so the size
 * costs nothing.
 */
export const FONT_METRICS_REFERENCE_SIZE_PX = 200;

/**
 * The prose the average advance is taken from.
 *
 * A pangram alone would over-weight the rare letters that make it a pangram, so
 * ordinary English words are appended to pull the letter frequencies back
 * toward what a script actually contains. Spaces are included in both the width
 * and the divisor because "characters per line" downstream counts them too.
 *
 * Measured as one string rather than glyph by glyph, so kerning and shaping are
 * inside the number, exactly as they are in a rendered line.
 */
export const FONT_METRICS_PROSE_SAMPLE =
  'the quick brown fox jumps over the lazy dog and then some ordinary words';

const DEFAULT_FONT_WEIGHT = 400;

/**
 * The reference-size floor exists for precision, not correctness.
 *
 * Below roughly this size the sub-pixel noise described above is a large enough
 * fraction of the cap height to move a resolved body size by a visible step. It
 * also keeps every request this module makes clear of the 10px sentinel in
 * `canvasMeasurer`, which is why that check can compare font strings without
 * qualifying the comparison.
 */
const MIN_REFERENCE_SIZE_PX = 32;
/** Past this a probe buys no further precision and only courts engine size limits. */
const MAX_REFERENCE_SIZE_PX = 1000;

export interface GlyphMeasurement {
  /** Ink height above the alphabetic baseline, in the units the size was given in. */
  ascentPx: number;
  /** Advance width of the whole string, same units. */
  widthPx: number;
}

export interface FontMeasureRequest {
  text: string;
  fontSizePx: number;
  fontStack: string;
  fontWeight: number;
}

/**
 * The one primitive this module needs from the platform.
 *
 * Injectable so the ratio arithmetic can be exercised without a browser: jsdom
 * has no canvas, and the unit suite runs under `environment: 'node'`, so
 * without this seam the only testable behaviour would be "returns the
 * fallback". Returning null means "this face could not be measured" — never
 * zeroes, which would read as a measurement of an infinitely small font.
 */
export type FontMeasurer = (request: FontMeasureRequest) => GlyphMeasurement | null;

export interface MeasureFontMetricsOptions {
  /**
   * The weight the stage will actually render at. A bold face has different
   * advances from its regular, so measuring 400 and drawing 600 is measuring a
   * different font.
   */
  fontWeight?: number;
  referenceSizePx?: number;
  /** Test seam; defaults to the canvas measurer. */
  measure?: FontMeasurer;
}

const cache = new Map<string, FontMetrics>();

/**
 * The proportions of `fontStack`, measured if the platform allows it.
 *
 * Total: every path returns usable metrics, because the alternative is a stage
 * that will not size text until a canvas cooperates. `FontMetrics.measured`
 * carries whether the answer is a measurement or the DIN estimate, and the
 * diagnostics surface says which — the resolver already turns `measured: false`
 * into an operator-facing warning.
 */
export function measureFontMetrics(
  fontStack: string,
  options: MeasureFontMetricsOptions = {},
): FontMetrics {
  // The signature says string; the contract above says total. A caller that
  // reads a stack out of a settings document rather than through
  // `stageFontStack` is not bound by the signature, and a throw on this path
  // takes the stage down mid-take rather than merely costing it a measurement.
  const stack = typeof fontStack === 'string' ? fontStack.trim() : '';
  // An empty stack cannot be measured, only guessed at, and a canvas handed one
  // silently keeps whatever face it had — a wrong answer wearing measured: true.
  if (stack.length === 0) return fallbackFontMetrics();

  const fontWeight = normalizeWeight(options.fontWeight);
  const referenceSizePx = normalizeReferenceSize(options.referenceSizePx);

  const key = `${fontWeight}|${referenceSizePx}|${stack}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const measure = options.measure ?? canvasMeasurer;
  const probe = (text: string): GlyphMeasurement | null =>
    measure({ text, fontSizePx: referenceSizePx, fontStack: stack, fontWeight });

  // 'H' rather than 'O' or 'D': a flat-topped cap has no overshoot, so its ink
  // height is the cap height rather than the cap height plus a curve's rise.
  const cap = probe('H');
  const ex = probe('x');
  const zero = probe('0');
  const prose = probe(FONT_METRICS_PROSE_SAMPLE);
  if (!cap || !ex || !zero || !prose) return fallbackFontMetrics();

  const metrics = normalizeFontMetrics({
    capHeightRatio: cap.ascentPx / referenceSizePx,
    xHeightRatio: ex.ascentPx / referenceSizePx,
    zeroAdvanceRatio: zero.widthPx / referenceSizePx,
    avgCharWidthRatio: prose.widthPx / FONT_METRICS_PROSE_SAMPLE.length / referenceSizePx,
    measured: true,
  });

  // Only a believed measurement is remembered. Caching a rejection would freeze
  // the estimate in place for the session, including the common case where the
  // rejection happened because the webfont had not landed yet.
  if (metrics.measured) cache.set(key, metrics);
  return metrics;
}

/**
 * Forget every measurement.
 *
 * For the case the cache key cannot see: the same stack resolving to a
 * different face. A bundled font that finishes loading after the stage has
 * already measured, or a system font installed mid-session, changes the
 * proportions of a string the cache still answers for.
 */
export function clearFontMetricsCache(): void {
  cache.clear();
}

/* ---------------------------------------------------------------------------
 * The canvas measurer
 * ------------------------------------------------------------------------- */

/**
 * A font the sentinel check below can recognise after the browser normalises
 * it. Its size sits under `MIN_REFERENCE_SIZE_PX`, so nothing this module asks
 * for can serialise to the same string and be misread as a rejection.
 */
const SENTINEL_FONT = '10px monospace';

/** `undefined` means "not tried yet"; `null` means "this platform has none". */
let context: CanvasRenderingContext2D | null | undefined;

function measuringContext(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    context = null;
    return null;
  }
  try {
    context = document.createElement('canvas').getContext('2d');
  } catch {
    // jsdom and headless runners report an unimplemented canvas by throwing.
    context = null;
  }
  return context;
}

function canvasMeasurer(request: FontMeasureRequest): GlyphMeasurement | null {
  const ctx = measuringContext();
  if (!ctx) return null;

  /*
   * Assigning an unparseable font shorthand to a 2D context is a silent no-op:
   * the previous face stays in force and `measureText` answers about THAT font.
   * A stack from a settings document is not necessarily quotable, so the
   * assignment is checked rather than trusted — reporting one font's metrics as
   * another's is precisely the failure the honesty flags exist to prevent.
   */
  ctx.font = SENTINEL_FONT;
  const rejected = ctx.font;
  ctx.font = `${request.fontWeight} ${request.fontSizePx}px ${request.fontStack}`;
  if (ctx.font === rejected) return null;

  // The default already, but stated: the ascent below is relative to whatever
  // baseline is set, and cap height is only cap height from the alphabetic one.
  ctx.textBaseline = 'alphabetic';

  const measured = ctx.measureText(request.text);
  const ascentPx = measured.actualBoundingBoxAscent;
  const widthPx = measured.width;
  // Engines that predate the bounding-box metrics leave them undefined, and a
  // context that has never had a font resolved returns zeroes.
  if (!Number.isFinite(ascentPx) || !Number.isFinite(widthPx)) return null;
  return { ascentPx, widthPx };
}

/* ---------------------------------------------------------------------------
 * Input normalisation
 * ------------------------------------------------------------------------- */

function normalizeWeight(weight: number | undefined): number {
  if (typeof weight !== 'number' || !Number.isFinite(weight)) return DEFAULT_FONT_WEIGHT;
  return Math.round(Math.min(1000, Math.max(1, weight)));
}

function normalizeReferenceSize(size: number | undefined): number {
  if (typeof size !== 'number' || !Number.isFinite(size)) return FONT_METRICS_REFERENCE_SIZE_PX;
  return Math.min(MAX_REFERENCE_SIZE_PX, Math.max(MIN_REFERENCE_SIZE_PX, size));
}
