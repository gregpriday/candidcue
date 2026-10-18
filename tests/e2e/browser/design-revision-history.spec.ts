/**
 * Design capture harness for the revision browser (Script actions › Revision
 * history). Opt-in: it writes screenshots for a design review and asserts
 * nothing about behaviour, so it never runs in the normal suite.
 *
 *   DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out CANDIDCUE_E2E_PORT=5316 \
 *     ./node_modules/.bin/playwright test tests/e2e/browser/design-revision-history.spec.ts
 *
 * The common shim answers `list_revisions` with `[]` and knows nothing about
 * `get_revision` or `restore_revision`, so this spec wraps the shim's `invoke`
 * for exactly those three commands and forwards every other command unchanged.
 * Each state is driven through that seam — held, failed or answered — before
 * the browser is opened, never by reaching into the component.
 *
 * The clock is pinned so "Today", "Yesterday" and "3 hours ago" render the same
 * on every run.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installTauriShim } from './fixtures/tauri-shim';
import { collection, openScript } from './fixtures/library';

const CAPTURE = process.env['DESIGN_CAPTURE'] === '1';
const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!CAPTURE, 'design capture harness — set DESIGN_CAPTURE=1');

/** Thursday afternoon, local time. */
const NOW = new Date(2026, 9, 15, 16, 20, 0);

const SIZES = [
  { name: 'default', width: 1240, height: 820 },
  { name: 'min', width: 980, height: 680 },
] as const;

/* ------------------------------------------------------------------------ */
/* Fixture drafts                                                           */
/* ------------------------------------------------------------------------ */

const PARAGRAPHS = [
  'Most teleprompters make you choose between reading and performing. You either lock your eyes on the glass and sound like you are reading, or you look away and lose your place. This one listens instead, so the words follow you rather than the other way round.',
  'Here is the part that surprised me. The hard problem was never transcription. It was deciding, from a few half-heard words, where in the script you actually are, and doing it without ever jumping somewhere you did not go.',
  '[Beat] So the engine is deliberately boring. It is deterministic, it never invents a position, and when it is unsure it simply waits for the next phrase. That patience is what makes it feel calm on camera.',
  'If you ad-lib, it holds. If you skip a paragraph, it notices the jump and catches up once two or three words agree. If you go back to retake a line, it follows you back without a fight.',
  '[Cue: look at the lens] The model runs on your own machine. Nothing you say leaves it, and there is no account to sign into before you can record.',
  'Setting up takes about a minute. Pick the display your prompter glass sits on, choose a reading distance, and press Present. The type is sized for the distance you chose, not for the pixels on the panel.',
  'I recorded this whole series with it, including the takes where I lost my thread completely. [Pause] Those are the ones I learned the most from.',
  'Next time I will walk through the settings that matter for a real studio rig, and the two I would leave alone.',
  'One more thing before we wrap. Everything you write is plain Markdown, stored as files you own. If you ever stop using it, your scripts come with you.',
  'Thanks for watching. If this was useful, the link to try it is in the description, and it is free.',
];

const SECTIONS = [
  'Opening',
  'Why voice following',
  'How the engine decides',
  'Ad-libs and retakes',
  'Privacy',
  'Setting up the rig',
  'Recording the series',
  'What comes next',
];

/** A draft with `sections` headed parts, `perSection` paragraphs each. */
function draft(title: string, sections: number, perSection: number, offset = 0): string {
  const parts = [`# ${title}`];
  for (let s = 0; s < sections; s += 1) {
    parts.push(`## ${SECTIONS[s % SECTIONS.length]}`);
    for (let p = 0; p < perSection; p += 1) {
      parts.push(PARAGRAPHS[(s * perSection + p + offset) % PARAGRAPHS.length]!);
    }
  }
  return `${parts.join('\n\n')}\n`;
}

/** Spoken words, as the editor counts them: headings and cues are not read. */
function words(source: string): number {
  return source
    .replace(/^#+\s.*$/gm, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

const SCRIPT_TITLE = 'Voice following, explained';
const CURRENT = draft(SCRIPT_TITLE, 8, 3);
const SCRIPT = {
  id: '51d0c0de-5d0c-4d0c-8d0c-51d0c0de5d0c',
  title: SCRIPT_TITLE,
  source: CURRENT,
  scriptRevision: 41,
};

interface FixtureRevision {
  id: string;
  revisionNumber: number;
  sourceHash: string;
  reason: string;
  wordCount?: number;
  createdAt: string;
  source: string;
}

/** `minutesAgo` before NOW, so the day groups and ages are stable. */
function revision(
  n: number,
  reason: string,
  minutesAgo: number,
  source: string,
  withCount = true,
): FixtureRevision {
  return {
    id: `rev-${String(n).padStart(3, '0')}`,
    revisionNumber: n,
    sourceHash: `hash${n}`,
    reason,
    wordCount: withCount ? words(source) : undefined,
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    source,
  };
}

/** Newest first, as Rust orders them. Spread across four days. */
function manyRevisions(): FixtureRevision[] {
  const list: FixtureRevision[] = [];
  let n = 40;
  // Today: a working session, a take, and a restore.
  list.push(revision(n--, 'autosave_interval', 6, draft(SCRIPT_TITLE, 8, 3)));
  list.push(revision(n--, 'before_restore', 22, draft(SCRIPT_TITLE, 8, 3, 1)));
  list.push(revision(n--, 'pre_session', 48, draft(SCRIPT_TITLE, 7, 3)));
  list.push(revision(n--, 'autosave_interval', 63, draft(SCRIPT_TITLE, 7, 3, 2)));
  list.push(revision(n--, 'autosave_interval', 78, draft(SCRIPT_TITLE, 7, 2)));
  list.push(revision(n--, 'external_change', 130, draft(SCRIPT_TITLE, 6, 3)));
  list.push(revision(n--, 'autosave_interval', 185, draft(SCRIPT_TITLE, 6, 2)));
  // Yesterday.
  for (let i = 0; i < 6; i += 1) {
    list.push(revision(n--, i === 2 ? 'pre_session' : 'autosave_interval', 60 * 22 + i * 17, draft(SCRIPT_TITLE, 6 - (i % 3), 2, i)));
  }
  list.push(revision(n--, 'external_change_preserved', 60 * 26, draft(SCRIPT_TITLE, 4, 2)));
  // Earlier in the week.
  for (let i = 0; i < 5; i += 1) {
    list.push(revision(n--, 'autosave_interval', 60 * 50 + i * 25, draft(SCRIPT_TITLE, 4, 2, i), i !== 3));
  }
  list.push(revision(n--, 'recovered', 60 * 72, draft(SCRIPT_TITLE, 3, 2)));
  list.push(revision(n--, 'import', 60 * 75, draft('Voice following (outline)', 2, 2)));
  list.push(revision(n--, 'initial', 60 * 75 + 1, '# Voice following (outline)\n\nIntro, the engine, privacy, setup.\n'));
  return list;
}

/* ------------------------------------------------------------------------ */
/* The revision seam                                                        */
/* ------------------------------------------------------------------------ */

type Mode = 'answer' | 'hold' | 'fail';

interface RevisionSeam {
  revisions: FixtureRevision[];
  list: Mode;
  get: Mode;
  /** Only this id is held/failed; the rest answer. `null` = every id. */
  getOnly: string | null;
  restore: Mode;
  listError: unknown;
  getError: unknown;
  restoreError: unknown;
}

/**
 * Wrap the shim's `invoke` for the three revision commands.
 *
 * Installed AFTER `installTauriShim`, so `__TAURI_INTERNALS__` already exists
 * when this runs, and before the app boots. Held commands never answer — a
 * capture is taken of the in-flight frame and the page is thrown away.
 */
async function installRevisionSeam(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seam = {
      revisions: [],
      list: 'answer',
      get: 'answer',
      getOnly: null,
      restore: 'answer',
      listError: null,
      getError: null,
      restoreError: null,
    } as unknown as RevisionSeam;
    (window as unknown as { __REV__: RevisionSeam }).__REV__ = seam;

    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const forward = internals.invoke.bind(internals);
    const pending = () => new Promise<never>(() => {});
    const summary = (r: FixtureRevision) => {
      const { source: _source, ...rest } = r;
      return rest;
    };

    internals.invoke = (command, args) => {
      if (command === 'list_revisions') {
        if (seam.list === 'hold') return pending();
        if (seam.list === 'fail') return Promise.reject(seam.listError);
        return Promise.resolve(seam.revisions.map(summary));
      }
      if (command === 'get_revision') {
        const id = args?.['revisionId'] as string;
        const targeted = seam.getOnly === null || seam.getOnly === id;
        if (targeted && seam.get === 'hold') return pending();
        if (targeted && seam.get === 'fail') return Promise.reject(seam.getError);
        const found = seam.revisions.find((r) => r.id === id);
        return found
          ? Promise.resolve(found)
          : Promise.reject({ code: 'NOT_FOUND', userMessage: 'Revision not found.' });
      }
      if (command === 'restore_revision') {
        if (seam.restore === 'hold') return pending();
        if (seam.restore === 'fail') return Promise.reject(seam.restoreError);
        return Promise.resolve({
          scriptRevision: 42,
          sourceHash: 'restored',
          savedAt: new Date().toISOString(),
          revisionCreated: true,
          revisionId: 'rev-041',
        });
      }
      return forward(command, args);
    };
  });
}

async function configure(page: Page, patch: Partial<RevisionSeam>): Promise<void> {
  await page.evaluate((p) => {
    Object.assign((window as unknown as { __REV__: RevisionSeam }).__REV__, p);
  }, patch);
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Revision history' });

/** Boot into the editor with the script open, at one window size. */
async function boot(page: Page, size: (typeof SIZES)[number]): Promise<void> {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.clock.setFixedTime(NOW);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    engineStatus: {
      available: true,
      loaded: true,
      model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    },
    promptMode: 'voice',
  });
  await installRevisionSeam(page);
  await page.goto('/control.html');
  await expect(collection(page)).toBeVisible();
  await openScript(page, SCRIPT.title);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
}

async function openHistory(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Script actions' }).click();
  await page.getByRole('menuitem', { name: /Revision History/ }).click();
  await expect(dialog(page)).toBeVisible();
}

async function shoot(page: Page, state: string, size: (typeof SIZES)[number]): Promise<void> {
  // Let entrance animations and the preview's layout settle.
  await page.waitForTimeout(350);
  await page.mouse.move(2, 2);
  await page.screenshot({ path: join(OUT!, `revisions--${state}--${size.name}.png`) });
}

/* ------------------------------------------------------------------------ */
/* States                                                                    */
/* ------------------------------------------------------------------------ */

const STATES: Array<{
  name: string;
  drive: (page: Page) => Promise<void>;
}> = [
  {
    name: 'loading',
    drive: async (page) => {
      await configure(page, { revisions: manyRevisions(), list: 'hold' });
      await openHistory(page);
      await expect(dialog(page)).toContainText(/Loading/);
    },
  },
  {
    name: 'empty',
    drive: async (page) => {
      await configure(page, { revisions: [] });
      await openHistory(page);
      await expect(dialog(page)).toContainText(/No revisions/);
    },
  },
  {
    name: 'list-failure',
    drive: async (page) => {
      await configure(page, {
        revisions: manyRevisions(),
        list: 'fail',
        listError: {
          code: 'INTERNAL_UNEXPECTED',
          userMessage: 'The revision index could not be read.',
        },
      });
      await openHistory(page);
      await expect(dialog(page).locator('.danger, [data-state="list-error"]').first()).toBeVisible();
    },
  },
  {
    name: 'populated',
    drive: async (page) => {
      await configure(page, { revisions: manyRevisions() });
      await openHistory(page);
      await expect(dialog(page)).toContainText('Voice following, explained');
      await expect(dialog(page).getByRole('button', { name: 'Restore this version' })).toBeEnabled();
    },
  },
  {
    name: 'many-scrolled',
    drive: async (page) => {
      await configure(page, { revisions: manyRevisions() });
      await openHistory(page);
      await expect(dialog(page).getByRole('button', { name: 'Restore this version' })).toBeEnabled();
      const rows = dialog(page).getByRole('listbox', { name: 'Revisions' }).getByRole('option');
      await rows.nth(16).scrollIntoViewIfNeeded();
      await rows.nth(16).click();
      await expect(dialog(page)).toContainText('Changed outside CandidCue');
      await expect(dialog(page).getByRole('button', { name: 'Restore this version' })).toBeEnabled();
    },
  },
  {
    name: 'long-draft-scrolled',
    drive: async (page) => {
      await configure(page, { revisions: manyRevisions() });
      await openHistory(page);
      const restore = dialog(page).getByRole('button', { name: 'Restore this version' });
      await expect(restore).toBeEnabled();
      const body = dialog(page).locator('.preview-body');
      await body.evaluate((el) => {
        el.scrollTop = Math.round(el.scrollHeight * 0.42);
      });
      await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    },
  },
  {
    name: 'preview-loading',
    drive: async (page) => {
      const revisions = manyRevisions();
      await configure(page, { revisions, get: 'hold', getOnly: revisions[0]!.id });
      await openHistory(page);
      await expect(dialog(page).getByRole('listbox', { name: 'Revisions' })).toBeVisible();
      await expect(dialog(page).getByRole('button', { name: 'Restore this version' })).toBeDisabled();
    },
  },
  {
    name: 'switch-loading',
    drive: async (page) => {
      const revisions = manyRevisions();
      await configure(page, { revisions, get: 'hold', getOnly: revisions[2]!.id });
      await openHistory(page);
      const restore = dialog(page).getByRole('button', { name: 'Restore this version' });
      await expect(restore).toBeEnabled();
      const rows = dialog(page).getByRole('listbox', { name: 'Revisions' }).getByRole('option');
      await rows.nth(2).click();
      await expect(restore).toBeDisabled();
      await expect(dialog(page)).toContainText('Before a session');
    },
  },
  {
    name: 'preview-failure',
    drive: async (page) => {
      const revisions = manyRevisions();
      await configure(page, {
        revisions,
        get: 'fail',
        getOnly: revisions[0]!.id,
        getError: {
          code: 'SCRIPT_FILE_MISSING',
          userMessage: 'The revision file is missing.',
        },
      });
      await openHistory(page);
      await expect(dialog(page)).toContainText('missing');
    },
  },
  {
    name: 'confirm',
    drive: async (page) => {
      await configure(page, { revisions: manyRevisions() });
      await openHistory(page);
      const rows = dialog(page).getByRole('listbox', { name: 'Revisions' }).getByRole('option');
      await rows.nth(2).click();
      await expect(dialog(page).getByRole('button', { name: 'Restore this version' })).toBeEnabled();
      await dialog(page).getByRole('button', { name: 'Restore this version' }).click();
      await expect(dialog(page).getByRole('alert')).toBeVisible();
    },
  },
  {
    name: 'restoring',
    drive: async (page) => {
      await configure(page, { revisions: manyRevisions(), restore: 'hold' });
      await openHistory(page);
      const rows = dialog(page).getByRole('listbox', { name: 'Revisions' }).getByRole('option');
      await rows.nth(2).click();
      await expect(dialog(page).getByRole('button', { name: 'Restore this version' })).toBeEnabled();
      await dialog(page).getByRole('button', { name: 'Restore this version' }).click();
      await expect(dialog(page).getByRole('alert')).toBeVisible();
      await dialog(page).locator('button.danger-primary').click();
      await expect(dialog(page)).toContainText('Restoring');
    },
  },
  {
    name: 'stale-failure',
    drive: async (page) => {
      await configure(page, {
        revisions: manyRevisions(),
        restore: 'fail',
        restoreError: {
          code: 'SCRIPT_CONFLICT',
          category: 'validation',
          userMessage: 'This document changed elsewhere. Reload before saving.',
          recoverable: true,
        },
      });
      await openHistory(page);
      const rows = dialog(page).getByRole('listbox', { name: 'Revisions' }).getByRole('option');
      await rows.nth(2).click();
      await expect(dialog(page).getByRole('button', { name: 'Restore this version' })).toBeEnabled();
      await dialog(page).getByRole('button', { name: 'Restore this version' }).click();
      await dialog(page).locator('button.danger-primary').click();
      await expect(dialog(page).getByRole('button', { name: 'Restore this version' })).toBeFocused();
      await expect(dialog(page)).toContainText(/changed/);
    },
  },
];

for (const size of SIZES) {
  for (const state of STATES) {
    test(`capture revision history — ${state.name} @ ${size.name}`, async ({ page }) => {
      if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repo');
      mkdirSync(OUT, { recursive: true });
      await boot(page, size);
      await state.drive(page);
      // Verified after the settle: refuse to write a frame of the wrong screen.
      await expect(dialog(page)).toBeVisible();
      await shoot(page, state.name, size);
    });
  }
}
