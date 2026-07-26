/**
 * The alignment driver — control's seam onto the Rust engine.
 *
 * What is worth asserting here is small, because the driver is small: the
 * engine lives in Rust and control neither aligns nor tokenizes. What control
 * still owns is the LIFECYCLE — which script is handed over, when snapshots are
 * allowed to move the UI, and which token an explicit navigation lands on — and
 * every one of those has been a source of a silent, take-losing bug.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compile } from '../../../src/shared/markdown';
import { setInvokeForTesting } from '../../../src/control/services/ipc';
import { createTrackingDriver } from '../../../src/control/services/session';
import { alignTokensFor } from '../../../src/control/services/alignment';
import type { AlignmentSnapshot } from '../../../src/shared/contracts';

const SOURCE = `# One

First paragraph sentence here. Another sentence in the same block.

Second paragraph sentence follows afterwards.
`;

interface Call {
  command: string;
  args: Record<string, unknown> | undefined;
}

function makeDriver() {
  const compiled = compile(SOURCE, { scriptId: 'script-1' });
  const calls: Call[] = [];
  setInvokeForTesting(async (command, args) => {
    calls.push({ command, args });
    return undefined as never;
  });
  const snapshots: AlignmentSnapshot[] = [];
  const driver = createTrackingDriver({
    sessionId: 'session-1',
    scriptId: 'script-1',
    sentences: compiled.sentences,
    totalTokens: compiled.spokenTokens.length,
    compiled,
    sessionGeneration: 7,
    onSnapshot: (s) => snapshots.push(s),
    onTranscript: () => {},
  });
  return { compiled, calls, driver, snapshots };
}

afterEach(() => {
  setInvokeForTesting(null);
  vi.restoreAllMocks();
});

describe('alignment driver', () => {
  it('hands Rust the compiled script under the transcription generation', async () => {
    const { compiled, calls, driver } = makeDriver();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));

    const start = calls.find((c) => c.command === 'start_alignment');
    expect(start, 'the driver never started an alignment session').toBeDefined();
    // The generation pairs alignment with the socket that feeds it; Rust drops
    // any transcript frame stamped with a different one.
    expect(start?.args?.generation).toBe(7);
    const tokens = start?.args?.tokens as Array<{ surface: string }>;
    expect(tokens).toHaveLength(compiled.spokenTokens.length);
    driver.dispose();
  });

  /*
   * The ORDER and COUNT of the token list is the whole contract: every snapshot
   * position is a fractional index into it, and the stage resolves those
   * indexes through geometry it measured for `spokenTokens`. A token filtered
   * out here shifts every position after it, silently.
   */
  it('sends the spoken tokens verbatim, in order, unsplit', () => {
    const compiled = compile('We raised $12 million in a well-known round.', {
      scriptId: 'script-1',
    });
    const tokens = alignTokensFor(compiled);
    expect(tokens.map((t) => t.surface)).toEqual(
      compiled.spokenTokens.map((t) => t.surface),
    );
    // `$12` and `well-known` cross as authored. The engine decides they are two
    // spoken words each; splitting here would make this a second tokenizer.
    expect(tokens.map((t) => t.surface)).toContain('$12');
    expect(tokens.map((t) => t.surface)).toContain('well-known');
  });

  /*
   * §9.1: hold position until the user explicitly starts prompting. The engine
   * has no pause — it is a pure function of the frames it is given — so the
   * gate is here, and a snapshot arriving before `start()` must not move
   * anything.
   */
  it('ignores snapshots until prompting starts', () => {
    const { driver, snapshots } = makeDriver();
    expect(snapshots).toHaveLength(0);
    driver.start();
    expect(snapshots).toHaveLength(0);
    driver.dispose();
  });

  it('moves by sentence and paragraph onto a real token index', async () => {
    const { compiled, calls, driver } = makeDriver();
    driver.start();

    driver.moveSentences(1);
    await vi.waitFor(() =>
      expect(calls.some((c) => c.command === 'set_alignment_position')).toBe(true),
    );
    const move = calls.filter((c) => c.command === 'set_alignment_position').at(-1);
    const target = move?.args?.token as number;
    expect(Number.isFinite(target)).toBe(true);
    expect(
      compiled.sentences.some((s) => s.startTokenIndex === target),
      'a sentence move must land on a sentence boundary',
    ).toBe(true);
    driver.dispose();
  });

  it('stops the alignment session on dispose', async () => {
    const { calls, driver } = makeDriver();
    driver.dispose();
    await vi.waitFor(() => expect(calls.some((c) => c.command === 'stop_alignment')).toBe(true));
  });

  it('falls back to the mock driver when there is no compiled script', () => {
    const snapshots: AlignmentSnapshot[] = [];
    const driver = createTrackingDriver({
      sessionId: 'session-1',
      scriptId: 'script-1',
      sentences: [],
      totalTokens: 40,
      compiled: null,
      onSnapshot: (s) => snapshots.push(s),
      onTranscript: () => {},
    });
    driver.start();
    // The mock emits a contract-correct snapshot immediately, so the Live
    // screen stays exercisable with no Rust and no microphone.
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]?.state).toBe('following');
    driver.dispose();
  });
});
