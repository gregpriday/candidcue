/**
 * LegacyLibraryNotice.svelte: the card that says the CandidCue library was
 * left behind (#454).
 *
 * What it has to say, per the issue: where the old library is, what the next
 * launch will do, and how to bring old scripts in once work has begun here.
 * For a failed copy, also that a script created here (the sample included)
 * ends the retry, because that is the step somebody checking the upgrade
 * would take next. Copy is asserted on claims, not whole sentences.
 */
import { render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import LegacyLibraryNotice from '../../src/control/components/LegacyLibraryNotice.svelte';
import type { LegacyLibraryNotice as Notice } from '../../src/control/services/legacy-library';

const OLD = '/Users/someone/Library/Application Support/com.candidcue.app';

const FAILED: Notice = {
  kind: 'failed',
  oldFolder: OLD,
  reason: 'CandidCue has not finished a recovery (restore-pending.json is still there)',
};

const ABANDONED: Notice = { kind: 'abandoned', oldFolder: OLD };

function renderNotice(
  notice: Notice,
  options: { placement?: 'inline' | 'floating'; libraryOpen?: boolean; reveal?: () => Promise<void> } = {},
) {
  const handlers = {
    onreveal: vi.fn(options.reveal ?? (async () => {})),
    ondismiss: vi.fn(),
  };
  const result = render(LegacyLibraryNotice, {
    props: {
      notice,
      placement: options.placement ?? 'inline',
      libraryOpen: options.libraryOpen ?? true,
      revealLabel: 'Reveal in Finder',
      ...handlers,
    },
  });
  const card = result.container.querySelector<HTMLElement>('[data-testid="legacy-library-notice"]');
  if (card === null) throw new Error('the card was not drawn');
  return { ...result, card, handlers };
}

function text(card: HTMLElement, testId: string): string {
  return card.querySelector(`[data-testid="${testId}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function buttons(card: HTMLElement): HTMLButtonElement[] {
  return [...card.querySelectorAll('button')];
}

describe('LegacyLibraryNotice', () => {
  it('a failed copy: where the old library is, why, and that a script here ends the retry', () => {
    const { card } = renderNotice(FAILED);
    // A labelled region, not a dialog: it takes no focus and traps nothing.
    expect(card.tagName).toBe('SECTION');
    expect(card.getAttribute('role')).toBeNull();
    expect(card.getAttribute('aria-labelledby')).toBeTruthy();
    expect(card.textContent).toMatch(/not copied/);
    expect(text(card, 'legacy-library-path')).toBe(OLD);
    expect(text(card, 'legacy-library-reason')).toContain('restore-pending.json');

    const next = text(card, 'legacy-library-next-launch');
    expect(next).toMatch(/tries again each time it opens/);
    expect(next).toMatch(/only while this library has no scripts/);
    expect(next).toMatch(/sample script included/);
    expect(next).toMatch(/not tried again/);
  });

  it('an abandoned copy: kept, never copied again, and the old folder untouched', () => {
    const { card } = renderNotice(ABANDONED);
    expect(card.dataset['kind']).toBe('abandoned');
    expect(text(card, 'legacy-library-path')).toBe(OLD);
    expect(card.textContent).toMatch(/will not copy the old one again/);
    expect(card.querySelector('[data-testid="legacy-library-reason"]')).toBeNull();
    // The retry warning is about a decision that has already been made.
    expect(card.querySelector('[data-testid="legacy-library-next-launch"]')).toBeNull();
  });

  it('says how to bring old scripts in after work has begun here, for either kind', () => {
    for (const notice of [FAILED, ABANDONED]) {
      const { card, unmount } = renderNotice(notice);
      const recover = text(card, 'legacy-library-recover');
      expect(recover).toMatch(/^To bring an old script into this library/);
      expect(recover).toContain('File › Import Markdown…');
      expect(recover).toContain('script.md');
      // The whole-library route says what it costs.
      expect(recover).toContain('Restore from export…');
      expect(recover).toMatch(/replaces everything here/);
      unmount();
    }
  });

  it('on the recovery screen, puts the import off until the library opens', () => {
    const { card } = renderNotice(ABANDONED, { placement: 'floating', libraryOpen: false });
    expect(card.classList.contains('floating')).toBe(true);
    expect(text(card, 'legacy-library-recover')).toMatch(/^Once Speaking Glass can open its library, bring/);
  });

  it('shows the folder or puts the card away, and nothing else', () => {
    const { card, handlers } = renderNotice(FAILED);
    expect(buttons(card).map((b) => b.textContent?.trim())).toEqual(['Dismiss', 'Reveal in Finder']);
    const [dismiss, reveal] = buttons(card);
    reveal!.click();
    dismiss!.click();
    flushSync();
    expect(handlers.onreveal).toHaveBeenCalledTimes(1);
    expect(handlers.ondismiss).toHaveBeenCalledTimes(1);
  });

  it('says so when the folder cannot be shown, and keeps the path on screen', async () => {
    const { card } = renderNotice(FAILED, {
      reveal: async () => {
        throw new Error('the opener refused');
      },
    });
    buttons(card)[1]!.click();
    await tick();
    await tick();
    const alert = card.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/could not be shown/);
    expect(text(card, 'legacy-library-path')).toBe(OLD);
  });
});
