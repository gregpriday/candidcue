/**
 * How a Playwright spec talks to the Library collection.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE HELPERS RATHER THAN INLINE LOCATORS
 * ---------------------------------------------------------------------------
 * The Library was a `role="list"` of cards whose bodies were buttons, so every
 * spec opened a script with `list.getByRole('button', { name: /Title/ }).click()`
 * — thirty-eight of them, each spelling the DOM out again.
 *
 * The desktop pass made it a `role="listbox"` of `role="option"` rows where a
 * single click SELECTS and a double click OPENS (§10.2). That is a behavioural
 * change, not a cosmetic one, and thirty-eight independent spellings of it is
 * thirty-eight chances to encode it slightly differently — and to have half the
 * suite quietly asserting the old model.
 *
 * So the interaction is defined once, here, in the terms the design uses.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The collection itself.
 *
 * Located by ROLE rather than by accessible name, because the name is the
 * current view's title ("All scripts", "Recent", "Trash") and a spec should not
 * have to know which view it landed in to find the list.
 */
export function collection(page: Page): Locator {
  return page.getByRole('listbox');
}

/** One row, by the script's title. */
export function row(page: Page, title: string | RegExp): Locator {
  return collection(page).getByRole('option').filter({ hasText: title });
}

/**
 * Select a row without opening it.
 *
 * This is the interaction that did not exist before: there was nothing to
 * select, so nothing could act on "the selected script".
 */
export async function selectScript(page: Page, title: string | RegExp): Promise<void> {
  const target = row(page, title);
  await target.click();
  await expect(target).toHaveAttribute('aria-selected', 'true');
}

/**
 * Open a script — deliberately by double click, which is the gesture the design
 * chose.
 *
 * A spec that opened with a single click would pass against an implementation
 * that had regressed to click-to-open, which is exactly the model this refinement
 * moved away from.
 */
export async function openScript(page: Page, title: string | RegExp): Promise<void> {
  await row(page, title).dblclick();
}

/** Open via the keyboard, which must reach the same place. */
export async function openSelectedWithKeyboard(page: Page): Promise<void> {
  await collection(page).getByRole('option').and(page.locator('[aria-selected="true"]')).press('Enter');
}

/** The overflow trigger on a row — distinct from the toolbar's view options. */
export function rowMenu(page: Page, title: string): Locator {
  return page.getByRole('button', { name: `Actions for ${title}` });
}

/** The toolbar's sort/density menu. */
export function viewOptions(page: Page): Locator {
  return page.getByRole('button', { name: 'View options' });
}
