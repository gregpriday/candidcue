/**
 * Notification store (spec §45.2 NotificationStore) backing the Toast region.
 */
import { get, writable, type Readable } from 'svelte/store';

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
  /**
   * One thing the reader can do about it, right there (#303).
   *
   * A notice that names a remedy the reader then has to go and find is the
   * unfollowable-instruction defect in its smallest form: "allow it in System
   * Settings" meant three menus deep, during a take, with the prompter up.
   * The toast stays after the action runs — the action starts a remedy, it does
   * not prove one worked, and the condition's own retraction is what clears it.
   */
  action?: ToastAction;
  /**
   * How many times this exact notice has arrived while it was showing, when
   * that is more than once. A retried copy that fails three times is one card
   * saying so, not three cards to dismiss (see `showToast`).
   */
  count?: number;
}

export interface ToastAction {
  label: string;
  /** Fire-and-forget; whatever it starts reports its own failures. */
  run: () => void;
}

const store = writable<Toast[]>([]);
export const toasts: Readable<Toast[]> = { subscribe: store.subscribe };

let nextId = 1;

/**
 * A passing notice's countdown. It keeps what is left of its lifetime rather
 * than a bare timeout handle, so the countdown can stop while somebody is
 * reading or reaching for the notice and resume from where it was.
 */
interface Countdown {
  handle: ReturnType<typeof setTimeout> | null;
  remainingMs: number;
  startedAt: number;
}

const timers = new Map<number, Countdown>();

/** True while the pointer or keyboard focus is on the stack (`holdToasts`). */
let held = false;

/**
 * Default lifetime by severity. A failure that scrolls away on a timer is a
 * failure the operator cannot act on, so `danger` sticks until it is
 * dismissed; informational notices still clear themselves.
 *
 * For the passing tones this is the FLOOR: a notice also gets time to be read
 * (`toastLifetimeMs`), so "Script text copied" and a two-sentence restore
 * instruction no longer share the same four seconds.
 */
export const DEFAULT_TOAST_DURATION_MS: Record<ToastTone, number> = {
  info: 4000,
  success: 4000,
  danger: 0,
};

/** A second to notice the card, then a comfortable reading pace. */
const READ_START_MS = 1000;
const READ_MS_PER_CHAR = 55;
/**
 * A notice that needs longer than this to read is not a receipt any more; it
 * is instructions ("Quit and reopen Speaking Glass to apply it — nothing has
 * changed yet"), and instructions that vanish on a timer are WCAG 2.2.1's
 * failure exactly. Past it, a notice stays until it is dismissed.
 */
const MAX_PASSING_MS = 8000;
/** A countdown released with almost nothing left gets this long to be seen leaving. */
const RESUME_FLOOR_MS = 1500;

/**
 * How long a notice stays before clearing itself; 0 means until dismissed.
 *
 * A short receipt clears itself; one long enough to be instructions stays
 * (`MAX_PASSING_MS`), as does an informational notice of more than one
 * sentence, outside a take. A notice with an action stays too: the action is
 * the reason it exists, and a button that times out while somebody is tabbing
 * to it is one they then have to go and find (#303's defect again, one step
 * later).
 */
export function toastLifetimeMs(
  tone: ToastTone,
  message: string,
  hasAction: boolean,
  presenting = false,
): number {
  const floor = DEFAULT_TOAST_DURATION_MS[tone];
  if (floor === 0 || hasAction) return 0;
  const reading = Math.max(floor, READ_START_MS + message.length * READ_MS_PER_CHAR);
  /*
   * During a take a notice that stays is one more card over the script, and
   * the presenter is a metre from the desk; there, a notice gets its reading
   * time and goes. Elsewhere a long one stays, and so does an informational
   * one that explains itself — "Speaking Glass imports Markdown and plain text.
   * notes.docx and 2 more were not imported." is the only place that list
   * exists. A short success stays timed: its result is on screen already.
   */
  if (presenting) return Math.min(reading, PRESENTING_MAX_MS);
  if (reading > MAX_PASSING_MS) return 0;
  if (tone === 'info' && splitLead(message).rest !== '') return 0;
  return reading;
}

/** The longest a notice stays on the glass by itself. */
const PRESENTING_MAX_MS = 12_000;

/**
 * A message's first sentence and the rest.
 *
 * Every caller writes "<what happened>. <why, or what to do>". The split is on
 * the first sentence end followed by more text, so a one-sentence message is
 * all lead, and the two halves are exactly the caller's words.
 */
export function splitLead(message: string): { lead: string; rest: string } {
  const match = /^(.+?[.!?][”’")]?)\s+(?=\S)/u.exec(message);
  if (!match) return { lead: message, rest: '' };
  return { lead: match[1]!, rest: message.slice(match[0].length) };
}

/**
 * Whether a take is running: App.svelte sets the document root's theme to
 * `studio` for exactly that long. Absent a document (unit tests), no.
 */
function presentingNow(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset['theme'] === 'studio';
}

export function showToast(
  message: string,
  tone: ToastTone = 'info',
  options?: { durationMs?: number; key?: string; action?: ToastAction },
): number {
  const id = nextId;
  nextId += 1;
  const key = options?.key;
  const action = options?.action;
  if (key !== undefined) dismissToastByKey(key);
  /*
   * The same notice again, while the first is still up, is one notice that
   * happened twice. It moves to the newest place — so it is announced again
   * and reads as current — and says how many times, instead of stacking a
   * second identical card that needs its own dismissal. Keyed notices already
   * replace themselves, and a notice with an action is never merged: two
   * actions with the same label may do different things.
   */
  let count = 1;
  if (key === undefined && action === undefined) {
    const repeat = get(store).find(
      (t) => t.key === undefined && t.action === undefined && t.tone === tone && t.message === message,
    );
    if (repeat) {
      count = (repeat.count ?? 1) + 1;
      dismissToast(repeat.id);
    }
  }
  store.update((list) => [
    ...list,
    {
      id,
      tone,
      message,
      ...(key === undefined ? {} : { key }),
      ...(action === undefined ? {} : { action }),
      ...(count > 1 ? { count } : {}),
    },
  ]);
  /*
   * No cap on how many exist: a burst is bounded by what the region shows,
   * not by deleting notices — one of them may be the one being read.
   */
  const duration =
    options?.durationMs ?? toastLifetimeMs(tone, message, action !== undefined, presentingNow());
  if (duration > 0) startCountdown(id, duration);
  return id;
}

function startCountdown(id: number, ms: number): void {
  timers.set(id, {
    handle: held ? null : setTimeout(() => dismissToast(id), ms),
    remainingMs: ms,
    startedAt: Date.now(),
  });
}

function stopCountdown(id: number): void {
  const countdown = timers.get(id);
  if (countdown?.handle) clearTimeout(countdown.handle);
  timers.delete(id);
}

/**
 * Stop every passing notice's countdown while somebody is on the stack, and
 * resume them when they leave (WCAG 2.2.1).
 *
 * The region calls this when the pointer is over a toast or keyboard focus is
 * inside one. All countdowns stop, not only the hovered card's: the reader is
 * looking at the stack, and a neighbour vanishing shifts the card under the
 * pointer.
 */
export function holdToasts(hold: boolean): void {
  if (hold === held) return;
  held = hold;
  const now = Date.now();
  for (const [id, countdown] of timers) {
    if (hold) {
      if (countdown.handle === null) continue;
      clearTimeout(countdown.handle);
      countdown.handle = null;
      countdown.remainingMs = Math.max(0, countdown.remainingMs - (now - countdown.startedAt));
    } else {
      countdown.remainingMs = Math.max(countdown.remainingMs, RESUME_FLOOR_MS);
      countdown.startedAt = now;
      countdown.handle = setTimeout(() => dismissToast(id), countdown.remainingMs);
    }
  }
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
  for (const id of doomed) stopCountdown(id);
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
  for (const id of doomed) stopCountdown(id);
}

export function dismissToast(id: number): void {
  stopCountdown(id);
  store.update((list) => list.filter((t) => t.id !== id));
}

export function clearToasts(): void {
  for (const countdown of timers.values()) {
    if (countdown.handle) clearTimeout(countdown.handle);
  }
  timers.clear();
  held = false;
  store.set([]);
}
