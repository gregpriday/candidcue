/**
 * A change made in Settings reaches the take that is already on the glass.
 *
 * In single-window presentation the control window IS the prompter, filling
 * the other display; Settings is the only control surface left on the desk.
 * Its sliders write the document, and the document reached the store here and
 * stopped — honoured by the next take and ignored by the running one. These
 * pin the follow: the fields that changed are applied through the same path
 * the in-session sheet uses, and only those fields.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  applyStageAppearance,
  clearSession,
  installLiveSettingsFollow,
  session,
  startLiveSession,
  toggleStageMirror,
} from '../../../src/control/stores/session';
import { adoptSettings, patchSettings, settings } from '../../../src/control/stores/settings';
import {
  buildStageEnvelope,
  stageSettingsFromSettings,
} from '../../../src/control/services/stage-envelope';
import {
  defaultAppSettings,
  withPanelMirror,
} from '../../../src/control/services/settings-types';
import type { DisplayDescriptor } from '../../../src/control/services/stage-types';
import type { CompiledScript, StageSessionEnvelope } from '../../../src/shared/contracts';

const SETTINGS = defaultAppSettings();

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

function envelopeFor(stageSettings: ReturnType<typeof stageSettingsFromSettings>): StageSessionEnvelope {
  return buildStageEnvelope({
    script: SCRIPT,
    sessionId: 'session-1',
    sessionGeneration: 1,
    stageGeneration: 0,
    stageSettings,
    assets: {},
  });
}

function start(): void {
  const stageSettings = stageSettingsFromSettings(SETTINGS);
  startLiveSession({
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

/**
 * A plain desk monitor, and the glass panel beside it. Neither reports a
 * physical size, so neither resolves optics — these are about the mirror.
 */
const DESK: DisplayDescriptor = {
  id: 'display-1',
  name: 'Desk monitor',
  primary: true,
  physicalPosition: { x: 0, y: 0 },
  physicalSize: { width: 2560, height: 1440 },
  logicalSize: { width: 2560, height: 1440 },
  scaleFactor: 1,
  fingerprint: 'panel-desk',
  topologyHash: 'topology-1',
};
const GLASS: DisplayDescriptor = { ...DESK, id: 'display-2', primary: false, fingerprint: 'panel-glass' };

/** A prompter take, opened on `display`. */
function startOn(display: DisplayDescriptor): void {
  const stageSettings = stageSettingsFromSettings(get(settings), display);
  startLiveSession({
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
    presentationMode: 'prompter',
    stageDisplay: display,
  });
}

/**
 * One panel's mirroring saved in the Settings window, arriving here.
 *
 * As a BROADCAST, which is how it reaches the take in the shipped app:
 * Settings is its own window, so its save is Rust's document handed to this
 * one. It is also the only route that works in this file once
 * "follows a document adopted from the other window" has moved the store's
 * revision past the in-memory backend's.
 */
function savePanelMirror(display: DisplayDescriptor, horizontal: boolean, vertical = false): void {
  const current = get(settings);
  const document = broadcast(current.revision + 1, current.teleprompter.fixedSpeedWpm) as {
    value: Record<string, unknown>;
  };
  document.value['optical'] = {
    migrated: true,
    profiles: {},
    activeRig: {},
    panelMirror: withPanelMirror(current.optical, display.fingerprint, { horizontal, vertical })
      .panelMirror,
  };
  expect(adoptSettings(document)).toBe(true);
}

/** What the embedded stage renderer is hydrated from. */
function rendered() {
  const envelope = get(session).stageEnvelope;
  expect(envelope).not.toBeNull();
  return envelope!.stageSettings;
}

/**
 * The wire shape Rust broadcasts — a whole document, because `fromRust`
 * validates the sections it maps. The pace is the one teleprompter field this
 * fixture can carry: `fixedSpeedWpm` is Rust-backed (`stageBehavior`), while
 * the type size lives in the per-window overlay and reaches this window
 * through a forced re-read rather than a broadcast.
 */
function broadcast(revision: number, fixedSpeedWpm: number): unknown {
  return {
    revision,
    value: {
      schemaVersion: 1,
      general: {
        openTo: 'library',
        autosaveDebounceMs: 800,
        revisionIntervalMinutes: 10,
        wordsPerMinuteEstimate: 150,
        analyticsEnabled: false,
      },
      editor: {},
      stageBehavior: {
        promptMode: 'voice',
        manualWheelMultiplier: 1,
        fixedSpeedWpm,
        pointerHideDelaySeconds: 1.5,
        manualMoveTrackingGraceSeconds: 2,
        stageAcknowledgement: 'flash',
        horizontalMirror: false,
        keepScreenAwake: true,
        blankColor: '#000000',
      },
      audio: {
        transcriptionModel: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
        language: 'en',
        delayProfile: 'low',
        softPauseAutoDisconnectMinutes: 10,
      },
      commands: {
        wakePhrase: 'CandidCue',
        wakeMode: 'strict',
      },
    },
  };
}

let teardown: (() => void) | null = null;
let originalFontSizePx: number;
let originalLineHeight: number;
let originalPace: number;
let originalSizeBias: number;

beforeEach(() => {
  vi.useFakeTimers();
  originalFontSizePx = get(settings).teleprompter.fontSizePx;
  originalLineHeight = get(settings).teleprompter.lineHeight;
  originalPace = get(settings).teleprompter.fixedSpeedWpm;
  originalSizeBias = get(settings).teleprompter.sizeBias;
});

afterEach(async () => {
  teardown?.();
  teardown = null;
  clearSession();
  vi.useRealTimers();
  // Put the shared document back for the next file.
  await patchSettings('teleprompter', {
    fontSizePx: originalFontSizePx,
    lineHeight: originalLineHeight,
    fixedSpeedWpm: originalPace,
    sizeBias: originalSizeBias,
  });
});

describe('saved settings follow into the running take', () => {
  it('applies a teleprompter change to the glass mid-take', async () => {
    start();
    teardown = installLiveSettingsFollow();
    const before = rendered().fontSizePx;
    expect(before).not.toBe(96);

    await patchSettings('teleprompter', { fontSizePx: 96 });

    expect(rendered().fontSizePx).toBe(96);
    expect(get(session).stageAppearance.fontSizePx).toBe(96);
  });

  it('touches only the fields that changed, keeping the take’s own nudges', async () => {
    start();
    teardown = installLiveSettingsFollow();
    // A nudge made on the glass, which the saved document knows nothing about.
    applyStageAppearance({ lineHeight: 1.6 });
    expect(rendered().lineHeight).toBe(1.6);

    await patchSettings('teleprompter', { fontSizePx: 96 });

    expect(rendered().fontSizePx).toBe(96);
    // Replacing the whole section would have snapped this back to the saved value.
    expect(rendered().lineHeight).toBe(1.6);
  });

  it('routes a changed auto-scroll pace to the transport, not the stage', async () => {
    start();
    teardown = installLiveSettingsFollow();
    const envelope = get(session).stageEnvelope;
    const before = get(session).autoScroll.wordsPerMinute;
    expect(before).not.toBe(170);

    await patchSettings('teleprompter', { fixedSpeedWpm: 170 });

    expect(get(session).autoScroll.wordsPerMinute).toBe(170);
    // Not a stage field: the glass was not rebuilt for it.
    expect(get(session).stageEnvelope).toBe(envelope);
  });

  it('rebuilds the glass for a size-bias change, like its two sibling preferences', async () => {
    /*
     * `sizeBias` is seeded into the AUTOMATIC optical profile by
     * `stageSettingsFromSettings`, exactly as `textIntensity` and `readingCue`
     * are — so it is a field the stage is composed from, and a change to it has
     * to reach a take already on the glass.
     *
     * Asserted as a rebuild rather than a resolved font size, because this
     * fixture starts a take with no display descriptor and therefore no optical
     * block to read a number out of. What is being pinned is membership of
     * `LIVE_STAGE_FIELDS`: leave it out and the presenter moves the slider on
     * the desk while the panel behind them keeps the old measure until the next
     * take — the exact shape of the bug the follow was built to close.
     */
    start();
    teardown = installLiveSettingsFollow();
    const envelope = get(session).stageEnvelope;

    await patchSettings('teleprompter', { sizeBias: 0 });

    expect(get(session).stageEnvelope).not.toBe(envelope);
  });

  it('leaves the glass alone for a commit that changed nothing the stage reads', async () => {
    start();
    teardown = installLiveSettingsFollow();
    const envelope = get(session).stageEnvelope;

    await patchSettings('general', { launchBehavior: 'recent' });

    // Every read rebuilds the optical section as a new object; only a change
    // in what it SAYS is a rig change.
    expect(get(session).stageEnvelope).toBe(envelope);
  });

  it('follows a document adopted from the other window', async () => {
    start();
    teardown = installLiveSettingsFollow();
    const revision = get(settings).revision + 5;

    // The Settings window saved; Rust broadcast; this window adopts.
    expect(adoptSettings(broadcast(revision, 172))).toBe(true);

    expect(get(session).autoScroll.wordsPerMinute).toBe(172);
  });

  it('does nothing when no take is running', async () => {
    teardown = installLiveSettingsFollow();
    await patchSettings('teleprompter', { fontSizePx: 96 });
    expect(get(session).active).toBe(false);
    expect(get(session).stageEnvelope).toBeNull();
  });

  it('stops following once torn down', async () => {
    start();
    const stop = installLiveSettingsFollow();
    stop();
    const before = rendered().fontSizePx;

    await patchSettings('teleprompter', { fontSizePx: 96 });

    expect(rendered().fontSizePx).toBe(before);
  });
});

/*
 * Mirroring is per panel (#206), so a switch thrown in Settings mid-take is a
 * statement about ONE panel's glass — it reaches the take only if that is the
 * panel the take is on.
 */
describe("a panel's saved mirroring, mid-take", () => {
  it('reaches a take running on that panel', () => {
    startOn(GLASS);
    teardown = installLiveSettingsFollow();
    expect(rendered().mirrorX).toBe(false);

    savePanelMirror(GLASS, true);

    expect(rendered().mirrorX).toBe(true);
  });

  it("leaves a take on another panel alone — that is not this take's glass", () => {
    startOn(DESK);
    teardown = installLiveSettingsFollow();

    savePanelMirror(GLASS, true);

    expect(rendered().mirrorX).toBe(false);
  });

  it('keeps a live flip through a change to some other panel', () => {
    startOn(DESK);
    teardown = installLiveSettingsFollow();
    toggleStageMirror('x');
    expect(rendered().mirrorX).toBe(true);

    // Both axes, so this is a real change to the glass's entry whatever an
    // earlier case left it as.
    savePanelMirror(GLASS, true, true);

    expect(rendered().mirrorX).toBe(true);
    expect(rendered().mirrorY).toBe(false);
  });

  it("replaces a live flip when the take's own panel is changed in Settings", () => {
    /*
     * The same rule as a slider: a value saved for the field the take nudged
     * replaces the nudge. Otherwise switching the mirror on in Settings would
     * do nothing to a take that had been flipped off on the glass.
     */
    savePanelMirror(GLASS, true);
    startOn(GLASS);
    teardown = installLiveSettingsFollow();
    // A vertical flip on the glass: the take now runs both axes.
    toggleStageMirror('y');
    expect(rendered().mirrorX).toBe(true);
    expect(rendered().mirrorY).toBe(true);

    savePanelMirror(GLASS, false);

    // The saved answer, not the flip laid over the old one.
    expect(rendered().mirrorX).toBe(false);
    expect(rendered().mirrorY).toBe(false);
  });
});
