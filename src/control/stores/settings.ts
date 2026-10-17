/**
 * SettingsStore (spec §45.2) — validated settings view with optimistic
 * patching through the settings service.
 */
import { get, writable } from 'svelte/store';
import * as settingsService from '../services/settings';
import { defaultAppSettings, type AppSettings } from '../services/settings-types';
import { describeError } from '../services/errors';
import { showToast } from './toasts';

const state = writable<AppSettings>(defaultAppSettings());
export const settings = { subscribe: state.subscribe };

let loaded = false;

/**
 * Adopt a settings document another window wrote (§14.1).
 *
 * Called by `services/settings-sync.ts` when Rust broadcasts a change. It
 * REPLACES the store rather than merging, because the payload is the whole
 * document at its new revision — merging would leave this window's
 * `expectedRevision` pointing at a version that no longer exists, which is the
 * conflict this whole mechanism exists to prevent.
 *
 * A payload that does not parse is ignored rather than adopted. An event is
 * delivered by evaluating JSON in the webview, so a malformed one is possible in
 * a way a typed command result is not, and replacing a working document with
 * nothing would be far worse than missing one update.
 *
 * `loaded` is set: a window that has been handed the current document has, for
 * every purpose, loaded it.
 */
export function adoptSettings(payload: unknown): boolean {
  const adapted = settingsService.adaptRevisionedSettings(payload);
  if (adapted === null) return false;
  /* A commit — so any read still in flight is stale. See `commitCount`. */
  commitSettings(adapted);
  return true;
}

/**
 * How many times the document has been COMMITTED.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS APPEARED WITH THE SECOND WINDOW
 * ---------------------------------------------------------------------------
 * `loadSettings` used to run at most once per window, from the shell, so there
 * was nothing to race. Three things now write the document at arbitrary
 * moments: a re-read forced by the `storage` event that carries an overlay
 * change between windows, a `settings://changed` broadcast adopted from the
 * other window, and this window's own save. Two of those in flight resolve in
 * whatever order the IPC layer answers, and the later `state.set` wins — so the
 * newest document could be overwritten by an older one that started first, and
 * the next save would fail its optimistic-concurrency check for reasons nobody
 * could see.
 *
 * ---------------------------------------------------------------------------
 * COUNTED ON COMMIT, NOT ON START
 * ---------------------------------------------------------------------------
 * The obvious version of this counts reads as they BEGIN and lets only the
 * newest commit. That is wrong in two ways, and both were real:
 *
 *   - a read that begins and then FAILS still invalidated an older read that
 *     had succeeded, so two reads racing at launch could leave the store never
 *     loaded at all;
 *   - it says nothing about a local save, which is a commit like any other —
 *     so a read that started before a save could still land after it and put
 *     the old value back.
 *
 * Counting commits answers all of it with one rule: a read commits only if
 * nothing else committed while it was in flight. A failed read commits
 * nothing and therefore invalidates nothing.
 */
let commitCount = 0;

/**
 * The last document Rust agreed to — what a refused write rolls back to.
 *
 * Not `get(state)`, which may already be carrying the optimistic values of
 * patches queued behind the one that failed; see `patchSettings`.
 */
let lastCommitted: AppSettings = get(state);

type CommitListener = (value: AppSettings) => void;
const commitListeners = new Set<CommitListener>();

/**
 * Hear every document Rust has agreed to — and nothing else.
 *
 * The store itself also carries this window's optimistic values and their
 * rollbacks, and a listener that wants "what changed in the saved document"
 * cannot tell those apart from a subscription: a refused write shows up as the
 * old values coming BACK, indistinguishable from somebody setting them. The
 * running take's follow (`stores/session.ts`) is exactly that listener, and
 * reacting to a rollback there would put the saved appearance back onto a take
 * whose look the presenter just asked to keep.
 */
export function onSettingsCommitted(listener: CommitListener): () => void {
  commitListeners.add(listener);
  return () => {
    commitListeners.delete(listener);
  };
}

/** Every write to the document goes through here, so nothing is missed. */
function commitSettings(value: AppSettings): void {
  commitCount += 1;
  lastCommitted = value;
  // ONE set, already carrying the queued patches: a subscriber must never see
  // the committed document alone, which would be a slider's value going
  // backwards for the length of a synchronous callback.
  state.set(withQueued(value));
  loaded = true;
  for (const listener of commitListeners) {
    /*
     * Contained. A listener is somebody else's code running inside a save's
     * success path; letting it throw here would leave the batch's callers
     * unsettled and the queue stalled behind them.
     */
    try {
      listener(value);
    } catch (err) {
      console.error('a settings commit listener failed', err);
    }
  }
}

/**
 * A document that has just replaced the store — a commit, or a rollback —
 * with the patches still waiting laid over it.
 *
 * A committed document is Rust's answer to the write BEFORE those patches, so
 * it does not carry them; adopting it as-is would take a slider's newest
 * position off the screen for the length of a round trip, and — worse — the
 * next batch reads the sections it sends off the store, so it would send the
 * committed values back and quietly drop the change it was queued to make.
 */
function withQueued(document: AppSettings): AppSettings {
  if (queued.length === 0) return document;
  const next = { ...document };
  for (const { section, patch } of queued) {
    (next as Record<keyof AppSettings, unknown>)[section] = mergeSection(next[section], patch);
  }
  return next;
}

export async function loadSettings(force = false): Promise<AppSettings> {
  if (loaded && !force) return get(state);
  const committedAt = commitCount;
  const value = await settingsService.getSettings();
  if (commitCount === committedAt) commitSettings(value);
  /*
   * The migrations run WHETHER OR NOT this read committed.
   *
   * They are one-shot upgrades of a stored document, not a consequence of this
   * particular read winning — and when a broadcast arrives mid-read they would
   * otherwise be skipped, permanently: adopting sets `loaded`, so no later
   * unforced `loadSettings` would ever reach them again.
   */
  await adoptStageModeFromOverlay();
  await adoptDisplayPinFromOverlay();
  await adoptOpticalFromOverlay();
  await adoptPanelMirrorFromLegacy();
  return get(state);
}

/**
 * Finish the presentation mode's move out of localStorage.
 *
 * ---------------------------------------------------------------------------
 * WHY A READ TRIGGERS A WRITE, JUST THIS ONCE
 * ---------------------------------------------------------------------------
 * Reading the old overlay as a fallback keeps an upgrading reader in reader
 * mode, and on its own that is only half a migration — Rust still holds
 * nothing, so the day the browser store is cleared they are silently back to
 * prompter. That is the exact failure the move was made to end, so the value
 * has to be written through rather than merely read.
 *
 * It happens here rather than in the service because a getter that writes is a
 * getter nobody can reason about. `pendingStageModeAdoption` reports what the
 * last read found; this acts on it once and then the flag stays null, because
 * the very next read sees a document that has an answer.
 *
 * Silent on failure, and deliberately: this is a migration the operator did not
 * ask for and cannot act on, the fallback keeps working in the meantime, and
 * the next launch tries again. A danger toast during startup for a settings
 * write nobody requested would be noise about a problem that fixes itself.
 */
/**
 * Forget that a migrated document was ever seen.
 *
 * A test seam. The latch that stops these one-shot migrations running twice
 * lives in the SERVICE, next to the raw Rust field it reads — see
 * `resetMigrationStateForTesting` there for why it cannot live here. This is
 * re-exported so a suite that drives the store does not have to know that.
 */
export function resetMigrationLatchesForTesting(): void {
  settingsService.resetMigrationStateForTesting();
}

/**
 * Commit a migration's answer — unless a newer document already stands, in
 * which case keep that one and re-read.
 *
 * Skipping the older answer is not the whole of it. Parsing it rewrote every
 * pending migration (`pending*Adoption` describe the LAST document parsed), so
 * the steps still to run in `loadSettings` would act on the older document's
 * inputs at the newer document's revision — and succeed. The other window
 * pinning a different panel while the mode adoption was in flight is the real
 * case: the mirror adoption then carried the old switch onto the panel that is
 * no longer pinned. A fresh read puts the pending state back on what stands.
 */
async function commitAdoption(saved: AppSettings): Promise<void> {
  if (saved.revision >= lastCommitted.revision) {
    commitSettings(saved);
    return;
  }
  try {
    const current = await settingsService.getSettings();
    if (current.revision >= lastCommitted.revision) commitSettings(current);
  } catch {
    // The newer document still stands; the next launch reads afresh.
  }
}

async function adoptStageModeFromOverlay(): Promise<void> {
  const pending = settingsService.pendingStageModeAdoption();
  if (pending === null) return;
  const before = get(state);
  try {
    const saved = await settingsService.updateSettings(before.revision, {
      stage: { ...before.stage, presentationMode: pending },
    });
    /*
     * Not unconditionally. This write carries the whole stage section, pin
     * included (#272), so the other window unpinning in the meantime and its
     * broadcast landing first is exactly the case where adopting this older
     * answer puts the pin back.
     */
    await commitAdoption(saved);
  } catch {
    // Left to the fallback, and to the next launch.
  }
}

/**
 * The same one-time move for the pinned prompter panel (#272).
 *
 * After the mode, because the mode's adoption writes the whole stage section
 * and so carries the pin with it: when both were waiting, one write moves both
 * and the read it commits reports nothing pending here. This catches the
 * upgrader whose mode moved long ago and whose pin never did.
 *
 * Nothing to forget afterwards: `applyOverlayPatch` drops the overlay copy as
 * part of the write that carried the pin, once Rust has committed it.
 *
 * Silent on failure, like the mode. The fallback still reads the overlay pin,
 * so takes keep opening on the right panel, and the next launch tries again.
 */
async function adoptDisplayPinFromOverlay(): Promise<void> {
  const pending = settingsService.pendingDisplayPinAdoption();
  if (pending === null) return;
  const before = get(state);
  try {
    const saved = await settingsService.updateSettings(before.revision, {
      stage: { ...before.stage, displayFingerprint: pending },
    });
    await commitAdoption(saved);
  } catch {
    // Left to the fallback, and to the next launch.
  }
}

/**
 * The same one-time move for calibrated rigs (§52), and the one that matters
 * most.
 *
 * Every measured viewing distance and lens placement used to live only in the
 * localStorage overlay — cleared by the OS under storage pressure, wiped by a
 * "clear website data" action nobody associates with an app, and written
 * through a `try` that swallowed every failure. A presentation mode somebody
 * loses is one menu click to set again; a viewing distance is a tape measure
 * and a room.
 *
 * Reading the overlay as a fallback would only be half the move: somebody who
 * calibrated last month and has not opened Calibrate since would leave Rust
 * holding nothing, so the measurement still dies with the browser store. The
 * read records what it found and this writes it through once.
 *
 * NOT silent on failure, unlike the mode above. That one has a working
 * fallback and a value the user can restate in a second; this one is the last
 * copy of something they measured. If it cannot be made durable the user needs
 * to know, because the fallback they are relying on is the thing that is about
 * to be cleared.
 */
async function adoptOpticalFromOverlay(): Promise<void> {
  const pending = settingsService.pendingOpticalAdoption();
  if (pending === null) return;
  const before = get(state);
  try {
    const saved = await settingsService.updateSettings(before.revision, {
      optical: pending,
    });
    await commitAdoption(saved);
    /*
     * Only now, and this ordering is the fix.
     *
     * The legacy overlay copy has to outlive the write that adopts it — if the
     * write fails, the fallback the user is relying on must still be there.
     * And it has to be removed once the write lands, or it sits as a second
     * answer: `applyOverlayPatch` skips `optical`, so nothing else would ever
     * clear it, and a user who later deleted their last rig would find it
     * resurrected from the copy.
     */
    settingsService.forgetOverlayOptical();
  } catch (err) {
    showToast(
      'CandidCue could not move your saved teleprompter calibrations into permanent ' +
        `storage, so they are still only in this window's local data. ${describeError(err)}`,
      'danger',
    );
  }
}

/**
 * Write per-panel mirroring through once, carried from the retired global
 * switch and the rigs' own records (#206).
 *
 * After the rigs, never before them: any optical write takes ownership of the
 * section in Rust, so a mirror adoption landing first would strand rigs still
 * waiting in the legacy overlay. And it writes the WHOLE section for the same
 * reason — if the rig adoption above failed, this one carries those rigs too
 * rather than claiming a section it has only half written. When the rig
 * adoption succeeded it already carried the mirror map, and the read that
 * committed it reports nothing left pending here.
 *
 * Silent on failure, like the mode. Every read carries the same answer until
 * one write lands, so the glass stays mirrored in the meantime, and the next
 * launch tries again.
 */
async function adoptPanelMirrorFromLegacy(): Promise<void> {
  const pending = settingsService.pendingPanelMirrorAdoption();
  if (pending === null) return;
  const before = get(state);
  try {
    const saved = await settingsService.updateSettings(before.revision, {
      optical: { ...before.optical, panelMirror: pending },
    });
    /*
     * A commit, like any other — see `commitCount` — unless a newer document
     * already stands. The other window can save after this write and its
     * broadcast can arrive first; adopting this older answer over it would put
     * a mirror back that the operator had just changed. See `commitAdoption`.
     */
    await commitAdoption(saved);
  } catch {
    // Left to the fallback, and to the next launch.
  }
}

/** A patch waiting its turn, with the promise its caller is holding. */
interface QueuedPatch {
  section: keyof AppSettings;
  patch: object;
  resolve: () => void;
  reject: (err: unknown) => void;
}

let queued: QueuedPatch[] = [];
let draining = false;

/**
 * Patch one or more settings fields optimistically; reverts on failure.
 *
 * ---------------------------------------------------------------------------
 * ONE SAVE IN FLIGHT AT A TIME, AND THE REST COALESCE BEHIND IT
 * ---------------------------------------------------------------------------
 * Every write is checked against `expectedRevision`, and this used to send
 * each patch the moment it was asked for, with whatever revision the store
 * held. Drag a slider and it asks thirty times in a second: the first write
 * lands and bumps the revision, and every one already in flight behind it was
 * sent with the revision it just retired — so all of them were refused, each
 * one toasted "Could not save settings", and the screen filled with a column
 * of identical errors for a value that had in fact been saved.
 *
 * So the writes are serialised. A patch made while one is in flight is
 * applied to the store immediately — the optimism is unchanged — and queued;
 * when the in-flight write settles, everything queued since is merged into ONE
 * write, sent with the revision that write handed back. A drag costs a handful
 * of saves rather than one per pixel, none of them can be stale, and every
 * caller's promise still settles with the outcome of the write that carried
 * its change.
 */
export function patchSettings<K extends keyof AppSettings>(
  section: K,
  patch: Partial<AppSettings[K]>,
): Promise<void> {
  /*
   * Deliberately NOT a commit.
   *
   * This is the optimistic half — shown immediately, and rolled back if the
   * write that carries it is refused. Counting it would make a value that may
   * never exist invalidate a read that is about to deliver a real one. The
   * commit is the `commitSettings(saved)` in `sendPatchBatch`, once Rust has
   * agreed.
   */
  state.update((current) => ({
    ...current,
    [section]: mergeSection(current[section], patch as object),
  }));
  return new Promise<void>((resolve, reject) => {
    queued.push({ section, patch: patch as object, resolve, reject });
    if (!draining) void drainQueuedPatches();
  });
}

async function drainQueuedPatches(): Promise<void> {
  draining = true;
  try {
    while (queued.length > 0) {
      const batch = queued;
      queued = [];
      try {
        await sendPatchBatch(batch);
      } catch (err) {
        // `sendPatchBatch` settles its own callers on every ordinary path;
        // this is the containment for an exceptional one — a subscriber
        // throwing out of a rollback — so the callers still hear an answer
        // and the loop goes on to the patches queued behind them.
        for (const entry of batch) entry.reject(err);
      }
    }
  } finally {
    draining = false;
  }
}

/** The section with the patch laid over it — or the patch, for a scalar section. */
function mergeSection(current: unknown, patch: object): unknown {
  return typeof current === 'object' && current !== null ? { ...current, ...patch } : patch;
}

async function sendPatchBatch(batch: QueuedPatch[]): Promise<void> {
  /*
   * The sections as the store shows them NOW — every patch in the batch has
   * already been laid over the store, in order, so the store's copy of each
   * section is the merged result. The revision is the store's too: optimistic
   * updates never touch it, so it is always the one Rust last handed back.
   */
  const before = lastCommitted;
  const current = get(state);
  const payload: Partial<AppSettings> = {};
  for (const { section } of batch) {
    (payload as Record<keyof AppSettings, unknown>)[section] = current[section];
  }
  const committedAt = commitCount;
  try {
    const saved = await settingsService.updateSettings(current.revision, payload);
    /*
     * A commit, so a read that started before this one cannot land after it
     * and put the old value back. See `commitCount`.
     *
     * Unless a NEWER document already stands. The other window can write the
     * revision after ours and Rust can broadcast it before our own answer
     * arrives — event and response ordering is not something this store can
     * enforce — and adopting our older answer over it would send the next
     * batch stale. Equal revisions still commit: an overlay-only write hands
     * back the current document at the current revision, and its sections
     * have changed.
     */
    if (saved.revision >= lastCommitted.revision) commitSettings(saved);

    /*
     * A local-storage failure is reported, not swallowed.
     *
     * `saveOverlay` used to wrap its write in a bare `catch {}`, so a quota
     * error or disabled storage meant every per-machine preference silently
     * reverted at the next launch — repeatedly, with this screen reporting
     * success each time.
     *
     * Not a thrown error and not a revert: the authoritative half has already
     * committed by the time this runs, and what is left in the overlay after
     * calibrated rigs moved to Rust is presentation and capture state rather
     * than measured data. Losing it is annoying, not destructive; being lied
     * to about it is the actual problem.
     */
    const overlayFailure = settingsService.overlayStorageFailure();
    if (overlayFailure !== null) {
      showToast(
        'That setting was saved, but CandidCue could not store this window’s local ' +
          `preferences, so some of them will reset next launch. ${overlayFailure}`,
        'danger',
      );
    }
  } catch (err) {
    /*
     * Roll back ONLY IF nothing else committed meanwhile.
     *
     * The optimistic value is this window's guess and the rollback undoes it —
     * but "undo" means "put back what was there", and what was there may have
     * been replaced while the write was in flight. The other window saving, and
     * this window adopting the broadcast, is exactly that: restoring `before`
     * unconditionally would discard a document that is newer than the one this
     * save started from, and leave the store holding a revision that no longer
     * exists.
     *
     * When something did commit, the newer document stands. This save failed
     * and changed nothing, which is what the toast says either way.
     */
    if (commitCount === committedAt) state.set(withQueued(before));
    showToast('Could not save settings. Nothing was changed.', 'danger');
    for (const entry of batch) entry.reject(err);
    return;
  }
  for (const entry of batch) entry.resolve();
}

export function getSettingsSnapshot(): AppSettings {
  return get(state);
}
