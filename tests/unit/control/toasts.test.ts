import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  clearToasts,
  DEFAULT_TOAST_DURATION_MS,
  dismissToast,
  holdToasts,
  showToast,
  splitLead,
  toastLifetimeMs,
  toasts,
} from '../../../src/control/stores/toasts';

describe('toast store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearToasts();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds and dismisses toasts', () => {
    const id = showToast('Saved', 'success', { durationMs: 0 });
    expect(get(toasts)).toHaveLength(1);
    expect(get(toasts)[0]).toMatchObject({ id, tone: 'success', message: 'Saved' });
    dismissToast(id);
    expect(get(toasts)).toHaveLength(0);
  });

  it('auto-dismisses after the duration', () => {
    showToast('Temporary', 'info', { durationMs: 1000 });
    expect(get(toasts)).toHaveLength(1);
    vi.advanceTimersByTime(1100);
    expect(get(toasts)).toHaveLength(0);
  });

  it('carries an action, and keeps it on a keyed replacement (#303)', () => {
    const run = vi.fn();
    showToast('Not allowed', 'danger', {
      key: 'mic-refused',
      action: { label: 'Open System Settings', run },
    });
    showToast('Still not allowed', 'danger', {
      key: 'mic-refused',
      action: { label: 'Open System Settings', run },
    });
    const list = get(toasts);
    expect(list).toHaveLength(1);
    expect(list[0]!.message).toBe('Still not allowed');
    list[0]!.action!.run();
    expect(run).toHaveBeenCalledTimes(1);
    // Running the action does not retract the notice; the condition does.
    expect(get(toasts)).toHaveLength(1);
  });

  it('has no action unless one is given', () => {
    showToast('Saved', 'success', { durationMs: 0 });
    expect(get(toasts)[0]).not.toHaveProperty('action');
  });

  it('stacks multiple toasts', () => {
    showToast('one', 'info', { durationMs: 0 });
    showToast('two', 'danger', { durationMs: 0 });
    expect(get(toasts).map((t) => t.message)).toEqual(['one', 'two']);
  });

  /*
   * A failure that scrolls away on a timer takes its reason with it. Info and
   * success still clear themselves; danger requires an explicit dismissal.
   */
  it('keeps danger toasts until they are dismissed', () => {
    const id = showToast('Stage did not open', 'danger');
    vi.advanceTimersByTime(60_000);
    expect(get(toasts)).toHaveLength(1);
    dismissToast(id);
    expect(get(toasts)).toHaveLength(0);
  });

  it('still auto-dismisses info and success by default', () => {
    showToast('Compiled', 'info');
    showToast('Saved', 'success');
    expect(get(toasts)).toHaveLength(2);
    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS.info + 100);
    expect(get(toasts)).toHaveLength(0);
  });

  it('an explicit duration still wins over the severity default', () => {
    showToast('Transient failure', 'danger', { durationMs: 500 });
    vi.advanceTimersByTime(600);
    expect(get(toasts)).toHaveLength(0);
  });

  /*
   * A notice gets time to be read: "Script text copied" and a two-sentence
   * instruction no longer share the same four seconds.
   */
  it('gives a longer receipt longer to be read, from the same floor', () => {
    expect(toastLifetimeMs('success', 'Saved', false)).toBe(DEFAULT_TOAST_DURATION_MS.success);
    const longer = 'Revision restored. Your previous text was saved as a revision.';
    expect(toastLifetimeMs('success', longer, false)).toBeGreaterThan(DEFAULT_TOAST_DURATION_MS.success);
  });

  it('keeps a notice with an action until it is dismissed', () => {
    showToast('Kept your edits.', 'success', { action: { label: 'Open revision history', run: () => {} } });
    vi.advanceTimersByTime(60_000);
    expect(get(toasts)).toHaveLength(1);
  });

  it('keeps instructions and an explanatory info notice, but not a short receipt', () => {
    const instructions =
      'Ready to restore 42 scripts from the export taken on 2026-10-01. ' +
      'Quit and reopen Speaking Glass to apply it — nothing has changed yet.';
    expect(toastLifetimeMs('success', instructions, false)).toBe(0);
    const explains = 'Speaking Glass imports Markdown and plain text. notes.docx was not imported.';
    expect(toastLifetimeMs('info', explains, false)).toBe(0);
    expect(toastLifetimeMs('success', 'Script imported. It is in your library.', false)).toBeGreaterThan(0);
  });

  it('lets every passing notice go during a take, where a notice that stays covers the script', () => {
    const explains = 'Voice following switched off after a long pause. Press Space to turn it back on.';
    expect(toastLifetimeMs('info', explains, false, true)).toBeGreaterThan(0);
    expect(toastLifetimeMs('danger', 'Voice following stopped.', false, true)).toBe(0);
  });

  it('stops every countdown while held, and resumes it when released', () => {
    showToast('Compiled', 'info');
    holdToasts(true);
    vi.advanceTimersByTime(60_000);
    expect(get(toasts)).toHaveLength(1);
    holdToasts(false);
    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS.info + 100);
    expect(get(toasts)).toHaveLength(0);
  });

  it('splits a message into its first sentence and the rest, word for word', () => {
    expect(splitLead('Could not copy to the clipboard')).toEqual({
      lead: 'Could not copy to the clipboard',
      rest: '',
    });
    expect(splitLead('Loaded the disk version. Your edits are in the Library.')).toEqual({
      lead: 'Loaded the disk version.',
      rest: 'Your edits are in the Library.',
    });
  });
});
