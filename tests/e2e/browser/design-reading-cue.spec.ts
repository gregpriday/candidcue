import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';
import { openScript } from './fixtures/library';

/**
 * Capture harness for the reading cue — design review only.
 *
 * Opt-in: it runs only when `DESIGN_CAPTURE_DIR` names a directory, so the
 * normal suite and CI skip every test here.
 *
 * Two seams, because the cue is drawn in two places that reach it differently:
 *
 *   - THE GLASS, through `/stage.html?preview=1`. The preview driver resolves a
 *     rig through the real optical model and feeds the stage's own event
 *     protocol on the local bus; the harness stops its clock and then speaks on
 *     that same bus, so every state is a real alignment snapshot through the
 *     real renderer. `?calibrated=0` is the flat layout an unmeasured rig gets.
 *   - A READING WINDOW, through `control.html` and the Tauri shim, presented in a
 *     window exactly as a user does it, on Dark and on Paper. Snapshots arrive
 *     on `align://snapshot`, the way Rust delivers them.
 *
 * Each state is checked on screen BEFORE its file is written: the document has
 * stopped moving, the cue is in the style and the rung the state names, and the
 * line it is supposed to mark is the one the harness chose. A capture that did
 * not reach its state throws instead of saving a plausible wrong frame.
 *
 *   DESIGN_CAPTURE_DIR=/tmp/shots SPEAKING_GLASS_E2E_PORT=5312 \
 *     ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *     tests/e2e/browser/design-reading-cue.spec.ts --project=chromium
 */

const CAPTURE_DIR = process.env.DESIGN_CAPTURE_DIR ?? '';

test.skip(CAPTURE_DIR === '', 'design capture harness: set DESIGN_CAPTURE_DIR to run it');

type CueStyle = 'ticks' | 'wash';
type Rung = 'none' | 'hollow' | 'message';

/** Where on a line the reader is: its first word, or its last. */
type Phase = 'entry' | 'late';

interface CueState {
  name: string;
  style: CueStyle;
  phase: Phase;
  rung: Rung;
}

const STATES: CueState[] = [
  { name: 'ticks-entry', style: 'ticks', phase: 'entry', rung: 'none' },
  { name: 'ticks-late', style: 'ticks', phase: 'late', rung: 'none' },
  { name: 'ticks-hollow', style: 'ticks', phase: 'entry', rung: 'hollow' },
  { name: 'ticks-held', style: 'ticks', phase: 'entry', rung: 'message' },
  { name: 'wash-entry', style: 'wash', phase: 'entry', rung: 'none' },
  { name: 'wash-late', style: 'wash', phase: 'late', rung: 'none' },
  { name: 'wash-hollow', style: 'wash', phase: 'entry', rung: 'hollow' },
  { name: 'wash-held', style: 'wash', phase: 'entry', rung: 'message' },
];

/* The ladder's own thresholds (`renderer/hold-status.ts`), plus a margin. */
const HOLLOW_AFTER_MS = 1_500 + 400;
const MESSAGE_AFTER_MS = 3_500 + 400;

interface Line {
  first: number;
  last: number;
}

/**
 * The second line of the first paragraph that wraps onto three or more.
 *
 * A middle line on purpose: its entry and its last word are both an ordinary
 * line, with no paragraph gap above or below it to flatter the mark.
 */
async function middleLine(page: Page): Promise<Line> {
  const line = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll<HTMLElement>('.script-layer [data-block-id]')];
    for (const block of blocks) {
      const words = [...block.querySelectorAll<HTMLElement>('[data-t]')];
      const lines: Array<{ first: number; last: number; top: number }> = [];
      for (const word of words) {
        const t = Number(word.dataset.t);
        const top = word.getBoundingClientRect().top;
        const current = lines[lines.length - 1];
        if (current && Math.abs(current.top - top) < 4) current.last = t;
        else lines.push({ first: t, last: t, top });
      }
      if (lines.length >= 3) return { first: lines[1]!.first, last: lines[1]!.last };
    }
    return null;
  });
  if (!line) throw new Error('no paragraph wraps onto three lines — refusing to capture');
  return line;
}

/** The scroll plane's transform has stopped changing. */
async function settled(page: Page): Promise<void> {
  let previous = '';
  let still = 0;
  await expect
    .poll(
      async () => {
        const now = await page
          .locator('.scroll-plane')
          .evaluate((el) => getComputedStyle(el).transform);
        still = now === previous ? still + 1 : 0;
        previous = now;
        return still;
      },
      { timeout: 15_000, intervals: [200] },
    )
    .toBeGreaterThanOrEqual(4);
}

/**
 * The line being marked is the one the state named, and at the phase it named.
 *
 * Measured against the tick rather than against the band number, so it holds
 * on every layout: at entry the cap middle of the line's first word sits on the
 * mark; late in the line the same word has risen most of a pitch above it.
 */
async function assertPhase(page: Page, line: Line, phase: Phase): Promise<void> {
  const { capMid, mark, pitch } = await page.evaluate((first) => {
    const word = document.querySelector<HTMLElement>(`.script-layer [data-t="${first}"]`)!;
    const box = word.getBoundingClientRect();
    const tick = document.querySelector<HTMLElement>('.cue .tick, .cue .wash-band');
    const tickBox = tick!.getBoundingClientRect();
    const column = document.querySelector<HTMLElement>('.script-layer .column')!;
    const pitchPx = Number.parseFloat(getComputedStyle(column).lineHeight);
    // The wash band's mark is the plateau's lower edge, which is the tick's centre.
    const markPx = tick!.classList.contains('wash-band')
      ? tickBox.top + tickBox.height * (Number.parseFloat(getComputedStyle(tick!).getPropertyValue('--plateau-bottom')) / 100)
      : tickBox.top + tickBox.height / 2;
    return { capMid: box.top + box.height / 2, mark: markPx, pitch: pitchPx };
  }, line.first);
  const offset = (mark - capMid) / pitch;
  if (phase === 'entry') {
    expect(Math.abs(offset), `line entry: mark is ${offset.toFixed(2)} pitches off the line`).toBeLessThan(0.45);
  } else {
    expect(offset, `late in the line: mark is ${offset.toFixed(2)} pitches below the line`).toBeGreaterThan(0.45);
  }
}

async function assertRung(page: Page, style: CueStyle, rung: Rung): Promise<void> {
  const cue = page.locator(`.cue.${style}`);
  await expect(cue).toHaveCount(1);
  await expect(cue).toHaveAttribute('data-hollow', rung === 'none' ? 'false' : 'true', {
    timeout: 6_000,
  });
  // The chip is always mounted, so that its own fade has something to fade.
  await expect(page.locator('.hold-status')).toHaveAttribute(
    'data-visible',
    rung === 'message' ? 'true' : 'false',
  );
}

async function shot(page: Page, name: string): Promise<void> {
  // Past the cue's own fill tween and the chip's arrival.
  await page.waitForTimeout(400);
  mkdirSync(CAPTURE_DIR, { recursive: true });
  await page.screenshot({ path: join(CAPTURE_DIR, `${name}.png`), caret: 'hide' });
}

interface Speaker {
  speak(token: number, state: 'following' | 'holding', decision: string): Promise<void>;
}

/* ---------------------------------------------------------------------------
 * The glass: the stage preview
 * ------------------------------------------------------------------------- */

const GLASS = [
  { name: 'prompter9', width: 1024, height: 600, query: '' },
  { name: 'flat1080', width: 1920, height: 1080, query: '&calibrated=0' },
] as const;

function previewSpeaker(page: Page): Speaker {
  return {
    async speak(token, state, decision) {
      await page.evaluate(
        async ({ token, state, decision }) => {
          const url = '/src/stage/events.ts';
          const bus = (await import(/* @vite-ignore */ url)) as {
            dispatchLocalStageEvent(name: string, payload: unknown): void;
          };
          const holder = window as unknown as { __cueSeq?: number };
          holder.__cueSeq = (holder.__cueSeq ?? 100_000) + 1;
          const atMs = holder.__cueSeq * 10;
          bus.dispatchLocalStageEvent('stage://alignment-snapshot', {
            sessionGeneration: 1,
            seq: holder.__cueSeq,
            state,
            decision,
            confirmedToken: token,
            observedToken: token,
            rateTokensPerSecond: 0,
            evidenceAudioMs: atMs,
            atAudioMs: atMs,
            maxPredictionMs: 900,
            pauseOnsetMs: 1800,
            leadFloorMs: 0,
            maxLeadTokens: 0,
            leadMarginTokens: 0,
            leadEaseMs: 450,
            leadHoldMs: 0,
            leadDecayMs: 1200,
            displayLimitToken: token + 6,
            confidence: state === 'following' ? 0.92 : 0.3,
            suggestionToken: null,
            scriptLenTokens: 200,
            observedAtom: token,
            confirmedAtom: token,
          });
        },
        { token, state, decision },
      );
    },
  };
}

async function bootGlass(page: Page, glass: (typeof GLASS)[number], style: CueStyle): Promise<void> {
  await page.setViewportSize({ width: glass.width, height: glass.height });
  await page.goto(`/stage.html?preview=1${glass.query}`);
  const root = page.locator('.stage-root');
  await expect(root).toHaveAttribute('data-phase', 'live');
  await expect(page.locator('.cue.ticks')).toHaveCount(1);
  // Stop the preview's own speech; from here the harness is the only speaker.
  await page.evaluate(() => {
    (window as unknown as { __stagePreview?: { stop(): void } }).__stagePreview?.stop();
  });
  if (style === 'wash') await root.press('r');
  await expect(page.locator(`.cue.${style}`)).toHaveCount(1);
  // The dock introduces itself and fades; a take is read without it.
  await expect(page.locator('.stage-dock .dock-button.end')).toHaveAttribute('data-hidden', 'true', {
    timeout: 12_000,
  });
}

/* ---------------------------------------------------------------------------
 * A reading window: control, presented in a window
 * ------------------------------------------------------------------------- */

const READER_SCRIPT: ShimScriptSeed = {
  id: '99999999-9999-4999-8999-999999999999',
  title: 'The survey boat',
  source:
    '# The survey boat\n\n' +
    'The harbour was quiet the morning the survey boat came in, low in the water and an hour later than anybody had said. ' +
    'Nobody on the quay knew what it had found, and the crew were not saying, which in a town that size was its own kind of announcement.\n\n' +
    'By noon the story had three versions. The harbourmaster had one, the café had another, and the third came from a boy ' +
    'who had been fishing off the breakwater and swore he had seen the winch bring something up in a net.\n\n' +
    'None of them were right, as it turned out, but the third was closest.\n',
};

const READERS = [
  { name: 'reader-dark', theme: 'dark' },
  { name: 'reader-paper', theme: 'paper' },
] as const;

function readerSpeaker(page: Page): Speaker {
  return {
    async speak(token, state, decision) {
      const delivered = await page.evaluate(
        ({ token, state, decision }) => {
          const holder = window as unknown as { __cueSeq?: number };
          holder.__cueSeq = (holder.__cueSeq ?? 0) + 1;
          const atMs = 2_000 + holder.__cueSeq * 500;
          return window.__E2E__.emit('align://snapshot', {
            sessionGeneration: window.__E2E__.lastSession?.sessionGeneration ?? 0,
            seq: holder.__cueSeq,
            state,
            decision,
            confirmedToken: token,
            observedToken: token,
            rateTokensPerSecond: 0,
            evidenceAudioMs: atMs,
            atAudioMs: atMs,
            maxPredictionMs: 800,
            pauseOnsetMs: 400,
            leadFloorMs: 0,
            maxLeadTokens: 0,
            leadMarginTokens: 0,
            leadEaseMs: 450,
            leadHoldMs: 0,
            leadDecayMs: 1200,
            displayLimitToken: token + 6,
            confidence: state === 'following' ? 0.92 : 0.3,
            suggestionToken: null,
            scriptLenTokens: 120,
            observedAtom: token,
            confirmedAtom: token,
          });
        },
        { token, state, decision },
      );
      expect(delivered).toBeGreaterThan(0);
    },
  };
}

async function bootReader(page: Page, theme: 'dark' | 'paper', style: CueStyle): Promise<void> {
  await page.setViewportSize({ width: 1240, height: 820 });
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [READER_SCRIPT],
    presentationMode: 'reader',
    engineStatus: {
      available: true,
      loaded: true,
      model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    },
    promptMode: 'voice',
  });
  await page.addInitScript(
    ({ theme, style }) => {
      const key = 'speaking-glass.settings-overlay.v1';
      const overlay = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      const teleprompter = (overlay['teleprompter'] ?? {}) as Record<string, unknown>;
      overlay['teleprompter'] = { ...teleprompter, readerTheme: theme, readingCue: style };
      localStorage.setItem(key, JSON.stringify(overlay));
    },
    { theme, style },
  );
  await page.goto('/control.html');
  await openScript(page, /The survey boat/);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await page.getByRole('button', { name: 'How to present' }).click();
  await page
    .getByRole('menu', { name: 'How to present' })
    .getByRole('menuitemradio', { name: /Present in a window/ })
    .click();
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', /ready|live/, {
    timeout: 20_000,
  });
  await expect(page.locator('.stage-root')).toHaveAttribute(
    'data-theme',
    theme === 'paper' ? 'reader-paper' : 'stage-dark',
  );
  await expect(page.locator(`.cue.${style}`)).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => window.__E2E__.settled.includes('start_transcription')), {
      timeout: 15_000,
    })
    .toBe(true);
  /*
   * Words keep coming back for the whole capture.
   *
   * The browser's fake microphone is never silent, so without recogniser text
   * the voice pill rightly raises "Not hearing you" — a named fault, which
   * outranks the hold ladder and would put a fault chip in every frame. A hold
   * with words still arriving is the ordinary case anyway: the presenter is
   * speaking and the engine has declined to place them.
   */
  await page.evaluate(() => {
    const generation =
      40 + window.__E2E__.calls.filter((call) => call.command === 'start_transcription').length;
    window.__E2E__.emit('stt://event', { kind: 'transport', generation, state: 'connected' });
    let n = 0;
    window.setInterval(() => {
      n += 1;
      window.__E2E__.emit('stt://event', {
        kind: 'partial',
        generation,
        itemId: `cue-${n}`,
        text: 'the harbour was quiet the morning',
      });
    }, 700);
  });
  // Park the pointer off the glass so nothing hover-revealed is in the frame.
  await page.mouse.move(0, 0);
}

/* ---------------------------------------------------------------------------
 * One state, on either seam
 * ------------------------------------------------------------------------- */

async function drive(page: Page, speaker: Speaker, state: CueState): Promise<void> {
  const line = await middleLine(page);
  const token = state.phase === 'entry' ? line.first : line.last;
  // A deliberate relocation lands without a long glide, then the position is
  // confirmed so the follower has a steady target to rest on.
  await speaker.speak(token, 'following', 'relocationAccepted');
  await page.waitForTimeout(300);
  await speaker.speak(token, 'following', 'localConfirmed');
  await settled(page);
  await assertPhase(page, line, state.phase);

  if (state.rung !== 'none') {
    await speaker.speak(token, 'holding', 'holdLowEvidence');
    await page.waitForTimeout(state.rung === 'hollow' ? HOLLOW_AFTER_MS : MESSAGE_AFTER_MS);
  }
  await assertRung(page, state.style, state.rung);
  // A hold must not have moved the document.
  await assertPhase(page, line, state.phase);
}

for (const glass of GLASS) {
  test.describe(`reading cue on the glass — ${glass.name}`, () => {
    for (const state of STATES) {
      test(`${glass.name} ${state.name}`, async ({ page }) => {
        await bootGlass(page, glass, state.style);
        await drive(page, previewSpeaker(page), state);
        await shot(page, `${glass.name}--${state.name}`);
      });
    }
  });
}

for (const reader of READERS) {
  test.describe(`reading cue in a reading window — ${reader.name}`, () => {
    for (const state of STATES) {
      test(`${reader.name} ${state.name}`, async ({ page }) => {
        await bootReader(page, reader.theme, state.style);
        await drive(page, readerSpeaker(page), state);
        await shot(page, `${reader.name}--${state.name}`);
      });
    }
  });
}
