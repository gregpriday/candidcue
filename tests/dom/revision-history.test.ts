/**
 * RevisionHistory.svelte — the confirm step, which used to happen in silence.
 *
 * Asking to restore swaps the focused "Restore this version" button for a
 * Cancel/Restore pair. Nothing moved focus across that swap, so the keyboard
 * was left on `<body>` behind an `aria-modal` scrim, and the question itself
 * was a plain paragraph with no live region — a screen reader was told nothing
 * at all. Both are invisible to a click-driven test and to every screenshot:
 * the confirm step LOOKS right.
 *
 * The service is mocked because it is deliberately not routed through the mock
 * backend (a fabricated restore point is worse than an honest error), so there
 * is no other way to reach the confirm step.
 */
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listRevisions = vi.fn();
const getRevision = vi.fn();
const restoreRevision = vi.fn();

vi.mock('../../src/control/services/revisions', () => ({
  listRevisions: (...args: unknown[]) => listRevisions(...args),
  getRevision: (...args: unknown[]) => getRevision(...args),
  restoreRevision: (...args: unknown[]) => restoreRevision(...args),
}));

const { default: RevisionHistory } = await import(
  '../../src/control/components/RevisionHistory.svelte'
);
const { RESTORE_SAFETY_NOTE } = await import('../../src/control/lib/revision-format');

const SUMMARY = {
  id: 'rev-1',
  revisionNumber: 4,
  sourceHash: 'abc123',
  reason: 'before_session',
  wordCount: 220,
  createdAt: '2026-07-30T10:00:00Z',
};

function renderPanel(props: Record<string, unknown> = {}) {
  return render(RevisionHistory, {
    props: {
      open: true,
      scriptId: 'script-1',
      expectedRevision: 4,
      currentWordCount: 240,
      onclose: () => {},
      onrestored: () => {},
      ...props,
    },
  });
}

/** The footer button carrying this label, whatever it is bound to. */
function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === name,
  );
  expect(match, `a "${name}" button must be rendered`).toBeDefined();
  return match as HTMLButtonElement;
}

/** Wait until the preview has landed and Restore is live. */
async function ready(): Promise<void> {
  await vi.waitFor(() => {
    expect((button('Restore this version') as HTMLButtonElement).disabled).toBe(false);
  });
}

/**
 * Wait for focus to settle on a named button.
 *
 * Polled rather than asserted after a single `tick()`: the component focuses
 * through a `bind:element` on `<Button>`, and a bindable prop propagates a
 * flush AFTER the element it is bound to has mounted. One tick sees the button
 * in the DOM and the binding still null, which reads as "the fix does not
 * work" when it does.
 */
async function focusSettlesOn(name: string): Promise<void> {
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(button(name));
  });
}

beforeEach(() => {
  listRevisions.mockReset().mockResolvedValue([SUMMARY]);
  getRevision.mockReset().mockResolvedValue({ ...SUMMARY, source: '# Panel talk\n' });
  restoreRevision.mockReset().mockResolvedValue(undefined);
});

describe('RevisionHistory — the restore confirmation', () => {
  it('announces the question when it appears', async () => {
    renderPanel();
    await ready();

    expect(document.querySelector('[role="alert"]'), 'nothing announced yet').toBeNull();

    button('Restore this version').click();
    await tick();

    const alert = document.querySelector('[role="alert"]');
    expect(alert, 'the confirm step must be a live region, not a silent paragraph').not.toBeNull();
    expect(alert?.textContent).toContain(RESTORE_SAFETY_NOTE);
  });

  it('moves focus onto Cancel — the safe half of the pair', async () => {
    renderPanel();
    await ready();

    button('Restore this version').click();

    // Not merely "somewhere in the dialog": the destructive key must not be the
    // one already sitting under a waiting Return.
    await focusSettlesOn('Cancel');
  });

  it('returns focus to Restore when the question is dismissed', async () => {
    renderPanel();
    await ready();

    button('Restore this version').click();
    await focusSettlesOn('Cancel');
    button('Cancel').click();
    await focusSettlesOn('Restore this version');

    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('confirming restores once, with the revision the operator was looking at', async () => {
    const onrestored = vi.fn();
    renderPanel({ onrestored });
    await ready();

    button('Restore this version').click();
    await tick();
    // The confirming half is the filled danger button; Cancel is the ghost.
    const confirm = [...document.querySelectorAll('button')].find((el) =>
      el.classList.contains('danger'),
    );
    expect(confirm, 'the confirming action must be the danger button').toBeDefined();
    confirm!.click();

    await vi.waitFor(() => expect(onrestored).toHaveBeenCalledTimes(1));
    expect(restoreRevision).toHaveBeenCalledWith('script-1', 'rev-1', 4);
  });

  it('a failed restore lands focus somewhere usable rather than on the body', async () => {
    restoreRevision.mockRejectedValue(new Error('the script changed underneath'));
    renderPanel();
    await ready();

    button('Restore this version').click();
    await tick();
    const confirm = [...document.querySelectorAll('button')].find((el) =>
      el.classList.contains('danger'),
    );
    confirm!.click();

    await focusSettlesOn('Restore this version');
    // Back to asking, not stuck mid-question.
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not reopen still holding a half-answered question', async () => {
    const { rerender } = renderPanel();
    await ready();

    button('Restore this version').click();
    await tick();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();

    await rerender({ open: false });
    await rerender({ open: true });
    await tick();

    expect(
      document.querySelector('[role="alert"]'),
      'a reopened browser must ask again from the start',
    ).toBeNull();
  });
});
