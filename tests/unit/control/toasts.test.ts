import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  clearToasts,
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
});
