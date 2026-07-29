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
 * The service answered `Unsupported model`; the take reconnected seven times
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
  SPEECH_LANGUAGES,
  sttSessionOptions,
} from '../../../src/control/services/stt/session';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/** Strip comments, so a mention in prose cannot satisfy a call-site check. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const PIPELINE = code(source('../../../src/control/services/voice-session.ts'));
const MIC_TEST = code(source('../../../src/control/services/voice-live.ts'));
const RUST = source('../../../src-tauri/src/stt/mod.rs');

describe('one builder, both callers', () => {
  it('the take builds its options through sttSessionOptions', () => {
    /*
     * Asserted as two properties rather than one exact expression: the take
     * must derive its options from the shared builder, and it must hand THOSE
     * options to the provider. Pinning the literal call shape made this fail
     * the moment the value was hoisted into a local to be traced — a test that
     * breaks on a rename is a test people delete.
     */
    expect(/sttSessionOptions\(/.test(PIPELINE), 'no shared builder in the take').toBe(true);
    expect(
      /const options = this\.sessionOptions\(\)/.test(PIPELINE) ||
        /startTranscription\(this\.sessionOptions\(\)\)/.test(PIPELINE),
      'the take must derive its options from sessionOptions()',
    ).toBe(true);
    expect(
      /startTranscription\(\s*options\s*\)/.test(PIPELINE) ||
        /startTranscription\(this\.sessionOptions\(\)\)/.test(PIPELINE),
      'the options built must be the options sent',
    ).toBe(true);
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
  /*
   * There is no model to forward any more, which is why the defect above
   * cannot recur in that shape. The streaming endpoint takes no model
   * parameter, the field is gone from the settings document, and a persisted
   * name from any previous provider is dropped by serde before it can reach a
   * take. What remains forwardable is the locale and the script.
   */
  it('ignores a model name from any previous provider entirely', () => {
    for (const stale of ['gpt-realtime-whisper', 'inworld/inworld-stt-1', 'whisper-1']) {
      const built = sttSessionOptions({ transcriptionModel: stale } as never);
      expect(built).toEqual({});
      expect('modelId' in built).toBe(false);
    }
  });

  it('survives an absent, null or partial settings object', () => {
    expect(sttSessionOptions(null)).toEqual({});
    expect(sttSessionOptions(undefined)).toEqual({});
    expect(sttSessionOptions({})).toEqual({});
    expect(sttSessionOptions({ language: 'en-GB' })).toEqual({ language: 'en-GB' });
  });

  it('trims, because a stored value with whitespace is still a real choice', () => {
    expect(sttSessionOptions({ language: '  en-GB  ' })).toEqual({ language: 'en-GB' });
    // Whitespace-only is not a choice at all — it must fall back to Rust's
    // default rather than open a session on an empty language parameter.
    expect(sttSessionOptions({ language: '   ' })).toEqual({});
  });
});

describe('the script vocabulary the take offers the recogniser (§26)', () => {
  const tokens = [
    { surface: 'RustLight', line: 0, para: 0 },
    { surface: 'Games', line: 0, para: 0 },
  ];

  it('forwards the take’s spoken tokens, not a term list', () => {
    /*
     * The SCRIPT crosses the boundary, and Rust decides which of it is unusual.
     * Choosing here would be a second opinion about rare words living in
     * TypeScript, drifting from `cc_align`'s — the same failure the alignment
     * core keeps one stopword list to avoid.
     */
    expect(sttSessionOptions({}, tokens)).toEqual({ vocabulary: tokens });
  });

  it('omits the field entirely when there is nothing to say', () => {
    // The microphone test has no script. An empty array would be a config frame
    // that differs from the one every take before this feature sent, for no
    // gain — and the frame that differs is the frame that gets blamed.
    expect(sttSessionOptions({}, [])).toEqual({});
    expect(sttSessionOptions({}, null)).toEqual({});
    expect(sttSessionOptions({})).toEqual({});
  });

  it('the take passes a vocabulary and the microphone test does not', () => {
    expect(
      /sttSessionOptions\([\s\S]{0,400}?this\.vocabularyTokens/.test(PIPELINE),
      'the take must offer its compiled script to the builder',
    ).toBe(true);
    expect(
      /alignTokensFor\(this\.deps\.compiled\)/.test(PIPELINE),
      'the tokens must be the same ones the aligner compiles, not a second projection',
    ).toBe(true);
    expect(
      /sttSessionOptions\([^)]*,/.test(MIC_TEST),
      'the microphone test has no script and must not invent one',
    ).toBe(false);
  });
});

describe('the locale the picker offers is one the wire will accept', () => {
  /*
   * Two forms of the same setting, in two languages, and only one of them is
   * legal on the wire: the picker stores BCP-47 (`en-US`) because that is what
   * a presenter recognises, and the provider takes only a primary subtag
   * (`en`). Rust narrows it at the moment the URL is built.
   *
   * The failure this guards is the quiet one. An unknown query parameter is
   * IGNORED rather than rejected, so a regional tag reaching the wire does not
   * fail the session — it runs it on the service's own default language, and
   * nothing anywhere reports that the choice was discarded.
   */
  it('every language the UI offers narrows to a bare subtag', () => {
    expect(SPEECH_LANGUAGES.length).toBeGreaterThan(0);
    for (const { value } of SPEECH_LANGUAGES) {
      const narrowed = value.split('-')[0];
      expect(narrowed, `${value} must have a primary subtag`).toBeTruthy();
      expect(narrowed).toMatch(/^[a-z]{2}$/);
    }
  });

  it('the UI default and the Rust default are the same choice', () => {
    const tag = /pub const DEFAULT_LANGUAGE_TAG: &str = "([^"]+)"/.exec(RUST)?.[1];
    const wire = /pub const DEFAULT_LANGUAGE: &str = "([^"]+)"/.exec(RUST)?.[1];
    expect(tag, 'DEFAULT_LANGUAGE_TAG must exist in src-tauri/src/stt/mod.rs').toBeTruthy();
    expect(wire, 'DEFAULT_LANGUAGE must exist in src-tauri/src/stt/mod.rs').toBeTruthy();
    // The stored default must be offered by the picker, and must narrow to the
    // wire default. Either half drifting is a session that silently runs on a
    // language nobody chose.
    expect(SPEECH_LANGUAGES.map((l) => l.value)).toContain(tag);
    expect(tag?.split('-')[0]).toBe(wire);
  });
});
