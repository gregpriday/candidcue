/**
 * Headless end-to-end of the loop that actually broke: control → Rust → stage.
 *
 * On the §55.8 WebDriver suite, see the note at the bottom of this file. This
 * is the strongest approximation that runs on macOS today, and it covers the
 * specific hop nobody was covering.
 *
 * The hop
 * ---------------------------------------------------------------------------
 * `tests/unit/control/session-live-wiring.test.ts` proves the control store
 * calls `publishStageSnapshot` with the generation Rust assigned.
 * `src-tauri/tests/session_lifecycle_tests.rs` proves that a well-formed
 * snapshot reaches the stage webview. Between them sits
 * `windows::validate_stage_payload_header`, which INSPECTS the payload and
 * silently drops anything whose header it does not like — and it was that drop,
 * on every single snapshot, that left the script hydrated and motionless in a
 * packaged build.
 *
 * Neither side could see it. The control test asserts against a mocked service
 * and never produces a real payload; the Rust test feeds a hand-written fixture
 * that was correct by construction. So this file runs the REAL control-side
 * session store, through the REAL stage service, and writes down the actual
 * bytes of every `publish_stage_snapshot` invocation. `src-tauri/tests/
 * ipc_roundtrip_tests.rs::the_captured_stage_snapshots_pass_rusts_header_gate`
 * then feeds those bytes to the real validator.
 *
 * Regenerate with:
 *   UPDATE_STAGE_CAPTURE=1 ./node_modules/.bin/vitest run tests/e2e/stage-publish-contract.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setInvokeForTesting } from '../../src/control/services/ipc';
import { startLiveSession, startPrompting, stopSession } from '../../src/control/stores/session';
import type { SentenceUnit } from '../../src/shared/contracts';

const ROOT = resolve(__dirname, '../..');
const FIXTURE = join(ROOT, 'tests/fixtures/ipc/stage-publish-capture.json');

/** The generations Rust would have assigned. Deliberately NOT 1 — a hard-coded
 * `1` on the control side is the exact defect, and 1 is the one value that
 * would let it pass unnoticed. */
const SESSION_GENERATION = 7;
const STAGE_GENERATION = 4;
const SESSION_ID = '3d1c9f2a-8b64-4a17-9d0e-5c2f7a1b3e40';

function sentences(): SentenceUnit[] {
  return [
    {
      id: 's1',
      blockId: 'b1',
      startTokenIndex: 0,
      endTokenIndex: 5,
      normalizedText: 'good morning everyone',
    },
    {
      id: 's2',
      blockId: 'b1',
      startTokenIndex: 6,
      endTokenIndex: 12,
      normalizedText: 'thank you for coming',
    },
    {
      id: 's3',
      blockId: 'b2',
      startTokenIndex: 13,
      endTokenIndex: 20,
      normalizedText: 'let us begin',
    },
  ] as SentenceUnit[];
}

interface Invocation {
  command: string;
  args: Record<string, unknown>;
}

let recorded: Invocation[] = [];

beforeEach(() => {
  recorded = [];
  setInvokeForTesting(async <T,>(command: string, args?: Record<string, unknown>) => {
    recorded.push({ command, args: structuredClone(args ?? {}) });
    return undefined as T;
  });
});

afterEach(() => {
  stopSession();
  setInvokeForTesting(null);
});

function snapshotPayloads(): Array<Record<string, unknown>> {
  return recorded
    .filter((entry) => entry.command === 'publish_stage_snapshot')
    .map((entry) => entry.args.snapshot as Record<string, unknown>);
}

function runSession(overrides: Partial<Parameters<typeof startLiveSession>[0]> = {}): void {
  startLiveSession({
    scriptId: 'script-e2e',
    scriptTitle: 'Headless keynote',
    mode: 'manual',
    displayLabel: 'Teleprompter Display',
    outline: [],
    sentences: sentences(),
    totalTokens: 21,
    sessionId: SESSION_ID,
    sessionGeneration: SESSION_GENERATION,
    stageGeneration: STAGE_GENERATION,
    ...overrides,
  });
  startPrompting();
}

describe('control → Rust stage publish contract', () => {
  it('publishes at all — the failure mode was total silence', () => {
    runSession();
    expect(
      snapshotPayloads().length,
      'starting a take must relay at least one tracking snapshot; zero here is the ' +
        'shipped bug (the script hydrates and then never moves)',
    ).toBeGreaterThan(0);
  });

  it('every payload carries the header fields Rust gates on', () => {
    runSession();
    for (const snapshot of snapshotPayloads()) {
      // These four are exactly what `validate_stage_payload_header` reads.
      // A missing one is not a type error anywhere — it is a silent drop.
      expect(snapshot.schemaVersion).toBe(1);
      expect(snapshot.sessionId).toBe(SESSION_ID);
      expect(snapshot.stageGeneration).toBe(STAGE_GENERATION);
      expect(snapshot.sessionGeneration).toBe(SESSION_GENERATION);
    }
  });

  it('adopts the generations it was given rather than assuming 1', () => {
    runSession();
    const [first] = snapshotPayloads();
    expect(first).toBeDefined();
    expect(
      first?.sessionGeneration,
      'a hard-coded 1 here is the C1 defect: the coordinator had assigned ' +
        `${SESSION_GENERATION}, so Rust drops every snapshot and the UI still reports ` +
        'a healthy session',
    ).toBe(SESSION_GENERATION);
    expect(first?.stageGeneration).toBe(STAGE_GENERATION);
  });

  it('publishes nothing when no stage generation has been handed down', () => {
    // Generation 0 means "no stage". Publishing under it would be a payload
    // Rust must reject, which is worse than not publishing.
    runSession({ stageGeneration: 0 });
    expect(snapshotPayloads()).toEqual([]);
  });

  it('addresses the command to the same session it stamps inside the payload', () => {
    runSession();
    for (const entry of recorded.filter((e) => e.command === 'publish_stage_snapshot')) {
      const snapshot = entry.args.snapshot as Record<string, unknown>;
      expect(
        entry.args.sessionId,
        'Rust compares the command argument against the payload header; a mismatch ' +
          'is an outright error, not a drop',
      ).toBe(snapshot.sessionId);
    }
  });

  it('writes the captured payloads for the Rust validator to consume', () => {
    runSession();
    const payloads = snapshotPayloads();
    expect(payloads.length).toBeGreaterThan(0);

    const actual = {
      $comment:
        'GENERATED by tests/e2e/stage-publish-contract.test.ts — do not hand-edit. ' +
        'Regenerate with UPDATE_STAGE_CAPTURE=1. Consumed by ' +
        'src-tauri/tests/ipc_roundtrip_tests.rs.',
      sessionId: SESSION_ID,
      sessionGeneration: SESSION_GENERATION,
      stageGeneration: STAGE_GENERATION,
      // Timestamps and confidences wobble per run; only the header is a
      // contract, so the fixture keeps one representative payload plus the
      // headers of the rest.
      snapshot: stripVolatile(payloads[0] as Record<string, unknown>),
      headers: payloads.map((p) => ({
        schemaVersion: p.schemaVersion,
        sessionId: p.sessionId,
        stageGeneration: p.stageGeneration,
        sessionGeneration: p.sessionGeneration,
      })),
    };

    if (process.env.UPDATE_STAGE_CAPTURE === '1') {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }

    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as typeof actual;
    expect(
      Object.keys(actual.snapshot).sort(),
      'the published snapshot gained or lost a field. Regenerate with ' +
        'UPDATE_STAGE_CAPTURE=1, then run `cargo test --test ipc_roundtrip_tests`.',
    ).toEqual(Object.keys(committed.snapshot).sort());
    expect(actual.snapshot.schemaVersion).toEqual(committed.snapshot.schemaVersion);
    expect(actual.sessionGeneration).toEqual(committed.sessionGeneration);
    expect(actual.stageGeneration).toEqual(committed.stageGeneration);
  });
});

/** Drop the fields that legitimately differ every run. */
function stripVolatile(snapshot: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    out[key] = key === 'generatedAtMs' ? 0 : key === 'confidence' ? 0.9 : value;
  }
  return out;
}

/*
 * ---------------------------------------------------------------------------
 * Why there is no WebDriverIO + tauri-driver suite here (spec §55.8)
 * ---------------------------------------------------------------------------
 * `tauri-driver` supports Linux (WebKitWebDriver) and Windows (msedgedriver)
 * only. macOS ships WKWebView, for which Apple provides no WebDriver — Tauri's
 * own documentation says so, and tauri-apps/tauri#7068 has tracked it since
 * 2023 without a native fix. This is a development machine running macOS with
 * no CI, so a §55.8 suite would not run anywhere.
 *
 * The two workarounds both cost more than they return right now:
 *   - `@wdio/tauri-service` runs an embedded WebDriver server INSIDE the app
 *     binary. That is a debug-only HTTP control surface compiled into a
 *     product whose entire threat model (§43.2, §50.2) is about minimising
 *     what can reach the command layer. It is a decision for the owner, not a
 *     test-infrastructure change.
 *   - CrabNebula's cross-platform tauri-driver fork needs a paid API key for
 *     macOS.
 * And the app opens two windows, the second of which is borderless,
 * always-on-top and sized to a second monitor — which on a single-display dev
 * machine means the suite would be fighting the runner for the screen.
 *
 * A flaky suite nobody trusts is worse than an honest gap, so the gap is
 * recorded here instead. Revisit when (a) CI exists on Linux, where
 * `tauri-driver` works today, or (b) the owner decides the embedded-driver
 * trade-off is acceptable.
 */
