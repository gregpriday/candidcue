/**
 * What a take did to the glass and to the aligner, read the way a spec needs it.
 *
 * Shared by the specs that press navigation keys during a take and then judge
 * the result as the presenter would: where the document is painted, frame by
 * frame, and where the aligner was asked to go. Defined once so that the specs
 * cannot drift into measuring "the document moved" in subtly different ways.
 */
import type { Page } from '@playwright/test';

/** Every token the aligner was asked to move to, in order. */
export function moves(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    window.__E2E__.calls
      .filter((call) => call.command === 'set_alignment_position')
      .map((call) => (call.args as { token: number }).token),
  );
}

/** How far down the script the document is painted, in pixels. */
export function scrollPx(page: Page): Promise<number> {
  return page.locator('.scroll-plane').evaluate((el) => {
    const match = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec((el as HTMLElement).style.transform);
    return match?.[1] === undefined ? 0 : -Number(match[1]);
  });
}

export interface ScrollSample {
  atMs: number;
  y: number;
}

/**
 * Start recording where the document is painted, every frame, until
 * `stopRecording`. Started BEFORE the key is pressed, so a move that lands in
 * the time a key press takes to come back is in the trace.
 */
export async function startRecording(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __ROLL__: ScrollSample[]; __ROLL_ON__: boolean };
    w.__ROLL__ = [];
    w.__ROLL_ON__ = true;
    const tick = () => {
      if (!w.__ROLL_ON__) return;
      const el = document.querySelector('.scroll-plane') as HTMLElement | null;
      const m = el ? /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(el.style.transform) : null;
      w.__ROLL__.push({ atMs: performance.now(), y: m?.[1] === undefined ? 0 : -Number(m[1]) });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export function stopRecording(page: Page): Promise<ScrollSample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __ROLL__: ScrollSample[]; __ROLL_ON__: boolean };
    w.__ROLL_ON__ = false;
    return w.__ROLL__;
  });
}
