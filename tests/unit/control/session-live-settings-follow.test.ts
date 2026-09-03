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
} from '../../../src/control/stores/session';
import { adoptSettings, patchSettings, settings } from '../../../src/control/stores/settings';
import {
  buildStageEnvelope,
  stageSettingsFromSettings,
} from '../../../src/control/services/stage-envelope';
import { defaultAppSettings } from '../../../src/control/services/settings-types';
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
        saveTranscript: 'off',
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

beforeEach(() => {
  vi.useFakeTimers();
  originalFontSizePx = get(settings).teleprompter.fontSizePx;
  originalLineHeight = get(settings).teleprompter.lineHeight;
  originalPace = get(settings).teleprompter.fixedSpeedWpm;
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
