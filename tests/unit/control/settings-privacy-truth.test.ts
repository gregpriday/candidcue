/**
 * #180 — the privacy disclosure is the one screen that must not overclaim.
 *
 * Three things were untrue at once, and all three read as reassurance:
 *
 *  - "CandidCue checks for software updates." It does not. Both
 *    `check_for_update` and `install_update` return NOT_IMPLEMENTED, and no
 *    updater plugin is wired at all — nothing in `package.json`, nothing in
 *    `Cargo.toml`, no `plugins` section in `tauri.conf.json`.
 *  - A "Diagnostic logging" toggle and an "Update channel" dropdown, neither of
 *    which reached Rust. `toRustPatch` maps `privacy.saveTranscript` and nothing
 *    else, so both wrote to the localStorage overlay and no code ever read them
 *    back. Logging ran either way; the channel selected nothing.
 *  - "Your microphone is open only while a take or a microphone test is
 *    running." Also false: the level meter holds an open capture the whole time
 *    Audio settings is on screen with permission granted (see the `$effect`
 *    guarded by `section !== 'audio' || micPermission !== 'granted'` — its own
 *    comment says "The meter holds an open capture").
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
  it('can still find the whole privacy section', () => {
    expect(
      sectionMatch,
      'the "Data, privacy & updates" Section could not be located — every ban below would pass vacuously',
    ).not.toBeNull();
    /*
     * Anchored on both ENDS rather than on a length floor. A capture truncated
     * at an early `</Section>` would still clear any byte count worth writing
     * down, and every "must not contain" below would then be passing on text
     * that simply stopped before the offending markup. The first copy block and
     * the last control are the real boundaries.
     */
    expect(privacySection, 'capture starts before the first copy block').toMatch(
      /Local by default/,
    );
    expect(privacySection, 'capture runs to the last control in the section').toMatch(
      /\{#if updateNote\}/,
    );
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

  it('discloses the request the app really does make', () => {
    /*
     * The webview CSP blocks remote hosts, but the webview is not the whole
     * application boundary — Rust holds a reqwest client — so saying nothing
     * about the network would be its own overclaim.
     *
     * The reachable path is the speech-model download. `import_remote_image`
     * exists in Rust and in `services/assets.ts`, but NOTHING calls it: the
     * editor only imports local files and the compiler rejects remote images.
     * Naming it would advertise an action a user cannot take, which is the
     * same defect as the update-check claim this issue removed.
     */
    expect(privacySection).toMatch(/Speech settings/i);
  });

  it('does not claim the microphone is open only during a take or test', () => {
    /*
     * The level meter holds a capture for as long as Audio settings is open.
     * Both places that describe microphone use are checked, because fixing one
     * would leave Settings contradicting itself. Banning the old wording is the
     * weaker half — a reworded exclusive claim would evade it — so each place
     * must POSITIVELY name the meter, which is the fact the old copy omitted.
     */
    expect(flatSource).not.toMatch(/microphone is open only/i);
    expect(flatSource).not.toMatch(/uses your microphone only/i);
    expect(privacySection, 'the privacy block must name the meter').toMatch(/input meter/i);

    const micDescription = flatSource.match(/<Section title="Microphone" description="([^"]*)"/);
    expect(micDescription, 'the Microphone Section description could not be located').not.toBeNull();
    expect(micDescription?.[1], 'the Microphone Section must name the meter too').toMatch(
      /input meter/i,
    );
  });

  it('no longer offers the two settings that decided nothing', () => {
    expect(settingsSource).not.toMatch(/label="Diagnostic logging"/);
    expect(settingsSource).not.toMatch(/label="Update channel"/);
    /*
     * Structural, not spelling. The bans above only catch the exact attributes
     * that used to be here; this catches a renamed or re-spelled revival, and
     * says the real rule: this section offers no interactive setting at all
     * now, only maintenance buttons and the update check.
     */
    expect(privacySection, 'no Toggle may return to this section').not.toMatch(/<Toggle\b/);
    expect(privacySection, 'no Select may return to this section').not.toMatch(/<Select\b/);
  });

  it('keeps the update check, which asks Rust a real question', () => {
    // Unlike the two removed controls, this button does not pretend to persist
    // a choice — it queries the backend and reports whatever comes back. The
    // issue explicitly protects it.
    expect(privacySection).toMatch(/Check for updates/);
    // The button must still be wired to the check, not left as decoration.
    expect(privacySection).toMatch(/runUpdateCheck\(\)/);
    // The sentence itself now lives in `settings.ts` as `describeUpdateCheck`,
    // and is asserted behaviourally at the bottom of this file.
    expect(settingsSource).toMatch(/describeUpdateCheck/);
  });
});

describe('#180 the dead privacy settings are gone from the settings shape', () => {
  it('leaves privacy with saveTranscript and nothing else', async () => {
    const { defaultAppSettings } = await import('../../../src/control/services/settings-types');
    /*
     * `toStrictEqual`, not `toEqual`: the latter ignores own properties whose
     * value is `undefined`, so a reintroduced `diagnosticLogging: undefined`
     * would sail straight through the matcher that is supposed to be catching
     * exactly that.
     */
    expect(defaultAppSettings().privacy).toStrictEqual({ saveTranscript: 'off' });
    expect(Object.keys(defaultAppSettings().privacy)).toEqual(['saveTranscript']);
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
    expect(result).toStrictEqual({ status: 'unsupported', currentVersion: '9.9.9-test' });
    /*
     * The button's whole claim to staying on screen is that it asks Rust a real
     * question. Without this, an implementation that skipped the IPC entirely
     * and returned `unsupported` outright would pass the assertion above — and
     * would be exactly the inert control this issue deleted two of.
     */
    expect(ipc.calls).toEqual(['app_version', 'check_for_update']);
  });

  it('still reports a real failure as a failure', async () => {
    /*
     * The anti-vacuity partner to the test above: if every error collapsed to
     * "unsupported", that test would pass while hiding genuine breakage the day
     * an updater ships.
     *
     * The code must be one `errorCode` actually RECOGNISES. Its CODE_TOKEN
     * demands an underscore, so a bare 'NETWORK' parses to null — and a broken
     * `errorCode(err) !== null` implementation would then pass both tests while
     * reporting every recognised failure as "unsupported".
     */
    const { checkForUpdate } = await import('../../../src/control/services/settings');
    ipc.updateFailure = { code: 'NETWORK_OFFLINE', userMessage: 'host unreachable' };
    const result = await checkForUpdate();
    expect(result.status).toBe('error');
    expect(result.currentVersion).toBe('9.9.9-test');
    expect(result.message, 'a failure must say what went wrong').toBeTruthy();
  });

  it('tells the presenter an unwired build cannot check, not that it is current', async () => {
    /*
     * The mapping the issue explicitly protects, tested directly. Asserting
     * only that the sentence exists SOMEWHERE in the route would pass with the
     * `unsupported` and `up_to_date` arms swapped — which is the one outcome
     * worse than saying nothing: "CandidCue is up to date." from a build that
     * has never checked anything.
     */
    const { describeUpdateCheck } = await import('../../../src/control/services/settings');
    expect(describeUpdateCheck({ status: 'unsupported', currentVersion: '9.9.9-test' })).toBe(
      'Update checks are not available in this build.',
    );
    expect(describeUpdateCheck({ status: 'up_to_date', currentVersion: '9.9.9-test' })).toBe(
      'CandidCue is up to date.',
    );
  });
});
