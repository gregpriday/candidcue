import { test, expect } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { openScript } from './fixtures/library';

/**
 * The editor at a window too narrow for its full measure.
 *
 * The editor pane was `flex-shrink: 0`, so below ~900px it kept CodeMirror's
 * 70ch max-content width and ran under the outline rail: the script's lines
 * painted over "Outline" and the readiness line. This measures the boxes
 * rather than eyeballing a screenshot — the pane must end where the rail
 * begins.
 */

const SCRIPT = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Launch keynote',
  source:
    '# Launch keynote\n\nThis is how I am working now. There are five coding agents running ' +
    'on my machine, across a few different projects, and at any moment I know exactly which ' +
    'one of them needs me.\n',
};

test('the editor pane shrinks to its slot instead of running under the outline rail', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 700 });
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');
  await openScript(page, /Launch keynote/);
  await expect(page.locator('.cm-content')).toBeVisible();

  const boxes = await page.evaluate(() => {
    const right = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect().right;
    const left = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect().left;
    return {
      panesRight: right('.panes'),
      editorRight: right('.editor-pane'),
      contentRight: right('.cm-content'),
      railLeft: left('.panel'),
    };
  });
  expect(boxes.editorRight).toBeLessThanOrEqual(boxes.panesRight + 1);
  expect(boxes.contentRight).toBeLessThanOrEqual(boxes.railLeft);
});
