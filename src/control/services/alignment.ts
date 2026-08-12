/**
 * Control's half of speech-to-script alignment.
 *
 * The engine itself is in Rust (`crates/cc-align`, hosted in
 * `src-tauri/src/align`), fed directly by the recogniser. Control does not
 * sit in that path at all — which is the point. What lives here is the small
 * remainder:
 *
 *   - handing Rust the script's spoken tokens when a take starts;
 *   - listening for the snapshots Rust publishes, for progress and the take
 *     summary;
 *   - forwarding an explicit "I am here" when the presenter navigates.
 *
 * There is no aligner, no ledger, no tokenizer and no worker on this side any
 * more. Everything that used to be here is now one `invoke` and one event
 * subscription, because the thing it was doing is being done somewhere it can
 * see the audio clock.
 */
import type { AlignmentSnapshot, CompiledScript } from '../../shared/contracts';
import { CONTROL_EVENT, isAlignmentSnapshot } from '../../shared/contracts';
import { ipcInvoke, isTauriRuntime } from './ipc';

/**
 * One spoken token, in the shape `cc_align::TokenInput` deserializes.
 *
 * `surface` is the AUTHORED text and must not be pre-split: `$12` goes across
 * as `$12`, and the engine decides it is two spoken words. Splitting it here
 * would make this a tokenizer, and the whole design depends on there being
 * exactly one of those.
 */
export interface AlignToken {
  surface: string;
  /**
   * A monotone locator carried through to the engine's atoms for diagnostics.
   * The engine never reads it. Sentence ordinal is used rather than a source
   * line because a compiled script does not carry its source text, and a
   * sentence is the finest real locator available here.
   */
  line: number;
  /** Block ordinal — a spoken paragraph, which is what the engine calls a para. */
  para: number;
  /**
   * The last token of its sentence. Unlike `line` and `para`, the engine DOES
   * read this: it brakes forward prediction here, so the display stops at the
   * full stop the reader is about to pause on instead of running into a
   * sentence they have not started.
   *
   * It has to be sent because it cannot be recovered downstream: `tokenize.ts`
   * never keeps a TERMINAL dot, so `surface` reaches the engine as `end` and
   * never `end.`, and the punctuation is gone before this point. What survives
   * is the compiler's own segmentation, which knows that `Dr.` and `3.14` are
   * not boundaries, and that is what this carries.
   */
  sentenceEnd: boolean;
}

/**
 * Project a compiled script into the token list the engine compiles against.
 *
 * The ORDER and the COUNT are the contract: every snapshot position is a
 * fractional index into this array, and the stage resolves those indexes
 * through `spokenTokens` geometry it measured itself. So this must be exactly
 * `compiled.spokenTokens`, in order, with nothing filtered — a token dropped
 * here shifts every position after it.
 */
export function alignTokensFor(compiled: CompiledScript): AlignToken[] {
  /*
   * A compiled script missing its block or sentence lists must still produce a
   * usable token stream. Throwing here would take alignment down for a take
   * whose SPOKEN TOKENS were perfectly fine — a total loss of following in
   * exchange for an ordinal.
   *
   * `line` really is only a diagnostic. `para` is NOT: the engine builds its
   * paragraph table from it, and that table is the outer bound on how far the
   * display may be carried past the reader. A block list that fails to load
   * collapses every token into paragraph 0, which is one long paragraph and a
   * looser ceiling — degraded, still safe, and worth knowing about.
   */
  const blockOrdinals = new Map<string, number>();
  (compiled.blocks ?? []).forEach((block, index) => blockOrdinals.set(block.id, index));
  const sentenceOrdinals = new Map<string, number>();
  const sentenceEnds = new Set<number>();
  (compiled.sentences ?? []).forEach((sentence, index) => {
    sentenceOrdinals.set(sentence.id, index);
    sentenceEnds.add(sentence.endTokenIndex);
  });

  return (compiled.spokenTokens ?? []).map((token) => ({
    surface: token.surface,
    line: sentenceOrdinals.get(token.sentenceId) ?? 0,
    para: blockOrdinals.get(token.blockId) ?? 0,
    /*
     * A GRAMMATICAL sentence end, with the navigation unit as the fallback.
     *
     * These were the same thing, and the conflation was a following defect:
     * `SentenceUnit` is a NAVIGATION unit, and a list item is deliberately one
     * of them however many sentences it contains (§25.5, see `singleSentence`
     * in `compile.ts`). So a multi-sentence bullet reported ONE boundary — at
     * the end of the item — and the display could be carried straight across
     * the full stop inside it. Prose got the braking; a bulleted script did
     * not.
     *
     * The compiler now publishes `grammaticalSentenceEnd` alongside, from the
     * real segmentation rather than the collapsed one, and it is identical to
     * the navigation end for an ordinary paragraph — which is why nothing
     * changes for prose.
     *
     * The fallback matters for a document compiled by an older build: it has
     * no `grammaticalSentenceEnd` at all, and reading that as "no sentence
     * ends anywhere" would take the engine back to braking only at paragraph
     * ends. `??` on the boolean rather than `||`, so an explicit `false` from
     * a future compiler is respected.
     */
    sentenceEnd: token.grammaticalSentenceEnd ?? sentenceEnds.has(token.index),
  }));
}

/**
 * Begin aligning `compiled` against the transcription session `generation`.
 *
 * The generation ties the two together so a frame from a socket that has
 * already been replaced can never reach a newer engine — Rust checks it on
 * every frame, and this is where the pairing is established.
 */
export async function startAlignment(
  generation: number,
  compiled: CompiledScript,
): Promise<void> {
  const tokens = alignTokensFor(compiled);
  if (tokens.length === 0) return;
  await ipcInvoke<void>('start_alignment', { generation, tokens });
}

export async function stopAlignment(): Promise<void> {
  await ipcInvoke<void>('stop_alignment', {});
}

/**
 * "I am here" — a tapped paragraph, a jump-to-section, a sentence step.
 *
 * Resets evidence continuity inside the engine, so speech from before the move
 * can never drag the cursor back to where it was.
 */
export async function setAlignmentPosition(token: number): Promise<void> {
  if (!Number.isFinite(token) || token < 0) return;
  await ipcInvoke<void>('set_alignment_position', { token });
}

/**
 * "Re-find me here" — the presenter says the follower is in the wrong place.
 *
 * A different act from [`setAlignmentPosition`], and it took a dedicated
 * command to stop being the same one. "I am here" asserts a position; this
 * says "I am somewhere on this screen and you are wrong", so the engine
 * reopens its search over the visible range and HOLDS the display until
 * evidence arrives, rather than asserting a lock the presenter has just
 * disputed.
 *
 * Takes no range. The engine reopens its search over the viewport the STAGE
 * already reports (`stage://viewport-hint`) — the tokens actually on the
 * glass. A range computed here would be the control window's second opinion
 * about what the reader can see, and the first version of this computed it
 * from the engine's own current position: the one place it is demonstrably
 * not finding them.
 */
export async function reacquireAlignment(): Promise<void> {
  await ipcInvoke<void>('reacquire_alignment');
}

/**
 * Subscribe to the snapshots Rust publishes to this window.
 *
 * Payloads are validated before they reach the handler: they arrive over an
 * event channel, and a consumer that took them on trust would be one malformed
 * message away from `NaN` in the progress meter.
 */
export function subscribeAlignmentSnapshots(
  handler: (snapshot: AlignmentSnapshot) => void,
): () => void {
  if (!isTauriRuntime()) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    const stop = await listen<unknown>(CONTROL_EVENT.alignmentSnapshot, (event) => {
      if (isAlignmentSnapshot(event.payload)) handler(event.payload);
    });
    if (cancelled) stop();
    else unlisten = stop;
  })().catch(() => {
    // No alignment feed is a degraded session, not a broken one: the take still
    // records and the script still shows. Nothing to escalate from here.
  });
  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = null;
  };
}
