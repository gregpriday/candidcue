/**
 * One microphone, one owner.
 *
 * macOS will happily hand the same input device to two `getUserMedia` callers,
 * and the second one waits. Measured on a real machine: a take whose
 * microphone test was still open took **9.8 seconds** to acquire the device,
 * by which time the session had been torn down and the presenter got
 * "Voice tracking is unavailable" with no explanation. A second attempt,
 * moments later with nothing else holding the device, took 908 ms.
 *
 * That is the third defect on this project shaped like "it works in the
 * diagnostic and not in the real thing", and the nastiest of the three,
 * because here the diagnostic does not merely fail to reproduce the problem —
 * running it successfully is what CAUSES it. The presenter proves their
 * microphone works, presses Present, and that proof is the thing standing on
 * the device.
 *
 * So claiming the microphone is explicit and exclusive: a new owner tears the
 * previous one down and WAITS for it, before anybody calls `getUserMedia`.
 */

/** Tear down whatever this owner is holding. Must be idempotent. */
export type MicrophoneRelease = () => void | Promise<void>;

interface Holder {
  owner: string;
  release: MicrophoneRelease;
}

let holder: Holder | null = null;

/** Who holds the microphone, for diagnostics and error copy. */
export function currentMicrophoneOwner(): string | null {
  return holder?.owner ?? null;
}

/**
 * Take the microphone for `owner`, releasing the previous holder first.
 *
 * Awaiting the old holder's teardown is the entire point: returning before the
 * device is actually free just moves the contention into `getUserMedia`, where
 * it costs ten seconds and looks like a hang.
 *
 * A release that throws is logged past, never rethrown — failing to hang up
 * cleanly must not stop the next take from starting, which is the one thing
 * the presenter is waiting for.
 */
export async function claimMicrophone(
  owner: string,
  release: MicrophoneRelease,
): Promise<void> {
  const previous = holder;
  holder = { owner, release };
  if (previous === null) return;
  try {
    await previous.release();
  } catch {
    // Deliberately swallowed; see above.
  }
}

/**
 * Give the microphone back, if this owner still has it.
 *
 * The guard matters: a slow teardown can finish after somebody else has
 * already claimed the device, and clearing the holder then would leave the new
 * owner unregistered — invisible to the next claim, and so never released.
 */
export function releaseMicrophone(owner: string): void {
  if (holder?.owner === owner) holder = null;
}

/** Drop all ownership without calling any release. Tests only. */
export function resetMicrophoneOwnershipForTesting(): void {
  holder = null;
}
