/**
 * Promise-based confirmation sheet (Appendix F.19 destructive confirmations).
 * One ConfirmHost in App.svelte renders the pending request.
 */
import { writable, type Readable } from 'svelte/store';

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PendingConfirm {
  request: ConfirmRequest;
  resolve: (accepted: boolean) => void;
}

const store = writable<PendingConfirm | null>(null);
export const pendingConfirm: Readable<PendingConfirm | null> = { subscribe: store.subscribe };

/**
 * Ask, and resolve with the answer.
 *
 * There is one sheet, so a second request REPLACES the first — and the first is
 * answered "no" on the way out rather than left pending. It used to be
 * dropped: nothing would ever resolve it, so whoever awaited it stayed
 * suspended for the life of the window. File › Close Window made that a dead
 * key — ⌘W, then ⌘. raising End Take's own question over it, and every later
 * ⌘W was refused as "a close is already in flight". Declining is the only safe
 * answer to a question that is no longer on screen: nobody agreed to it.
 */
export function requestConfirm(request: ConfirmRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    store.update((pending) => {
      pending?.resolve(false);
      return { request, resolve };
    });
  });
}

export function settleConfirm(accepted: boolean): void {
  store.update((pending) => {
    pending?.resolve(accepted);
    return null;
  });
}
