/**
 * #180 — the privacy disclosure is the one screen that must not overclaim.
 *
 * Two things were untrue at once, and both read as reassurance:
 *
 *  - "CandidCue checks for software updates." It does not. Both
 *    `check_for_update` and `install_update` return NOT_IMPLEMENTED, and no
 *    updater plugin is wired at all — nothing in `package.json`, nothing in
 *    `Cargo.toml`, no `plugins` section in `tauri.conf.json`.
 *  - A "Diagnostic logging" toggle and an "Update channel" dropdown, neither of
 *    which reached Rust. `toRustPatch` maps `privacy.saveTranscript` and nothing
 *    else, so both wrote to the localStorage overlay and no code ever read them
 *    back. Logging ran either way; the channel selected nothing.
 *
 * These read the route SOURCE rather than mounting it. The defect class is
 * static copy and static control presence, and mounting a 3,000-line route
 * would drag in microphone, display, model and diagnostics setup to prove
 * something about a paragraph. The one behavioural claim the issue explicitly
 * protects — NOT_IMPLEMENTED reported as "unsupported" — IS driven through the
 * real service path at the bottom of this file, because that one is behaviour.
 *
 * Assertions are on CLAIMS, not on prose. Pinning the paragraphs verbatim would
 * break on a rewording that is just as true, which teaches people to delete the
 * test rather than read it.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    /** What `check_for_update` should do. Default: the shipped v1 answer. */
    updateFailure: { code: 'NOT_IMPLEMENTED' } as unknown,
    invoke: async (command: string) => {
      calls.push(command);
      if (command === 'app_version') return '9.9.9-test';
      if (command === 'check_for_update') throw ipc.updateFailure;
      throw new Error(`unexpected command ${command}`);
    },
  };
});

vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  BackendUnavailableError: class extends Error {},
  ipcInvoke: ipc.invoke,
}));

const settingsSource = readFileSync(
  new URL('../../../src/control/routes/Settings.svelte', import.meta.url),
  'utf8',
);

/** Line wrapping is not a claim. Everything below reads the flattened text. */
const flatSource = settingsSource.replace(/\s+/g, ' ');

/**
 * The privacy Section only, so a ban cannot be satisfied — or defeated — by
 * text somewhere else in a very long route.
 *
 * Extraction failing is a FAILURE, not a skip. A guard that quietly stops
 * matching anything is worse than no guard, so the anti-vacuity test below
 * runs first and every other test in this block depends on it.
 */
const sectionMatch = flatSource.match(
  /<Section title="Data, privacy & updates">([\s\S]*?)<\/Section>/,
);
const privacySection = sectionMatch?.[1] ?? '';

describe('#180 the privacy section describes what the app actually does', () => {
  it('can still find the privacy section at all', () => {
    expect(
      sectionMatch,
      'the "Data, privacy & updates" Section could not be located — every ban below would pass vacuously',
    ).not.toBeNull();
    // Big enough to be the real section rather than an empty shell.
    expect(privacySection.length).toBeGreaterThan(400);
  });

  it('does not claim CandidCue checks for updates', () => {
    expect(privacySection).not.toMatch(/checks for software updates/i);
  });

  it('does not invent a CandidCue server to be private from', () => {
    // The claim "your data is not sent to CandidCue servers" is technically
    // true and completely hollow: there are no CandidCue servers. Reassurance
    // about a thing that does not exist is not a privacy disclosure.
    expect(privacySection).not.toMatch(/CandidCue servers/i);
  });

  it('discloses the requests the app really does make', () => {
    // Rust genuinely reaches the network twice, both user-started: the speech
    // model download (`speech_cmds`) and `import_remote_image` (`assets`).
    // The webview CSP blocks remote hosts, but the webview is not the whole
    // application boundary, so silence here would be its own overclaim.
    expect(privacySection).toMatch(/Speech settings/i);
    expect(privacySection).toMatch(/image from a web address/i);
  });

  it('no longer offers the two settings that decided nothing', () => {
    expect(settingsSource).not.toMatch(/label="Diagnostic logging"/);
    expect(settingsSource).not.toMatch(/label="Update channel"/);
  });

  it('keeps the update check, which asks Rust a real question', () => {
    // Unlike the two removed controls, this button does not pretend to persist
    // a choice — it queries the backend and reports whatever comes back. The
    // issue explicitly protects it.
    expect(privacySection).toMatch(/Check for updates/);
    expect(settingsSource).toMatch(/Update checks are not available in this build\./);
  });
});

describe('#180 the dead privacy settings are gone from the settings shape', () => {
  it('leaves privacy with saveTranscript and nothing else', async () => {
    const { defaultAppSettings } = await import('../../../src/control/services/settings-types');
    // Strict equality, not a property check: a reintroduced field that nothing
    // reads is exactly the defect this issue removed, and it would sail past
    // `toMatchObject`.
    expect(defaultAppSettings().privacy).toEqual({ saveTranscript: 'off' });
  });
});

describe('#180 an unwired updater still reports itself honestly', () => {
  beforeEach(() => {
    ipc.calls.length = 0;
    ipc.updateFailure = { code: 'NOT_IMPLEMENTED' };
  });

  it('reports NOT_IMPLEMENTED as unsupported rather than up to date', async () => {
    const { checkForUpdate } = await import('../../../src/control/services/settings');
    const result = await checkForUpdate();
    // "up_to_date" here would be the worst possible answer: it tells a
    // presenter they are current when nothing was ever checked.
    expect(result).toEqual({ status: 'unsupported', currentVersion: '9.9.9-test' });
  });

  it('still reports a real failure as a failure', async () => {
    // The anti-vacuity partner to the test above: if every error collapsed to
    // "unsupported", that test would pass while hiding genuine breakage the
    // day an updater ships.
    const { checkForUpdate } = await import('../../../src/control/services/settings');
    ipc.updateFailure = { code: 'NETWORK', message: 'host unreachable' };
    const result = await checkForUpdate();
    expect(result.status).toBe('error');
  });
});
