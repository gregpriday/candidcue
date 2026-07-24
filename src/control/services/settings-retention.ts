/**
 * §32.2 consent revocation for the coaching retention toggles.
 *
 * ---------------------------------------------------------------------------
 * ONE POLICY, NOT TWO.
 * ---------------------------------------------------------------------------
 * `shared/coaching/review/report-store.ts` already decided what a retention
 * consent means, and it is not "stop writing":
 *
 *   > `saveReport: false` → the report is deleted, not merely not written. A
 *   > toggle the user turned off must remove what an earlier session left.
 *
 * It applies that rule on **every** save whose consent is off, not only on the
 * transition — so a purge that failed once is retried, and a document written
 * by a build that ignored the toggle is cleaned up the next time the user
 * saves. This module is the settings-screen half of the same rule, and it is
 * deliberately shaped the same way:
 *
 * - a patch that *sets a consent to false* revokes it, whether or not it was
 *   already false, so the operation is idempotent and self-healing;
 * - revocation deletes across **all** sessions, because the settings screen is
 *   not talking about one take;
 * - a purge failure is surfaced, never swallowed — the user has just been told
 *   what is no longer kept.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PURGERS ARE A REGISTRY.
 * ---------------------------------------------------------------------------
 * Nothing writes a coaching report or an audio recording to disk yet: the
 * §36.2 `coaching_sessions` tables have no Rust implementation and no recorder
 * exists, so `ReviewReportPersistence` has no real backend. Rather than
 * pretend to delete bytes that are not there — or, worse, leave the rule to be
 * remembered later by whoever builds the store — the seam exists now and is
 * empty. The review lane registers its purger next to the persistence it
 * writes, and revocation starts working the moment there is something to
 * revoke.
 *
 * The transcript consent is NOT here: it is `general.saveTranscript`, and Rust
 * enforces it inside `update_settings` against the rows it owns.
 */
import type { AppSettings } from './settings-types';

/** The consents this module can revoke. Transcript is Rust-owned (§36.2). */
export type RetentionKind = 'coaching_report' | 'audio_recording';

/**
 * Delete everything stored under one consent, for every session.
 *
 * Implementations must be safe to call when nothing is stored — revocation
 * runs on every save that leaves the consent off, not only on the transition.
 */
export type RetentionPurger = () => Promise<void>;

const purgers = new Map<RetentionKind, RetentionPurger>();

/**
 * Register the purge for one consent. Called by the lane that owns the bytes
 * (the review store for reports, the recorder for audio), not by the settings
 * screen — the settings screen must not know where anything is kept.
 */
export function registerRetentionPurger(kind: RetentionKind, purge: RetentionPurger): void {
  purgers.set(kind, purge);
}

/** Test seam. */
export function clearRetentionPurgers(): void {
  purgers.clear();
}

/**
 * Which consents a patch turns off.
 *
 * `false` — not "changed to false". A patch that re-asserts a consent is off
 * re-runs the purge, which is how a purge that failed the first time is
 * eventually completed. `undefined` (the key is absent) revokes nothing.
 */
export function revokedRetentions(patch: Partial<AppSettings>): RetentionKind[] {
  const coaching = patch.coaching;
  if (!coaching) return [];
  const revoked: RetentionKind[] = [];
  if (coaching.postTakeReportEnabled === false) revoked.push('coaching_report');
  if (coaching.retainAudioRecordingEnabled === false) revoked.push('audio_recording');
  return revoked;
}

export interface RetentionRevocationResult {
  /** Consents whose purge ran to completion (including "nothing was stored"). */
  purged: RetentionKind[];
  /** Consents with no registered purger — nothing of that kind is stored yet. */
  unclaimed: RetentionKind[];
  /** Purges that threw. The caller must not report the revocation as complete. */
  failed: Array<{ kind: RetentionKind; error: unknown }>;
}

/**
 * Run every purge the patch revokes.
 *
 * Never throws: a settings write that succeeded must not be reported as failed
 * because a deletion did. The caller decides what to say about `failed`, and
 * `updateSettings` says it out loud rather than swallowing it.
 */
export async function runRetentionRevocation(
  patch: Partial<AppSettings>,
): Promise<RetentionRevocationResult> {
  const result: RetentionRevocationResult = { purged: [], unclaimed: [], failed: [] };
  for (const kind of revokedRetentions(patch)) {
    const purge = purgers.get(kind);
    if (!purge) {
      result.unclaimed.push(kind);
      continue;
    }
    try {
      await purge();
      result.purged.push(kind);
    } catch (error) {
      result.failed.push({ kind, error });
    }
  }
  return result;
}

/** What the user is told when a purge failed. Named, never generic. */
export const RETENTION_PURGE_FAILURE: Record<RetentionKind, string> = {
  coaching_report:
    'The setting was saved, but previously saved coaching reports could not be deleted. They are still on this device.',
  audio_recording:
    'The setting was saved, but previously saved audio recordings could not be deleted. They are still on this device.',
};
