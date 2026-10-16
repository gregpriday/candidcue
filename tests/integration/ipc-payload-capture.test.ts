/**
 * Layer 4 (spec §55.1), half one: capture what the REAL TypeScript services
 * actually put on the wire.
 *
 * `tests/fixtures/ipc/script-command-payloads.json` is hand-written. That is
 * its weakness: it records what someone believed `listScripts` sends, and it
 * stayed correct while the service itself sent `filter.view` — a field Rust has
 * never had — for weeks. A fixture and the code it describes can drift in
 * exactly the same way two implementations can.
 *
 * So this file does not describe anything. It installs a recording `invoke`,
 * calls the production service functions, and writes down the payload they
 * produced. `tests/fixtures/ipc/captured-invocations.json` is the committed
 * result, and `src-tauri/tests/ipc_roundtrip_tests.rs` feeds those exact bytes
 * through the real Tauri command handlers against a real database.
 *
 * The loop is therefore closed:
 *
 *   production TS service  →  captured payload  →  real Rust command
 *
 * A change to a service payload fails HERE (with instructions to regenerate);
 * regenerating then fails on the RUST side if the new shape is one the command
 * cannot accept. Neither half can be satisfied by editing a fixture.
 *
 * Regenerate with:
 *   UPDATE_IPC_CAPTURE=1 ./node_modules/.bin/vitest run tests/integration/ipc-payload-capture.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as controlWindow from '../../src/control/services/control-window';
import { setInvokeForTesting } from '../../src/control/services/ipc';
import * as scripts from '../../src/control/services/scripts';
import * as sessionRecords from '../../src/control/services/session-records';
import * as settings from '../../src/control/services/settings';
import * as speechModels from '../../src/control/services/speech-models';
import * as stage from '../../src/control/services/stage';

const ROOT = resolve(__dirname, '../..');
const FIXTURE = join(ROOT, 'tests/fixtures/ipc/captured-invocations.json');

/**
 * Placeholders the Rust side rewrites to real values it minted itself. They
 * are deliberately well-formed for their position — the script id is a valid
 * UUID — so that a capture which forgot to use one still fails Rust's boundary
 * validation rather than passing by accident.
 */
export const PLACEHOLDER_SCRIPT_ID = '00000000-0000-4000-8000-0000000000c0';
export const PLACEHOLDER_SESSION_ID = '00000000-0000-4000-8000-0000000000c1';

interface Capture {
  command: string;
  args: unknown;
}

const captured = new Map<string, Capture>();
let pending: Capture | null = null;

/**
 * Records the invocation and answers with the smallest value that lets the
 * service function return without throwing. The RESPONSE is not the point —
 * the request is — so these stay deliberately minimal.
 */
function responseFor(command: string): unknown {
  switch (command) {
    case 'list_scripts':
      return { items: [], total: 0 };
    case 'get_settings':
    case 'update_settings':
      return rustSettingsDocument();
    case 'app_version':
      return '0.1.0';
    case 'clear_cache':
      return { kind: 'logs', removedFiles: 0, removedBytes: 0 };
    case 'start_session':
      return { id: PLACEHOLDER_SESSION_ID, sessionGeneration: 1 };
    case 'append_session_transcript':
      return 1;
    case 'list_sessions':
      return [];
    default:
      return null;
  }
}

/** Minimal shape `settings.ts::fromRust` can read without exploding. */
function rustSettingsDocument() {
  return {
    revision: 3,
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
        fixedSpeedWpm: 140,
        pointerHideDelaySeconds: 1.5,
        manualMoveTrackingGraceSeconds: 3,
        stageAcknowledgement: 'required',
        horizontalMirror: false,
        keepScreenAwake: true,
        blankColor: '#000000',
      },
      audio: {
        transcriptionModel: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
        language: 'en',
        delayProfile: 'balanced',
        softPauseAutoDisconnectMinutes: 5,
      },
      commands: {
        wakePhrase: 'hey cue',
        wakeMode: 'double_gate',
      },
    },
  };
}

/** Record one service call under a stable case name. */
async function capture(name: string, run: () => Promise<unknown>): Promise<void> {
  pending = null;
  await run();
  if (pending === null) {
    throw new Error(
      `"${name}" did not reach the IPC boundary. Either the service short-circuited ` +
        '(check isTauriRuntime()) or the command was renamed.',
    );
  }
  captured.set(name, pending);
}

beforeEach(() => {
  // Several services gate on `isTauriRuntime()` BEFORE calling ipcInvoke, and
  // would otherwise answer from the mock backend without ever producing a
  // payload. Standing up the marker makes them take the real path.
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  setInvokeForTesting(async <T,>(command: string, args?: Record<string, unknown>) => {
    // `structuredClone` freezes the payload at call time; a service that
    // mutated its argument object afterwards would otherwise be recorded in
    // its post-mutation state.
    pending = { command, args: args === undefined ? null : structuredClone(args) };
    return responseFor(command) as T;
  });
});

afterEach(() => {
  setInvokeForTesting(null);
  delete (globalThis as { window?: unknown }).window;
});

describe('captured IPC payloads (production services → wire)', () => {
  it('captures every script-library command', async () => {
    await capture('list_scripts_all', () =>
      scripts.listScripts({ view: 'all', query: 'keynote' }, 'name', { page: 1, pageSize: 50 }),
    );
    await capture('list_scripts_trash', () =>
      scripts.listScripts({ view: 'trash' }, 'recently_edited', { page: 1, pageSize: 50 }),
    );
    await capture('list_scripts_recent', () =>
      scripts.listScripts({ view: 'recent' }, 'name', { page: 1, pageSize: 25 }),
    );
    await capture('list_scripts_bare', () => scripts.listScripts());
    await capture('create_script', () =>
      scripts.createScript({ title: 'Keynote', source: '# Keynote\n\nHello.\n' }),
    );
    await capture('get_script', () => scripts.getScript(PLACEHOLDER_SCRIPT_ID));
    await capture('save_script', () =>
      scripts.saveScript(PLACEHOLDER_SCRIPT_ID, 1, '# Keynote\n\nRevised.\n', {
        title: 'Keynote II',
      }),
    );
    await capture('rename_script', () =>
      scripts.renameScript(PLACEHOLDER_SCRIPT_ID, 'Renamed keynote', 1),
    );
    await capture('duplicate_script', () => scripts.duplicateScript(PLACEHOLDER_SCRIPT_ID));
    await capture('trash_script', () => scripts.trashScript(PLACEHOLDER_SCRIPT_ID, 1));
    await capture('restore_script', () => scripts.restoreScript(PLACEHOLDER_SCRIPT_ID, 1));
    await capture('permanently_delete_script', () =>
      scripts.permanentlyDeleteScript(PLACEHOLDER_SCRIPT_ID),
    );
    await capture('reveal_script_folder', () => scripts.revealScriptFolder(PLACEHOLDER_SCRIPT_ID));
    await capture('import_script', () => scripts.importScript({ title: 'Keynote' }));
    await capture('export_script_markdown', () =>
      scripts.exportScript(PLACEHOLDER_SCRIPT_ID, { format: 'markdown' }),
    );
    await capture('export_script_bundle', () =>
      scripts.exportScript(PLACEHOLDER_SCRIPT_ID, {
        format: 'bundle',
        includeAssets: true,
        suggestedName: 'Keynote',
      }),
    );

    expect(captured.size).toBeGreaterThan(0);
  });

  it('captures every session-record command', async () => {
    await capture('start_session', () =>
      sessionRecords.startSessionRecord({
        scriptId: PLACEHOLDER_SCRIPT_ID,
        scriptSourceHash: 'sha256:aaaabbbbccccdddd',
        mode: 'voice',
        startTokenIndex: 0,
        compileHash: 'compile-abc',
      }),
    );
    await capture('end_session', () =>
      sessionRecords.endSessionRecord(PLACEHOLDER_SESSION_ID, {
        endTokenIndex: 412,
        softPauseMs: 1200,
        commandCount: 3,
        retakeCount: 1,
        reconnectCount: 0,
        manualCorrectionCount: 2,
      }),
    );
    await capture('append_session_transcript', () =>
      sessionRecords.appendSessionTranscript(PLACEHOLDER_SESSION_ID, [
        {
          commitSequence: 1,
          providerItemId: 'item_1',
          audioStartMs: 0,
          audioEndMs: 1500,
          transcript: 'Good morning everyone.',
          disposition: 'script',
        },
        {
          commitSequence: 2,
          transcript: 'hey cue pause',
          disposition: 'command',
        },
      ]),
    );
    await capture('list_sessions', () =>
      sessionRecords.listSessionRecords(PLACEHOLDER_SCRIPT_ID, 20),
    );
    await capture('list_sessions_bare', () => sessionRecords.listSessionRecords());
  });

  it('captures the settings and maintenance commands', async () => {
    await capture('get_settings', () => settings.getSettings());
    // Deliberately NO `speech` section (§153). The language and the recogniser
    // are one choice and are set through `select_speech_language`, which is
    // guarded on a running take and checks the model is actually installed —
    // neither of which this command can do. Rust now REFUSES an `audio.language`
    // patch, so capturing one here would pin a payload the backend rejects.
    // `optical` carries a panel's mirroring (#206), so the Rust replay proves
    // the per-panel map binds to the document's typed shape.
    await capture('update_settings', () =>
      settings.updateSettings(3, {
        privacy: { saveTranscript: '7d' } as never,
        teleprompter: { fixedSpeedWpm: 155 } as never,
        optical: {
          profiles: {},
          activeRig: {},
          panelMirror: { 'dsp-1': { horizontal: true, vertical: false } },
        },
      }),
    );
    await capture('select_speech_language', () =>
      speechModels.selectSpeechLanguage(3, 'en-US'),
    );
    await capture('clear_cache_logs', () => settings.clearCache('logs'));
    await capture('clear_cache_analysis', () => settings.clearCache('analysis'));
    await capture('app_version', () => settings.getAppVersion());
  });

  it('captures the stage commands', async () => {
    await capture('open_stage', () =>
      stage.openStage({ displayFingerprint: 'dsp-1', sessionId: PLACEHOLDER_SESSION_ID } as never),
    );
    await capture('close_stage', () => stage.closeStage(PLACEHOLDER_SESSION_ID));
    await capture('set_stage_fullscreen', () =>
      stage.setStageFullscreen(PLACEHOLDER_SESSION_ID, true),
    );
    // Single-window presentation's counterpart: this window becomes the
    // teleprompter and comes back. Both directions, because the payload is the
    // only thing that distinguishes them.
    await capture('set_control_presenting_on', () => controlWindow.enterPresentation());
    await capture('set_control_presenting_off', () => controlWindow.exitPresentation());
    await capture('get_stage_status', () => stage.getStageStatus());
    await capture('list_displays', () => stage.listDisplays());
    await capture('identify_displays', () => stage.identifyDisplays());
  });

  /**
   * Guard on the guard. A capture harness that silently records nothing would
   * make the Rust round-trip test iterate over an empty list and pass — the
   * classic vacuous source-scanning failure. These assertions fail loudly if
   * the harness stops working, independently of whether the fixture matches.
   */
  it('the harness captured the commands it exists to capture', () => {
    expect(captured.size).toBeGreaterThanOrEqual(30);

    // Every historically-broken payload must be present by name.
    for (const name of [
      'list_scripts_trash', // C3 — the `view` filter Rust discarded
      'list_scripts_all', // C7 — sort keys Rust never matched
      'save_script', // H1 — compare-and-swap revision
      'start_session', // §43.5 — the generation the stage never got
      'update_settings', // §36.2 — the retention mapping that was missing
      // Both directions of single-window presentation. Named rather than left
      // to the count above, which would still pass if both vanished.
      'set_control_presenting_on',
      'set_control_presenting_off',
    ]) {
      expect(captured.has(name), `${name} was not captured`).toBe(true);
    }

    // And every capture must actually name a command and carry a payload
    // object (or an explicit null for the no-argument commands).
    for (const [name, entry] of captured) {
      expect(entry.command, `${name} has no command name`).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(
        entry.args === null || (typeof entry.args === 'object' && entry.args !== null),
        `${name} recorded a non-object payload`,
      ).toBe(true);
    }
  });

  it('the committed fixture matches what the services send today', () => {
    const actual = {
      $comment:
        'GENERATED by tests/integration/ipc-payload-capture.test.ts — do not hand-edit. ' +
        'Regenerate with UPDATE_IPC_CAPTURE=1. src-tauri/tests/ipc_roundtrip_tests.rs ' +
        'replays these payloads through the real Tauri commands.',
      placeholders: { scriptId: PLACEHOLDER_SCRIPT_ID, sessionId: PLACEHOLDER_SESSION_ID },
      invocations: Object.fromEntries([...captured].sort(([a], [b]) => a.localeCompare(b))),
    };

    if (process.env.UPDATE_IPC_CAPTURE === '1') {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }

    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as typeof actual;
    expect(
      actual.invocations,
      'A control-window service changed the payload it sends. Regenerate with ' +
        'UPDATE_IPC_CAPTURE=1 and then run `cargo test --test ipc_roundtrip_tests` — ' +
        'that is the half that decides whether Rust can actually accept the new shape.',
    ).toEqual(committed.invocations);
  });
});

afterAll(() => {
  setInvokeForTesting(null);
});
