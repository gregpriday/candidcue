/**
 * UpdateNotice.svelte — the card that offers an update (docs/updates.md).
 *
 * The rule this component exists to keep: it draws NOTHING while a take is on,
 * whatever it is holding, because during a take this window is the glass. The
 * rest is that each state offers the actions that make sense for it, and only
 * those. Copy is asserted on claims (what it offers), not on whole sentences.
 */
import { render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import UpdateNotice from '../../src/control/components/UpdateNotice.svelte';
import type { UpdateNoticeState } from '../../src/control/stores/updates';

const AVAILABLE: UpdateNoticeState = {
  kind: 'available',
  version: '0.2.0',
  currentVersion: '0.1.0',
  canInstall: true,
};

function renderNotice(notice: UpdateNoticeState, hidden = false) {
  const handlers = { oninstall: vi.fn(), onlater: vi.fn(), ondownload: vi.fn() };
  const result = render(UpdateNotice, { props: { notice, hidden, ...handlers } });
  return { ...result, handlers };
}

function buttons(container: HTMLElement): string[] {
  return [...container.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '');
}

describe('UpdateNotice', () => {
  it('draws nothing during a take, even with an update waiting', () => {
    const { container } = renderNotice(AVAILABLE, true);
    expect(container.querySelector('[data-testid="update-notice"]')).toBeNull();
    expect(container.textContent?.trim()).toBe('');
  });

  it('draws nothing when there is nothing to say', () => {
    const { container } = renderNotice({ kind: 'hidden' });
    expect(container.querySelector('[data-testid="update-notice"]')).toBeNull();
  });

  it('names the new version and the installed one, and offers Later or Install and Restart', () => {
    const { container, handlers } = renderNotice(AVAILABLE);
    const card = container.querySelector('[data-testid="update-notice"]');
    expect(card).not.toBeNull();
    // A labelled region, not a dialog: it takes no focus and traps nothing.
    expect(card?.tagName).toBe('SECTION');
    expect(card?.getAttribute('role')).toBeNull();
    expect(card?.textContent).toContain('0.2.0');
    expect(card?.textContent).toContain('0.1.0');
    expect(buttons(container)).toEqual(['Later', 'Install and Restart']);

    const [later, install] = [...container.querySelectorAll('button')];
    install!.click();
    later!.click();
    flushSync();
    expect(handlers.oninstall).toHaveBeenCalledTimes(1);
    expect(handlers.onlater).toHaveBeenCalledTimes(1);
  });

  it('offers the download page, not an install, to a copy that cannot replace itself', () => {
    const { container, handlers } = renderNotice({ ...AVAILABLE, canInstall: false });
    expect(buttons(container)).toEqual(['Later', 'Download']);
    expect(container.textContent).toMatch(/speakingglass\.com/);
    container.querySelectorAll('button')[1]!.click();
    flushSync();
    expect(handlers.ondownload).toHaveBeenCalledTimes(1);
    expect(handlers.oninstall).not.toHaveBeenCalled();
  });

  it('shows download progress and offers nothing to press while it runs', () => {
    const { container } = renderNotice({ kind: 'downloading', version: '0.2.0', fraction: 0.42 });
    const bar = container.querySelector('progress');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('value')).toBe('0.42');
    expect(container.textContent).toContain('42%');
    expect(buttons(container)).toEqual([]);
  });

  it('shows an indeterminate bar before the size is known', () => {
    const { container } = renderNotice({ kind: 'downloading', version: '0.2.0', fraction: null });
    expect(container.querySelector('progress')?.hasAttribute('value')).toBe(false);
  });

  it('says it is installing, then restarting', () => {
    const installing = renderNotice({ kind: 'installing', version: '0.2.0' });
    expect(installing.container.textContent).toMatch(/signature check/i);
    expect(buttons(installing.container)).toEqual([]);

    const restarting = renderNotice({ kind: 'restarting', version: '0.2.0' });
    expect(restarting.container.textContent).toMatch(/Restarting Speaking Glass/);
  });

  it('reports a failure in words, with Close and Try Again', () => {
    const { container, handlers } = renderNotice({
      kind: 'failed',
      version: '0.2.0',
      currentVersion: '0.1.0',
      canInstall: true,
      message: 'The update could not be downloaded, and nothing was changed.',
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('could not be downloaded');
    expect(buttons(container)).toEqual(['Close', 'Try Again']);
    container.querySelectorAll('button')[1]!.click();
    flushSync();
    expect(handlers.oninstall).toHaveBeenCalledTimes(1);
  });
});
