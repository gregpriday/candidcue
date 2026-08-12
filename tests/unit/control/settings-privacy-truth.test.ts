/**
 * #180 — the privacy disclosure is the one screen that must not overclaim.
 *
 * Three things were untrue at once, and all three read as reassurance:
 *
 *  - "CandidCue checks for software updates." It does not, and it now says so.
 *    `check_for_update`/`install_update` used to return NOT_IMPLEMENTED behind
 *    a button; CandidCue 1.0 has no updater at all and the section states the
 *    manual-update policy instead (docs/updates.md).
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
 * something about a paragraph. The claims that ARE behaviour — the version
 * comes from Rust, and the update sentence never implies a check — are driven
 * through the real service path at the bottom of this file.
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
    invoke: async (command: string) => {
      calls.push(command);
      if (command === 'app_version') return '9.9.9-test';
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

/**
 * Line wrapping is not a claim, and neither is a comment.
 *
 * Comments are stripped BEFORE flattening. Every ban in this file is about what
 * the screen says, and the comments in this route routinely quote the copy they
 * are explaining why we removed — the note recording that a "Check for updates"
 * button used to be here contains the string "Check for updates". Scanning raw
 * source made the postmortem fail the test it was written to explain, which
 * teaches exactly the wrong lesson: delete the explanation.
 *
 * The stripping is SCOPED, which matters more than it looks. `<!-- -->` is a
 * comment anywhere in a Svelte file, so it goes everywhere. `/* *\/` and `//`
 * are comments only inside the `<script>` block; in markup they are ordinary
 * text, and stripping them there would delete rendered copy — so a paragraph
 * reading `// CandidCue checks for updates daily.` would become invisible to
 * every ban below. Narrowing JS-comment removal to the script region closes
 * that. The `renders comment-shaped copy` test at the bottom guards it.
 */
const SCRIPT_END = '</script>';
const scriptEnd = settingsSource.indexOf(SCRIPT_END);
const scriptRegion = scriptEnd === -1 ? '' : settingsSource.slice(0, scriptEnd);
const markupRegion = scriptEnd === -1 ? settingsSource : settingsSource.slice(scriptEnd);

const withoutComments = (
  scriptRegion.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ') + markupRegion
).replace(/<!--[\s\S]*?-->/g, ' ');

const flatSource = withoutComments.replace(/\s+/g, ' ');

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
      /data-testid="update-policy"/,
    );
  });

  it('does not claim CandidCue checks for updates', () => {
    /*
     * Banning the one sentence that used to be here is not enough — a reworded
     * claim ("CandidCue checks for updates daily", "we let you know when a new
     * version is out") is the same lie and would sail past a literal ban. So
     * the rule is the SHAPE: no sentence in this section may put CandidCue in
     * the position of doing the checking or the telling.
     */
    expect(privacySection).not.toMatch(/checks for software updates/i);
    expect(privacySection).not.toMatch(/checks? for (?:new )?(?:updates|versions)(?! on its own)/i);
    expect(privacySection).not.toMatch(/\b(?:notifies?|tells?|lets? you know|alerts?)\b[^.]*\bnew(?:er)? (?:version|build|release)/i);
    expect(privacySection).not.toMatch(/\bup to date\b/i);

    /*
     * Naming an update service is only a lie when it is ASSERTED. The shipping
     * copy says "CandidCue has no update service and never contacts one",
     * which is the most useful sentence on the screen and which a flat ban on
     * the phrase would delete. So every mention has to be negated.
     */
    for (const mention of privacySection.matchAll(
      /(.{0,24})update (?:server|service|feed|channel|endpoint)/gi,
    )) {
      expect(
        mention[1],
        `"${mention[0]}" asserts an update service rather than denying one`,
      ).toMatch(/\b(?:no|not|never|without)\b/i);
    }
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
    expect(withoutComments).not.toMatch(/label="Diagnostic logging"/);
    expect(withoutComments).not.toMatch(/label="Update channel"/);
    /*
     * Structural, not spelling. The bans above only catch the exact attributes
     * that used to be here; this catches a renamed or re-spelled revival, and
     * says the real rule: this section offers no interactive setting at all
     * now, only maintenance buttons.
     */
    expect(privacySection, 'no Toggle may return to this section').not.toMatch(/<Toggle\b/);
    expect(privacySection, 'no Select may return to this section').not.toMatch(/<Select\b/);
  });

  it('offers no update action, because CandidCue 1.0 has no updater', () => {
    /*
     * A "Check for updates" button used to survive here on the grounds that it
     * asked Rust a real question. The answer was always "not available in this
     * build", which makes it an action with no outcome — the same defect as the
     * two controls #180 deleted, one level down. CandidCue 1.0 updates manually
     * (docs/updates.md) and the section states that instead.
     */
    expect(privacySection, 'no update-check button may return').not.toMatch(/Check for updates/i);
    expect(withoutComments, 'no update-check handler may return').not.toMatch(/runUpdateCheck/);

    /*
     * Structural, not spelling — the same escalation as the Toggle/Select rule
     * above. Banning the old LABEL and the old HANDLER NAME leaves
     * `<Button onclick={() => findNewerBuilds()}>Find newer builds</Button>`
     * passing, which is the identical defect wearing different words. The real
     * rule is that this section contains no interactive control at all beyond
     * the maintenance actions, which live in their own `row-actions` block.
     */
    const updateBlock = privacySection.slice(privacySection.indexOf('<h3 class="privacy-head">Updates'));
    expect(updateBlock, 'the Updates block must be found, or the ban below is vacuous').toContain(
      'data-testid="update-policy"',
    );
    expect(updateBlock, 'the Updates block must offer no button').not.toMatch(/<Button\b/);

    /*
     * The rendered node must actually consume the policy sentence. Asserting
     * only that `describeUpdatePolicy` appears SOMEWHERE in the route would
     * pass with its result discarded and misleading static copy in the node.
     */
    expect(updateBlock, 'the visible node must render the policy state').toMatch(
      /data-testid="update-policy"[^>]*>\s*\{updateNote/,
    );
    expect(withoutComments, 'the policy state must come from the pure function').toMatch(
      /updateNote = settingsService\.describeUpdatePolicy\(/,
    );
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

describe('the manual-update policy is stated truthfully', () => {
  beforeEach(() => {
    ipc.calls.length = 0;
  });

  it('reports the version the signed bundle carries, not a literal', async () => {
    /*
     * `getAppVersion` used to fall back to a hard-coded '0.1.0' twice in this
     * file, and both survived every version bump — so a support paste could
     * report a version that had not been real for months. The version must come
     * from Rust, which reads it from the bundle's package info.
     */
    const { getAppVersion } = await import('../../../src/control/services/settings');
    expect(await getAppVersion()).toBe('9.9.9-test');
    expect(ipc.calls).toEqual(['app_version']);
  });

  it('never implies CandidCue watches for new versions', async () => {
    /*
     * The failure this guards against is the one the old code made structurally
     * possible: a sentence that reads as reassurance about a check that never
     * happens. Asserting only that SOME sentence is produced would pass with
     * "CandidCue is up to date." in it — the single worst thing this screen
     * could say.
     */
    const { describeUpdatePolicy } = await import('../../../src/control/services/settings');
    const sentence = describeUpdatePolicy('9.9.9-test');

    expect(sentence, 'the running version must be quotable from this line').toContain('9.9.9-test');
    expect(sentence, 'the policy must be stated, not implied').toMatch(/never checks for updates/i);
    expect(sentence, 'the user must be told how to actually update').toMatch(/download/i);

    expect(sentence).not.toMatch(/up to date/i);
    expect(sentence).not.toMatch(/checking/i);
    expect(sentence).not.toMatch(/update (?:available|server|service is)/i);

    /*
     * The bans above are all about the WORD "check", and a sentence can imply
     * a check without using it: "CandidCue never checks for updates manually;
     * it polls the release feed at launch and tells you when a newer build
     * exists" satisfies every assertion above while describing an updater.
     *
     * So this bans the MECHANISMS too. It is not an exhaustive list of ways to
     * be misleading — no ban list is — but it covers the vocabulary anyone
     * would reach for when wiring the feature back up, which is when this test
     * needs to fire.
     */
    expect(sentence).not.toMatch(/\bpolls?\b|\bpolling\b/i);
    expect(sentence).not.toMatch(/release feed|update feed|manifest|endpoint/i);
    expect(sentence).not.toMatch(/\b(?:notifies?|tells?|alerts?|lets? you know)\b/i);
    expect(sentence).not.toMatch(/\bautomatic(?:ally)?\b/i);

    /*
     * And the positive claim must be unqualified. "never checks for updates
     * manually" and "never checks for updates without asking" both match the
     * `/never checks for updates/i` above while meaning the opposite.
     */
    expect(sentence).toMatch(/never checks for updates and never contacts/i);
  });

  it('would still see comment-shaped copy if it were ever rendered', () => {
    /*
     * The guard on the comment stripping above.
     *
     * Stripping is how this file stopped failing on its own postmortems, and
     * it is also the easiest way to blind every ban in it: strip `/* *\/` and
     * `//` from the WHOLE file and a rendered paragraph beginning `//` — or
     * one wrapped in `/* *\/` — disappears before a single assertion runs.
     * Markup keeps its JS-comment delimiters as ordinary text, and this proves
     * the stripper honours that.
     */
    const markup = '<p>/* banned text */</p>\n<p>\n  // banned text\n</p>';
    const stripped = (
      "<script lang=\"ts\">\n  // gone\n  /* also gone */\n</script>\n" + markup
    )
      .replace(/^[\s\S]*?<\/script>/, (script) =>
        script.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' '),
      )
      .replace(/<!--[\s\S]*?-->/g, ' ');

    expect(stripped, 'script comments must go').not.toContain('gone');
    expect(stripped, 'rendered text that merely looks like a comment must stay').toContain(
      'banned text',
    );
  });

  it('says what happens to user data across a manual update', async () => {
    /*
     * "Replace the app in your Applications folder" is an instruction people
     * hesitate over precisely because it sounds destructive. Scripts, settings
     * and calibrations live in the app data directory, not the bundle, so the
     * sentence must say so — otherwise the honest policy reads as a warning.
     */
    const { describeUpdatePolicy } = await import('../../../src/control/services/settings');
    expect(describeUpdatePolicy('1.2.3')).toMatch(/scripts, settings/i);
  });
});
