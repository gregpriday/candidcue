/**
 * B3: the outbound Luna coach request identified the wrong thing.
 *
 * `CoachingSessionController` built its host state with
 * `initialHostState(deps.sessionId, deps.takePassId)` — and that function's
 * first parameter is `scriptId`. So `CoachingHostState.scriptId` held the
 * SESSION id, `scriptRevision` never moved off its initial `0`, and the
 * orchestrator copied both straight into every `LunaCoachRequest`
 * (`buildRequestInput`: `scriptId: this.host.scriptId`).
 *
 * It survived because nothing on this side reads either field: the local lanes
 * key off `sessionId`, `trackingEpoch` and `takePassId`. They are read on the
 * WIRE, where a request that names the session as its script cannot be
 * correlated with the script it is about, and where a revision of 0 defeats the
 * §22 staleness comparison the review lane makes
 * (`shared/coaching/review/script-annotations.ts` compares a report's
 * `scriptRevision` against the script's own).
 *
 * The assertion is on the real outbound request, not on the host state: the
 * host state is an implementation detail, and the field that shipped wrong is
 * the one that leaves the machine. The controller builds the host; the real
 * orchestrator, the real candidate registry and the real Luna observer turn it
 * into a request; a recording transport reads the bytes.
 */
import { describe, expect, it } from 'vitest';

import {
  CoachingSessionController,
  type CoachingSessionDeps,
} from '../../../src/control/services/coaching-session';
import { defaultCoachingSettings } from '../../../src/control/lib/coaching-profiles';
import { TakeHarness, prose } from '../coaching/integration/harness';
import type {
  CoachObserverResponse,
  CoachObserverTransport,
} from '../../../src/shared/coaching/coach/luna-observer';
import type { LunaCoachRequest } from '../../../src/shared/contracts/coaching';
import type { CompiledScript } from '../../../src/shared/contracts';
import type { FidelitySpanObservation } from '../../../src/shared/coaching/fidelity/comparator';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const SCRIPT_ID = '9d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f';
const SCRIPT_REVISION = 12;

/**
 * The presenter delivered the line in their own words: enough authored content
 * words to be worth asking about, at a divergence inside the 0.35–0.8 band
 * where "paraphrase" beats "misalignment". This is the one candidate class that
 * §20.2 says needs semantic judgement, so it is what makes a request happen.
 */
const AUTHORED =
  'the platform reduces onboarding effort for every new customer account across the region';
const SPOKEN = 'the platform reduces onboarding effort in a different way for every user';

function paraphrasedSpan(
  startMs: number,
  endMs: number,
  takePassId: string,
): FidelitySpanObservation {
  const authoredWords = AUTHORED.split(' ');
  const spokenWords = SPOKEN.split(' ');
  const step = (endMs - startMs) / spokenWords.length;
  return {
    spanId: 'span-1',
    authored: authoredWords.map((surface, index) => ({ tokenIndex: index, surface })),
    spoken: spokenWords.map((surface, index) => ({
      transcriptIndex: index,
      surface,
      final: true,
      audioStartMs: startMs + index * step,
      audioEndMs: startMs + (index + 1) * step,
      commitSequence: 1,
    })),
    alignment: [{ transcriptIndex: 0, scriptTokenIndex: 0 }],
    trackingEpoch: 0,
    takePassId,
  };
}

class RecordingTransport implements CoachObserverTransport {
  readonly requests: LunaCoachRequest[] = [];

  async classify(request: LunaCoachRequest): Promise<CoachObserverResponse> {
    this.requests.push(request);
    // §23.2: a refusal is a valid answer and produces no tip. The request is
    // what this file is about.
    return { result: null, refusal: 'no_finding' };
  }

  cancel(): void {
    /* best-effort */
  }
}

/** Only the fields the controller reads off a compiled script. */
function compiledScript(scriptId: string): CompiledScript {
  return {
    schemaVersion: 1,
    compilerVersion: 'test',
    scriptId,
    sourceHash: 'sha256:abc',
    settingsHash: 'sha256:def',
    title: 'Keynote',
    outline: [],
    blocks: [],
    spokenTokens: [],
    sentences: [],
    navigationTargets: [],
    cues: [],
    assets: [],
    diagnostics: [],
    statistics: {} as CompiledScript['statistics'],
    indexes: {} as CompiledScript['indexes'],
    literalCommandRanges: [],
  };
}

function buildController(overrides: Partial<CoachingSessionDeps> = {}): CoachingSessionController {
  return new CoachingSessionController({
    sessionId: SESSION_ID,
    settings: { ...defaultCoachingSettings(), mode: 'coach' },
    compiled: compiledScript(SCRIPT_ID),
    scriptId: SCRIPT_ID,
    scriptRevision: SCRIPT_REVISION,
    stream: {
      getAudioTracks: () => [{ kind: 'audio' }],
    } as unknown as CoachingSessionDeps['stream'],
    takePassId: `${SESSION_ID}:1`,
    publish: () => {},
    ...overrides,
  });
}

/**
 * Run a take that reaches Luna, using the host state the REAL controller built.
 *
 * The controller owns host construction (the defect) and the orchestrator owns
 * request construction; the seam between them is the whole point, so the host
 * is taken from the controller rather than assembled here.
 */
async function requestFrom(controller: CoachingSessionController): Promise<LunaCoachRequest[]> {
  const transport = new RecordingTransport();
  const harness = new TakeHarness({
    host: controller.hostState(),
    deps: { sessionId: SESSION_ID, lunaTransport: transport },
  });
  const span = harness.say(prose(15), 6_000);
  harness.orchestrator.noteFidelitySpan(
    paraphrasedSpan(span.startMs, span.endMs, harness.orchestrator.hostState().takePassId),
  );
  // §20.3: candidates coalesce for 800 ms before a request is issued.
  harness.settle(1_200);
  await harness.orchestrator.lunaObserver()?.settle();
  harness.settle(400);
  return transport.requests;
}

describe('outbound Luna coach request identity (§22)', () => {
  it('names the script it is about, not the session it came from', async () => {
    const requests = await requestFrom(buildController());
    expect(requests.length).toBeGreaterThan(0);

    const request = requests[0]!;
    expect(
      request.scriptId,
      'the request identifies the SCRIPT. Sending the session id here makes every ' +
        'coach request uncorrelatable with the text it is about',
    ).toBe(SCRIPT_ID);
    expect(request.scriptId).not.toBe(SESSION_ID);
    // …and the session id is still carried, in the field that is for it.
    expect(request.sessionId).toBe(SESSION_ID);
  });

  it('carries the stored revision rather than a permanent zero', async () => {
    const requests = await requestFrom(buildController());
    expect(requests[0]?.scriptRevision).toBe(SCRIPT_REVISION);
  });

  it('prefers the compiled script’s id over the one it was handed', async () => {
    // The compiled document is the thing the coaching lane actually analysed.
    // If the two ever disagree, the compiled one is the truthful answer.
    const controller = buildController({
      compiled: compiledScript('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
      scriptId: SCRIPT_ID,
    });
    const requests = await requestFrom(controller);
    expect(requests[0]?.scriptId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('falls back to the handed-down id when nothing compiled (browser dev)', async () => {
    const controller = buildController({ compiled: null });
    const requests = await requestFrom(controller);
    expect(requests[0]?.scriptId).toBe(SCRIPT_ID);
  });

  it('reports revision 0 only when no revision was handed down', async () => {
    const controller = buildController({ scriptRevision: undefined });
    const requests = await requestFrom(controller);
    expect(requests[0]?.scriptRevision).toBe(0);
  });
});
