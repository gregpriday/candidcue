/**
 * The node test project runs as a Mac, whatever machine runs it.
 *
 * `detectPlatform()` (src/control/lib/platform.ts) reads `navigator`, and in
 * the node environment that is Node's OWN navigator, whose `platform` is the
 * host's: `MacIntel` on a Mac, `Win32` on Windows, `Linux x86_64` on Linux.
 * So the same suite asserted ⌘ shortcuts and "System Settings" on the Mac it
 * was written on and in CI (macos-15), and would have asserted Ctrl and
 * "Windows Settings" — and failed — on a Windows laptop. A test result that
 * depends on whose desk it ran at is not a result.
 *
 * The pin is the Mac because that is what every existing assertion was
 * written against: this changes nothing on the Mac or in CI, and makes a
 * Windows or Linux host behave the same. The other platforms' copy is not left
 * untested by it — those tests name their platform explicitly
 * (`osCopy('windows')`, `microphoneAccessFinding('denied', 'windows')`), which
 * is the only kind of platform test that means the same thing everywhere.
 *
 * Only `platform` is pinned. `detectPlatform()` takes the first non-empty of
 * `userAgentData.platform`, `platform` and `userAgent`; Node has no
 * `userAgentData`, and a non-empty `platform` is read before the user agent —
 * so leaving `userAgent` as Node's own keeps anything that sniffs it for Node
 * working. Should a later Node grow `userAgentData`, it is pinned too, since
 * it would otherwise win.
 *
 * An own property on the instance shadows the prototype getter and is
 * configurable, so a test that needs another platform can still define its
 * own, and one that replaces `navigator` wholesale (`vi.stubGlobal`) behaves
 * exactly as it did before this file existed.
 *
 * The jsdom project does not use this: jsdom's `navigator.platform` is empty
 * on every host, `detectPlatform()` answers `linux`, and CodeMirror agrees
 * with it there (see platform.ts) — already host-independent.
 */
if (typeof navigator !== 'undefined') {
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
  if ('userAgentData' in navigator) {
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform: 'macOS' },
      configurable: true,
    });
  }
}
