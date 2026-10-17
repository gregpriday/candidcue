/**
 * Screenshots of the take summary in every shape its footer and outcome card
 * can take, for design review. Opt-in: it skips unless DESIGN_CAPTURE_DIR
 * names a directory to write into, so the normal suite never runs it.
 *
 *     DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5300 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-capture-take-summary.spec.ts
 *
 * A real take cannot be steered into each of these — the share, the part, the
 * section it ended in and the refusals all come out of a live recogniser — so
 * the summary is written straight into the session store the dialog reads.
 * The store exports no setter, so the dev server's copy of the module gets one
 * appended on the way to the page. The app and this spec then share the one
 * module instance, and everything downstream of the store is the real path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { openScript } from './fixtures/library';

const OUT = process.env['DESIGN_CAPTURE_DIR'];

const SCRIPT = {
  id: '5e55a1a0-5e55-4a1a-8a1a-5e55a1a05e55',
  title: 'Quarterly update',
  source:
    '# Opening\n\nThank you for joining me today. Here is what changed this quarter, ' +
    'and why it matters for the next one.\n\n' +
    '## The pricing story\n\nWe moved two plans into one and nobody missed the second.\n\n' +
    '## Start a sentence over\n\nIf you lose your place, start the sentence again. ' +
    'CandidCue holds where it is until it hears you.\n\n' +
    '## What we learned from the beta\n\nPeople read faster than they think they do.\n',
};

const PART = {
  id: 'part-2',
  label: 'The pricing story',
  ordinal: 2,
  totalParts: 4,
  startTokenIndex: 24,
  endTokenIndex: 41,
};
const NEXT_PART = {
  id: 'part-3',
  label: 'What we learned from the beta',
  ordinal: 3,
  totalParts: 4,
  startTokenIndex: 42,
  endTokenIndex: 70,
};

/** A voice take that heard plenty and followed most of it. */
const BASE = {
  durationSeconds: 223,
  mode: 'voice',
  sectionsReached: 3,
  retakes: 1,
  reconnects: 0,
  endingLocation: 'Start a sentence over',
  manualJumps: 2,
  followingShare: 0.68,
  followingTime: { onSeconds: 223, pausedSeconds: 0, offSeconds: 0, autoScrollSeconds: 0 },
  listenedSeconds: 223,
  wordsHeard: 512,
  wordsInFlight: 0,
  wordsFollowed: 488,
  coverageWords: 540,
  coverageScope: 'script',
  voiceFollowingAvailable: true,
  microphoneRefused: false,
  endTokenIndex: 60,
  sectionStartTokenIndex: 42,
  part: null,
  partComplete: false,
  partRolledToEnd: false,
  nextPart: null,
};

interface Capture {
  name: string;
  summary: Record<string, unknown>;
  /** Open the "Take details" disclosure before the shot. */
  details?: boolean;
  viewport?: { width: number; height: number };
}

const CAPTURES: Capture[] = [
  // The take the summary is most often looking at: unbounded, a section to retry.
  { name: '01-held-retry-section', summary: BASE },
  { name: '02-steady-from-the-top', summary: { ...BASE, followingShare: 0.94, sectionStartTokenIndex: null, endingLocation: 'Opening' } },
  // A part that stopped short, with another after it: the widest footer there is.
  { name: '03-part-unfinished-next', summary: { ...BASE, part: PART, nextPart: NEXT_PART, coverageScope: 'part', coverageWords: 120, wordsFollowed: 64 } },
  { name: '04-part-finished-next', summary: { ...BASE, followingShare: 0.88, part: PART, partComplete: true, nextPart: NEXT_PART, coverageScope: 'part', coverageWords: 120, wordsFollowed: 120 } },
  { name: '05-nothing-transcribed', summary: { ...BASE, wordsHeard: 0, followingShare: null, wordsFollowed: 0, manualJumps: 3 } },
  { name: '06-microphone-refused', summary: { ...BASE, wordsHeard: 0, followingShare: null, wordsFollowed: 0, manualJumps: 0, microphoneRefused: true } },
  { name: '07-manual-mode', summary: { ...BASE, mode: 'manual', followingShare: null, wordsHeard: 0, wordsFollowed: 0 } },
  { name: '08-held-details-open', summary: BASE, details: true },
  { name: '09-narrow-window', summary: BASE, viewport: { width: 560, height: 760 } },
  // Names nothing can break between, under a share low enough for the holding remark.
  {
    name: '10-unbroken-names',
    summary: {
      ...BASE,
      followingShare: 0.45,
      endingLocation: 'Q3PricingWalkthroughForEnterpriseProcurementTeams',
      part: PART,
      partComplete: true,
      nextPart: { ...NEXT_PART, label: 'WhatWeLearnedFromTheBetaAndWhatWeAreChangingNext' },
      coverageScope: 'part',
      coverageWords: 120,
      wordsFollowed: 120,
    },
    details: true,
  },
];

/** Give the store a setter, in the dev server's copy of the module only. */
async function exposeSessionSetter(page: Page): Promise<void> {
  await page.route('**/src/control/stores/session.ts*', async (route) => {
    const response = await route.fetch();
    const body =
      (await response.text()) +
      '\nexport function __designSetSession(patch) { state.update((s) => ({ ...s, ...patch })); }\n';
    await route.fulfill({ response, body });
  });
}

async function showSummary(page: Page, summary: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    async ({ summary, scriptId }) => {
      // A browser-absolute URL the dev server resolves at runtime; held in a
      // variable because tsc tries (and fails) to resolve it as a literal.
      const sessionUrl = '/src/control/stores/session.ts';
      const store = (await import(/* @vite-ignore */ sessionUrl)) as unknown as {
        __designSetSession: (patch: Record<string, unknown>) => void;
      };
      store.__designSetSession({ active: false, scriptId, summary });
    },
    { summary, scriptId: SCRIPT.id },
  );
}

test.describe('design capture: take summary', () => {
  test.skip(!OUT, 'DESIGN_CAPTURE_DIR is not set');
  test.use({ deviceScaleFactor: 2 });

  for (const capture of CAPTURES) {
    test(capture.name, async ({ page }) => {
      fs.mkdirSync(OUT!, { recursive: true });
      await page.setViewportSize(capture.viewport ?? { width: 1100, height: 820 });
      await exposeSessionSetter(page);
      await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT], promptMode: 'voice' });
      await page.goto('/control.html');
      await openScript(page, SCRIPT.title);
      await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();

      await showSummary(page, capture.summary);
      const dialog = page.getByRole('dialog', { name: 'Take complete' });
      await expect(dialog).toBeVisible();
      if (capture.details) {
        await dialog.getByText('Take details').click();
        await expect(dialog.locator('.summary-grid')).toBeVisible();
      }
      // Let the scrim's fade settle.
      await page.waitForTimeout(250);

      const file = path.join(OUT!, `${capture.name}.png`);
      const box = await dialog.boundingBox();
      if (!box) throw new Error('the dialog has no box to capture');
      const viewport = page.viewportSize()!;
      const pad = 24;
      const x = Math.max(0, box.x - pad);
      const y = Math.max(0, box.y - pad);
      await page.screenshot({
        path: file,
        clip: {
          x,
          y,
          width: Math.min(viewport.width - x, box.width + pad * 2),
          height: Math.min(viewport.height - y, box.height + pad * 2),
        },
      });
      // Count what was written rather than trusting the call returned.
      expect(fs.statSync(file).size).toBeGreaterThan(5_000);
    });
  }
});
