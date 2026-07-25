/**
 * The microphone test and a real take must ask the provider for the SAME thing.
 *
 * This is the third defect on this project shaped like "it works in the
 * diagnostic path and not in the real one", and it is by far the most expensive
 * shape, because the diagnostic is the thing you reach for to find out what is
 * wrong. It reports success, so you look somewhere else.
 *
 * The instance: `startTranscription()` in the microphone test passed no options,
 * so Rust applied its own defaults and it always worked. The take passed the
 * model from the persisted settings document, and on any installation upgraded
 * from the previous provider that document still said `gpt-realtime-whisper`.
 * Inworld answers `code 3, Unsupported model`; the take reconnected seven times
 * in twelve seconds and heard nothing, while the Test transcription button
 * beside it kept working perfectly.
 *
 * So the options are built in one function, and these tests are about that
 * function being the only builder there is — a source assertion, because "both
 * callers use it" is not a property any single behavioural test can observe.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_MODELS,
  sttSessionOptions,
} from '../../../src/control/services/stt/inworld';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/** Strip comments, so a mention in prose cannot satisfy a call-site check. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const PIPELINE = code(source('../../../src/control/services/voice-session.ts'));
const MIC_TEST = code(source('../../../src/control/services/voice-live.ts'));
const RUST = source('../../../src-tauri/src/inworld/mod.rs');

describe('one builder, both callers', () => {
  it('the take builds its options through sttSessionOptions', () => {
    expect(/sttSessionOptions\(/.test(PIPELINE)).toBe(true);
    expect(/startTranscription\(this\.sessionOptions\(\)\)/.test(PIPELINE)).toBe(true);
  });

  it('the microphone test builds its options through sttSessionOptions', () => {
    expect(/sttSessionOptions\(/.test(MIC_TEST)).toBe(true);
    expect(
      /startTranscription\(sttSessionOptions\(/.test(MIC_TEST),
      'the microphone test must not open a session on options of its own — that is ' +
        'exactly how it came to pass while every real take failed',
    ).toBe(true);
  });

  it('neither caller opens a session with no options at all', () => {
    // `startTranscription()` is the specific call that made the test vacuous:
    // it defers to Rust's defaults, which are always valid, so it can never
    // reproduce a configuration problem the take will hit.
    for (const [name, body] of [
      ['the take', PIPELINE],
      ['the microphone test', MIC_TEST],
    ] as const) {
      expect(
        /startTranscription\(\s*\)/.test(body),
        `${name} must not call startTranscription with no arguments`,
      ).toBe(false);
    }
  });
});

describe('what the builder will and will not forward', () => {
  it('passes a supported model through', () => {
    expect(sttSessionOptions({ transcriptionModel: 'inworld/inworld-stt-1' })).toEqual({
      modelId: 'inworld/inworld-stt-1',
    });
  });

  /*
   * The actual defect. A persisted value naming another provider's model must
   * be DROPPED, not forwarded: an absent field lets Rust apply a default it
   * knows is valid, where a stale one is a hard provider error mid-take.
   */
  it('drops a model this provider does not serve', () => {
    for (const stale of ['gpt-realtime-whisper', 'gpt-4o-transcribe', 'whisper-1', '']) {
      expect(sttSessionOptions({ transcriptionModel: stale }).modelId).toBeUndefined();
    }
  });

  it('survives an absent, null or partial settings object', () => {
    expect(sttSessionOptions(null)).toEqual({});
    expect(sttSessionOptions(undefined)).toEqual({});
    expect(sttSessionOptions({})).toEqual({});
    expect(sttSessionOptions({ language: 'en-GB' })).toEqual({ language: 'en-GB' });
  });

  it('trims, because a stored value with whitespace is still a real choice', () => {
    expect(sttSessionOptions({ transcriptionModel: '  inworld/inworld-stt-1  ' })).toEqual({
      modelId: 'inworld/inworld-stt-1',
    });
  });
});

describe('the two model lists agree', () => {
  /*
   * Rust is the authority and re-checks whatever arrives, so this duplicate
   * only stops a bad value being offered or sent. But a list that drifts is
   * worse than no list: the UI would offer a model the backend silently
   * replaces, and the setting would appear to do nothing.
   */
  it('the TypeScript list matches SUPPORTED_MODELS in Rust', () => {
    const declared = /pub const SUPPORTED_MODELS: &\[&str\] = &\[([^\]]*)\]/.exec(RUST);
    expect(declared, 'SUPPORTED_MODELS must exist in src-tauri/src/inworld/mod.rs').not.toBeNull();
    const rustModels = [...(declared?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(rustModels.length).toBeGreaterThan(0);
    expect([...SUPPORTED_MODELS].sort()).toEqual([...rustModels].sort());
  });

  it('the default Rust falls back to is one the UI would accept', () => {
    const fallback = /pub const DEFAULT_MODEL: &str = "([^"]+)"/.exec(RUST)?.[1];
    expect(fallback).toBeTruthy();
    expect(SUPPORTED_MODELS).toContain(fallback);
  });
});
