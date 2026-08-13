/**
 * The presentation mode: how it is chosen, remembered, migrated and sent.
 *
 * The optical half is `src/shared/reader-mode-optics.test.ts`. This is the
 * plumbing — the setting that replaced a boolean which did nothing, the chord
 * that switches mid-take, and the two things a reading window must never inherit
 * from a glass rig.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultAppSettings,
  inheritableReaderScale,
  migrateStageMode,
  readerOpticalProfile,
  READER_RIG_NAME,
  opticalRigKey,
  withOpticalProfile,
  type OpticalSettings,
} from '../../../src/control/services/settings-types';
import { stageSettingsFromSettings } from '../../../src/control/services/stage-envelope';
import { chooseStageDisplay } from '../../../src/control/lib/start-take';
import {
  presentationModeShortcutLabel,
  resolveShortcut,
  type ShortcutQuery,
} from '../../../src/control/lib/shortcuts';
import { defaultOpticalProfile } from '../../../src/shared/contracts';
import type { DisplayDescriptor } from '../../../src/control/services/stage-types';

/* ------------------------------------------------------------ the setting */

describe('the presentation-mode setting', () => {
  it('defaults to what every take has always done', () => {
    // Reader mode is a deliberate choice. A first run on a laptop must not
    // discover it by surprise.
    expect(defaultAppSettings().stage.presentationMode).toBe('prompter');
  });

  it('reads a stored mode back verbatim', () => {
    expect(migrateStageMode({ presentationMode: 'reader' })).toBe('reader');
    expect(migrateStageMode({ presentationMode: 'prompter' })).toBe('prompter');
  });

  it('honours somebody who turned the retired "Full screen" switch off', () => {
    /*
     * `fullscreen` never affected a take — it was read by the preview and the
     * display test and by nothing on the path Present takes — so nobody's habits
     * were built on it. But turning it off WAS an expression of the preference
     * reader mode now delivers, and honouring it is cheaper than explaining why
     * it was ignored.
     */
    expect(migrateStageMode({ fullscreen: false })).toBe('reader');
    expect(migrateStageMode({ fullscreen: true })).toBe('prompter');
  });

  it('takes prompter for anything it cannot read', () => {
    // The safe side: prompter is what the app did before the field existed, so an
    // unreadable overlay cannot silently change how a take presents.
    expect(migrateStageMode(undefined)).toBe('prompter');
    expect(migrateStageMode(null)).toBe('prompter');
    expect(migrateStageMode({})).toBe('prompter');
    expect(migrateStageMode({ presentationMode: 'windowed' })).toBe('prompter');
    expect(migrateStageMode('reader')).toBe('prompter');
  });

  it('prefers an explicit mode over a leftover boolean', () => {
    // Both present is the shape of a settings document written across the
    // upgrade. The new field is the one somebody actually set.
    expect(migrateStageMode({ presentationMode: 'prompter', fullscreen: false })).toBe('prompter');
  });
});

/* ----------------------------------------------------------- the shortcut */

describe('the mid-take mode chord', () => {
  const press = (over: Partial<ShortcutQuery>): ShortcutQuery => ({
    key: 'f',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    typing: false,
    isMac: true,
    ...over,
  });

  it('answers the platform full-screen chord on macOS', () => {
    expect(resolveShortcut(press({ ctrlKey: true, metaKey: true }))).toBe(
      'toggle-presentation-mode',
    );
  });

  it('answers a bare F11 elsewhere', () => {
    expect(resolveShortcut(press({ isMac: false, key: 'F11' }))).toBe('toggle-presentation-mode');
  });

  /*
   * The chord it USED to have off macOS, and why it does not any more.
   *
   * Ctrl+Alt+F is `edit.replace` — Mod+Alt+F in the command registry, which is
   * Ctrl+Alt+F on Windows and Linux. That is a native menu accelerator, and the
   * menu takes the chord from the window, so this branch would have been
   * unreachable on the two platforms it existed for while passing every test in
   * this file.
   */
  it('leaves Ctrl+Alt+F to Find and Replace off macOS', () => {
    expect(resolveShortcut(press({ isMac: false, ctrlKey: true, altKey: true }))).toBeNull();
  });

  it('does not fire on the other platform’s chord', () => {
    /*
     * The reason this is tested in both directions: on macOS `primary` is
     * `metaKey`, so a Control+Command+F reaching the `primary && !altKey` block
     * would be read as a plain Cmd+F and fall through to null — and Ctrl+Alt+F on
     * a Mac is not the gesture anybody there is making.
     */
    expect(resolveShortcut(press({ isMac: true, ctrlKey: true, altKey: true }))).not.toBe(
      'toggle-presentation-mode',
    );
    expect(resolveShortcut(press({ isMac: false, ctrlKey: true, metaKey: true }))).not.toBe(
      'toggle-presentation-mode',
    );
    // And F11 is not a macOS gesture — there it is a system Exposé key.
    expect(resolveShortcut(press({ isMac: true, key: 'F11' }))).not.toBe(
      'toggle-presentation-mode',
    );
  });

  it('still fires while typing, like every other modified chord', () => {
    /*
     * Deliberately NOT gated on `typing`. Only the plain-key block at the bottom
     * of `resolveShortcut` stands down for a text field, because an unmodified
     * `b` or `space` is text. A modifier already says "this is an app command" —
     * Cmd+S saves from inside the editor — and a window command is exactly that
     * kind of key.
     */
    expect(resolveShortcut(press({ ctrlKey: true, metaKey: true, typing: true }))).toBe(
      'toggle-presentation-mode',
    );
  });

  it('stands down when the key is repeating', () => {
    /*
     * Held, this would flip the window between shapes at the key-repeat rate, and
     * each flip is an OS window operation plus a full document relayout. The `a`
     * transport toggle makes the same objection about itself for much less cost.
     */
    expect(resolveShortcut(press({ ctrlKey: true, metaKey: true, repeat: true }))).toBeNull();
    // And the non-repeating press still works, so the guard is not blanket.
    expect(resolveShortcut(press({ ctrlKey: true, metaKey: true, repeat: false }))).toBe(
      'toggle-presentation-mode',
    );
  });

  it('stands down behind a modal, like every other shortcut', () => {
    expect(
      resolveShortcut(press({ ctrlKey: true, metaKey: true, modal: true })),
    ).toBeNull();
  });

  it('does not swallow the F chords next to it', () => {
    /*
     * Cmd+F is `find-in-list` — the Library's filter field, for the two places
     * with no menu bar to take the chord first. What matters here is that the
     * presentation branch does not claim it on its way past, and that
     * Cmd+Shift+F is still nobody's.
     */
    expect(resolveShortcut(press({ metaKey: true }))).toBe('find-in-list');
    expect(resolveShortcut(press({ metaKey: true, shiftKey: true }))).toBeNull();
    expect(resolveShortcut(press({ ctrlKey: true, metaKey: true, shiftKey: true }))).not.toBe(
      'toggle-presentation-mode',
    );
  });

  it('labels itself the way the platform writes it', () => {
    // Derived rather than spelled out at the two places that show it, so a label
    // can never describe a key `resolveShortcut` does not answer to.
    expect(presentationModeShortcutLabel(true)).toBe('⌃⌘F');
    expect(presentationModeShortcutLabel(false)).toBe('F11');
  });
});

/* ------------------------------------------------------- the reading rig */

const FINGERPRINT = 'panel-1';

/** A 16" MacBook Pro at default scaling — 1728 x 1117 CSS px over 3456 x 2234. */
function displayDescriptor(): DisplayDescriptor {
  return {
    id: 'display-1',
    name: 'Built-in Display',
    primary: true,
    physicalPosition: { x: 0, y: 0 },
    physicalSize: { width: 3456, height: 2234 },
    logicalSize: { width: 1728, height: 1117 },
    scaleFactor: 2,
    fingerprint: FINGERPRINT,
    topologyHash: 'topology-1',
  };
}

describe('the reading rig', () => {
  const empty = (): OpticalSettings => ({ profiles: {}, activeRig: {} });

  it('answers without a calibration, unlike its prompter sibling', () => {
    /*
     * `activeOpticalProfile` refuses to adopt a rig nobody chose, and the reason
     * is stated there: a stale ARRANGEMENT — a hood, a mirror, a distance — must
     * not be inherited. A reading window has no arrangement, so refusing would
     * mean reader mode could not size text until somebody had walked a wizard for
     * a rig that does not exist.
     */
    const profile = readerOpticalProfile(empty(), FINGERPRINT);
    expect(profile.lensPlacement).toBe('none');
    expect(profile.flips).toEqual({ horizontal: false, vertical: false });
    expect(profile.viewingDistanceMm).toBeGreaterThan(0);
  });

  it('claims no completed calibration steps, because nobody completed any', () => {
    // The list records what a person confirmed. This profile was derived.
    expect(readerOpticalProfile(empty(), FINGERPRINT).completedSteps).toEqual([]);
  });

  function glassRig(source: 'ruler' | 'model' | 'diagonal') {
    return {
      ...defaultOpticalProfile(),
      rigName: 'Studio hood',
      scale: { mmPerCssPx: 0.2, source },
      viewingDistanceMm: 2500,
      flips: { horizontal: true, vertical: false },
      lensPlacement: 'in-panel' as const,
      safeArea: { top: 0.2, right: 0.1, bottom: 0.2, left: 0.1 },
    };
  }

  it('inherits none of the panel’s RIG facts', () => {
    const optical = withOpticalProfile(empty(), FINGERPRINT, glassRig('model'));
    const reader = readerOpticalProfile(optical, FINGERPRINT);
    // Every one of these is a fact about a hood and a camera.
    expect(reader.viewingDistanceMm).not.toBe(2500);
    expect(reader.flips).toEqual({ horizontal: false, vertical: false });
    expect(reader.lensPlacement).toBe('none');
    expect(reader.safeArea).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('inherits a panel-derived scale, because that describes the glass a reader looks at', () => {
    for (const source of ['model', 'diagonal'] as const) {
      const optical = withOpticalProfile(empty(), FINGERPRINT, glassRig(source));
      expect(readerOpticalProfile(optical, FINGERPRINT).scale?.mmPerCssPx).toBe(0.2);
    }
  });

  it('refuses a RULER scale, which measured the optical path and not the panel', () => {
    /*
     * The subtle one, and the reason `inheritableReaderScale` exists.
     *
     * `OpticalScale`'s own contract says a ruler measurement describes "the
     * finished optical path" and "silently corrects for anything the hardware
     * table cannot know — a magnifying beamsplitter". A reading window has no
     * beamsplitter, so inheriting that number is wrong by exactly the
     * magnification: a rig measured at 0.25 mm/px through glass whose bare panel
     * is 0.20 would render a reading window ~20% small, confidently, while
     * reporting itself calibrated.
     *
     * Falling through to the uncalibrated reader default is the honest outcome —
     * a guess that says it is one beats a measurement of the wrong thing.
     */
    const optical = withOpticalProfile(empty(), FINGERPRINT, glassRig('ruler'));
    expect(readerOpticalProfile(optical, FINGERPRINT).scale).toBeNull();
  });

  it('states that rule on its own, so a refactor cannot lose it quietly', () => {
    expect(inheritableReaderScale(glassRig('ruler'))).toBeNull();
    expect(inheritableReaderScale(glassRig('model'))?.mmPerCssPx).toBe(0.2);
    expect(inheritableReaderScale(null)).toBeNull();
  });

  it('does not adopt a prompter rig that merely shares the reserved name', () => {
    /*
     * `READER_RIG_NAME` is reserved by convention and the convention is not
     * enforceable — somebody can name a rig "Reading window" in the calibration
     * wizard and land it on this key. Adopting it wholesale would bring its hood
     * crop, its mirror and its 2.5 m distance into a window on a desk.
     *
     * `lensPlacement === 'none'` is the discriminator, because it is the one field
     * only a reading rig has and nothing but `readerOpticalProfile` writes it.
     */
    const impostor = { ...glassRig('model'), rigName: READER_RIG_NAME };
    const optical: OpticalSettings = {
      profiles: { [opticalRigKey(FINGERPRINT, READER_RIG_NAME)]: impostor },
      activeRig: {},
    };
    const reader = readerOpticalProfile(optical, FINGERPRINT);
    expect(reader.lensPlacement).toBe('none');
    expect(reader.viewingDistanceMm).not.toBe(2500);
    expect(reader.safeArea).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('prefers a stored reading profile over the derived one', () => {
    const stored = {
      ...defaultOpticalProfile(),
      rigName: READER_RIG_NAME,
      lensPlacement: 'none' as const,
      viewingDistanceMm: 700,
    };
    const optical: OpticalSettings = {
      profiles: { [opticalRigKey(FINGERPRINT, READER_RIG_NAME)]: stored },
      activeRig: {},
    };
    expect(readerOpticalProfile(optical, FINGERPRINT).viewingDistanceMm).toBe(700);
  });

  it('still answers for a panel it has never seen', () => {
    // A take can open before the displays are enumerable, and a reading window
    // with no geometry at all is a blank screen.
    expect(readerOpticalProfile(empty(), null).lensPlacement).toBe('none');
  });
});

/* --------------------------------------------------- which display it measures */

describe('the display a take is measured against', () => {
  const external: DisplayDescriptor = {
    ...displayDescriptor(),
    id: 'display-2',
    name: 'Elgato Prompter',
    primary: false,
    fingerprint: 'panel-2',
  };
  const builtIn = displayDescriptor();

  it('sends a prompter to a panel that is not the one you are sitting at', () => {
    // Unchanged: on the rig this app is for, the primary display has the
    // operator's face pointed at it, and presenting on top of that is not
    // presenting.
    expect(chooseStageDisplay([builtIn, external], null, 'prompter')?.fingerprint).toBe('panel-2');
  });

  it('honours a pinned prompter panel', () => {
    expect(chooseStageDisplay([builtIn, external], 'panel-1', 'prompter')?.fingerprint).toBe(
      'panel-1',
    );
  });

  it('measures a reading window against the display it is actually on', () => {
    /*
     * The defect this fixes, and it is not cosmetic. Reader mode presents THIS
     * window where it already is, so the panel that matters is the one under it —
     * and the prompter rule steers deliberately AWAY from that. A reader working
     * at their laptop with a calibrated external prompter attached would have had
     * their type sized from the external panel's millimetres-per-pixel, which is
     * the entire basis of the angular model. The text comes out confidently the
     * wrong physical size.
     *
     * The primary display is the honest guess: it is where an ordinary window sits
     * unless somebody moved it.
     */
    expect(chooseStageDisplay([external, builtIn], null, 'reader')?.fingerprint).toBe('panel-1');
  });

  it('ignores a pinned PROMPTER panel when presenting as a reader', () => {
    // The pin names the panel a prompter presents on. It says nothing about where
    // a reading window happens to be.
    expect(chooseStageDisplay([external, builtIn], 'panel-2', 'reader')?.fingerprint).toBe(
      'panel-1',
    );
  });

  it('defaults to the prompter rule when no mode is given', () => {
    // Every pre-existing caller passes two arguments and means prompter.
    expect(chooseStageDisplay([builtIn, external], null)?.fingerprint).toBe('panel-2');
  });

  it('has something to answer with on a single-display machine, in either mode', () => {
    for (const mode of ['prompter', 'reader'] as const) {
      expect(chooseStageDisplay([builtIn], null, mode)?.fingerprint).toBe('panel-1');
    }
    expect(chooseStageDisplay([], null, 'reader')).toBeNull();
  });
});

/* -------------------------------------------------- what the stage is sent */

describe('the settings a reading window runs', () => {
  function settingsFor(mode: 'prompter' | 'reader') {
    const base = defaultAppSettings();
    return {
      ...base,
      stage: { ...base.stage, presentationMode: mode },
      // A glass rig's mirror, deliberately left ON, to prove reader mode does not
      // carry it.
      teleprompter: { ...base.teleprompter, mirrorX: true },
    };
  }

  it('never mirrors, whatever Settings says', () => {
    /*
     * The mirror toggles describe a BEAMSPLITTER. A reading window has no glass
     * in the optical path, and carrying a glass rig's mirror into it gives
     * somebody backwards text on a bare monitor — which the `desk-webcam` preset
     * already calls "the classic first-run confusion".
     *
     * Forced rather than defaulted: the prompter rig legitimately wants it on, and
     * switching modes must not make somebody turn a setting off and back on again.
     */
    const reader = stageSettingsFromSettings(settingsFor('reader'), displayDescriptor());
    expect(reader.mirrorX).toBe(false);
    expect(reader.mirrorY).toBe(false);
  });

  it('still mirrors a prompter take that asked for it', () => {
    const prompter = stageSettingsFromSettings(settingsFor('prompter'), displayDescriptor());
    expect(prompter.mirrorX).toBe(true);
  });

  it('tells the stage which measure band to aim at', () => {
    /*
     * On the wire because the STAGE re-resolves against its own viewport. Without
     * it a reading window would open at control's resolution and then re-resolve
     * itself into a narrow prompter column on its first measurement pass.
     */
    expect(stageSettingsFromSettings(settingsFor('reader'), displayDescriptor()).readingContext)
      .toBe('reader');
  });

  it('says nothing for a prompter, so an older stage reads no new field', () => {
    expect(
      stageSettingsFromSettings(settingsFor('prompter'), displayDescriptor()).readingContext,
    ).toBeUndefined();
  });

  it('carries the reading context even with no display to resolve against', () => {
    /*
     * The case where the default matters MOST: with no display there is no
     * `optics` block, so the stage falls back to a constant — and it has to be
     * the reader's 30 px rather than the prompter's 64, which in a reading window
     * is about a dozen characters a line.
     */
    const settings = stageSettingsFromSettings(settingsFor('reader'), null);
    expect(settings.readingContext).toBe('reader');
    expect(settings.optics).toBeUndefined();
  });
});
