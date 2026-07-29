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
   * `line` and `para` are debug metadata the engine never reads, so a compiled
   * script that is missing its block or sentence lists must still produce a
   * usable token stream. Throwing here would take alignment down for a take
   * whose SPOKEN TOKENS were perfectly fine — a total loss of following in
   * exchange for a diagnostic ordinal.
   */
  const blockOrdinals = new Map<string, number>();
  (compiled.blocks ?? []).forEach((block, index) => blockOrdinals.set(block.id, index));
  const sentenceOrdinals = new Map<string, number>();
  (compiled.sentences ?? []).forEach((sentence, index) =>
    sentenceOrdinals.set(sentence.id, index),
  );

  return (compiled.spokenTokens ?? []).map((token) => ({
    surface: token.surface,
    line: sentenceOrdinals.get(token.sentenceId) ?? 0,
    para: blockOrdinals.get(token.blockId) ?? 0,
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
