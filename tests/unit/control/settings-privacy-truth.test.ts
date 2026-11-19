/**
 * #180 — the privacy disclosure is the one screen that must not overclaim.
 *
 * Three things were untrue at once, and all three read as reassurance:
 *
 *  - "Speaking Glass checks for software updates." It did not: `check_for_update`
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
 * The promise this file protects: the privacy section claims nothing the app
 * does not do and leaves out nothing it does — when the microphone is open,
 * what touches the network and where it goes, what is kept on this computer,
 * and that an update is never installed without being asked for — and every
 * control in it decides something.
 *
 * Assertions are on CLAIMS, not on prose. The section is found by the route's
 * own branch structure rather than by its title or headings, the update host
 * and the menu item are read from the code that owns them, and a ban names a
 * false claim rather than a sentence. Rewording any of it truthfully passes.
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

/** The host the updater contacts, from where it is compiled in. */
const UPDATE_HOST = (() => {
  const updater = readFileSync(
    new URL('../../../src-tauri/src/updater.rs', import.meta.url),
    'utf8',
  );
  const base = /pub const UPDATE_BASE_URL: &str = "([^"]+)";/.exec(updater)?.[1];
  if (base === undefined) throw new Error('UPDATE_BASE_URL could not be read out of updater.rs');
  return new URL(base).hostname;
})();
const HOST = new RegExp(UPDATE_HOST.replace(/\./g, '\\.'));

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
 * reading `// Speaking Glass checks for updates daily.` would become invisible to
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
 * One Settings pane, by the route's own branch structure: `{#if section ===
 * 'general'}`, `{:else if section === 'speech'}`, …, and a bare `{:else}` for
 * the last one, which is Data, privacy & updates. Found by that, not by a
 * title or a heading, so retitling a pane is not a test edit.
 *
 * Read from the unflattened source, because the indent is what tells the
 * chain's own branches from the `{#if}` blocks nested inside a pane: the chain
 * is the one that sits at the indent of the pane switch.
 */
function pane(name: string | null): string {
  const opener =
    name === null
      ? /^( *)\{:else\}/m
      : new RegExp(`^( *)\\{(?:#if|:else if) section === '${name}'\\}`, 'm');
  const from =
    name === null
      ? withoutComments.indexOf(
          '{:else}',
          withoutComments.indexOf("{:else if section === 'following'}"),
        )
      : withoutComments.search(opener);
  if (from === -1) return '';
  const lineStart = withoutComments.lastIndexOf('\n', from) + 1;
  const indent = withoutComments.slice(lineStart, from);
  const rest = withoutComments.slice(from + 1);
  const close = rest.search(new RegExp(`\\n${indent}\\{(?::else|\\/if)\\b`));
  return (close === -1 ? rest : rest.slice(0, close)).replace(/\s+/g, ' ');
}

/**
 * The privacy Section only — the first Section of the last pane — so a ban
 * cannot be satisfied, or defeated, by text somewhere else in a long route.
 *
 * Extraction failing is a FAILURE, not a skip. A guard that quietly stops
 * matching anything is worse than no guard, so the anti-vacuity test below
 * runs first and every other test in this block depends on it.
 */
const sectionMatch = pane(null).match(/<Section\b[^>]*>([\s\S]*?)<\/Section>/);
const privacySection = sectionMatch?.[1] ?? '';

/** The `description` attributes of the Audio pane's Sections. */
const audioDescriptions = [...pane('audio').matchAll(/<Section\b[^>]*?\bdescription="([^"]*)"/g)].map(
  (match) => match[1] ?? '',
);

describe('#180 the privacy section describes what the app actually does', () => {
  it('can still find the whole privacy section', () => {
    expect(
      sectionMatch,
      'the privacy Section could not be located — every ban below would pass vacuously',
    ).not.toBeNull();
    /*
     * Anchored on the last control rather than on a length floor. A capture
     * truncated at an early `</Section>` would still clear any byte count worth
     * writing down, and every "must not contain" below would then be passing
     * on text that simply stopped before the offending markup.
     */
    expect(privacySection, 'capture runs to the last control in the section').toMatch(
      /data-testid="update-policy"/,
    );
    expect(audioDescriptions.length, 'the Audio pane has no Section description to read').toBeGreaterThan(0);
  });

  it('describes the update check rather than hiding or overstating it', () => {
    /*
     * The section used to be held to "Speaking Glass never checks for updates".
     * That became false the day the updater shipped (#191), and a privacy
     * screen that kept saying it would be the worst kind of wrong: reassuring.
     * So the rule is now positive. The section must NAME the host a check
     * contacts, and every mention of an update server must be that host — not
     * "our servers", not a service nobody can look up.
     */
    expect(privacySection, 'the update host must be named').toMatch(HOST);
    for (const mention of privacySection.matchAll(
      /update (?:server|service|feed|channel|endpoint)[^.]{0,60}/gi,
    )) {
      expect(
        mention[0],
        `"${mention[0]}" names an update service without saying which host it is`,
      ).toMatch(HOST);
    }

    /*
     * A RESULT is not a policy. This section never ran a check, so it may not
     * report one — "up to date" here would be the single worst thing it could
     * say, a reassurance about a question nobody asked.
     */
    expect(privacySection).not.toMatch(/\bup to date\b/i);
    expect(privacySection).not.toMatch(/\bupdate (?:is )?available\b/i);

    /*
     * And it must not overstate in the other direction: the CHECK is
     * automatic, an install never is. ("Automatic updates" used to be banned
     * outright here; it is the install claim that would be false.)
     */
    expect(privacySection).not.toMatch(
      /install(?:s|ed)? (?:updates )?automatically|updates? (?:are |is )?installed automatically/i,
    );
  });

  it('says when the network is used, both uses included', () => {
    /*
     * The webview CSP blocks remote hosts, but the webview is not the whole
     * application boundary — Rust holds a reqwest client — so saying nothing
     * about the network would be its own overclaim. There are two uses: the
     * speech-model download and the update check.
     */
    expect(privacySection, 'the model download is one use').toMatch(/\bdownload/i);
    expect(privacySection, 'the update check is the other').toMatch(HOST);
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
    expect(privacySection, 'the privacy block must name the meter').toMatch(/\bmeter\b/i);
    expect(
      audioDescriptions.some((description) => /\bmeter\b/i.test(description)),
      'the Audio pane must name the meter too',
    ).toBe(true);
  });

  it('no longer offers the two settings that decided nothing', () => {
    /*
     * Structural, not spelling: a "Diagnostic logging" toggle and an "Update
     * channel" dropdown used to be here, and a label ban would miss a renamed
     * revival.
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
    // Nor a hand-rolled control the component checks above would not see.
    expect(privacySection, 'no raw form control in this section').not.toMatch(
      /<(?:input|select|textarea)\b|role="(?:switch|checkbox|combobox|slider)"/i,
    );
    const toggles = [...privacySection.matchAll(/<Toggle\b[\s\S]*?\/>/g)].map((match) => match[0]);
    expect(toggles, 'the update switch is the only toggle in this section').toHaveLength(1);
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
      /retention/i,
    );
  });

  it('says the recognised words are not saved, where Speech settings describes them', () => {
    // The sentence that used to send people to the retention row. Its
    // replacement has to make the claim the row's absence implies, not just
    // stop making the old one.
    const speech = pane('speech');
    expect(speech, 'the Speech pane could not be located').not.toBe('');
    expect(speech).toMatch(/\bwords\b[^.]*\b(?:not|never)\b[^.]*\bsaved?\b/i);
    expect(speech, 'and audio is still never saved').toMatch(
      /\baudio\b[^.]*\b(?:not|never)\b[^.]*\bsaved?\b/i,
    );
  });

  it('still says what is kept on this device, and that audio is not', () => {
    /*
     * Removing a control is not permission to say less. The section has to
     * name what Speaking Glass really keeps locally — scripts, their saved
     * versions, settings, the session history Editor reads "start where the
     * last take ended" from — and still make the one claim about audio that
     * the retention row's hint used to make in passing.
     */
    const kept = privacySection;
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
    // The block that holds the policy line, found by that line rather than by
    // its heading.
    const policyAt = privacySection.indexOf('data-testid="update-policy"');
    const updateBlock = privacySection.slice(
      privacySection.lastIndexOf('<div class="privacy"', policyAt),
      policyAt,
    );
    expect(policyAt, 'the update policy line must be found, or the ban below is vacuous').toBeGreaterThan(-1);
    expect(updateBlock, 'the Updates block must be found, or the ban below is vacuous').toMatch(
      /<Toggle\b/,
    );
    expect(updateBlock, 'the Updates block must offer no button').not.toMatch(/<Button\b/);

    /*
     * The rendered node must actually consume the policy sentence. Asserting
     * only that `describeUpdatePolicy` appears SOMEWHERE in the route would
     * pass with its result discarded and misleading static copy in the node —
     * and it must be handed the switch's position, or the sentence under the
     * switch describes the wrong one.
     */
    expect(privacySection.slice(policyAt), 'the visible node must render the policy state').toMatch(
      /^data-testid="update-policy"[^>]*>\s*\{updateNote/,
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

  /*
   * The policy line under the switch. Its words are free; its claims are not.
   * The host comes from updater.rs and the menu item from the command
   * registry, so moving the feed or renaming the item cannot leave this line
   * naming the old one.
   */
  it('says exactly what the automatic check is, when it is on', async () => {
    const { describeUpdatePolicy } = await import('../../../src/control/services/settings');
    const { COMMANDS } = await import('../../../src/control/lib/commands');
    const sentence = describeUpdatePolicy('9.9.9-test', true);

    expect(sentence, 'the running version must be quotable from this line').toContain('9.9.9-test');
    expect(sentence, 'which host').toMatch(HOST);
    expect(sentence, 'and how to ask by hand').toContain(COMMANDS['help.check-for-updates'].label);
    /*
     * What the request carries — the whole of it. The IP address is named
     * because leaving it out is the classic understatement; the version, OS
     * and processor are in the URL and the User-Agent (updater.rs).
     */
    expect(sentence, 'the platform').toMatch(/operating system/i);
    expect(sentence, 'the processor').toMatch(/processor|architecture/i);
    expect(sentence, 'and, like any request, the IP address').toMatch(/IP address/i);
    expect(sentence, 'none of the scripts or audio').toMatch(
      /\b(?:none|not|no|never)\b[^.;]*\bscripts?\b[^.;]*\baudio\b/i,
    );

    // What it never does: install unasked, during a take, or unsigned.
    expect(sentence, 'installs are the user’s decision').toMatch(
      /\binstall\w*\b[^.]*\bonly when you\b/i,
    );
    expect(sentence, 'never during a take').toMatch(/\b(?:never|not)\b[^.]*\btake\b/i);
    expect(sentence, 'and only if signed').toMatch(/signature|signed/i);

    // A policy is not a result.
    expect(sentence).not.toMatch(/up to date/i);
    expect(sentence).not.toMatch(/update (?:is )?available/i);
    expect(sentence).not.toMatch(
      /install(?:s|ed)? (?:updates )?automatically|updates? (?:are |is )?installed automatically/i,
    );
  });

  it('says the network is only touched on request, when the switch is off', async () => {
    const { describeUpdatePolicy } = await import('../../../src/control/services/settings');
    const { COMMANDS } = await import('../../../src/control/lib/commands');
    const off = describeUpdatePolicy('9.9.9-test', false);

    expect(off).toContain('9.9.9-test');
    expect(off, 'the switch position must change what the line says').not.toBe(
      describeUpdatePolicy('9.9.9-test', true),
    );
    expect(off, 'the remaining contact is the host').toMatch(HOST);
    expect(off, 'by request').toContain(COMMANDS['help.check-for-updates'].label);
    expect(off, 'and it must not still describe a schedule').not.toMatch(
      /\bevery\b[^.]*\b(?:minutes?|hours?|days?)\b/i,
    );
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
      const sentence = describeUpdatePolicy('1.2.3', automatic);
      expect(sentence).toMatch(/\bscripts\b/i);
      expect(sentence).toMatch(/\bsettings\b/i);
    }
  });
});
