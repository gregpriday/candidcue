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

export function requestConfirm(request: ConfirmRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    store.set({ request, resolve });
  });
}

export function settleConfirm(accepted: boolean): void {
  store.update((pending) => {
    pending?.resolve(accepted);
    return null;
  });
}
