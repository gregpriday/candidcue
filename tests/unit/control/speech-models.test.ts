/**
 * The control window's half of the speech-model install (#152).
 *
 * The recogniser is downloaded after installation rather than bundled, which
 * means a screen now has to render a multi-step, cancellable, resumable
 * process. Everything the UI decides from — is it busy, how far through, what
 * do we call this phase — is a pure function here so it can be pinned without
 * a webview.
 *
 * The command names and payload keys are asserted literally. A typo in either
 * is invisible at runtime: Tauri answers "Command not found", `invokeOrMock`
 * treats that like any other failure, and in browser dev the mock answers
 * instead — so the screen works in `pnpm dev` and does nothing in a packaged
 * build.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setInvokeForTesting } from '../../../src/control/services/ipc';
import {
  canDownload,
  canRemove,
  cancelSpeechModelDownload,
  deleteSpeechModel,
  formatBytes,
  getSpeechModelStatus,
  isBusy,
  phaseLabel,
  progressFraction,
  startSpeechModelDownload,
  SPEECH_MODEL_PROGRESS_EVENT,
  type SpeechModelPhase,
  type SpeechModelStatus,
} from '../../../src/control/services/speech-models';

function statusFixture(overrides: Partial<SpeechModelStatus> = {}): SpeechModelStatus {
  return {
    modelId: 'x-asr-480ms',
    modelName: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    languages: ['en', 'zh'],
    phase: 'notInstalled',
    source: null,
    installed: false,
    supported: true,
    downloadBytes: 133_895_136,
    installedBytes: 169_347_218,
    progressBytes: 0,
    progressTotal: 0,
    operationId: null,
    error: null,
    ...overrides,
  };
}

afterEach(() => setInvokeForTesting(null));

describe('speech model IPC', () => {
  it('calls the exact command names Rust registers, with camelCase payloads', async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    setInvokeForTesting(async (command, args) => {
      calls.push({ command, args });
      return statusFixture() as never;
    });

    await getSpeechModelStatus();
    await startSpeechModelDownload('x-asr-480ms');
    await cancelSpeechModelDownload('x-asr-480ms');
    await deleteSpeechModel('x-asr-480ms');

    expect(calls.map((c) => c.command)).toEqual([
      'get_speech_model_status',
      'start_speech_model_download',
      'cancel_speech_model_download',
      'delete_speech_model',
    ]);
    // `modelId`, not `model_id`: Tauri camelCases argument names.
    expect(calls[1]?.args).toEqual({ modelId: 'x-asr-480ms' });
  });

  /**
   * There is one model worth naming today, and the catalogue owns its id.
   * Sending `undefined` lets Rust fall back to its own default rather than
   * putting a catalogue string into the frontend where it can go stale.
   */
  it('omits the model id so Rust applies the catalogue default', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    setInvokeForTesting(async (_command, args) => {
      calls.push(args);
      return statusFixture() as never;
    });

    await getSpeechModelStatus();

    expect(calls[0]).toEqual({ modelId: undefined });
  });

  it('propagates a backend failure rather than falling back to the mock', async () => {
    setInvokeForTesting(async () => {
      throw new Error('STT_MODEL_BUSY');
    });
    await expect(startSpeechModelDownload()).rejects.toThrow('STT_MODEL_BUSY');
  });

  it('names the progress event Rust actually emits', () => {
    // Mirrored verbatim in src-tauri/src/windows/mod.rs::events. Keep the
    // literal grep-able on both sides.
    expect(SPEECH_MODEL_PROGRESS_EVENT).toBe('speech://model-progress');
  });
});

describe('install phases', () => {
  const busy: SpeechModelPhase[] = [
    'downloading',
    'verifyingArchive',
    'extracting',
    'verifyingFiles',
    'installing',
    'validating',
  ];
  const idle: SpeechModelPhase[] = ['notInstalled', 'installed', 'failed'];

  it('treats every in-flight phase as busy', () => {
    for (const phase of busy) {
      expect(isBusy(statusFixture({ phase })), phase).toBe(true);
    }
  });

  it('treats settled phases as not busy', () => {
    for (const phase of idle) {
      expect(isBusy(statusFixture({ phase })), phase).toBe(false);
    }
    expect(isBusy(null)).toBe(false);
  });

  /**
   * Downloading reaching 100% and then appearing to hang for the length of a
   * SHA-256 over 128 MB and a bz2 decompression is the most confusing thing
   * this process can do. Each slow step gets its own name.
   */
  it('gives every phase a distinct label', () => {
    const labels = [...busy, ...idle].map((phase) => phaseLabel(statusFixture({ phase })));
    expect(new Set(labels).size).toBe(labels.length);
    expect(phaseLabel(statusFixture({ phase: 'verifyingArchive' }))).not.toBe(
      phaseLabel(statusFixture({ phase: 'downloading' })),
    );
  });
});

describe('progress fraction', () => {
  it('reports a fraction while bytes are moving', () => {
    expect(
      progressFraction(
        statusFixture({ phase: 'downloading', progressBytes: 50, progressTotal: 200 }),
      ),
    ).toBeCloseTo(0.25);
  });

  /**
   * Null, not zero. `installing` and `validating` measure nothing, and a bar
   * snapping back to empty at the very end reads as "it failed and restarted"
   * — the opposite of what happened.
   *
   * The totals here are the ones RUST ACTUALLY EMITS: `Validating(0, 1)`,
   * `Installing(0, 1)`, `Validating(1, 1)`. An earlier version of this test
   * left `progressTotal: 0` from the fixture, which made it pass against an
   * implementation that gated on `progressTotal > 0` and therefore rendered
   * exactly the reset the test claimed to forbid.
   */
  it('is null for phases that have nothing to measure', () => {
    for (const [phase, bytes, total] of [
      ['validating', 0, 1],
      ['installing', 0, 1],
      ['validating', 1, 1],
    ] as const) {
      expect(
        progressFraction(
          statusFixture({ phase, progressBytes: bytes, progressTotal: total }),
        ),
        `${phase} ${bytes}/${total}`,
      ).toBeNull();
    }
  });

  /** The measured phases still report, so the bar moves where it should. */
  it('reports a fraction for every byte-measured phase', () => {
    for (const phase of [
      'downloading',
      'verifyingArchive',
      'extracting',
      'verifyingFiles',
    ] as const) {
      expect(
        progressFraction(
          statusFixture({ phase, progressBytes: 25, progressTotal: 100 }),
        ),
        phase,
      ).toBeCloseTo(0.25);
    }
  });

  it('is null when nothing is happening', () => {
    expect(progressFraction(null)).toBeNull();
    expect(progressFraction(statusFixture({ phase: 'installed' }))).toBeNull();
  });

  /** A lying total must not paint a bar past its end. */
  it('never exceeds one', () => {
    expect(
      progressFraction(
        statusFixture({ phase: 'downloading', progressBytes: 500, progressTotal: 200 }),
      ),
    ).toBe(1);
  });
});

describe('byte formatting', () => {
  it('reads as a size a person would say out loud', () => {
    expect(formatBytes(133_895_136)).toBe('128 MB');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });
});

describe('what the screen offers', () => {
  /**
   * Only a real download is removable, and this is the rule both routes read.
   *
   * `bundled` lives inside the app bundle and is not ours to delete.
   * `override` is `CANDIDCUE_MODELS_DIR`; Remove would delete an app-data copy
   * the user cannot see while the override stayed installed — a button that
   * appears to do nothing. An earlier version tested `source !== 'bundled'`,
   * which offered Remove for an override.
   */
  it('offers removal only for a model this machine downloaded', () => {
    const cases: Array<[SpeechModelStatus['source'], boolean]> = [
      ['downloaded', true],
      ['bundled', false],
      ['override', false],
      [null, false],
    ];
    for (const [source, removable] of cases) {
      const status = statusFixture({ phase: 'installed', installed: true, source });
      expect(canRemove(status), `${source}`).toBe(removable);
    }
  });

  /** A model still installing is not removable however it got there. */
  it('never offers removal mid-install', () => {
    expect(
      canRemove(statusFixture({ phase: 'extracting', installed: true, source: 'downloaded' })),
    ).toBe(false);
  });

  /**
   * A catalogue entry with no compiled tuning is downloadable and not usable.
   * Offering Download for it would be a button that can only ever fail.
   */
  it('does not offer a download for a model this build cannot load', () => {
    expect(canDownload(statusFixture({ supported: false }))).toBe(false);
    expect(canDownload(statusFixture({ supported: true }))).toBe(true);
    expect(
      canDownload(statusFixture({ phase: 'downloading', supported: true })),
      'already running',
    ).toBe(false);
    expect(
      canDownload(statusFixture({ phase: 'installed', installed: true, supported: true })),
      'already installed',
    ).toBe(false);
  });
});

describe('progress subscription', () => {
  it('is a no-op outside Tauri so callers can always unsubscribe', async () => {
    vi.resetModules();
    const { onSpeechModelProgress } = await import(
      '../../../src/control/services/speech-models'
    );
    const stop = await onSpeechModelProgress(() => {});
    expect(typeof stop).toBe('function');
    // Must not throw: a screen unmounting in browser dev still cleans up.
    stop();
  });
});
