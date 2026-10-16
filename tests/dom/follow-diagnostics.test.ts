/**
 * FollowDiagnostics — "Why did it move?" and the export behind it (#236).
 *
 * This panel is now mounted in Live's take controls, the only surface a take
 * can open, so two of its promises matter in a way they did not while it sat on
 * a console nobody saw:
 *
 *   - the Developer diagnostics setting really does reveal the timeline, and
 *   - Copy diagnostics never reports a success it cannot see. It used to fall
 *     back to a blob download and say "Saved as a JSON file." on nothing more
 *     than `anchor.click()` not throwing; now a refused clipboard shows the
 *     export as text the operator can select themselves.
 *
 * The export comes from the `smoothFollow` SINGLETON while the display comes
 * from the `follow` prop, so the singleton is seeded and reset around each test.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FollowDiagnostics from '../../src/control/components/FollowDiagnostics.svelte';
import { defaultFollowingSettings } from '../../src/control/lib/follow-profiles';
import { smoothFollow } from '../../src/control/stores/smooth-follow';

const SESSION_ID = '00000000-0000-0000-0000-0000000000d6';

function mount(developerMode = false) {
  return render(FollowDiagnostics, {
    props: { follow: smoothFollow.snapshot(), developerMode },
  });
}

function copyButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === 'Copy diagnostics',
  );
  expect(button, 'the Copy diagnostics button').toBeDefined();
  return button!;
}

function stubClipboard(writeText: ((text: string) => Promise<void>) | null): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText === null ? undefined : { writeText },
  });
}

/** The always-mounted result line, so a screen reader hears it. */
function statusText(container: HTMLElement): string {
  const status = container.querySelector('[role="status"]');
  expect(status, 'the export result is a status region').not.toBeNull();
  return status!.textContent?.trim() ?? '';
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function beginAnotherSession(): void {
  smoothFollow.reset();
  smoothFollow.beginSession('00000000-0000-0000-0000-0000000000d7', defaultFollowingSettings());
}

beforeEach(() => {
  smoothFollow.reset();
  smoothFollow.beginSession(SESSION_ID, defaultFollowingSettings());
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
  smoothFollow.reset();
});

describe('the developer timeline', () => {
  it('stays hidden, and says where to turn it on, without developer diagnostics', () => {
    const { container } = mount(false);
    expect(container.querySelector('.timeline')).toBeNull();
    expect(container.textContent).toContain('Turn on developer diagnostics in Settings → Following');
  });

  it('appears when developer diagnostics are on', () => {
    const { container } = mount(true);
    expect(container.querySelector('.timeline')).not.toBeNull();
    expect(container.textContent).not.toContain('Turn on developer diagnostics');
  });
});

describe('Copy diagnostics', () => {
  it('reports Copied only once the clipboard has taken the redacted export', async () => {
    const write = deferred();
    const writeText = vi.fn<(text: string) => Promise<void>>().mockReturnValue(write.promise);
    stubClipboard(writeText);
    const { container } = mount();

    await fireEvent.click(copyButton(container));
    await tick();
    // Still pending: nothing may be claimed yet.
    expect(statusText(container)).toBe('');

    write.resolve();
    await vi.waitFor(() => expect(statusText(container)).toContain('Copied.'));

    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(writeText.mock.calls[0]![0]);
    expect(payload.kind).toBe('candidcue.follow-diagnostics');
    expect(payload.redacted).toBe(true);
    expect(payload.sessionId).toBe(SESSION_ID);
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('shows the export for copying by hand when the clipboard refuses it', async () => {
    stubClipboard(() => Promise.reject(new Error('NotAllowedError')));
    const { container } = mount();

    await fireEvent.click(copyButton(container));
    await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull());

    const field = container.querySelector('textarea')!;
    expect(field.readOnly).toBe(true);
    expect(field.getAttribute('aria-label')).toBe('Follow diagnostics export');
    expect(JSON.parse(field.value).kind).toBe('candidcue.follow-diagnostics');
    // Focusing it selects all of it, ready for ⌘C.
    container.querySelector('details')!.open = true;
    field.focus();
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length]);
    expect(statusText(container)).toContain('Could not copy to the clipboard');
    // Neither outcome may claim a file it has no way of knowing was written.
    expect(container.textContent).not.toContain('Copied.');
    expect(container.textContent).not.toContain('Saved as a JSON file');
  });

  it('falls back the same way when there is no clipboard at all', async () => {
    stubClipboard(null);
    const { container } = mount();

    await fireEvent.click(copyButton(container));
    await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull());

    expect(JSON.parse(container.querySelector('textarea')!.value).sessionId).toBe(SESSION_ID);
    expect(container.textContent).not.toContain('Saved as a JSON file');
  });

  it('lets only the newest copy report, however the older one settles', async () => {
    const older = deferred();
    const writes = [older.promise, Promise.resolve()];
    stubClipboard(() => writes.shift()!);
    const { container } = mount();

    await fireEvent.click(copyButton(container));
    await fireEvent.click(copyButton(container));
    await vi.waitFor(() => expect(statusText(container)).toContain('Copied.'));

    // The first click's export is the OLDER snapshot. Its refusal arriving
    // late must not replace the newer success with a stale fallback.
    older.reject(new Error('NotAllowedError'));
    await older.promise.catch(() => {});
    await tick();
    expect(statusText(container)).toContain('Copied.');
    expect(container.querySelector('textarea')).toBeNull();
  });
});

/*
 * A normal take mounts this component afresh, because ending one navigates
 * away from Live. These cover an instance that IS handed a second session,
 * which is the only way a result could outlive the take it describes.
 */
describe('across sessions', () => {
  it('keeps its result through a take, and drops it when another begins', async () => {
    stubClipboard(() => Promise.reject(new Error('NotAllowedError')));
    const view = mount();
    await fireEvent.click(copyButton(view.container));
    await vi.waitFor(() => expect(view.container.querySelector('textarea')).not.toBeNull());

    // Every snapshot hands the panel a fresh `follow` object. The same take
    // must not read as a new one, or the result would vanish within a frame.
    smoothFollow.reportTranscriptStatus('live');
    await view.rerender({ follow: smoothFollow.snapshot(), developerMode: false });
    expect(view.container.querySelector('textarea')).not.toBeNull();
    expect(statusText(view.container)).toContain('Could not copy');

    beginAnotherSession();
    await view.rerender({ follow: smoothFollow.snapshot(), developerMode: false });
    expect(view.container.querySelector('textarea')).toBeNull();
    expect(statusText(view.container)).toBe('');
  });

  it('does not report a copy that settles after another session has begun', async () => {
    const write = deferred();
    stubClipboard(() => write.promise);
    const view = mount();
    await fireEvent.click(copyButton(view.container));

    beginAnotherSession();
    await view.rerender({ follow: smoothFollow.snapshot(), developerMode: false });
    write.resolve();
    await write.promise;
    await tick();
    expect(statusText(view.container)).toBe('');
  });
});
