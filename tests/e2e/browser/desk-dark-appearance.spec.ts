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
  /** Each place probed, with each token resolved there to an `rgb()` colour. */
  places: { where: string; colours: Record<string, string> }[];
}

const PROBED = ['--accent-strong', '--text-primary', '--bg-canvas', '--bg-panel', '--bg-chrome'];

/**
 * Resolve tokens where the desk draws. A probe element takes each token as
 * its `color`, so the browser does the cascade, the `var()` lookup and the
 * colour parse, and hands back `rgb()`. It is placed inside EVERY element that
 * carries the workspace theme — the control window mirrors it onto `<html>`
 * as well as its `.shell`, so the first one alone is not where the library
 * draws — and inside one element deep in the window's own content, so an
 * override scoped to the shell or below it is read too.
 */
async function resolveDesk(page: Page, deep: string): Promise<Resolved> {
  return page.evaluate(
    ({ tokens, deep }) => {
      const themed = [...document.querySelectorAll<HTMLElement>("[data-theme='workspace']")];
      if (themed.length === 0) throw new Error('no element carries the workspace theme');
      const inner = document.querySelector<HTMLElement>(deep);
      if (!inner) throw new Error(`nothing matches ${deep}`);
      const describe = (el: HTMLElement) =>
        el === inner ? deep : `${el.tagName.toLowerCase()}${el.className ? `.${el.className}` : ''}`;
      const places = [...themed, inner].map((host) => {
        const probe = document.createElement('span');
        host.appendChild(probe);
        const colours: Record<string, string> = {};
        for (const token of tokens) {
          probe.style.color = `var(${token})`;
          colours[token] = getComputedStyle(probe).color;
        }
        probe.remove();
        return { where: describe(host), colours };
      });
      return {
        appearance: document.documentElement.dataset['appearance'],
        colorScheme: getComputedStyle(inner).colorScheme,
        places,
      };
    },
    { tokens: PROBED, deep },
  );
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
  expect(desk.places.length).toBeGreaterThan(1);
  for (const { where, colours } of desk.places) {
    for (const ground of ['--bg-canvas', '--bg-panel', '--bg-chrome']) {
      for (const ink of ['--accent-strong', '--text-primary']) {
        expect(
          contrast(colours[ink]!, colours[ground]!),
          `${ink} (${colours[ink]}) on ${ground} (${colours[ground]}) in ${where}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
}

/** Every place probed, held to the same test. */
function everywhere(desk: Resolved, check: (colours: Record<string, string>, where: string) => void) {
  for (const { where, colours } of desk.places) check(colours, where);
}

const WINDOWS = [
  {
    name: 'the control window',
    // The library's list, inside the shell, inside the route.
    deep: '[role="listbox"]',
    open: async (page: Page) => {
      await page.goto('/control.html');
      await collection(page).getByRole('option').first().waitFor();
    },
  },
  // The section content Settings draws its forms in.
  { name: 'the Settings window', deep: 'main.shell .content', open: openPreferences },
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

    const dark = await resolveDesk(page, desk.deep);
    expect(dark.appearance).toBe('dark');
    expect(dark.colorScheme).toBe('dark');
    expectReadable(dark);
    // Dark ground under light ink, not the light desk with an attribute on it.
    everywhere(dark, (colours, where) => {
      expect(luminance(rgb(colours['--bg-canvas']!)), where).toBeLessThan(0.05);
      expect(luminance(rgb(colours['--text-primary']!)), where).toBeGreaterThan(0.7);
    });

    // The system changes while the window is open; nothing reloads.
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(async () => (await resolveDesk(page, desk.deep)).appearance).toBe('light');

    const light = await resolveDesk(page, desk.deep);
    expect(light.colorScheme).toBe('light');
    expectReadable(light);
    everywhere(light, (colours, where) => {
      expect(luminance(rgb(colours['--bg-canvas']!)), where).toBeGreaterThan(0.7);
      const before = dark.places.find((place) => place.where === where)!.colours;
      for (const token of PROBED) {
        expect(colours[token], `${token} in ${where} must differ between the appearances`).not.toBe(
          before[token],
        );
      }
    });
  });
}
