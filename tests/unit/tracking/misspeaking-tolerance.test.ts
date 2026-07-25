/**
 * TOLERANCE — a presenter who misspeaks is still followed.
 *
 * `liveness.test.ts` proved the cursor reaches the end of the script, and it
 * does so with mechanically verbatim text: its spoken words are generated from
 * `document.spokenTokens[].surface`, so across the whole tracking suite there
 * are 8 inserted fillers, 5 substituted words and no mis-transcriptions at all.
 * It varies document topology thoroughly and speech accuracy hardly at all,
 * which means it can only ever answer "does a perfect reader reach the end".
 *
 * Nobody reads a script perfectly. The product's claim is that it follows word
 * by word *with a lot of tolerance for incorrect words and misspeaking*, and
 * that claim had no test.
 *
 * These are trajectory assertions, not endpoint ones, because the failure being
 * measured is not that the cursor fails to arrive — it is that the cursor stops
 * moving for several seconds of perfectly correct speech after one bad
 * utterance. On a stage that is the whole failure: the presenter is reading and
 * the script is standing still.
 *
 * `garble` is a FRACTION of an utterance's content words, not a count. It was a
 * count first, and in fixtures whose sentences run seven to nine words a
 * request for "six wrong words" silently produced two — the tests passed while
 * exercising a quarter of the divergence they claimed. Stopwords are never
 * substituted; the weak-match tier treats those as nearly free, so swapping
 * them would not be misspeaking in any sense the aligner cares about.
 */
import { describe, expect, it } from 'vitest';
import { runPlayback } from '../../../src/shared/tracking/playback-harness';
import { scenarioMisspokenReadThrough } from '../../fixtures/alignment/playback-scenarios';
import { demoDocument } from '../../fixtures/alignment/fixture-script';

const doc = demoDocument();
const LAST_TOKEN = doc.spokenTokens.length - 1;

/**
 * Each scenario replays a whole script through the real engine and takes about
 * two seconds on an idle machine. Vitest's 5 s default left almost no headroom,
 * and these went red purely from running alongside the rest of the suite — a
 * test that fails because other tests are running teaches nothing and trains
 * people to re-run until green.
 */
const TOLERANCE_TIMEOUT_MS = 30_000;

/**
 * Committed cursor sampled once per utterance, at the action that ends it.
 *
 * The boundaries come from the scenario, not from the trace. Recovering them
 * by watching the committed value change is the one thing that cannot work
 * here: a stall is the ABSENCE of a change, so collapsing repeats erases every
 * stall. (It did. This helper read the trace on its first draft, all three
 * tests passed against unfixed code, and the only clue was that a defect
 * measured minutes earlier had apparently evaporated.)
 */
function committedPerUtterance(
  result: ReturnType<typeof runPlayback>,
  endOfTurn: readonly number[],
): number[] {
  return endOfTurn.map((action) => result.committedAfterAction[action] ?? 0);
}

describe('a presenter who misspeaks is still followed', () => {
  it('keeps advancing through verbatim speech that follows a stumble', () => {
    /*
     * Utterance 2 is improvised — every content word replaced, which is a
     * presenter who has lost their place and is talking their way back to it.
     * Utterances 3 onward are read exactly as written, and those are the ones
     * that have to move.
     *
     * Before the multi-tail fix this stalled for two utterances and dropped to
     * `lost_local`; commit confidence came only from the 30-token rolling tail,
     * so the ruined utterance stayed in the denominator until it scrolled out.
     */
    const scenario = scenarioMisspokenReadThrough(
      'T.1',
      'One fully improvised utterance in an otherwise verbatim read.',
      doc,
      { garble: new Map([[2, 1]]) },
    );
    const result = runPlayback(scenario);
    const committed = committedPerUtterance(result, scenario.endOfTurn);

    expect(scenario.wordsChanged[2], 'the utterance must really be garbled').toBeGreaterThan(3);

    // Count verbatim utterances that left the cursor exactly where the previous
    // one did. One is allowed: the utterance straight after the stumble is
    // genuinely ambiguous evidence and holding through it is correct.
    const stalled: number[] = [];
    for (let i = 3; i < committed.length; i++) {
      if (committed[i] === committed[i - 1]) stalled.push(i);
    }
    expect(
      stalled.length,
      `the cursor did not move on verbatim utterance(s) ${JSON.stringify(stalled)} after a ` +
        `stumble at utterance 2; per-utterance committed trace was ${JSON.stringify(committed)}`,
    ).toBeLessThanOrEqual(1);
  }, TOLERANCE_TIMEOUT_MS);

  it('reaches the end despite the stumble, without cheating to get there', () => {
    const scenario = scenarioMisspokenReadThrough(
      'T.2',
      'One fully improvised utterance in an otherwise verbatim read.',
      doc,
      { garble: new Map([[2, 1]]) },
    );
    const result = runPlayback(scenario);
    expect(result.committedAfterAction.at(-1) ?? 0).toBeGreaterThanOrEqual(LAST_TOKEN - 8);
    expect(result.prohibitedJumps).toHaveLength(0);
  }, TOLERANCE_TIMEOUT_MS);

  it('follows a presenter who fluffs a word in every single utterance', () => {
    /*
     * Sustained low-grade divergence — a fifth of the content words wrong, in
     * every utterance, which is an ordinary nervous read rather than a
     * breakdown. Nothing here should ever be dramatic.
     */
    const garble = new Map<number, number>();
    for (let i = 0; i < 40; i++) garble.set(i, 0.2);
    const scenario = scenarioMisspokenReadThrough(
      'T.3',
      'Every utterance carries a wrong word or two.',
      doc,
      { garble },
    );
    const result = runPlayback(scenario);

    expect(
      result.committedAfterAction.at(-1) ?? 0,
      'a presenter who fluffs a word per sentence must still be followed to the end',
    ).toBeGreaterThanOrEqual(LAST_TOKEN - 12);
    expect(result.prohibitedJumps).toHaveLength(0);
  }, TOLERANCE_TIMEOUT_MS);

  /*
   * KNOWN DEFECT — not fixed, deliberately pinned.
   *
   * A FLUENT reader (two sentences per breath, ~18 words, which is what the
   * realtime VAD actually emits for someone not pausing at every full stop) who
   * misspeaks half of one utterance wedges the cursor permanently:
   *
   *   committed = [18, 42, 42, 42, 42, 42, 42]
   *   states    = [acquiring, following, lost_local, adlib_hold, adlib_hold, …]
   *
   * Every utterance after the third is verbatim and the cursor never moves
   * again for the rest of the script. `adlib_hold` is only a projection of
   * `searching` while the best candidate is still near the cursor, and the
   * candidate windows are banded around that same stale cursor — so the state
   * that says "the presenter is ad-libbing near here" is partly self-fulfilling.
   *
   * Connecting the short tails to the commit decision fixed the one-sentence
   * case and did NOT fix this one, so the remaining cause is separate and is
   * not yet understood well enough to change safely.
   *
   * `it.fails` is used rather than deleting the evidence: the suite stays green,
   * the defect stays visible, and the day someone fixes it this test goes red
   * and asks to be promoted to a real assertion.
   */
  it.fails('KNOWN DEFECT: a fluent reader who misspeaks once is wedged forever', () => {
    const scenario = scenarioMisspokenReadThrough(
      'T.4',
      'A two-sentences-per-breath read with one half-misspoken utterance.',
      doc,
      { garble: new Map([[2, 0.5]]), sentencesPerTurn: 2 },
    );
    const result = runPlayback(scenario);
    const committed = committedPerUtterance(result, scenario.endOfTurn);
    const stalled: number[] = [];
    for (let i = 3; i < committed.length; i++) {
      if (committed[i] === committed[i - 1]) stalled.push(i);
    }
    expect(
      stalled.length,
      `verbatim utterances that did not move the cursor: ${JSON.stringify(stalled)}; ` +
        `trace ${JSON.stringify(committed)}`,
    ).toBeLessThanOrEqual(1);
  }, TOLERANCE_TIMEOUT_MS);
});
