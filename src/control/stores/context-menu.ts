/**
 * The one open context menu (desktop refinement §20.1).
 *
 * A store rather than component-local state, because the menu is hosted once by
 * the shell and requested from anywhere. That arrangement makes two properties
 * true by construction rather than by everybody remembering them: at most one
 * menu is open in the window, and opening a second closes the first.
 *
 * It also keeps the FOCUS RESTORATION honest. §30.5 requires that closing a menu
 * returns focus to the control that opened it, and the only place that reliably
 * knows what that was is the moment of opening — so the trigger is captured here
 * rather than re-derived when the menu closes, by which time the row may have
 * been re-rendered, sorted away or deleted.
 */
import { get, writable, type Readable } from 'svelte/store';

export interface ContextMenuItem {
  label: string;
  /** A right-aligned key hint, already formatted for this platform. */
  shortcut?: string;
  /** Present only on checkable rows; its presence reserves the tick column. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a hairline above this item — destructive actions sit below one. */
  separated?: boolean;
  onselect: () => void;
}

export interface ContextMenuRequest {
  /** Viewport coordinates of the pointer, or of the row for a keyboard menu. */
  x: number;
  y: number;
  label: string;
  items: ContextMenuItem[];
  /** Focused again when the menu closes by Escape or by choosing an item. */
  trigger: HTMLElement | null;
}

const state = writable<ContextMenuRequest | null>(null);

export const contextMenu: Readable<ContextMenuRequest | null> = { subscribe: state.subscribe };

/**
 * Open a context menu at a point.
 *
 * An empty item list is DECLINED rather than rendered. A zero-row popover is a
 * one-pixel box that appears and eats the next click, and the caller that
 * produced it (a row whose every action turned out to be unavailable) has said
 * clearly enough that there is nothing to offer.
 */
export function openContextMenu(request: ContextMenuRequest): void {
  if (request.items.length === 0) return;
  state.set(request);
}

/**
 * Close it.
 *
 * `restoreFocus` is false for a dismissal the user made by clicking elsewhere —
 * they have already chosen where they want to be, and yanking focus back to the
 * row they right-clicked would undo it. It is true for Escape and for choosing
 * an item, which are both ways of saying "I am finished here", and where losing
 * focus to the document body strands a keyboard user.
 */
export function closeContextMenu(restoreFocus: boolean): void {
  const current = get(state);
  state.set(null);
  if (restoreFocus && current?.trigger?.isConnected) current.trigger.focus();
}

/**
 * Where a keyboard-invoked context menu should open.
 *
 * The Menu key and Shift+F10 carry no coordinates, so a menu opened by them has
 * to be placed against the focused element instead — near its leading edge and
 * just below it, which is where every platform puts one.
 */
export function anchorFor(element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: Math.round(rect.left + 12), y: Math.round(rect.bottom - 4) };
}
