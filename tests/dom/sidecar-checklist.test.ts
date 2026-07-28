/**
 * SidecarChecklist — never claim a setting it cannot see.
 *
 * The panel exists because Sidecar breaks takes in ways nothing in the app can
 * detect, so the one thing it must never do is present a reminder as a result.
 * These tests mount the component that actually consumes `shared/sidecar.ts`
 * and assert the two shapes stay apart: exactly one statement, and a tick for
 * everything else.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import SidecarChecklist from '../../src/control/components/SidecarChecklist.svelte';
import { sidecarChecklist, sidecarSafeAreaHint } from '../../src/shared/sidecar';

/** 12.9-inch iPad Pro over Sidecar. */
const ipad = {
  name: "Greg's iPad Pro",
  physicalSize: { width: 2732, height: 2048 },
  scaleFactor: 2,
};

const dell = {
  name: 'DELL U2720Q',
  physicalSize: { width: 3840, height: 2160 },
  scaleFactor: 2,
};

const viewport = { widthPx: 1366, heightPx: 1024 };

describe('SidecarChecklist', () => {
  it('says nothing at all about an ordinary monitor', () => {
    const { container } = render(SidecarChecklist, { props: { display: dell, viewport } });
    expect(container.textContent?.trim()).toBe('');
  });

  it('shows every item, with its reason, for an iPad panel', () => {
    const { container } = render(SidecarChecklist, { props: { display: ipad, viewport } });
    const text = container.textContent ?? '';
    expect(text).toContain('This looks like an iPad over Sidecar');
    for (const check of sidecarChecklist()) {
      expect(text, check.id).toContain(check.label);
      // The reason is the point. A label on its own is a rule.
      expect(text, check.id).toContain(check.why);
    }
  });

  it('ticks everything it cannot see, and states only what it can', () => {
    const { container } = render(SidecarChecklist, { props: { display: ipad, viewport } });
    const checks = sidecarChecklist();
    const tickable = checks.filter((check) => !check.verifiable);
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    // One box per unverifiable item, and none for the verifiable one — a
    // checkbox beside a fact the app has already established would invite the
    // presenter to go and confirm something nobody needs to look at.
    expect(boxes.length).toBe(tickable.length);
    expect(boxes.length).toBe(checks.length - 1);

    const rows = container.querySelectorAll('li');
    const stated = Array.from(rows).filter((row) => row.querySelector('input') === null);
    expect(stated.length).toBe(1);
    expect(stated[0]?.textContent).toContain(checks[0]?.label);
  });

  it('counts ticks without ever calling them verified', async () => {
    const { container } = render(SidecarChecklist, { props: { display: ipad, viewport } });
    const tickable = sidecarChecklist().filter((check) => !check.verifiable).length;
    expect(container.textContent).toContain(`0 of ${tickable} confirmed`);

    const first = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    first.click();
    // Svelte 5 flushes on a microtask; awaiting the event loop is enough.
    await Promise.resolve();
    expect(container.textContent).toContain(`1 of ${tickable} confirmed`);
  });

  it('lets a tick come back off, because a rig can stop being ready', async () => {
    /*
     * The one operation a checklist of reminders has to get right in both
     * directions. Somebody plugs the iPad in, ticks the cable, then unplugs it
     * to move the desk — a count that only ever climbs is the panel asserting a
     * rig that was true a minute ago, which is the same lie as a status pill.
     */
    const { container } = render(SidecarChecklist, { props: { display: ipad, viewport } });
    const tickable = sidecarChecklist().filter((check) => !check.verifiable).length;
    const first = container.querySelector('input[type="checkbox"]') as HTMLInputElement;

    first.click();
    await Promise.resolve();
    expect(first.checked).toBe(true);
    expect(container.textContent).toContain(`1 of ${tickable} confirmed`);

    first.click();
    await Promise.resolve();
    expect(first.checked).toBe(false);
    expect(container.textContent).toContain(`0 of ${tickable} confirmed`);
  });

  it('trusts a presenter who named the hardware over the geometry test', () => {
    // Sidecar over a panel whose shape gave nothing away. They can see the rig;
    // the app cannot, so the heading stops claiming a resemblance.
    const { container } = render(SidecarChecklist, {
      props: { display: dell, hardwareKind: 'ipad-sidecar' as const, viewport },
    });
    expect(container.textContent).toContain('Prompting from an iPad over Sidecar');
    expect(container.textContent).not.toContain('This looks like');
  });

  it('offers the safe-area hint as a starting point, and hands back exactly it', () => {
    const onapplysafearea = vi.fn();
    const { container, getByText } = render(SidecarChecklist, {
      props: { display: ipad, viewport, onapplysafearea },
    });
    const hint = sidecarSafeAreaHint(viewport);
    const text = container.textContent ?? '';
    expect(text).toContain(`${hint.sidebarPx} px`);
    expect(text).toContain(`${Math.round(hint.insets.left * 100)}%`);
    // The wording has to keep it a suggestion — the frame on the glass is the
    // only measurement in this whole panel.
    expect(text).toContain('A starting point, not a measurement');

    fireEvent.click(getByText('Start the safe area here'));
    expect(onapplysafearea).toHaveBeenCalledWith(hint.insets);
  });

  it('still shows its working when there is no viewport to seed from', () => {
    const onapplysafearea = vi.fn();
    const { container } = render(SidecarChecklist, {
      props: { display: ipad, viewport: null, onapplysafearea },
    });
    // "The sidebar costs about 64 px" is useful on its own; an apply button
    // that would write a rectangle computed from nothing is not.
    expect(container.textContent).toContain('64 px');
    expect(container.textContent).not.toContain('Start the safe area here');
  });
});
