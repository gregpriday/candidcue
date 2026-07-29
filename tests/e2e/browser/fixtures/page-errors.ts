import { expect, type Page } from '@playwright/test';

/**
 * Uncaught-error watch for the browser E2E layer.
 *
 * The compiler-worker `ReferenceError: document is not defined` (fixed in
 * e630311) lived for the life of the project, passed every unit test, and only
 * appeared when something drove the real app in a real browser — where it
 * surfaced as an uncaught page error nobody was watching for. So every journey
 * spec watches, and an uncaught error on a route the test walked is a failure
 * of that route, not incidental noise.
 *
 * `console.error` counts too: the app never logs one deliberately, and Chromium
 * reports failed subresource loads and unhandled promise rejections there.
 */
export interface ErrorWatch {
  /** Everything seen so far, newest last. */
  readonly seen: string[];
  /** Fail now if the page raised anything. Call at the end of a journey. */
  expectClean(): void;
}

export function watchPageErrors(page: Page): ErrorWatch {
  const seen: string[] = [];

  page.on('pageerror', (error) => {
    seen.push(`uncaught ${error.name}: ${error.message}\n${error.stack ?? '(no stack)'}`);
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    seen.push(`console.error: ${message.text()}`);
  });

  return {
    seen,
    expectClean() {
      expect(seen, `the page raised errors:\n${seen.join('\n')}`).toEqual([]);
    },
  };
}
