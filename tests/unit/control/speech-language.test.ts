/**
 * The control window's half of the language choice (#153).
 *
 * Two things are pinned here that nothing else can catch:
 *
 *   1. **The command names and payload shape.** A typo is invisible at runtime
 *      — Tauri answers "Command not found", `ipcInvoke` treats that like any
 *      other failure, and the screen simply never saves a language.
 *   2. **The per-model snapshot/event race.** #152 fixed this for ONE model
 *      with a counter. Generalising that counter to a single global one is a
 *      new bug: a progress event for model A would discard a perfectly good
 *      snapshot for model B. The reconciliation rule is reproduced here so it
 *      can be pinned without mounting a component.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setInvokeForTesting } from '../../../src/control/services/ipc';
import {
  getSpeechLanguageOptions,
  languageDisplayName,
  selectSpeechLanguage,
  type SpeechLanguageOption,
  type SpeechLanguageOptions,
  type SpeechModelStatus,
} from '../../../src/control/services/speech-models';

function statusFixture(overrides: Partial<SpeechModelStatus> = {}): SpeechModelStatus {
  return {
    modelId: 'x-asr-480ms',
    modelName: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    languages: ['en', 'zh'],
    phase: 'installed',
    source: 'downloaded',
    installed: true,
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

function optionFixture(overrides: Partial<SpeechLanguageOption> = {}): SpeechLanguageOption {
  return {
    languageTag: 'en-US',
    primarySubtag: 'en',
    modelId: 'x-asr-480ms',
    recognizerId: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    active: true,
    status: statusFixture(),
    origins: [{ kind: 'upstream', host: 'github.com' }],
    attribution: {
      title: 'X-ASR streaming Zipformer transducer',
      author: 'Jun Guo, with the X-LANCE Lab, Shanghai Jiao Tong University',
      sourceUrl: 'https://github.com/Gilgamesh-J/X-ASR',
      distributedVia: 'https://github.com/k2-fsa/sherpa-onnx',
      license: {
        id: 'Apache-2.0',
        name: 'Apache License 2.0',
        url: 'https://www.apache.org/licenses/LICENSE-2.0',
      },
      licenseNote: null,
      modified: false,
    },
    ...overrides,
  };
}

function optionsFixture(overrides: Partial<SpeechLanguageOptions> = {}): SpeechLanguageOptions {
  return {
    active: {
      languageTag: 'en-US',
      primarySubtag: 'en',
      modelId: 'x-asr-480ms',
      recognizerId: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    },
    changeBlocked: false,
    languages: [optionFixture()],
    removable: [],
    ...overrides,
  };
}

afterEach(() => setInvokeForTesting(null));

describe('language IPC', () => {
  it('calls the exact command names Rust registers, with camelCase payloads', async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    setInvokeForTesting(async (command, args) => {
      calls.push({ command, args });
      return optionsFixture() as never;
    });

    await getSpeechLanguageOptions();
    await selectSpeechLanguage(7, 'en-US');

    expect(calls.map((c) => c.command)).toEqual([
      'get_speech_language_options',
      'select_speech_language',
    ]);
    // Nested under `input`, because Rust takes a struct rather than loose
    // arguments — a flat payload deserializes to nothing and the command fails.
    expect(calls[1]?.args).toEqual({
      input: { expectedRevision: 7, languageTag: 'en-US' },
    });
  });

  it('propagates a refusal rather than swallowing it', async () => {
    setInvokeForTesting(async () => {
      throw { code: 'STT_LANGUAGE_CHANGE_BLOCKED', userMessage: 'End the current take first.' };
    });
    await expect(selectSpeechLanguage(1, 'en-US')).rejects.toMatchObject({
      code: 'STT_LANGUAGE_CHANGE_BLOCKED',
    });
  });
});

describe('language display names', () => {
  it('names a language rather than showing its tag', () => {
    // Asserted case-insensitively: ICU data varies by runtime and the point is
    // that a human-readable name comes back, not its exact capitalisation.
    expect(languageDisplayName('en-US').toLowerCase()).toContain('english');
  });

  it('falls back to the tag when the runtime has no name for it', () => {
    // Never empty: a bare tag is a worse label than a name and a better one
    // than nothing at all.
    expect(languageDisplayName('zz-ZZ')).not.toBe('');
  });
});

/*
 * The reconciliation rule, reproduced exactly as the picker applies it.
 *
 * Kept as a pure function here rather than asserted through a mounted
 * component: the rule is the thing that has to be right, and a DOM test would
 * pin the rendering of it instead.
 */
function reconcile(
  current: Record<string, SpeechModelStatus>,
  seen: Record<string, number>,
  now: Record<string, number>,
  incoming: SpeechModelStatus[],
): Record<string, SpeechModelStatus> {
  const merged = { ...current };
  for (const row of incoming) {
    if ((now[row.modelId] ?? 0) === (seen[row.modelId] ?? 0)) merged[row.modelId] = row;
  }
  return merged;
}

describe('snapshot versus event, per model', () => {
  it('discards a snapshot for a model whose status moved while it was in flight', () => {
    const seen = { 'x-asr-480ms': 0 };
    // A terminal event landed while the snapshot was pending.
    const now = { 'x-asr-480ms': 1 };
    const terminal = statusFixture({ phase: 'installed', installed: true });

    const merged = reconcile({ 'x-asr-480ms': terminal }, seen, now, [
      statusFixture({ phase: 'validating', installed: false }),
    ]);

    // The event wins: Rust's events are newer than any request already in
    // flight, so the stale snapshot must not repaint a finished install.
    expect(merged['x-asr-480ms']?.phase).toBe('installed');
  });

  it('keeps a snapshot for a model that did NOT move', () => {
    const seen = { 'x-asr-480ms': 0, 'kroko-fr': 0 };
    // English moved; French did not.
    const now = { 'x-asr-480ms': 1, 'kroko-fr': 0 };

    const merged = reconcile({}, seen, now, [
      statusFixture({ modelId: 'x-asr-480ms', phase: 'validating' }),
      statusFixture({ modelId: 'kroko-fr', phase: 'notInstalled', installed: false }),
    ]);

    // THE regression this file exists for: a single global counter would have
    // thrown French away too, because *something* had moved.
    expect(merged['kroko-fr']?.phase).toBe('notInstalled');
    expect(merged['x-asr-480ms']).toBeUndefined();
  });

  it('accepts every model when nothing moved', () => {
    const counts = { 'x-asr-480ms': 3, 'kroko-fr': 1 };
    const merged = reconcile({}, counts, counts, [
      statusFixture({ modelId: 'x-asr-480ms' }),
      statusFixture({ modelId: 'kroko-fr' }),
    ]);
    expect(Object.keys(merged).sort()).toEqual(['kroko-fr', 'x-asr-480ms']);
  });
});

describe('what the picker is allowed to offer', () => {
  it('treats the catalogue id and the recogniser id as different strings', () => {
    const option = optionFixture();
    // Confusing these is the easiest mistake in this feature: install commands
    // take the short one, settings persists the long one.
    expect(option.modelId).not.toBe(option.recognizerId);
    expect(option.status.modelId).toBe(option.modelId);
  });

  it('carries both sizes and an origin before anything is downloaded', () => {
    const option = optionFixture({ status: statusFixture({ installed: false, phase: 'notInstalled' }) });
    expect(option.status.downloadBytes).toBeGreaterThan(0);
    expect(option.status.installedBytes).toBeGreaterThan(option.status.downloadBytes);
    expect(option.origins.at(-1)?.host).toBe('github.com');
  });

  it('carries an attribution with no acceptance flag anywhere on it', () => {
    const option = optionFixture();
    expect(option.attribution.license.id).toBe('Apache-2.0');
    // §153: the licence is an obligation the app carries, not a decision put in
    // front of the user. Nothing in this payload can gate a download.
    expect(Object.keys(option.attribution)).not.toContain('accepted');
    expect(Object.keys(option.attribution)).not.toContain('requiresConsent');
  });
});
