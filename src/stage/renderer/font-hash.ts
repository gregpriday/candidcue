/**
 * A fingerprint of the face that is actually RENDERING.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `LayoutFingerprint.fontFamily` is a settings string. Two different faces can
 * wear the same id — a bundled woff2 that lands after the bounded font wait, a
 * system font installed mid-session, a font file that failed to load and put
 * the humanist fallback on the glass — and each of those re-wraps every line
 * while every declared fingerprint field holds still. A rebuild with an
 * unchanged fingerprint is classified coverage-only, so the §33 semantic
 * re-anchor is skipped and the presenter's position is carried across a layout
 * that moved underneath it.
 *
 * `fontHash` is the §7.2 contract's term for that, and this is what fills it.
 *
 * ---------------------------------------------------------------------------
 * WHY A MEASUREMENT AND NOT A FILE DIGEST
 * ---------------------------------------------------------------------------
 * A digest would answer "which bytes did we ship", which is not the question.
 * The fingerprint exists to detect that GLYPHS MOVED, and glyphs move for
 * reasons a file digest cannot see: a fallback kicking in, an OS font update
 * under a system family, a variable axis rendered at a different weight. So the
 * probe is of the rendered result — what the browser resolved, at the weight
 * the stage will draw — and every one of those causes moves it.
 *
 * The sibling module `fontMetrics.ts` already measures a face, but for a
 * different purpose and with different tolerances: its four ratios are
 * NORMALIZED, clamped and rejected into a DIN fallback so the optical solver
 * never runs on an implausible number, and they are CACHED by stack so the
 * solver is cheap. Both of those are right there and wrong here. A fingerprint
 * wants the raw reading, and it wants it now — a clamp can collapse two faces
 * onto one value, and a cache is a promise that the face has not changed, which
 * is precisely the thing being tested.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT COSTS
 * ---------------------------------------------------------------------------
 * Six `measureText` calls on a detached, never-painted canvas, plus one
 * `FontFaceSet.check` per named family. Tens of microseconds, called on
 * layout-affecting changes rather than per frame. Deliberately not memoized:
 * see above.
 */
import { FONT_METRICS_PROSE_SAMPLE, FONT_METRICS_REFERENCE_SIZE_PX } from './fontMetrics';

/**
 * The answer when nothing could be learned about the face.
 *
 * Constant on purpose. Under SSR, in a node test runner and on any platform
 * with neither a canvas nor a `FontFaceSet`, this has to be stable — a value
 * that varied per call would report a font swap on every rebuild and turn every
 * coverage-only rebuild into a full re-anchor.
 *
 * It cannot collide with a real reading: both tagged forms below carry a
 * provenance letter and a hash, and neither is the word `absent`.
 */
export const FONT_HASH_UNAVAILABLE = 'face:absent';

export interface FaceProbe {
  /** Advance width of the whole probe string, CSS px at the reference size. */
  widthPx: number;
  /** Ink height above the alphabetic baseline. */
  ascentPx: number;
  /** Ink depth below it — the descender, which separates faces the ascent does not. */
  descentPx: number;
}

export interface FaceProbeRequest {
  text: string;
  fontSizePx: number;
  fontStack: string;
  fontWeight: number;
}

/**
 * The measuring primitive, injectable for the same reason `fontMetrics.ts`
 * injects its own: the unit suite runs under `environment: 'node'`, where a
 * canvas returns nothing, so without a seam the only testable behaviour would
 * be the sentinel. Null means "this face could not be measured" — never zeroes,
 * which read as a measurement of an infinitely small font.
 */
export type FaceMeasurer = (request: FaceProbeRequest) => FaceProbe | null;

/**
 * Whether a font family is ready to render with, by family name as written in
 * the stack. `null` means the platform could not say.
 *
 * "Ready", not "installed", and the difference is the whole reason to be
 * careful with this channel. `FontFaceSet.check` answers about the faces the
 * DOCUMENT declares: it is `false` while a declared `@font-face` is still
 * unloaded and `true` once it lands, which is exactly the event this module was
 * built for. But a family nobody declares matches nothing in the set, and the
 * spec says an empty match answers `true` — so 'Seravek' reads available on a
 * machine that has never had it. Only the bundled family carries signal here;
 * the rest are a constant, and the measurement is what separates them.
 */
export type FamilyAvailability = (family: string, fontWeight: number) => boolean | null;

export interface FontHashOptions {
  /**
   * The weight the stage will render at. Not optional in spirit: the bundled
   * face is variable over 200-800, so its advances at 300 and at 700 are the
   * advances of two different fonts, and a fingerprint that ignored the weight
   * would call a weight change a non-event.
   */
  fontWeight?: number;
  /** Test seam; defaults to the canvas measurer. */
  measure?: FaceMeasurer;
  /** Test seam; defaults to `document.fonts.check`. */
  available?: FamilyAvailability;
}

/**
 * The probe strings, chosen for how hard they are to agree on.
 *
 * Not a pangram apiece — this is discrimination, not coverage. Each entry is a
 * place where two faces that share a family id measurably differ:
 *
 *  - 'H'    flat-topped cap, so its ink height is the cap height with no
 *           overshoot to confuse it.
 *  - 'x'    x-height, which is where a humanist and a grotesque part company
 *           at equal cap height.
 *  - 'gjp'  descender depth and shape. A single-storey g and a double-storey g
 *           differ here by far more than any rounding.
 *  - 'Il1'  the confusables Atkinson Hyperlegible exists to separate. A face
 *           designed to distinguish them spends width doing it; a system sans
 *           does not, so this triplet is the single strongest signal that the
 *           bundled face did or did not land.
 *  - '0'    slashed, dotted or bare, and the zero is the digit that most often
 *           differs while the letters match.
 *  - prose  the same sentence `fontMetrics.ts` averages over, measured whole so
 *           kerning and shaping are inside the number exactly as they are in a
 *           rendered line. Shared with that module on purpose: one sample, so
 *           the two readings are of the same thing.
 */
export const FONT_HASH_PROBES: readonly string[] = [
  'H',
  'x',
  'gjp',
  'Il1',
  '0',
  FONT_METRICS_PROSE_SAMPLE,
];

const DEFAULT_FONT_WEIGHT = 400;

/**
 * CSS generic families are available by definition, so asking about them adds a
 * constant `true` to the availability record and no signal. Skipping them keeps
 * the record about the named faces, which are the ones that can go missing.
 */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  'inherit',
  'initial',
  'revert',
  'revert-layer',
  'unset',
]);

/**
 * A stable identity for the face `fontStack` currently resolves to.
 *
 * Total, like every other measurement on this path: a stage that throws
 * mid-take because a settings document held an unquotable family name is a
 * worse outcome than one that admits it does not know the face.
 *
 * Guarantees, in the order they matter:
 *  - equal for repeated calls in an unchanged environment;
 *  - different when the resolved face differs, including when it differs only
 *    because a load succeeded that had previously failed;
 *  - `FONT_HASH_UNAVAILABLE`, and nothing else, when there is no platform to
 *    ask.
 */
export function fontHash(fontStack: string, options: FontHashOptions = {}): string {
  const stack = typeof fontStack === 'string' ? fontStack.trim() : '';
  const fontWeight = normalizeWeight(options.fontWeight);

  // An empty stack cannot be measured, only guessed at, and a canvas handed one
  // silently keeps whatever face it had — a wrong reading wearing a measured
  // tag. There is genuinely nothing to know here, which is what the sentinel
  // says.
  if (stack.length === 0) return FONT_HASH_UNAVAILABLE;

  const availability = readAvailability(stack, fontWeight, options.available);
  const measurements = readMeasurements(stack, fontWeight, options.measure ?? canvasMeasurer);

  // Neither channel answered: no canvas, no FontFaceSet, nothing rendered. This
  // is the SSR and node-runner case, and it has to be the constant.
  if (measurements === null && availability === null) return FONT_HASH_UNAVAILABLE;

  /*
   * The provenance letter leads, exactly as `measured`/`estimated` leads the
   * optical metrics fingerprint. Without it, a hash computed from availability
   * alone could in principle collide with one computed from a measurement, and
   * the two mean very different things: one says "this is the face", the other
   * says "this is only which families claim to exist".
   */
  const tag = measurements === null ? 'u' : 'm';
  return `face:${tag}:${fnv1a(`${availability ?? '?'}|${measurements ?? ''}`)}`;
}

/**
 * The named families of a CSS font-family list, in cascade order, generics
 * dropped. Exported because it is the part worth asserting on directly: a stack
 * that names a family nobody declares is the failure mode this whole unit is
 * about.
 *
 * Splitting on commas is safe for the stacks this app produces — a family name
 * containing a comma would have to be quoted, and none are.
 */
export function namedFamilies(fontStack: string): string[] {
  if (typeof fontStack !== 'string') return [];
  const families: string[] = [];
  for (const raw of fontStack.split(',')) {
    const family = raw.trim();
    if (family.length === 0) continue;
    if (GENERIC_FAMILIES.has(unquote(family).toLowerCase())) continue;
    families.push(family);
  }
  return families;
}

function unquote(family: string): string {
  const first = family[0];
  if ((first === "'" || first === '"') && family.endsWith(first) && family.length > 1) {
    return family.slice(1, -1);
  }
  return family;
}

/**
 * A record of the named families in cascade order and what the platform says
 * about each, as `Family=1|0|?`.
 *
 * This is the channel that catches the case the measurement can miss. Two faces
 * with coincidentally similar proportions would hash alike; "the first family
 * in the stack went from unavailable to available" is unambiguous, and it is
 * the exact shape of the event this unit was built for — a bundled woff2
 * landing after the stage already drew a fallback.
 *
 * The family NAMES are in the record and not only their answers, because a bare
 * bitstring makes the record a count rather than an identity: every stack with
 * three named families and the same answers produces the same bits, so the
 * serif stack and the humanist stack were indistinguishable on any platform
 * where the measurement channel is the one that cannot answer. Carrying the
 * names costs a few dozen bytes into a hash and removes that whole collision
 * class. It can only ever move the hash when the operator changed the stack,
 * which is the safe direction: a spurious re-anchor costs a string compare, a
 * missed one carries the presenter across a layout that moved.
 */
function readAvailability(
  stack: string,
  fontWeight: number,
  injected: FamilyAvailability | undefined,
): string | null {
  const families = namedFamilies(stack);
  if (families.length === 0) return null;
  const check = injected ?? platformAvailability;
  const entries: string[] = [];
  let answered = false;
  for (const family of families) {
    const answer = check(family, fontWeight);
    // One unknown family does not discard the others: a partial record is still
    // a record, and `?` is a distinct state from both yes and no.
    if (answer !== null) answered = true;
    entries.push(`${family}=${answer === null ? '?' : answer ? '1' : '0'}`);
  }
  // A record of nothing but unknowns is not a record; say so, so the caller can
  // tell "the platform cannot answer" from "the platform says no".
  return answered ? entries.join(';') : null;
}

/**
 * See `FamilyAvailability`: this reports LOAD STATE for the families the
 * document declares, and a constant `true` for the ones it does not.
 */
function platformAvailability(family: string, fontWeight: number): boolean | null {
  if (typeof document === 'undefined') return null;
  const fonts = document.fonts;
  if (!fonts || typeof fonts.check !== 'function') return null;
  try {
    // The family is passed through as written rather than re-quoted: it came
    // out of a CSS font-family list and is already quoted correctly there, and
    // re-quoting is how a name with an apostrophe becomes a parse error.
    return fonts.check(`${fontWeight} ${FONT_METRICS_REFERENCE_SIZE_PX}px ${family}`);
  } catch {
    // `check` throws on a font shorthand it cannot parse, and jsdom throws
    // "not implemented" for the whole FontFaceSet.
    return null;
  }
}

function readMeasurements(
  stack: string,
  fontWeight: number,
  measure: FaceMeasurer,
): string | null {
  const parts: string[] = [];
  for (const text of FONT_HASH_PROBES) {
    const probe = measure({
      text,
      fontSizePx: FONT_METRICS_REFERENCE_SIZE_PX,
      fontStack: stack,
      fontWeight,
    });
    // All or nothing. A partial set would silently change shape when one probe
    // started or stopped working, which reads downstream as a font swap.
    if (!probe) return null;
    parts.push(round(probe.widthPx), round(probe.ascentPx), round(probe.descentPx));
  }
  return parts.join(',');
}

/**
 * Three decimals of a CSS pixel at a 200px reference — far finer than any
 * difference that could move a line break, and coarse enough that the last bits
 * of a double cannot make two identical measurements look different.
 */
function round(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : 'nan';
}

/* ---------------------------------------------------------------------------
 * The canvas measurer
 * ------------------------------------------------------------------------- */

/**
 * A font the rejection check below can recognise after the browser normalises
 * it. Its size sits far under the reference size, so nothing this module asks
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

/**
 * Reset the cached context. Only the platform handle is cached — never a
 * reading — so this exists for tests that swap the global `document`, not to
 * make anything correct at runtime.
 */
export function resetFontHashContext(): void {
  context = undefined;
}

function canvasMeasurer(request: FaceProbeRequest): FaceProbe | null {
  const ctx = measuringContext();
  if (!ctx) return null;

  /*
   * Assigning an unparseable font shorthand to a 2D context is a silent no-op:
   * the previous face stays in force and `measureText` answers about THAT font.
   * Reporting one face's metrics under another's name is the exact failure this
   * module is supposed to detect, so the assignment is checked rather than
   * trusted.
   */
  ctx.font = SENTINEL_FONT;
  const rejected = ctx.font;
  ctx.font = `${request.fontWeight} ${request.fontSizePx}px ${request.fontStack}`;
  if (ctx.font === rejected) return null;

  // The ascent and descent below are relative to whatever baseline is set, and
  // they only mean cap height and descender from the alphabetic one.
  ctx.textBaseline = 'alphabetic';

  /*
   * Nothing here scales the canvas or reads `devicePixelRatio`, so these are CSS
   * pixels on every display. That matters: moving the stage window to a panel
   * with a different backing scale must NOT read as a font swap. The scale
   * factor is its own fingerprint field and already invalidates the map on its
   * own account.
   */
  const measured = ctx.measureText(request.text);
  const widthPx = measured.width;
  const ascentPx = measured.actualBoundingBoxAscent;
  const descentPx = measured.actualBoundingBoxDescent;
  // Engines that predate the bounding-box metrics leave them undefined, and a
  // context that has never had a font resolved returns zeroes for the width.
  if (!Number.isFinite(widthPx) || !Number.isFinite(ascentPx) || !Number.isFinite(descentPx)) {
    return null;
  }
  return { widthPx, ascentPx, descentPx };
}

/* ---------------------------------------------------------------------------
 * Hashing
 * ------------------------------------------------------------------------- */

/**
 * FNV-1a, 32-bit.
 *
 * A fingerprint term is only ever compared for equality, so the requirement is
 * a good avalanche on short strings and no allocation — not cryptographic
 * strength. The alternative of carrying the raw measurement string would work
 * equally well for correctness and put a few hundred bytes into every
 * fingerprint the stage keeps, compares and logs.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    /*
     * The 16777619 multiply written as shifts. `hash * 16777619` exceeds the
     * exact-integer range of a double, so the product is rounded before the
     * `>>> 0` truncates it and the low bits — the ones the avalanche depends on
     * — are lost.
     */
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(36);
}

function normalizeWeight(weight: number | undefined): number {
  if (typeof weight !== 'number' || !Number.isFinite(weight)) return DEFAULT_FONT_WEIGHT;
  return Math.round(Math.min(1000, Math.max(1, weight)));
}
