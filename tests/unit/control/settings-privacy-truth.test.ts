/**
 * #180 — the privacy disclosure is the one screen that must not overclaim.
 *
 * Three things were untrue at once, and all three read as reassurance:
 *
 *  - "CandidCue checks for software updates." It did not: `check_for_update`
 *    and `install_update` returned NOT_IMPLEMENTED behind a button. It does
 *    now (docs/updates.md, #191), so the rule has turned round — the section
 *    must say exactly what the check is (which host, when, what it sends), how
 *    to turn it off, and that nothing is installed without being asked for.
 *  - A "Diagnostic logging" toggle and an "Update channel" dropdown, neither of
 *    which reached Rust. `toRustPatch` had no mapping for either, so both wrote
 *    to the localStorage overlay and no code ever read them back. Logging ran
 *    either way; the channel selected nothing.
 *
 * #215 then removed the one control that did reach Rust, "Save session
 * transcripts", once takes stopped writing transcripts (#214) and the window it
 * set had nothing left to keep — along with every line elsewhere in Settings
 * that pointed people at it.
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
 * comes from Rust, and the update sentence describes the check it really makes
 * in the position the switch is in — are driven through the real service path
 * at the bottom of this file.
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
      /<h3 class="privacy-head">Your data<\/h3>/,
    );
    expect(privacySection, 'capture runs to the last control in the section').toMatch(
      /data-testid="update-policy"/,
    );
  });

  it('describes the update check rather than hiding or overstating it', () => {
    /*
     * The section used to be held to "CandidCue never checks for updates".
     * That became false the day the updater shipped (#191), and a privacy
     * screen that kept saying it would be the worst kind of wrong: reassuring.
     * So the rule is now positive. The section must NAME the host a check
     * contacts, and every mention of an update server must be that host — not
     * "our servers", not a service nobody can look up.
     */
    expect(privacySection, 'the update host must be named').toMatch(/updates\.candidcue\.com/);
    for (const mention of privacySection.matchAll(
      /update (?:server|service|feed|channel|endpoint)[^.]{0,60}/gi,
    )) {
      expect(
        mention[0],
        `"${mention[0]}" names an update service without saying which host it is`,
      ).toMatch(/updates\.candidcue\.com/);
    }

    /*
     * A RESULT is not a policy. This section never ran a check, so it may not
     * report one — "up to date" here would be the single worst thing it could
     * say, a reassurance about a question nobody asked.
     */
    expect(privacySection).not.toMatch(/\bup to date\b/i);
    expect(privacySection).not.toMatch(/\bupdate (?:is )?available\b/i);

    /*
     * And it must not overstate in the other direction: an update is never
     * installed by the check itself.
     */
    expect(privacySection).not.toMatch(/install(?:s|ed)? (?:updates )?automatically/i);
    expect(privacySection).not.toMatch(/\bautomatic updates\b/i);
  });

  it('says when the network is used, update checks included', () => {
    const network = privacySection.match(
      /When CandidCue uses the network<\/h3>\s*<p class="privacy-body">([^<]*)/,
    );
    expect(network, 'the network paragraph could not be located').not.toBeNull();
    const text = network?.[1] ?? '';
    expect(text, 'the model download is one use').toMatch(/speech language/i);
    expect(text, 'the update check is the other').toMatch(/updates\.candidcue\.com/);
    expect(text, 'and an exclusive claim must not survive beside it').not.toMatch(/^\s*Only\b/);
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
     * The one path is the speech-model download.
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
     * that used to be here; this catches a renamed or re-spelled revival.
     *
     * The rule is that a control in this section must DECIDE something, which
     * is exactly what the two removed ones did not — and, since #214, what the
     * retention Select did not either. So: no selects at all, and exactly one
     * toggle — "Check for updates automatically", the one stored preference
     * here that decides something. It writes `checkForUpdates`, a Rust-owned
     * field the Rust `check_for_update` command reads before it will make an
     * automatic check. Any other toggle has to make the same case before it
     * relaxes this.
     */
    expect(privacySection, 'no Select may return to this section').not.toMatch(/<Select\b/);
    const toggles = [...privacySection.matchAll(/<Toggle\b[\s\S]*?\/>/g)].map((match) => match[0]);
    expect(toggles, 'the update switch is the only toggle in this section').toHaveLength(1);
    expect(toggles[0]).toMatch(/label="Check for updates automatically"/);
    expect(toggles[0], 'and it reads the Rust-owned field').toMatch(
      /checked=\{\$settings\.general\.checkForUpdates\}/,
    );
    expect(toggles[0], 'and writes it').toMatch(
      /patchSettings\('general', \{ checkForUpdates: value \}\)/,
    );
  });

  /*
   * #215. The retention row was not the only thing describing it: Speech
   * settings told the user their words "are kept only if you set Save session
   * transcripts", and the search index listed "transcript retention". Removing
   * the row and leaving either of those would recreate the contradiction this
   * section shipped with (a pointer at a control that does not exist), so all
   * three are checked.
   */
  it('no longer offers or points at transcript saving', () => {
    expect(withoutComments, 'the row may not come back').not.toMatch(/Save session transcripts/i);
    expect(withoutComments, 'nor its helper').not.toMatch(/transcript-retention/);
    expect(flatSource, 'nothing may promise that the words are kept').not.toMatch(/kept only if/i);
    expect(privacySection, 'nor that a transcript travels with an export').not.toMatch(
      /retained transcripts|transcripts? travel/i,
    );

    const privacyKeywords = flatSource.match(
      /id: 'privacy',[\s\S]*?keywords:\s*((?:'[^']*'\s*\+?\s*)+)/,
    );
    expect(privacyKeywords, 'the privacy section keywords could not be located').not.toBeNull();
    expect(privacyKeywords?.[1], 'search must not find a setting that is gone').not.toMatch(
      /transcript|retention/i,
    );
  });

  it('says the recognised words are not saved, where Speech settings describes them', () => {
    // The sentence that used to send people to the retention row. Its
    // replacement has to make the claim the row's absence implies, not just
    // stop making the old one.
    const speechHint = flatSource.match(/Your voice never leaves this computer[^<]*/);
    expect(speechHint, 'the Speech settings hint could not be located').not.toBeNull();
    expect(speechHint?.[0]).toMatch(/\bwords\b[^.]*\b(?:not|never)\b[^.]*\bsave/i);
    expect(speechHint?.[0], 'and audio is still never saved').toMatch(/audio is never[^.]*saved/i);
  });

  it('still says what is kept on this device, and that audio is not', () => {
    /*
     * Removing a control is not permission to say less. The section has to
     * name what CandidCue really keeps locally — scripts, their saved
     * versions, settings, the session history Editor reads "start where the
     * last take ended" from — and still make the one claim about audio that
     * the retention row's hint used to make in passing.
     */
    const local = privacySection.match(/Your data<\/h3>\s*<p class="privacy-body">([^<]*)/);
    expect(local, 'the "Your data" paragraph could not be located').not.toBeNull();
    const kept = local?.[1] ?? '';
    expect(kept).toMatch(/\bscripts\b/i);
    expect(kept, 'saved versions are kept too').toMatch(/saved versions|revisions/i);
    expect(kept).toMatch(/\bsettings\b/i);
    expect(kept, 'and the session history').toMatch(/\bsessions?\b|history of your takes/i);
    expect(kept).toMatch(/this (?:device|computer)/i);

    // The claims, not one wording of them: each must be a negation in the
    // same sentence as the thing it is about.
    expect(privacySection, 'audio is never saved').toMatch(/\baudio\b[^.]*\b(?:not|never)\b[^.]*\bsaved?\b/i);
    expect(privacySection, 'nor are the recognised words').toMatch(
      /\bwords\b[^.]*\b(?:not|never)\b[^.]*\bsaved?\b/i,
    );
  });

  it('offers the switch and the policy, and no second check button', () => {
    /*
     * Help › Check for Updates… is the action, and its answer is drawn in the
     * document window where the install flow lives. A button here would have
     * had to report into a window behind this one — so the Updates block has a
     * switch and a statement, and no button.
     */
    const updateBlock = privacySection.slice(privacySection.indexOf('<h3 class="privacy-head">Updates'));
    expect(updateBlock, 'the Updates block must be found, or the ban below is vacuous').toContain(
      'data-testid="update-policy"',
    );
    expect(updateBlock, 'the Updates block must offer no button').not.toMatch(/<Button\b/);
    expect(withoutComments, 'no update-check handler may return').not.toMatch(/runUpdateCheck/);

    /*
     * The rendered node must actually consume the policy sentence. Asserting
     * only that `describeUpdatePolicy` appears SOMEWHERE in the route would
     * pass with its result discarded and misleading static copy in the node —
     * and it must be handed the switch's position, or the sentence under the
     * switch describes the wrong one.
     */
    expect(updateBlock, 'the visible node must render the policy state').toMatch(
      /data-testid="update-policy"[^>]*>\s*\{updateNote/,
    );
    expect(withoutComments, 'the policy state must come from the pure function').toMatch(
      /settingsService\.describeUpdatePolicy\(runningVersion, \$settings\.general\.checkForUpdates\)/,
    );
  });
});

describe('#180 the dead privacy settings are gone from the settings shape', () => {
  it('leaves no privacy section at all', async () => {
    const { defaultAppSettings } = await import('../../../src/control/services/settings-types');
    /*
     * An own-property check, not `.privacy === undefined`: a reintroduced
     * `privacy: undefined` — or `privacy: {}` waiting for a field nobody reads
     * — is the shape this is supposed to be catching. `saveTranscript` was the
     * last field, and #215 took it (see `settings-retired-keys.test.ts` for
     * documents and overlays that still carry it).
     */
    expect(Object.hasOwn(defaultAppSettings(), 'privacy')).toBe(false);
  });
});

describe('the update policy is stated truthfully', () => {
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

  it('says exactly what the automatic check is, when it is on', async () => {
    const { describeUpdatePolicy } = await import('../../../src/control/services/settings');
    const sentence = describeUpdatePolicy('9.9.9-test', true);

    expect(sentence, 'the running version must be quotable from this line').toContain('9.9.9-test');
    expect(sentence, 'which host').toMatch(/updates\.candidcue\.com/);
    expect(sentence, 'when').toMatch(/every six hours/i);
    expect(sentence, 'and how to ask by hand').toMatch(/Check for Updates…/);
    /*
     * What the request carries — the whole of it. The IP address is named
     * because leaving it out is the classic understatement; the version, OS
     * and processor are in the URL and the User-Agent (updater.rs).
     */
    expect(sentence, 'it carries the version').toMatch(/sends this version/i);
    expect(sentence, 'the platform').toMatch(/operating system and processor/i);
    expect(sentence, 'and, like any request, the IP address').toMatch(/IP address/);
    expect(sentence, 'and nothing personal').toMatch(/nothing that identifies you/i);
    expect(sentence, 'none of the scripts or audio').toMatch(/none of your scripts or\s+audio/i);

    // What it never does.
    expect(sentence, 'installs are the user’s decision').toMatch(/installed only when you choose/i);
    expect(sentence, 'never during a take').toMatch(/never during a take/i);
    expect(sentence, 'and only if signed').toMatch(/signature/i);

    // A policy is not a result.
    expect(sentence).not.toMatch(/up to date/i);
    expect(sentence).not.toMatch(/update (?:is )?available/i);
    expect(sentence).not.toMatch(/install(?:s|ed)? automatically|automatic updates/i);
  });

  it('says the network is only touched on request, when the switch is off', async () => {
    const { describeUpdatePolicy } = await import('../../../src/control/services/settings');
    const sentence = describeUpdatePolicy('9.9.9-test', false);

    expect(sentence).toContain('9.9.9-test');
    expect(sentence).toMatch(/Automatic checks are off/i);
    expect(sentence, 'the remaining contact is by request only').toMatch(
      /contacts updates\.candidcue\.com only when you\s+choose Check for Updates…/i,
    );
    expect(sentence, 'and it must not still describe a schedule').not.toMatch(/every six hours/i);
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

  it('says what happens to user data across an update', async () => {
    /*
     * "Installing one replaces the app" is a sentence people hesitate over
     * precisely because it sounds destructive. Scripts, settings and
     * calibrations live in the app data directory, not the bundle, so the
     * sentence must say so — otherwise the honest policy reads as a warning.
     */
    const { describeUpdatePolicy } = await import('../../../src/control/services/settings');
    for (const automatic of [true, false]) {
      expect(describeUpdatePolicy('1.2.3', automatic)).toMatch(/scripts,\s+settings/i);
    }
  });
});
