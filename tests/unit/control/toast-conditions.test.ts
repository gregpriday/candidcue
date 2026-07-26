/**
 * A condition gets one notice, and it goes away when the condition does.
 *
 * `danger` toasts never expire — deliberately, because a failure that scrolls
 * away is a failure nobody can act on. But a following hold is a STATE, not an
 * event: the microphone goes quiet between two sentences, following pauses,
 * audio returns, following resumes. Reporting each one as a fresh permanent
 * notice meant an ordinary take produced a stack of identical warnings that
 * outlived the session — the presenter met six of them at once, on the summary
 * screen of a take that had scored 96%, all describing a microphone that was
 * no longer in use.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  clearConditionToasts,
  dismissToast,
  dismissToastByKey,
  showToast,
  toasts,
} from '../../../src/control/stores/toasts';

function messages(): string[] {
  return get(toasts).map((t) => t.message);
}

beforeEach(() => {
  for (const toast of get(toasts)) dismissToast(toast.id);
});

describe('a keyed notice replaces rather than stacks', () => {
  it('keeps one toast however often the condition is reported', () => {
    for (let i = 0; i < 6; i += 1) {
      showToast('No sound is reaching the microphone.', 'danger', { key: 'input' });
    }
    expect(messages()).toEqual(['No sound is reaching the microphone.']);
  });

  it('shows the newest wording for the condition', () => {
    showToast('Reconnecting — your position is held.', 'danger', { key: 'hold' });
    showToast('No sound is reaching the microphone.', 'danger', { key: 'hold' });
    expect(messages()).toEqual(['No sound is reaching the microphone.']);
  });

  it('keeps distinct conditions apart', () => {
    showToast('No sound is reaching the microphone.', 'danger', { key: 'input' });
    showToast('Reconnecting — your position is held.', 'danger', { key: 'transport' });
    expect(messages()).toHaveLength(2);
  });

  it('leaves unkeyed notices alone — they are events, not states', () => {
    showToast('Take marker added', 'info');
    showToast('Take marker added', 'info');
    showToast('No sound is reaching the microphone.', 'danger', { key: 'input' });
    showToast('No sound is reaching the microphone.', 'danger', { key: 'input' });
    expect(messages()).toEqual([
      'Take marker added',
      'Take marker added',
      'No sound is reaching the microphone.',
    ]);
  });
});

describe('a notice is retracted when its condition ends', () => {
  it('dismisses by key', () => {
    showToast('No sound is reaching the microphone.', 'danger', { key: 'input' });
    dismissToastByKey('input');
    expect(messages()).toEqual([]);
  });

  it('is safe to retract a condition that was never reported', () => {
    // "The microphone came back" fires far more often than "it went away" —
    // the level monitor reports on every buffer.
    expect(() => dismissToastByKey('input')).not.toThrow();
    expect(messages()).toEqual([]);
  });

  it('survives the full hold/release cycle without accumulating', () => {
    for (let i = 0; i < 4; i += 1) {
      showToast('Reconnecting — your position is held.', 'danger', { key: 'hold' });
      dismissToastByKey('hold');
    }
    expect(messages()).toEqual([]);
  });
});

describe('the end of a take clears its warnings', () => {
  it('drops every keyed notice and keeps the rest', () => {
    showToast('No sound is reaching the microphone.', 'danger', { key: 'input' });
    showToast('Reconnecting — your position is held.', 'danger', { key: 'transport' });
    showToast('Session saved', 'success');

    clearConditionToasts();

    // The summary screen must not open under warnings about a microphone the
    // session has already released.
    expect(messages()).toEqual(['Session saved']);
  });
});
