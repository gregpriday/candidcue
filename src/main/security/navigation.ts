import { shell } from 'electron';
import type { WebContents } from 'electron';

/** Documentation/links we permit to open in the system browser. */
const EXTERNAL_ALLOWLIST: readonly string[] = [
  'https://platform.openai.com',
  'https://docs.inworld.ai',
  'https://inworld.ai',
  'https://openai.com',
];

export function isAllowedExternalUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return EXTERNAL_ALLOWLIST.some((prefix) => rawUrl === prefix || rawUrl.startsWith(prefix + '/'));
}

/**
 * Lock down a renderer's navigation surface (spec §20.5): deny window.open and
 * off-origin navigation; route only allowlisted https links to the OS browser.
 */
export function hardenNavigation(contents: WebContents, appOrigin: string): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appOrigin)) {
      event.preventDefault();
      if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    }
  });

  // Never allow a renderer to attach a webview.
  contents.on('will-attach-webview', (event) => event.preventDefault());
}
