import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { collection } from './fixtures/library';
import { openPreferences } from './fixtures/preferences';

/**
 * The desk follows the system's light or dark appearance (#231), in a real
 * browser.
 *
 * `design-system-tokens.test.ts` checks the palettes by parsing `tokens.css`,
 * which says what the dark block declares but not what an element ends up
 * with: a more specific or later rule anywhere in the bundle — a component's
 * scoped override, an `html[...]` selector — wins the cascade and the parser
 * never sees it. And a window whose entry point stops calling
 * `followSystemAppearance` would still parse fine. So this loads both desk
 * windows, emulates the system's choice, and reads the colours the browser
 * actually resolves on the element that carries the workspace theme.
 *
 * It says nothing about WKWebView or WebView2, which is what ships — see
 * CLAUDE.md on that gap — only that the page answers `prefers-color-scheme`.
 */

type Rgb = [number, number, number];

interface Resolved {
  appearance: string | undefined;
  colorScheme: string;
  /** Each token, resolved through the real cascade to an `rgb()` colour. */
  colours: Record<string, string>;
}

const PROBED = ['--accent-strong', '--text-primary', '--bg-canvas', '--bg-panel', '--bg-chrome'];

/**
 * Resolve tokens where the desk draws: a probe element inside the themed
 * element takes each token as its `color`, so the browser does the cascade,
 * the `var()` lookup and the colour parse, and hands back `rgb()`.
 */
async function resolveDesk(page: Page): Promise<Resolved> {
  return page.evaluate((tokens) => {
    const themed = document.querySelector<HTMLElement>("[data-theme='workspace']");
    if (!themed) throw new Error('no element carries the workspace theme');
    const probe = document.createElement('span');
    themed.appendChild(probe);
    const colours: Record<string, string> = {};
    for (const token of tokens) {
      probe.style.color = `var(${token})`;
      colours[token] = getComputedStyle(probe).color;
    }
    probe.remove();
    return {
      appearance: document.documentElement.dataset['appearance'],
      colorScheme: getComputedStyle(themed).colorScheme,
      colours,
    };
  }, PROBED);
}

function rgb(css: string): Rgb {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(css);
  expect(m, `${css} must be an rgb() colour`).not.toBeNull();
  expect(m![4] === undefined || Number(m![4]) === 1, `${css} must be opaque`).toBe(true);
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}

function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** What #231 asks of either appearance: small accent text and body text clear AA. */
function expectReadable(desk: Resolved): void {
  for (const ground of ['--bg-canvas', '--bg-panel', '--bg-chrome']) {
    for (const ink of ['--accent-strong', '--text-primary']) {
      expect(
        contrast(desk.colours[ink]!, desk.colours[ground]!),
        `${ink} (${desk.colours[ink]}) on ${ground} (${desk.colours[ground]})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
}

const WINDOWS = [
  {
    name: 'the control window',
    open: async (page: Page) => {
      await page.goto('/control.html');
      await collection(page).getByRole('option').first().waitFor();
    },
  },
  { name: 'the Settings window', open: openPreferences },
];

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Launch keynote',
        source: '# Launch keynote\n\nWelcome everyone to the show.\n',
      },
    ],
  });
});

for (const desk of WINDOWS) {
  test(`${desk.name} opens dark on a dark system and follows it back to light`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await desk.open(page);

    const dark = await resolveDesk(page);
    expect(dark.appearance).toBe('dark');
    expect(dark.colorScheme).toBe('dark');
    expectReadable(dark);
    // Dark ground under light ink, not the light desk with an attribute on it.
    expect(luminance(rgb(dark.colours['--bg-canvas']!))).toBeLessThan(0.05);
    expect(luminance(rgb(dark.colours['--text-primary']!))).toBeGreaterThan(0.7);

    // The system changes while the window is open; nothing reloads.
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(async () => (await resolveDesk(page)).appearance).toBe('light');

    const light = await resolveDesk(page);
    expect(light.colorScheme).not.toBe('dark');
    expectReadable(light);
    expect(luminance(rgb(light.colours['--bg-canvas']!))).toBeGreaterThan(0.7);
    for (const token of PROBED) {
      expect(light.colours[token], `${token} must differ between the appearances`).not.toBe(
        dark.colours[token],
      );
    }
  });
}
