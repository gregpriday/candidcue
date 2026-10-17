/**
 * Auto-scroll: the pace the document rolls at when nothing is following a voice.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A CONSTANT-RATE PATH AT ALL
 * ---------------------------------------------------------------------------
 * Every take follows a voice, and when the voice is not getting through the
 * stage holds still — correctly, because moving on evidence it does not have is
 * the one thing a prompter must never do. But "holds still" is the whole of the
 * answer today, and there are ordinary rooms where it is the answer for the
 * whole take: no key entered yet, no network, a language the recogniser handles
 * badly, or a stage loud enough that finals stop arriving. The presenter is then
 * in front of a camera with a script that will not move, and their only recourse
 * is a keyboard they are not standing next to.
 *
 * So this is a fallback rather than a second way to prompt. It is not smarter
 * than voice following and does not try to be: it advances at the rate it is
 * told, and the moment recognition is working again the alignment path outranks
 * it inside the motion engine without anything here being consulted.
 *
 * ---------------------------------------------------------------------------
 * WHY WORDS PER MINUTE, AND WHY THAT NEEDS THE LINE MAP
 * ---------------------------------------------------------------------------
 * A speed control on a teleprompter has to be in the presenter's units, not the
 * renderer's. Nobody knows what 34 px/s feels like, everybody knows roughly what
 * 150 words a minute sounds like, and the same pixel rate is a crawl at 40 px
 * type and a bolt at 100 px. So the setting is words per minute and the pixels
 * are derived — which means the conversion needs to know how much script one
 * pixel of travel actually carries.
 *
 * The line map already measured exactly that. Two rendered lines' baselines give
 * a real document distance, and their first token indices give the number of
 * words crossed between them: the ratio is measured rather than estimated, it is
 * for the type currently on the glass, and it re-derives itself for free when
 * the operator changes the size mid-take.
 *
 * Except that a line map only knows about words on the glass. An image, a
 * table, a silent block, a heading nobody reads aloud — none of them has a word
 * anchored on the glass, so none of them is a line, and the height each one
 * takes up sits inside a single baseline-to-baseline step between the spoken
 * lines either side of it. Counted as distance the words bought, a 600 px
 * screenshot in a twenty-line script turns 130 wpm into nearly 200 over the
 * text. So that height is taken back out of the measurement
 * (`measureAutoScrollScale`), and what is left describes the words alone.
 *
 * Pure and separate from the component for the usual reason: the interesting
 * behaviour is at the edges — one line, zero-height spans, a map that ran
 * backwards, a frame delta of four seconds because the window was occluded —
 * and not one of those is worth mounting a stage to check.
 */

import type { CompiledBlock, RenderedLine } from '../../shared/contracts';
import type { MeasuredBlockBox } from '../motion/lineMap';

/**
 * Largest frame delta that may be integrated in one step, milliseconds.
 *
 * The same guard the motion controller keeps for the same reason: a tab that was
 * occluded, a machine that swapped, or a debugger paused at a breakpoint returns
 * a delta measured in seconds, and integrating it whole would jump the target a
 * page down the script in a single frame. Capping it means a stall costs some
 * missed travel rather than a lurch — and missed travel while nothing was on
 * screen is not travel anybody needed.
 *
 * 100 ms is six frames at 60 Hz: long enough to absorb ordinary jitter and a
 * dropped frame or two, short enough that nothing perceptible is integrated
 * from a hitch.
 */
export const AUTO_SCROLL_MAX_FRAME_MS = 100;

/**
 * The speed range offered, in words per minute.
 *
 * The floor is below any delivery anybody reads aloud, because the control is
 * also how somebody dials a pace in while watching the glass, and a floor that
 * starts at a normal speaking rate gives them nowhere to approach it from. The
 * ceiling is fast enough for a rushed sponsor read and no faster: above this the
 * document is moving quicker than the words can be spoken, which is not a
 * teleprompter setting, it is a scrolling credit roll.
 */
export const AUTO_SCROLL_MIN_WPM = 60;
export const AUTO_SCROLL_MAX_WPM = 260;

/**
 * The starting pace.
 *
 * Unhurried conversational delivery. Deliberately a little under the ~150 wpm
 * usually quoted for presentation speech: reading to a lens is slower than
 * talking, and a presenter whose first experience of the feature is the script
 * outrunning them turns it off rather than turning it down.
 */
export const AUTO_SCROLL_DEFAULT_WPM = 130;

/**
 * How much one press of the pace keys moves it.
 *
 * Big enough that a single press is felt — an adjustment nobody can perceive
 * gets pressed repeatedly and then overshoots — and small enough that the range
 * takes a deliberate number of presses to cross rather than two.
 */
export const AUTO_SCROLL_WPM_STEP = 10;

/** Document pixels one spoken word occupies, measured off the rendered lines. */
export interface AutoScrollScale {
  pxPerWord: number;
  /** Words the measurement spanned — how much evidence `pxPerWord` rests on. */
  sampledWords: number;
}

/**
 * How many document pixels a spoken word costs, from the measured line map.
 *
 * Measured between the FIRST tokens of the first and last rendered lines rather
 * than across the full token span of the map, because those two quantities have
 * to describe the same journey. Baseline-to-baseline is the distance travelled
 * in getting from one line to the next, and the words that travel buys are the
 * ones on the lines left behind — counting the last line's words as well would
 * charge the presenter for a line the document has not moved past yet, and
 * report the script as denser than it is.
 *
 * Null rather than a guess whenever the map cannot answer: fewer than two lines,
 * a span with no height, or a line map whose token indices do not advance.
 * Auto-scroll simply does not run in those states, which is the honest outcome —
 * a made-up density would move the document at a speed with no relationship to
 * the words on it, and the presenter has no way to tell that from a real one.
 *
 * `blocks` is the measured block boxes the map was built from, in document
 * order, and it is what lets the span describe words rather than paper. Any
 * block that produced no rendered line has nothing on it to read, and its
 * height is subtracted from the span (see `wordlessSpan`). Without it — or in a
 * script with nothing wordless in it — the answer is exactly the plain baseline
 * ratio.
 */
export function measureAutoScrollScale(
  lines: readonly RenderedLine[],
  blocks: readonly AutoScrollBlockBox[] = [],
): AutoScrollScale | null {
  if (lines.length < 2) return null;
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first || !last) return null;

  const wordless = wordlessSpan(lines, blocks);
  const spanPx = last.baselineY - first.baselineY - wordless.px;
  const spanWords = last.firstTokenIndex - first.firstTokenIndex - wordless.words;
  // Both must advance. A non-positive span is a map that is empty, reversed, or
  // measured before layout settled; none of them describe a document that can
  // be rolled at a readable rate.
  if (!(spanPx > 0) || !(spanWords > 0)) return null;
  if (!Number.isFinite(spanPx) || !Number.isFinite(spanWords)) return null;

  return { pxPerWord: spanPx / spanWords, sampledWords: spanWords };
}

/** The parts of a measured block box the wordless correction reads. */
export type AutoScrollBlockBox = Pick<MeasuredBlockBox, 'blockId' | 'topY' | 'bottomY'> & {
  /**
   * Spoken tokens the compiled block owns. Only ever read for a block that
   * produced no rendered line, so none of them can be on the glass; absent is
   * none.
   */
  spokenTokens?: number;
};

/**
 * The measured boxes, each carrying how many spoken tokens its block owns.
 *
 * The measurement knows where a block is and the compiler knows what it says,
 * and the wordless correction needs both: an image read by its alt text owns
 * tokens that never reach a line, and the only record of which tokens are its
 * — rather than an unanchored tail of the paragraph above it — is its compiled
 * token range.
 */
export function autoScrollBlockBoxes(
  boxes: readonly AutoScrollBlockBox[],
  compiled: readonly Pick<CompiledBlock, 'id' | 'startTokenIndex' | 'endTokenIndex'>[],
): AutoScrollBlockBox[] {
  const owned = new Map<string, number>();
  for (const block of compiled) {
    const { startTokenIndex: start, endTokenIndex: end } = block;
    if (start === undefined || end === undefined || !(end >= start)) continue;
    owned.set(block.id, end - start + 1);
  }
  return boxes.map((box) => ({
    blockId: box.blockId,
    topY: box.topY,
    bottomY: box.bottomY,
    spokenTokens: owned.get(box.blockId) ?? 0,
  }));
}

/**
 * What inside the line map's span is not text on the glass: the height of the
 * blocks with nothing to read, and any spoken tokens that never reached a line.
 *
 * Wordless is decided by the lines themselves, not by block kind or by the
 * compiler's `spoken` flag: a block is wordless here precisely when it produced
 * no rendered line. That is the question the scale is asking — a kind list would
 * miss the silent block, the cue and the unread heading.
 *
 * Each such run is taken as one envelope, from the top of its first box to the
 * bottom of its last, so the margins between two adjacent wordless blocks go
 * with them — there is nothing to read in those either. And it is clipped to the
 * space between the two spoken lines it sits between, so a box that measured
 * oddly can never eat into the lines themselves: what survives of each step is
 * at least the descent of one line and the ascent of the next, which is about
 * what an ordinary paragraph break costs. The words still get the travel a
 * paragraph boundary would have given them; the screenshot does not.
 *
 * The words come out with the height, and for the same reason. An image whose
 * alt text is read aloud (`readImageAltText`) owns spoken tokens with no anchor
 * on the glass — the picture is their visual form — so they sit between the two
 * lines' token indices exactly as the picture sits between their baselines.
 * Taking the height out and leaving those words in would have the text roll
 * SLOWER than the dial by however much alt text there was. Only the removed
 * blocks' OWN tokens, though (`spokenTokens`, from their compiled ranges):
 * the paragraphs either side can have unanchored tokens too — an inline image's
 * alt text, the extra words of a `say=` pronunciation — and those are paid for
 * by their own paragraph's height, which stays, as they always were.
 *
 * The removed height is not skipped, and it is not hurried either: the transport
 * crosses it at the same pixel rate as the text. A faster crossing is a velocity
 * step at each end of the block, and the plant comes out of one under its jerk
 * limits — which means arriving at the first line after the image still carrying
 * the faster speed. The one stretch of the script with nothing to read is not
 * worth getting the next sentence wrong for, and a presenter who wants past a
 * tall screenshot has the step keys.
 */
function wordlessSpan(
  lines: readonly RenderedLine[],
  blocks: readonly AutoScrollBlockBox[],
): { px: number; words: number } {
  if (blocks.length === 0) return { px: 0, words: 0 };
  // Block ids are unique per compiled document and each block renders one
  // `[data-block-id]` wrapper, so first-seen is the only index there is.
  const order = new Map<string, number>();
  blocks.forEach((box, index) => {
    if (!order.has(box.blockId)) order.set(box.blockId, index);
  });
  const voiced = new Set(lines.map((line) => line.blockId));

  let px = 0;
  let words = 0;
  for (let i = 1; i < lines.length; i++) {
    const above = lines[i - 1];
    const below = lines[i];
    if (!above || !below || above.blockId === below.blockId) continue;
    const from = order.get(above.blockId);
    const to = order.get(below.blockId);
    if (from === undefined || to === undefined || to <= from + 1) continue;

    let topY = Infinity;
    let bottomY = -Infinity;
    let owned = 0;
    for (let k = from + 1; k < to; k++) {
      const box = blocks[k];
      if (!box || voiced.has(box.blockId)) continue;
      // A box that cannot be measured removes nothing: the scale falls back to
      // counting that step as text, which is what it did before any of this.
      if (!Number.isFinite(box.topY) || !Number.isFinite(box.bottomY)) continue;
      if (!(box.bottomY > box.topY)) continue;
      topY = Math.min(topY, box.topY);
      bottomY = Math.max(bottomY, box.bottomY);
      const tokens = box.spokenTokens ?? 0;
      if (tokens > 0 && Number.isFinite(tokens)) owned += tokens;
    }
    const removed = Math.min(bottomY, below.topY) - Math.max(topY, above.bottomY);
    if (!(removed > 0) || !Number.isFinite(removed)) continue;
    px += removed;
    // Never more than the tokens that are genuinely between the two lines: a
    // range that claimed more would be taking words that ARE on the glass.
    words += Math.min(owned, Math.max(0, below.firstTokenIndex - above.lastTokenIndex - 1));
  }
  return { px, words };
}

/**
 * Words per minute to document pixels per second.
 *
 * Zero whenever the answer would be meaningless — no scale, a non-finite or
 * non-positive rate — and zero is a full stop rather than an error, because the
 * caller's response to both is the same: do not advance the target this frame.
 */
export function autoScrollPxPerSecond(
  wordsPerMinute: number,
  scale: AutoScrollScale | null,
): number {
  if (!scale || !Number.isFinite(scale.pxPerWord) || scale.pxPerWord <= 0) return 0;
  if (!Number.isFinite(wordsPerMinute) || wordsPerMinute <= 0) return 0;
  return (wordsPerMinute / 60) * scale.pxPerWord;
}

/** Clamp a requested pace into the offered range, rejecting nonsense. */
export function clampAutoScrollWpm(wordsPerMinute: number): number {
  if (!Number.isFinite(wordsPerMinute)) return AUTO_SCROLL_DEFAULT_WPM;
  return Math.min(AUTO_SCROLL_MAX_WPM, Math.max(AUTO_SCROLL_MIN_WPM, wordsPerMinute));
}

export interface AdvanceInput {
  /** Where the target sits now, document pixels. */
  targetPx: number;
  pxPerSecond: number;
  /** Time since the previous advance. Capped; see AUTO_SCROLL_MAX_FRAME_MS. */
  dtMs: number;
  /** Furthest the document may be scrolled. */
  maxScrollPx: number;
}

/**
 * Advance the auto-scroll target by one frame.
 *
 * The TARGET is what moves here, not the document. Everything downstream of this
 * is the ordinary motion controller: it is handed a goal that creeps forward at
 * a constant rate and it closes on that goal under the same velocity,
 * acceleration and jerk limits every other kind of motion obeys. That is the
 * whole reason auto-scroll is expressed as a moving target rather than as a
 * velocity written into the plant — a second thing allowed to set the plant's
 * speed would be a second definition of how this prompter is permitted to move,
 * and the limits exist because motion on a teleprompter is not a free parameter.
 *
 * It also means the transitions are free. Starting eases in from rest, stopping
 * coasts to a halt, and a manual nudge in the middle is absorbed the same way a
 * correction is, because none of them are special cases here — they are all just
 * the goal moving.
 */
export function advanceAutoScrollTarget(input: AdvanceInput): number {
  const { targetPx, pxPerSecond, dtMs, maxScrollPx } = input;
  const ceiling = Number.isFinite(maxScrollPx) && maxScrollPx > 0 ? maxScrollPx : 0;
  const from = Number.isFinite(targetPx) ? Math.min(Math.max(targetPx, 0), ceiling) : 0;
  if (!Number.isFinite(pxPerSecond) || pxPerSecond <= 0) return from;
  if (!Number.isFinite(dtMs) || dtMs <= 0) return from;

  const dt = Math.min(dtMs, AUTO_SCROLL_MAX_FRAME_MS) / 1000;
  return Math.min(Math.max(from + pxPerSecond * dt, 0), ceiling);
}

/**
 * Has the target reached the end of the script?
 *
 * Worth asking separately from "is it running", because running into the bottom
 * of the document is not a fault and must not be reported as one: the presenter
 * has reached the end of what there was to read. The caller uses this to stand
 * the transport down by itself rather than leave a Pause button live over a
 * document that cannot move.
 *
 * The tolerance is a pixel because the target is fractional and `maxScrollPx` is
 * measured — an exact equality would be true only by luck, and the state it
 * guards would then never be reached at all.
 */
export function autoScrollAtEnd(targetPx: number, maxScrollPx: number): boolean {
  if (!Number.isFinite(targetPx) || !Number.isFinite(maxScrollPx)) return false;
  if (maxScrollPx <= 0) return true;
  return targetPx >= maxScrollPx - 1;
}

export interface NowhereToGoInput {
  /**
   * Spoken tokens the DOCUMENT contains — what the compiler produced, not what
   * the renderer has managed to measure yet.
   *
   * The distinction is the whole point. A measured count is zero for a frame or
   * two after every relayout, and treating that as the end of the script would
   * stand a running transport down mid-roll; the authored count is a property of
   * the script and does not flicker.
   */
  documentTokenCount: number;
  maxScrollPx: number;
}

/**
 * Can this document be rolled at all?
 *
 * Two unrelated ways to answer no, which is why it is worth one function rather
 * than two conditions at the call site.
 *
 * A non-positive scroll range is the obvious one: a script shorter than the
 * glass has nowhere to go.
 *
 * A script with no words is the one that is easy to get wrong, because it does
 * NOT have a zero range. The stage's padding is a viewport plus the reserved
 * future lines, so an empty document is a couple of hundred pixels taller than
 * the glass and its `maxScrollPx` is comfortably positive — while there is
 * nothing on that paper to roll past, no line map can be built from it, and
 * `measureAutoScrollScale` can never derive a pace. It is as finished as a
 * script that ran off the bottom, and the caller has to hear the same answer for
 * both or the empty one is a transport that runs forever and arrives nowhere.
 */
export function autoScrollNowhereToGo(input: NowhereToGoInput): boolean {
  // Deliberately not a finiteness check: a NaN range is a broken measurement,
  // not a finished script, and announcing an end for it would stand the
  // transport down over a rebuild that is about to produce a real number.
  if (input.maxScrollPx <= 0) return true;
  return !(input.documentTokenCount > 0);
}
