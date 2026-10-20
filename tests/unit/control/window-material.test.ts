/**
 * What the page makes of the window Rust built: the material under it, the
 * titlebar over it, and where the chrome opens to the glass.
 *
 * The global names and values are the contract with `windows/material.rs`,
 * whose own test reads this module's source for them.
 */
import { describe, expect, it } from 'vitest';
import {
  applyWindowMaterial,
  showMaterialRail,
  showSidebar,
  windowMaterial,
  windowTitlebar,
} from '../../../src/control/lib/window-material';

/** Enough of an element for the attribute helpers: a dataset. */
const root = () => ({ dataset: {} as Record<string, string | undefined> }) as unknown as HTMLElement;

describe('the material Rust reports', () => {
  it('names the two materials the page has rules for', () => {
    expect(windowMaterial({ __CANDIDCUE_WINDOW_MATERIAL__: 'vibrancy' })).toBe('vibrancy');
    expect(windowMaterial({ __CANDIDCUE_WINDOW_MATERIAL__: 'mica' })).toBe('mica');
  });

  it('reads anything else — none, a plain browser, a name it does not know — as the opaque desk', () => {
    expect(windowMaterial({ __CANDIDCUE_WINDOW_MATERIAL__: null })).toBeNull();
    expect(windowMaterial({})).toBeNull();
    expect(windowMaterial({ __CANDIDCUE_WINDOW_MATERIAL__: 'acrylic' })).toBeNull();
  });

  it('knows the titlebar is an overlay only when told', () => {
    expect(windowTitlebar({ __CANDIDCUE_TITLEBAR__: 'overlay' })).toBe('overlay');
    expect(windowTitlebar({ __CANDIDCUE_TITLEBAR__: null })).toBeNull();
    expect(windowTitlebar({})).toBeNull();
  });
});

describe('the root attributes', () => {
  it('puts the material and the titlebar on the root, and takes them off again', () => {
    const element = root();
    applyWindowMaterial(element, 'vibrancy', 'overlay');
    expect(element.dataset['windowMaterial']).toBe('vibrancy');
    expect(element.dataset['titlebar']).toBe('overlay');
    applyWindowMaterial(element, null, null);
    expect(element.dataset['windowMaterial']).toBeUndefined();
    expect(element.dataset['titlebar']).toBeUndefined();
  });

  it('opens the chrome to the material only while a rail is drawn', () => {
    const element = root();
    showMaterialRail(element, true);
    expect(element.dataset['materialRail']).toBe('');
    showMaterialRail(element, false);
    expect('materialRail' in element.dataset).toBe(false);
  });

  it('says when a full-height sidebar is there for the traffic lights to sit on', () => {
    const element = root();
    showSidebar(element, true);
    expect(element.dataset['sidebar']).toBe('');
    showSidebar(element, false);
    expect('sidebar' in element.dataset).toBe(false);
  });
});
