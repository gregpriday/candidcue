/**
 * Which desktop this window is on (desktop refinement §22.3).
 *
 * ---------------------------------------------------------------------------
 * ONE CHECK, ON THE ROOT ELEMENT
 * ---------------------------------------------------------------------------
 * §22.3's rule is explicit: add a platform attribute at the application root for
 * genuinely platform-specific CSS, and do not scatter user-agent checks through
 * components. The scattering is the failure mode — a dozen `navigator.platform`
 * tests written at a dozen moments drift, and none of them can be seen together.
 *
 * The attribute is applied ONCE, at mount, before the first paint. It cannot
 * change during a session (a webview does not move between operating systems),
 * so nothing has to react to it and no store is needed.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE ATTRIBUTE IS FOR, AND WHAT IT IS NOT FOR
 * ---------------------------------------------------------------------------
 * FOR: the handful of places where a platform's window chrome genuinely differs
 * — macOS traffic-light inset in a full-size-content titlebar, Windows caption
 * buttons, the scrollbar behaviour above.
 *
 * NOT FOR: making one platform look like the other. §22.3 again: keep the
 * colours and the typography, and let the native menu, window, keyboard and
 * dialog conventions do their job. A `[data-platform='windows']` block that
 * re-created macOS vibrancy would be exactly the mimicry the guardrails forbid.
 */

export type Platform = 'macos' | 'windows' | 'linux';

/**
 * Read the platform from the user agent.
 *
 * `navigator.userAgentData.platform` is preferred where it exists (WebView2
 * supplies it) because `navigator.platform` is deprecated and frozen in some
 * engines. `navigator.platform` is next, then the user-agent string.
 *
 * ---------------------------------------------------------------------------
 * THE FALLBACK IS `linux`, AND IT IS NOT ARBITRARY
 * ---------------------------------------------------------------------------
 * A packaged build always has a real user agent, so the fallback is never
 * reached in production — it is reached in jsdom, where `navigator.platform` is
 * an empty string and the user agent names no platform at all.
 *
 * It matters there because `isMacPlatform()` is what decides whether the app
 * sends ⌘ or Ctrl, and CODEMIRROR MAKES ITS OWN DECISION with its own
 * `navigator.platform` test. If the two disagree, the app dispatches ⌘B at an
 * editor whose keymap is listening for Ctrl-B, and the formatting keys silently
 * stop working — under test, and on any host whose agent we read differently
 * from the way CodeMirror does. `linux` is the value that agrees with CodeMirror
 * on an unidentifiable host, and it is also the neutral one for the root
 * attribute: no macOS traffic-light inset, no Windows caption buttons.
 */
export function detectPlatform(
  agent: { userAgentData?: { platform?: string }; platform?: string; userAgent?: string } = typeof navigator ===
  'undefined'
    ? {}
    : navigator,
): Platform {
  const hint = (
    agent.userAgentData?.platform ??
    agent.platform ??
    agent.userAgent ??
    ''
  ).toLowerCase();
  if (hint.includes('win')) return 'windows';
  if (hint.includes('mac') || hint.includes('iphone') || hint.includes('ipad')) return 'macos';
  // …and anything unidentifiable. Written as a plain return rather than folded
  // into the branch above so the fallback is visible as a decision.
  return 'linux';
}

/** Stamp the root element. Called once from the entry point. */
export function applyPlatformAttribute(root: HTMLElement, platform = detectPlatform()): void {
  root.dataset['platform'] = platform;
}
