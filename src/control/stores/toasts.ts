/**
 * Notification store (spec §45.2 NotificationStore) backing the Toast region.
 */
import { writable, type Readable } from 'svelte/store';

export type ToastTone = 'info' | 'success' | 'danger';

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

const store = writable<Toast[]>([]);
export const toasts: Readable<Toast[]> = { subscribe: store.subscribe };

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function showToast(
  message: string,
  tone: ToastTone = 'info',
  options?: { durationMs?: number },
): number {
  const id = nextId;
  nextId += 1;
  store.update((list) => [...list, { id, tone, message }]);
  const duration = options?.durationMs ?? 4000;
  if (duration > 0) {
    timers.set(
      id,
      setTimeout(() => dismissToast(id), duration),
    );
  }
  return id;
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
