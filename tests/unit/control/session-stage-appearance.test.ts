/**
 * Changing how the prompter looks WHILE it is prompting.
 *
 * ---------------------------------------------------------------------------
 * THE TWO DEFECTS THIS PINS
 * ---------------------------------------------------------------------------
 * 1. The quick-controls patched one field onto the live `StageSettings`.
 *    `readingBandHalfHeightPercent` is derived from size and line height, so a
 *    patched size left the reading corridor measured for type that is no longer
 *    on the glass — the band a presenter aligned to their lens quietly stopped
 *    matching the text inside it. Nothing on the stage says so.
 *
 * 2. They reached the stage by publishing a directive to a second webview.
 *    Presentation is one window now (§62): the renderer is mounted inside the
 *    control window and hydrates from `stageEnvelope`. The directive went
 *    nowhere, so `+`/`-` and Cmd+Shift+M moved a number in the store and
 *    nothing at all on the screen.
 *
 * Both are invisible from inside the store's own state, which is why these
 * assert against the ENVELOPE — the thing the stage actually renders from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  adjustStageFontSize,
  adoptPresentationMode,
  applyReaderAppearance,
  applyReaderTheme,
  applyStageAppearance,
  clearSession,
  noteStageRenderedFontSize,
  liveMirrorX,
  session,
  startLiveSession,
  suspendReaderPaper,
  takeReaderPreferenceSettings,
  takeReaderThemeSetting,
  takeTeleprompterSettings,
  toggleStageMirror,
} from '../../../src/control/stores/session';
import { getSettingsSnapshot } from '../../../src/control/stores/settings';
import { smoothFollow } from '../../../src/control/stores/smooth-follow';
import {
  PAPER_PAST_OPACITY,
  READER_PAPER_THEME_ID,
  STAGE_DARK_THEME_ID,
  buildStageEnvelope,
  buildStageSettings,
  stageSettingsFromSettings,
} from '../../../src/control/services/stage-envelope';
import {
  defaultAppSettings,
  readerPreferenceReplacement,
} from '../../../src/control/services/settings-types';
import { defaultOpticalProfile, type OpticalProfile } from '../../../src/shared/contracts';
import type { CompiledScript, StageSessionEnvelope } from '../../../src/shared/contracts';
import type { DisplayDescriptor } from '../../../src/control/services/stage-types';

const SETTINGS = defaultAppSettings();

/** The smallest compiled document the envelope builder will accept. */
const SCRIPT = {
  scriptId: 'script-1',
  sourceHash: 'hash-1',
  title: 'Launch video',
  blocks: [],
  cues: [],
  outline: [],
  sentences: [],
  spokenTokens: [],
  assets: [],
  navigationTargets: [],
  diagnostics: [],
} as unknown as CompiledScript;

function envelopeFor(stageSettings = stageSettingsFromSettings(SETTINGS)): StageSessionEnvelope {
  return buildStageEnvelope({
    script: SCRIPT,
    sessionId: 'session-1',
    sessionGeneration: 1,
    stageGeneration: 0,
    stageSettings,
    assets: {},
    following: SETTINGS.following,
  });
}

function start(
  stageSettings = stageSettingsFromSettings(SETTINGS),
  presentationMode?: 'prompter' | 'reader',
): void {
  startLiveSession({
    ...(presentationMode ? { presentationMode } : {}),
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'manual',
    displayLabel: 'This window',
    outline: [],
    sentences: [],
    totalTokens: 200,
    stageSettings,
    stageEnvelope: envelopeFor(stageSettings),
    teleprompter: SETTINGS.teleprompter,
  });
}

/** The settings the embedded stage renderer is currently hydrated from. */
function rendered() {
  const envelope = get(session).stageEnvelope;
  expect(envelope).not.toBeNull();
  return envelope!.stageSettings;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  clearSession();
  vi.useRealTimers();
});

describe('adjusting the prompter mid-take', () => {
  it('re-issues the envelope the embedded stage renders from', () => {
    start();
    const before = get(session).stageEnvelope;

    applyStageAppearance({ fontSizePx: 96 });

    expect(rendered().fontSizePx).toBe(96);
    // A NEW object, so the renderer's `envelope !== bridge.envelope` check sees
    // it. Mutating the old one in place would leave the stage on the settings
    // it hydrated with and nothing would ever say why.
    expect(get(session).stageEnvelope).not.toBe(before);
  });

  it('keeps the document and the generation, so the take does not restart', () => {
    start();
    const before = get(session).stageEnvelope!;

    applyStageAppearance({ fontSizePx: 96 });

    const after = get(session).stageEnvelope!;
    // Same generation: `stageReducer` treats this as a refresh in place and
    // keeps phase, alignment and position. A bumped generation would restart
    // the handshake and re-measure — mid-sentence.
    expect(after.stageGeneration).toBe(before.stageGeneration);
    expect(after.sessionId).toBe(before.sessionId);
    // The same document object, so the renderer has nothing to recompile and
    // the script cannot lose its place over a change of type size.
    expect(after.renderDocument).toBe(before.renderDocument);
  });

  /*
   * The corridor. This is the assertion the old patch-one-field path fails:
   * the band's half-height is derived from size AND line height, so a stage
   * whose type just doubled must be given a corridor that matches it.
   */
  it('recomputes the reading corridor from the new type, not the old', () => {
    start();
    const before = rendered().readingBandHalfHeightPercent;

    applyStageAppearance({ fontSizePx: 128 });

    const after = rendered().readingBandHalfHeightPercent;
    expect(after).not.toBe(before);
    // And it says exactly what a take STARTED at this size would say — one
    // description of the layout, whichever door it came in by.
    expect(after).toBe(
      stageSettingsFromSettings({
        ...SETTINGS,
        teleprompter: { ...SETTINGS.teleprompter, fontSizePx: 128 },
      }).readingBandHalfHeightPercent,
    );
  });

  it('reports what is on the glass, for the sheet to open on', () => {
    start();
    applyStageAppearance({ readingBandCenterPercent: 52, textIntensity: 'strong' });

    const s = get(session);
    expect(s.stageAppearance.readingBandCenterPercent).toBe(52);
    expect(s.stageAppearance.textIntensity).toBe('strong');
    expect(s.stageAppearance.fontSizePx).toBe(rendered().fontSizePx);
  });

  it('accumulates, so one slider does not undo the last', () => {
    start();
    applyStageAppearance({ fontSizePx: 88 });
    applyStageAppearance({ columnWidthPercent: 60 });

    expect(rendered().fontSizePx).toBe(88);
    expect(rendered().columnWidthPercent).toBe(60);
  });

  /*
   * Cancel is "put it back", and it is expressed as another apply. Nothing
   * special happens on the way out, which is the point: the take ends up in a
   * state it could have been driven into by hand.
   */
  it('goes back exactly, when the sheet is cancelled', () => {
    start();
    const opened = get(session).stageAppearance;

    applyStageAppearance({ fontSizePx: 140, lineHeight: 1.7 });
    applyStageAppearance(opened);

    expect(get(session).stageAppearance).toEqual(opened);
    expect(rendered()).toEqual(
      envelopeFor(stageSettingsFromSettings(SETTINGS)).stageSettings,
    );
  });
});

/*
 * §108/§62: `rebuildStageLayout` used to only publish a directive, which
 * reaches nothing in single-window presentation — the same generation-0 dead
 * end as everywhere else in this file. It needs the identical envelope kick
 * `applyStageAppearance` already uses, minted from the CURRENT settings
 * rather than a patch, since recovery is "run this again" and must not
 * change what the take looks like.
 */
describe('§62 layout recovery, which used to reach nothing either', () => {
  it('re-issues a fresh envelope and settings identity, unchanged in value', () => {
    start();
    const before = get(session).stageEnvelope!;
    const beforeSettings = before.stageSettings;

    smoothFollow.requestLayoutRebuild();

    const after = get(session).stageEnvelope!;
    // New identities, so the embedded stage's `envelope !== bridge.envelope`
    // effect fires and `ScriptLayer`'s settings-keyed layout recomputes.
    expect(after).not.toBe(before);
    expect(after.stageSettings).not.toBe(beforeSettings);
    // Same values: this is a re-run, not a change of appearance.
    expect(after.stageSettings).toEqual(beforeSettings);
  });

  it('keeps the document and the generation, so the take does not restart', () => {
    start();
    const before = get(session).stageEnvelope!;

    smoothFollow.requestLayoutRebuild();

    const after = get(session).stageEnvelope!;
    expect(after.stageGeneration).toBe(before.stageGeneration);
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.renderDocument).toBe(before.renderDocument);
  });

  /*
   * The guard this exercises: `rebuildStageLayout` only rewrites the envelope
   * when one is already there to rewrite. Without it, a recovery request
   * arriving with no take running (or after one just ended) would invent a
   * `stageEnvelope` out of nothing, which is a session the store never
   * actually started.
   */
  it('invents nothing when there is no take to recover', () => {
    expect(get(session).stageEnvelope).toBeNull();

    smoothFollow.requestLayoutRebuild();

    expect(get(session).stageEnvelope).toBeNull();
  });

  it('leaves a just-ended take alone', () => {
    start();
    smoothFollow.requestLayoutRebuild();
    const before = get(session).stageEnvelope!;

    clearSession();
    smoothFollow.requestLayoutRebuild();

    expect(get(session).stageEnvelope).toBeNull();
    // And the take's own envelope, had anything kept a reference to it, was
    // never mutated in place to produce that null.
    expect(before).not.toBeNull();
  });
});

describe('the quick-controls, which used to reach nothing', () => {
  it('steps the size on the rendered envelope', () => {
    start();
    const before = rendered().fontSizePx;

    const next = adjustStageFontSize(8);

    expect(next).toBe(before + 8);
    expect(rendered().fontSizePx).toBe(before + 8);
    expect(get(session).stageFontSizePx).toBe(before + 8);
  });

  /*
   * The old clamp stopped at 160px, which is not a taste limit — it is short of
   * what this product's own hardware asks for (a Prompter XL at its rated 4.6m
   * wants roughly 234), and it was a different limit from the one the Settings
   * slider offered for the same value.
   */
  it('reaches the sizes the product ships hardware for', () => {
    start();
    adjustStageFontSize(1000);
    expect(rendered().fontSizePx).toBe(320);
  });

  it('mirrors on the rendered envelope', () => {
    start();
    expect(rendered().mirrorX).toBe(false);

    expect(toggleStageMirror('x')).toBe(true);

    expect(rendered().mirrorX).toBe(true);
    // The menu checkmark reads the same answer the glass shows.
    expect(liveMirrorX()).toBe(true);

    // The vertical axis is its own flip, and the horizontal one survives it.
    toggleStageMirror('y');
    expect(rendered().mirrorY).toBe(true);
    expect(rendered().mirrorX).toBe(true);

    // And it is a toggle.
    expect(toggleStageMirror('x')).toBe(false);
    expect(rendered().mirrorX).toBe(false);
  });

  it('keeps a flip through an unrelated nudge', () => {
    start();
    toggleStageMirror('x');

    applyStageAppearance({ fontSizePx: 96 });

    expect(rendered().fontSizePx).toBe(96);
    expect(rendered().mirrorX).toBe(true);
  });

  it('refuses a flip in a reading window rather than holding one nobody can see', () => {
    /*
     * A reading window is never mirrored, so a flip there would change nothing
     * on screen and then turn up — on the glass — the moment the take switched
     * back to the prompter.
     */
    start();
    adoptPresentationMode('reader');
    const envelope = get(session).stageEnvelope;

    expect(toggleStageMirror('x')).toBeNull();

    expect(liveMirrorX()).toBe(false);
    expect(get(session).stageEnvelope).toBe(envelope);
    adoptPresentationMode('prompter');
    expect(rendered().mirrorX).toBe(false);
  });
});

describe('what a take keeps, and what it does not', () => {
  it('starts from the saved settings, and says so', () => {
    start();
    expect(takeTeleprompterSettings()).toEqual(SETTINGS.teleprompter);
    expect(get(session).stageAppearance.fontSizePx).toBe(SETTINGS.teleprompter.fontSizePx);
  });

  /*
   * An unsaved in-session change is scoped to the take on purpose. Carrying it
   * into the next one would make "Cancel" mean "until you quit" — and the
   * presenter who nudged the type up for one difficult paragraph would find it
   * there tomorrow with nothing to explain it.
   */
  it('drops an unsaved change when the session is cleared', () => {
    start();
    applyStageAppearance({ fontSizePx: 140 });
    clearSession();

    expect(takeTeleprompterSettings()).toEqual(SETTINGS.teleprompter);
  });
});

describe('the size ceiling belongs to the take, not to the last value', () => {
  const bigTeleprompter = { ...SETTINGS.teleprompter, fontSizePx: 400 };
  const bigSettings = stageSettingsFromSettings({
    ...SETTINGS,
    teleprompter: bigTeleprompter,
  });

  function startBig(): void {
    startLiveSession({
      scriptId: 'script-1',
      scriptTitle: 'Launch video',
      mode: 'manual',
      displayLabel: 'This window',
      outline: [],
      sentences: [],
      totalTokens: 200,
      stageSettings: bigSettings,
      stageEnvelope: envelopeFor(bigSettings),
      teleprompter: bigTeleprompter,
    });
  }

  it('publishes the ceiling the sliders must draw against', () => {
    startBig();
    expect(get(session).stageFontCeilingPx).toBe(400);
  });

  /*
   * The ratchet. `typeCeilingPx` follows the value it is handed so a hand-set
   * 400px is not clamped to the ordinary 320 the moment a panel shows it —
   * which, recomputed on every change, means stepping DOWN lowers the ceiling
   * and the size can never come back up.
   */
  it('lets a size come back up after it has been taken down', () => {
    startBig();
    applyStageAppearance({ fontSizePx: 350 });
    expect(rendered().fontSizePx).toBe(350);

    applyStageAppearance({ fontSizePx: 400 });
    expect(rendered().fontSizePx).toBe(400);
  });

  /*
   * Cancel is the same request, so it failed the same way: the sheet promised
   * to put the take back at 400 and left it at 350, with the button reporting
   * success.
   */
  it('restores the opening size when the sheet is cancelled', () => {
    startBig();
    const opened = get(session).stageAppearance;

    applyStageAppearance({ fontSizePx: 350 });
    applyStageAppearance(opened);

    expect(rendered().fontSizePx).toBe(400);
  });
});

describe('a rig-resolved take', () => {
  const VIEWPORT = { widthPx: 1024, heightPx: 600 };
  const rig: OpticalProfile = {
    ...defaultOpticalProfile(),
    rigName: 'Desk hood',
    hardwareKind: 'elgato-prompter',
    scale: {
      mmPerCssPx: (9 * 25.4) / Math.hypot(VIEWPORT.widthPx, VIEWPORT.heightPx),
      source: 'model',
      diagonalMm: 9 * 25.4,
    },
    viewingDistanceMm: 1200,
  };

  const rigSettings = () => buildStageSettings({ optical: { profile: rig, viewport: VIEWPORT } });

  /*
   * §17.2. Every one of these is resolved from a measured distance, so none of
   * them is the sheet's to set. It reports them instead — which it can only do
   * if the store tells it which kind of take this is.
   */
  it('is announced, so the sheet can stop offering what it does not decide', () => {
    start(rigSettings());
    expect(get(session).stageRigResolved).toBe(true);
  });

  it('is not claimed for an ordinary take', () => {
    start();
    expect(get(session).stageRigResolved).toBe(false);
  });

  /*
   * The readout says what is ON THE GLASS. A rig may resolve a line height
   * outside the range the sliders offer (the optical override alone allows
   * 1.0–2.0 against the sheet's 1.05–1.8), and clamping the READ to the
   * controls' limits made the panel report type that was not there.
   */
  it('reports the resolved geometry exactly, not clamped to the sliders', () => {
    const settings = rigSettings();
    start(settings);

    const shown = get(session).stageAppearance;
    expect(shown.lineHeight).toBe(settings.lineHeight);
    expect(shown.fontSizePx).toBe(settings.fontSizePx);
    expect(shown.columnWidthPercent).toBe(settings.columnWidthPercent);
    expect(shown.readingBandCenterPercent).toBe(settings.readingBandCenterPercent);
  });

  /*
   * Recomposing needs the panel: the profile is found by its fingerprint and
   * the type is sized against its viewport. Without one, a rebuild silently
   * produces the UNCALIBRATED layout — so any nudge, even the mirror, would
   * demote a measured rig to a guess mid-take with nothing saying so.
   */
  it('refuses to recompose itself when the panel it was measured on is unknown', () => {
    const settings = rigSettings();
    start(settings);

    applyStageAppearance({ fontSizePx: 96 });
    // Not even the mirror, which would otherwise be the most innocent nudge.
    expect(toggleStageMirror('x')).toBeNull();

    expect(rendered()).toEqual(settings);
    expect(get(session).stageRigResolved).toBe(true);
  });
});

/**
 * Issue #116, in the middle of a take rather than at the start of one.
 *
 * `set_control_presenting` names the panel it applied the new shape to on EVERY
 * arm, not just the opening one, and ⌃⌘F goes through the same command. Reading
 * only `mode` out of that reply rebuilt the geometry against the panel the take
 * opened on — so a reader who popped out onto an external prompter read type
 * sized in the laptop's millimetres, which `mmPerCssPx` makes a confidently
 * wrong physical size rather than a near miss.
 */
describe('switching presentation mode mid-take', () => {
  const LAPTOP: DisplayDescriptor = {
    id: 'display-1',
    name: 'Built-in Retina Display',
    primary: true,
    physicalPosition: { x: 0, y: 0 },
    physicalSize: { width: 3456, height: 2234 },
    logicalSize: { width: 1728, height: 1117 },
    scaleFactor: 2,
    fingerprint: 'panel-laptop',
    topologyHash: 'topology-1',
  };
  const PROMPTER: DisplayDescriptor = {
    ...LAPTOP,
    id: 'display-2',
    name: 'Elgato Prompter',
    primary: false,
    physicalSize: { width: 2560, height: 1440 },
    logicalSize: { width: 2560, height: 1440 },
    scaleFactor: 1,
    fingerprint: 'panel-prompter',
  };

  /** The settings the take would run if it were composed against `display`. */
  const composedFor = (mode: 'prompter' | 'reader', display: DisplayDescriptor) =>
    stageSettingsFromSettings(
      { ...SETTINGS, stage: { ...SETTINGS.stage, presentationMode: mode } },
      display,
    );

  /** A prompter take, open and filling the laptop panel. */
  function startOnLaptop(): void {
    const opening = composedFor('prompter', LAPTOP);
    startLiveSession({
      scriptId: 'script-1',
      scriptTitle: 'Launch video',
      mode: 'manual',
      displayLabel: 'This window',
      outline: [],
      sentences: [],
      totalTokens: 200,
      stageSettings: opening,
      stageEnvelope: envelopeFor(opening),
      teleprompter: SETTINGS.teleprompter,
      presentationMode: 'prompter',
      stageDisplay: LAPTOP,
    });
  }

  it('re-resolves the optics against the panel the switch landed on', () => {
    startOnLaptop();

    // Rust restores the reading window onto the external panel — "the frame
    // being restored, not the monitor being left", as the Switch arm puts it.
    adoptPresentationMode('reader', PROMPTER);

    expect(rendered()).toEqual(composedFor('reader', PROMPTER));
    /*
     * And the two panels must genuinely compose differently, or the assertion
     * above would pass just as well on the code that ignored the answer. This is
     * the layout the reader is looking at.
     */
    expect(rendered()).not.toEqual(composedFor('reader', LAPTOP));
  });

  it("drops a live flip when the take lands on another panel's glass (#206)", () => {
    /*
     * The flip was made at the glass the take WAS on. Carrying it onto a panel
     * with no glass in front of it is the bug this whole change is about,
     * arriving mid-take instead of at the opening.
     */
    startOnLaptop();
    toggleStageMirror('x');
    expect(rendered().mirrorX).toBe(true);

    adoptPresentationMode('prompter', PROMPTER);

    expect(rendered().mirrorX).toBe(false);
    expect(rendered()).toEqual(composedFor('prompter', PROMPTER));
  });

  it('keeps a live flip across a mode switch on the same panel', () => {
    startOnLaptop();
    toggleStageMirror('x');

    adoptPresentationMode('reader', LAPTOP);
    // Never mirrored in a reading window, and the menu checkmark says so...
    expect(rendered().mirrorX).toBe(false);
    expect(liveMirrorX()).toBe(false);

    adoptPresentationMode('prompter', LAPTOP);
    // ...and still the take's choice when it is back on the same glass.
    expect(rendered().mirrorX).toBe(true);
    expect(liveMirrorX()).toBe(true);
  });

  it('ends a live flip with the take', () => {
    startOnLaptop();
    toggleStageMirror('x');
    toggleStageMirror('y');
    expect(rendered().mirrorX).toBe(true);

    clearSession();
    startOnLaptop();

    // The panel's own answer again — nothing is mirrored for it.
    expect(rendered().mirrorX).toBe(false);
    expect(rendered().mirrorY).toBe(false);
    expect(liveMirrorX()).toBe(false);
    toggleStageMirror('x');
    expect(rendered().mirrorY).toBe(false);
  });

  it('keeps the panel it already had when nobody can name the new one', () => {
    /*
     * Plain-browser dev and an unidentifiable monitor both report no
     * fingerprint. The panel the take is already measured against is an answer
     * that was once true, so it beats re-deriving a guess.
     */
    startOnLaptop();

    adoptPresentationMode('reader');

    expect(rendered()).toEqual(composedFor('reader', LAPTOP));
  });
});

/**
 * A reading window, adjusted during a read.
 *
 * A reading window always runs a profile, so it used to be announced as
 * rig-resolved: the sheet showed a read-only readout over a window nobody had
 * calibrated, ⌘= and ⌘− were greyed out, and even had they not been, the only
 * thing they could write was `takeTeleprompter` — the prompter's fallback,
 * which a reading window never reads. Its appearance is the reader preference
 * laid over its profile now, and these pin that the take-time path reaches the
 * glass and stays out of the prompter's way.
 */
describe('a reading window, adjusted mid-read', () => {
  const DESK: DisplayDescriptor = {
    id: 'display-1',
    name: 'Built-in Retina Display',
    primary: true,
    physicalPosition: { x: 0, y: 0 },
    physicalSize: { width: 3456, height: 2234 },
    logicalSize: { width: 1728, height: 1117 },
    scaleFactor: 2,
    fingerprint: 'panel-desk',
    topologyHash: 'topology-1',
  };

  const composedFor = (mode: 'prompter' | 'reader') =>
    stageSettingsFromSettings(
      { ...SETTINGS, stage: { ...SETTINGS.stage, presentationMode: mode } },
      DESK,
    );

  function startReading(): void {
    const opening = composedFor('reader');
    startLiveSession({
      scriptId: 'script-1',
      scriptTitle: 'Launch video',
      mode: 'manual',
      displayLabel: 'This window',
      outline: [],
      sentences: [],
      totalTokens: 200,
      stageSettings: opening,
      stageEnvelope: envelopeFor(opening),
      teleprompter: SETTINGS.teleprompter,
      presentationMode: 'reader',
      stageDisplay: DESK,
    });
  }

  it('is not announced as rig-resolved, so its controls and keys are offered', () => {
    startReading();
    expect(get(session).stageRigResolved).toBe(false);
    const reader = get(session).stageReaderAppearance;
    expect(reader).not.toBeNull();
    expect(reader?.fontSizePx).toBe(rendered().fontSizePx);
    expect(reader?.characters).toBeNull();
  });

  /*
   * Control composes against the whole display with fallback metrics; the
   * stage re-resolves against the window with the measured face. With a
   * borrowed scale those can differ by more than a step, and "smaller" must
   * still make the text smaller — so the readout and the steps start from the
   * size the stage says it is drawing.
   */
  it('steps from the size the stage reports it is drawing', () => {
    startReading();
    const composed = rendered().fontSizePx;
    // Drawn LARGER than composed: a step down from the composed size would
    // have pinned something larger than the text on the glass.
    noteStageRenderedFontSize(composed + 8.3);
    expect(get(session).stageReaderAppearance?.fontSizePx).toBe(Math.round(composed + 8.3));
    adjustStageFontSize(-2);
    expect(takeReaderPreferenceSettings().fontSizePx).toBe(Math.round(composed + 8.3) - 2);
  });

  it('forgets the reported size when the take changes shape', () => {
    startReading();
    const composed = rendered().fontSizePx;
    noteStageRenderedFontSize(composed + 9);
    adoptPresentationMode('prompter', DESK);
    adoptPresentationMode('reader', DESK);
    expect(get(session).stageReaderAppearance?.fontSizePx).toBe(rendered().fontSizePx);
  });

  it('is not claimed for a prompter take', () => {
    start();
    expect(get(session).stageReaderAppearance).toBeNull();
  });

  it('reaches the glass through the profile the stage re-resolves from', () => {
    startReading();
    applyReaderAppearance({ fontSizePx: 40, lineHeight: 1.6, characters: 55, readingCue: 'wash' });

    expect(rendered().opticalProfile?.overrides).toEqual({
      fontSizePx: 40,
      lineHeight: 1.6,
      characters: 55,
    });
    expect(rendered().fontSizePx).toBe(40);
    expect(rendered().readingCue).toBe('wash');
    expect(get(session).stageReaderAppearance).toMatchObject({
      fontSizePx: 40,
      lineHeight: 1.6,
      characters: 55,
      readingCue: 'wash',
    });
  });

  it('leaves the prompter’s fallback alone, and saves nothing', () => {
    startReading();
    applyReaderAppearance({ fontSizePx: 40 });
    adjustStageFontSize(2);

    expect(takeTeleprompterSettings()).toEqual(SETTINGS.teleprompter);
    expect(takeReaderPreferenceSettings()).toEqual({ fontSizePx: 42 });
    // Done is what saves; a nudge is the take's.
    expect(getSettingsSnapshot().optical).toEqual(SETTINGS.optical);
  });

  it('steps its own size with ⌘= and ⌘−, inside the reader’s range', () => {
    startReading();
    const opening = rendered().fontSizePx;

    expect(adjustStageFontSize(2)).toBe(opening + 2);
    expect(rendered().fontSizePx).toBe(opening + 2);

    applyReaderAppearance({ fontSizePx: 95 });
    expect(adjustStageFontSize(2)).toBe(96);
    expect(adjustStageFontSize(2)).toBe(96);
    applyReaderAppearance({ fontSizePx: 21 });
    expect(adjustStageFontSize(-2)).toBe(20);
  });

  it('keeps each mode’s nudges to itself across a switch', () => {
    startReading();
    applyReaderAppearance({ fontSizePx: 40 });

    // To the prompter: none of the reader's size comes with it...
    adoptPresentationMode('prompter', DESK);
    expect(rendered()).toEqual(composedFor('prompter'));

    // ...a prompter nudge stays the prompter's...
    applyStageAppearance({ fontSizePx: 96 });

    // ...and back again, the reading window is where it was left.
    adoptPresentationMode('reader', DESK);
    expect(rendered().fontSizePx).toBe(40);
    expect(takeTeleprompterSettings().fontSizePx).toBe(96);
  });

  it('does not take an unsaved prompter intensity into the reading window', () => {
    /*
     * The reading window is seeded from Settings' intensity, and the section a
     * take recomposes from is the take's — prompter nudges included. Tried on
     * the prompter and never saved, a Soft belongs to the prompter.
     */
    startReading();
    adoptPresentationMode('prompter', DESK);
    applyStageAppearance({ textIntensity: 'soft' });
    expect(rendered().textIntensity).toBe('soft');

    adoptPresentationMode('reader', DESK);
    expect(rendered().textIntensity).toBe(SETTINGS.teleprompter.textIntensity);
    expect(rendered()).toEqual(composedFor('reader'));

    adoptPresentationMode('prompter', DESK);
    expect(rendered().textIntensity).toBe('soft');
  });

  it('goes back exactly when the sheet is cancelled, automatic fields and all', () => {
    startReading();
    const opening = rendered();
    const onOpen = takeReaderPreferenceSettings();

    applyReaderAppearance({ fontSizePx: 40, characters: 75, intensity: 'strong' });
    applyReaderAppearance(readerPreferenceReplacement(onOpen));

    // Not "pinned at the size it happened to be": automatic again.
    expect(rendered()).toEqual(opening);
    expect(takeReaderPreferenceSettings()).toEqual({});
  });

  it('puts a field back to automatic with null', () => {
    startReading();
    const opening = rendered();
    applyReaderAppearance({ characters: 75 });
    applyReaderAppearance({ characters: null });
    expect(rendered()).toEqual(opening);
  });

  it('drops an unsaved nudge when the session is cleared', () => {
    startReading();
    applyReaderAppearance({ fontSizePx: 40 });
    clearSession();
    startReading();
    expect(takeReaderPreferenceSettings()).toEqual({});
    expect(rendered()).toEqual(composedFor('reader'));
  });

  it('keeps the ordinary controls for a reading window with no panel to resolve against', () => {
    /*
     * Without a display there is no profile on the stage: the window prompts
     * from the flat fields, the reader preference would reach nothing, and the
     * controls that DO reach it are the prompter's.
     */
    start(
      stageSettingsFromSettings({
        ...SETTINGS,
        stage: { ...SETTINGS.stage, presentationMode: 'reader' },
      }),
      'reader',
    );
    // The premise first: this IS a reading-window take, with no optics.
    expect(get(session).stagePresentationMode).toBe('reader');
    expect(rendered().optics).toBeUndefined();
    expect(get(session).stageReaderAppearance).toBeNull();
    expect(get(session).stageRigResolved).toBe(false);
  });

  /*
   * Dark or Paper, chosen during the read.
   *
   * Through the same recomposition every other reader control takes, so the
   * field, the past-text floor and the stage's theme arrive in one envelope —
   * and held per take, apart from the prompter, which is composed black
   * however often the take switches.
   */
  it('draws the reading window on paper, now, and saves nothing', () => {
    startReading();
    const before = get(session).stageEnvelope;
    expect(rendered().themeId).toBe(STAGE_DARK_THEME_ID);

    expect(applyReaderTheme('paper')).toBe('paper');

    expect(rendered().themeId).toBe(READER_PAPER_THEME_ID);
    expect(rendered().background).toBe('#f6f2ea');
    expect(rendered().pastOpacity).toBe(PAPER_PAST_OPACITY);
    // A refresh in place, like every other mid-take change.
    expect(get(session).stageEnvelope).not.toBe(before);
    expect(get(session).stageEnvelope!.stageGeneration).toBe(before!.stageGeneration);
    expect(takeReaderThemeSetting()).toBe('paper');
    expect(getSettingsSnapshot().teleprompter.readerTheme).toBeUndefined();
  });

  it('comes back black on a switch to the prompter, and paper again on the way back', () => {
    startReading();
    applyReaderTheme('paper');

    adoptPresentationMode('prompter', DESK);
    expect(rendered()).toEqual(composedFor('prompter'));
    expect(rendered().themeId).toBe(STAGE_DARK_THEME_ID);
    expect(rendered().background).toBe('#000000');
    // Held for the reading window while the prompter runs, not drawn on it.
    expect(takeReaderThemeSetting()).toBe('paper');
    applyStageAppearance({ fontSizePx: 96 });
    expect(rendered().themeId).toBe(STAGE_DARK_THEME_ID);

    adoptPresentationMode('reader', DESK);
    expect(rendered().themeId).toBe(READER_PAPER_THEME_ID);
  });

  it('holds a choice made on a prompter take without drawing it', () => {
    start(stageSettingsFromSettings(SETTINGS, DESK));
    const opening = rendered();
    applyReaderTheme('paper');
    expect(rendered()).toEqual(opening);
    expect(takeReaderThemeSetting()).toBe('paper');
  });

  it('goes back when the sheet is cancelled', () => {
    startReading();
    const opening = rendered();
    const onOpen = takeReaderThemeSetting();
    applyReaderTheme('paper');
    applyReaderTheme(onOpen);
    expect(rendered()).toEqual(opening);
  });

  it('ends with the take', () => {
    startReading();
    applyReaderTheme('paper');
    clearSession();
    startReading();
    expect(takeReaderThemeSetting()).toBe('dark');
    expect(rendered()).toEqual(composedFor('reader'));
  });

  it('changes nothing outside a take', () => {
    expect(applyReaderTheme('paper')).toBe('dark');
    expect(get(session).stageEnvelope).toBeNull();
  });

  /*
   * The window moves before the geometry recomposes, and a switch to the
   * prompter moves it onto the glass — so a paper reading window is put on
   * the dark field FIRST, in place, and the switch landing lifts that.
   */
  it('goes dark in place ahead of a switch to the prompter, without re-wrapping', () => {
    startReading();
    applyReaderTheme('paper');
    const onPaper = rendered();

    suspendReaderPaper(true);

    const held = rendered();
    expect(held.themeId).toBe(STAGE_DARK_THEME_ID);
    expect(held.background).toBe('#000000');
    // Still the reading window's layout: nothing the line map depends on moved.
    expect(held.readingContext).toBe('reader');
    expect(held.fontSizePx).toBe(onPaper.fontSizePx);
    expect(held.lineHeight).toBe(onPaper.lineHeight);
    expect(held.optics).toEqual(onPaper.optics);
    // The take still wants paper; this is only the switch.
    expect(takeReaderThemeSetting()).toBe('paper');

    adoptPresentationMode('prompter', DESK);
    expect(rendered()).toEqual(composedFor('prompter'));

    // Lifted by the switch landing: back in a reading window, paper again.
    adoptPresentationMode('reader', DESK);
    expect(rendered().themeId).toBe(READER_PAPER_THEME_ID);
  });

  it('stays dark after a switch that failed, until somebody picks Paper again', () => {
    /*
     * A failed switch may have put the window on the glass before the part
     * that failed, and nothing in control can tell — so the hold is not
     * lifted by failure. A deliberate choice at the window is what ends it.
     */
    startReading();
    applyReaderTheme('paper');
    const onPaper = rendered();
    suspendReaderPaper(true);
    // No `adoptPresentationMode`: the switch threw.
    expect(rendered().themeId).toBe(STAGE_DARK_THEME_ID);
    applyReaderTheme('paper');
    expect(rendered()).toEqual(onPaper);
  });

  it('gets its paper back when the switch lands on the mode it was already in', () => {
    startReading();
    applyReaderTheme('paper');
    const onPaper = rendered();
    suspendReaderPaper(true);
    adoptPresentationMode('reader', DESK);
    expect(rendered()).toEqual(onPaper);
  });

  it('does not carry a held switch into the next take', () => {
    startReading();
    applyReaderTheme('paper');
    suspendReaderPaper(true);
    clearSession();
    startReading();
    applyReaderTheme('paper');
    expect(rendered().themeId).toBe(READER_PAPER_THEME_ID);
  });
});
