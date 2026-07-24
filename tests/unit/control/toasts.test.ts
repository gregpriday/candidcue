import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  clearToasts,
  DEFAULT_TOAST_DURATION_MS,
  dismissToast,
  showToast,
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
});
