/**
 * Platform detection (desktop refinement §22.3).
 *
 * This is load-bearing in two directions and both are easy to get wrong:
 *
 *   - it decides whether the app sends ⌘ or Ctrl, and CODEMIRROR MAKES ITS OWN
 *     DECISION with its own `navigator.platform` test. If the two disagree the
 *     app dispatches ⌘B at an editor listening for Ctrl-B and the formatting
 *     keys silently stop working;
 *   - it stamps `data-platform` on the root, which is what scopes the macOS
 *     traffic-light reserve in the sidebar.
 */
import { describe, expect, it } from 'vitest';
import { applyPlatformAttribute, detectPlatform } from './platform';

describe('detectPlatform', () => {
  it('prefers userAgentData, which is what WebView2 supplies', () => {
    expect(detectPlatform({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe(
      'windows',
    );
    expect(detectPlatform({ userAgentData: { platform: 'macOS' }, platform: '' })).toBe('macos');
  });

  it('falls back to navigator.platform', () => {
    expect(detectPlatform({ platform: 'MacIntel' })).toBe('macos');
    expect(detectPlatform({ platform: 'Win32' })).toBe('windows');
    expect(detectPlatform({ platform: 'Linux x86_64' })).toBe('linux');
  });

  it('falls back to the user agent when platform is empty', () => {
    // jsdom sets `navigator.platform` to an empty string, which is not nullish
    // — so `??` does not skip it and the user agent has to be read explicitly.
    expect(detectPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; …)' })).toBe('macos');
    expect(detectPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe(
      'windows',
    );
  });

  it('treats iPad and iPhone as macOS for keyboard purposes', () => {
    // An iPad reporting itself as such still wants ⌘, not Ctrl.
    expect(detectPlatform({ platform: 'iPad' })).toBe('macos');
  });

  /**
   * The fallback is `linux`, and it is not arbitrary.
   *
   * A packaged build always has a real user agent, so this is reached only in
   * jsdom — where `navigator.platform` is empty and the user agent names no
   * platform. `linux` is the value that AGREES WITH CODEMIRROR on an
   * unidentifiable host, and it is also the neutral one for the root attribute:
   * no macOS traffic-light inset, no Windows caption buttons.
   */
  it('falls back to linux for an agent that names nothing', () => {
    expect(detectPlatform({})).toBe('linux');
    expect(detectPlatform({ platform: '', userAgent: 'jsdom/26' })).toBe('linux');
  });
});

describe('applyPlatformAttribute', () => {
  it('stamps the root element', () => {
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    applyPlatformAttribute(root, 'windows');
    expect(root.dataset['platform']).toBe('windows');
  });

  it('detects when not told', () => {
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    applyPlatformAttribute(root);
    expect(['macos', 'windows', 'linux']).toContain(root.dataset['platform']);
  });
});
