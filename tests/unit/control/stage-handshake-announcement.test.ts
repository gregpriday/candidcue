/**
 * The stage handshake's step 0, from the control/stage side.
 *
 * The defect: `open_stage` returns as soon as the window is built, control
 * published the session envelope milliseconds later, and a Tauri event is
 * delivered by evaluating JS in the target webview with no queue behind it — so
 * the envelope landed on a page that had not yet registered a listener and was
 * gone. The stage never hydrated and the start sequence died on its 12 s
 * timeout with "the stage did not finish preparing in time". On the default
 * sample script. Every time, under `tauri dev`.
 *
 * The Rust half of the fix (hold the envelope, replay it on announcement) is
 * covered by `src-tauri/tests/stage_handshake_tests.rs`, which reproduces the
 * race through the real command against a late-subscribing webview.
 *
 * This file covers the two halves Rust cannot see:
 *
 *  1. the stage actually announces itself, and announces it AFTER its
 *     subscriptions resolve — announcing first would reintroduce the same race
 *     one step earlier, and would look completely correct doing it;
 *  2. the timeout that remains says which step stalled.
 *
 * (1) is a source assertion for the same reason `take-pass-caller.test.ts` is:
 * the behaviour is correct whenever something invokes it, so what has to be
 * asserted is that the production path does — and here, that it does so in the
 * right order. A mounted-component test would prove the emit happens; only the
 * ordering makes it useful, and the ordering is a property of the source.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stageStalledMessage } from '../../../src/control/services/stage';
import { STAGE_EVENT } from '../../../src/shared/contracts';
import type { StageStatus } from '../../../src/shared/contracts';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/** Strip comments, so prose describing the fix can never satisfy a check. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const STAGE_APP = source('../../../src/stage/StageApp.svelte');

describe('the stage announces itself once it can receive events', () => {
  it('emits the announcement at all', () => {
    expect(
      /emitStageEvent<[^>]*>\(\s*STAGE_EVENT\.listening/.test(code(STAGE_APP)),
      'StageApp must emit stage://listening — without it Rust has nothing to ' +
        'answer, and an envelope that arrives early stays lost',
    ).toBe(true);
  });

  it('emits it after the subscriptions resolve, not before', () => {
    /*
     * The whole point. `subscribeStageEvent` is async (Tauri's `listen`
     * returns a promise), so announcing anywhere above the awaited
     * `Promise.all` would tell Rust the stage is reachable while it still is
     * not — the replay would then race the listener exactly as the original
     * publish did, and fail exactly as silently.
     */
    const body = code(STAGE_APP);
    const subscribed = body.indexOf('unsubs.push(...subs)');
    const announced = body.indexOf('STAGE_EVENT.listening');
    expect(subscribed, 'the subscription bookkeeping must still be there').toBeGreaterThan(-1);
    expect(announced, 'the announcement must still be there').toBeGreaterThan(-1);
    expect(
      announced,
      'stage://listening must be emitted after the subscriptions are live',
    ).toBeGreaterThan(subscribed);
  });

  it('does not announce when the component was disposed mid-mount', () => {
    // The early `return` after unsubscribing is what keeps a torn-down stage
    // from asking for a document it will never render.
    const body = code(STAGE_APP);
    const disposed = body.indexOf('subs.forEach((u) => u())');
    const announced = body.indexOf('STAGE_EVENT.listening');
    expect(disposed).toBeGreaterThan(-1);
    expect(body.slice(disposed, announced)).toMatch(/\breturn\b/);
  });

  it('guards the guard: the event name is still part of the contract', () => {
    expect(STAGE_EVENT.listening).toBe('stage://listening');
    expect(STAGE_APP.length).toBeGreaterThan(1000);
  });
});

describe('a stalled handshake says which step stalled', () => {
  const ready: StageStatus = {
    exists: true,
    visible: false,
    fullscreen: false,
    displayFingerprint: 'dsp-1',
    stageGeneration: 7,
    listening: true,
    hydrated: true,
    layoutReady: true,
    mediaHealthy: true,
  };

  it('names a stage window that is not there', () => {
    expect(stageStalledMessage({ ...ready, exists: false }, 7)).toMatch(/closed/i);
    // Never polled at all — the failure came before the first 400 ms tick.
    expect(stageStalledMessage(null, 7)).toMatch(/closed/i);
  });

  it('names a stage whose bundle never loaded', () => {
    const message = stageStalledMessage(
      { ...ready, listening: false, hydrated: false, layoutReady: false },
      7,
    );
    expect(message).toMatch(/never finished loading/i);
  });

  it('names a stage that never received the script', () => {
    const message = stageStalledMessage({ ...ready, hydrated: false, layoutReady: false }, 7);
    expect(message).toMatch(/never received the script/i);
  });

  it('gives each stalled step its own wording', () => {
    /*
     * These are four unrelated failures with four unrelated causes — the stage
     * window died, its bundle never loaded, its document never arrived, its
     * layout never settled — and the single "did not finish preparing in time"
     * covered all of them. That is why the shipped report had nothing in it to
     * act on. If any two of these collapse back together the distinction is
     * gone, whatever the strings happen to say.
     */
    const messages = [
      stageStalledMessage({ ...ready, exists: false }, 7),
      stageStalledMessage({ ...ready, listening: false, hydrated: false, layoutReady: false }, 7),
      stageStalledMessage({ ...ready, hydrated: false, layoutReady: false }, 7),
      stageStalledMessage({ ...ready, layoutReady: false }, 7),
    ];
    expect(new Set(messages).size).toBe(messages.length);
    expect(messages[3]).toMatch(/laying it out/i);
  });

  it('names a stage window that was replaced mid-handshake', () => {
    expect(stageStalledMessage({ ...ready, stageGeneration: 8 }, 7)).toMatch(/replaced/i);
  });

  it('falls back rather than claiming success when everything looks ready', () => {
    // Reachable: the poll can observe a ready stage in the same tick the
    // timeout fires. It must still read as a failure — this string is only
    // ever shown inside "Could not start the session. …".
    const message = stageStalledMessage(ready, 7);
    expect(message).toMatch(/did not finish preparing/i);
  });

  it('never returns an empty string, for any combination', () => {
    for (const exists of [true, false]) {
      for (const listening of [true, false]) {
        for (const hydrated of [true, false]) {
          for (const layoutReady of [true, false]) {
            for (const generation of [7, 8]) {
              const message = stageStalledMessage(
                {
                  ...ready,
                  exists,
                  listening,
                  hydrated,
                  layoutReady,
                  stageGeneration: generation,
                },
                7,
              );
              expect(message.length).toBeGreaterThan(10);
              expect(message.endsWith('.')).toBe(true);
            }
          }
        }
      }
    }
  });
});
