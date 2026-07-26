/**
 * Notification store (spec §45.2 NotificationStore) backing the Toast region.
 */
import { writable, type Readable } from 'svelte/store';

export type ToastTone = 'info' | 'success' | 'danger';

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  /**
   * Identity of the CONDITION this toast reports, when it has one.
   *
   * A keyed toast replaces the previous toast with the same key instead of
   * stacking beside it, and can be retracted when the condition ends. Both
   * halves matter: "no sound is reaching the microphone" is a state, not an
   * event, so it must appear once and disappear by itself when sound comes
   * back. Without this, a take with four ordinary pauses between sentences
   * left four permanent notices — `danger` toasts never expire — which the
   * presenter met all at once, minutes later, on a take that had worked.
   */
  key?: string;
}

const store = writable<Toast[]>([]);
export const toasts: Readable<Toast[]> = { subscribe: store.subscribe };

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Default lifetime by severity. A failure that scrolls away on a timer is a
 * failure the operator cannot act on, so `danger` sticks until it is
 * dismissed; informational notices still clear themselves.
 */
export const DEFAULT_TOAST_DURATION_MS: Record<ToastTone, number> = {
  info: 4000,
  success: 4000,
  danger: 0,
};

export function showToast(
  message: string,
  tone: ToastTone = 'info',
  options?: { durationMs?: number; key?: string },
): number {
  const id = nextId;
  nextId += 1;
  const key = options?.key;
  if (key !== undefined) dismissToastByKey(key);
  store.update((list) => [
    ...list,
    { id, tone, message, ...(key === undefined ? {} : { key }) },
  ]);
  const duration = options?.durationMs ?? DEFAULT_TOAST_DURATION_MS[tone];
  if (duration > 0) {
    timers.set(
      id,
      setTimeout(() => dismissToast(id), duration),
    );
  }
  return id;
}

/**
 * Retract the notice for a condition that has ended.
 *
 * Safe to call when nothing is showing — "the microphone came back" fires far
 * more often than "the microphone went away", because the level monitor
 * reports on every buffer.
 */
export function dismissToastByKey(key: string): void {
  let doomed: number[] = [];
  store.update((list) => {
    doomed = list.filter((t) => t.key === key).map((t) => t.id);
    return doomed.length === 0 ? list : list.filter((t) => t.key !== key);
  });
  for (const id of doomed) {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }
}

/**
 * Drop every keyed notice — the end of a take.
 *
 * A take's warnings belong to that take. Left standing they greet the
 * presenter on the summary screen, describing a microphone that is no longer
 * being used, which reads as a fresh problem rather than an old one.
 */
export function clearConditionToasts(): void {
  let doomed: number[] = [];
  store.update((list) => {
    doomed = list.filter((t) => t.key !== undefined).map((t) => t.id);
    return doomed.length === 0 ? list : list.filter((t) => t.key === undefined);
  });
  for (const id of doomed) {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  store.update((list) => list.filter((t) => t.id !== id));
}

export function clearToasts(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  store.set([]);
}
