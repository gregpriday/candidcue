/**
 * The authored text reaches the wire, with a real `punctuationClass`.
 *
 * `authored-spans.test.ts` proves the derivation. This proves the delivery: the
 * request the transport actually sees carries §20.4's 1–3 sentences around the
 * cursor, and each one carries a punctuation class read off the authored
 * characters rather than a default.
 *
 * The assertion is on the outbound `LunaCoachRequest`, not on the host state,
 * because the host state is an implementation detail and the field that was
 * empty is the one that leaves the machine. On revert `authoredSpans` is `[]`
 * in every request and every assertion below fails.
 */
import { describe, expect, it } from 'vitest';

import { compile } from '../../../src/shared/markdown/compile';
import {
  CoachingSessionController,
  type CoachingSessionDeps,
} from '../../../src/control/services/coaching-session';
import { defaultCoachingSettings } from '../../../src/control/lib/coaching-profiles';
import { SESSION_ID, TakeHarness, prose } from './integration/harness';
import type {
  CoachObserverResponse,
  CoachObserverTransport,
} from '../../../src/shared/coaching/coach/luna-observer';
import type { LunaCoachRequest } from '../../../src/shared/contracts/coaching';
import type { FidelitySpanObservation } from '../../../src/shared/coaching/fidelity/comparator';

/**
 * Two paragraphs, four sentences. The middle sentence of the first paragraph
 * closes on a full stop and the last one closes the paragraph, so a request
 * built at the right cursor carries two *different* classes — a request in
 * which every class is the same could be produced by a constant.
 */
const SCRIPT = [
  'We shipped the whole release in a single afternoon.',
  'The numbers came in ahead of every internal forecast.',
  'Nobody expected the migration to finish before the weekend.',
  '',
  'That is the part of the story worth repeating.',
].join('\n');

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
    return { result: null, refusal: 'no_finding' };
  }

  cancel(): void {
    /* best-effort */
  }
}

/**
 * Drive a real take to a real request, with the host state the REAL controller
 * built after the cursor reached `sentenceIndex`.
 */
async function requestsAtSentence(sentenceIndex: number): Promise<LunaCoachRequest[]> {
  const compiled = compile(SCRIPT, { scriptId: 'authored-span-script' });
  const controller = new CoachingSessionController({
    sessionId: SESSION_ID,
    settings: { ...defaultCoachingSettings(), mode: 'coach' },
    compiled,
    stream: {
      getAudioTracks: () => [{ kind: 'audio' }],
    } as unknown as CoachingSessionDeps['stream'],
    publish: () => {},
  });
  const sentence = compiled.sentences[sentenceIndex];
  if (!sentence) throw new Error(`no sentence ${sentenceIndex}`);
  controller.setTrackingState({
    tokenIndex: sentence.startTokenIndex + 1,
    alignmentConfidence: 0.9,
    reacquiring: false,
    commandActive: false,
    activeScriptSpanId: sentence.id,
    trackingEpoch: 0,
  });

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
  await controller.dispose();
  return transport.requests;
}

describe('§20.4/§22 the outbound coach request carries the authored text', () => {
  it('sends the sentences around the cursor rather than an empty array', async () => {
    const requests = await requestsAtSentence(1);
    expect(requests.length).toBeGreaterThan(0);
    const spans = requests[0]!.authoredSpans;
    expect(
      spans.length,
      'the request carried no authored text at all — §20.4 asks for 1–3 sentences',
    ).toBeGreaterThan(0);
    expect(spans.length).toBeLessThanOrEqual(3);
    expect(spans[0]?.text.length).toBeGreaterThan(0);
  });

  it('carries a punctuationClass derived from the script, not a default', async () => {
    const requests = await requestsAtSentence(1);
    const spans = requests[0]!.authoredSpans;
    const classes = spans.map((span) => span.punctuationClass);
    for (const value of classes) {
      expect(['weak', 'medium', 'strong', 'paragraph']).toContain(value);
    }
    // The window is sentences 0–2 of the first paragraph: two mid-paragraph
    // stops and the one that closes the block. A constant could not produce
    // this, and neither could a fabricated value.
    expect(classes).toEqual(['strong', 'strong', 'paragraph']);
  });

  it('moves with the cursor — a different sentence is a different window', async () => {
    const first = (await requestsAtSentence(0))[0]!.authoredSpans;
    const later = (await requestsAtSentence(3))[0]!.authoredSpans;
    expect(first[0]?.spanId).not.toBe(later[0]?.spanId);
    // The lone sentence of the second paragraph opens and closes its block.
    expect(later.map((span) => span.punctuationClass)).toEqual(['paragraph', 'paragraph']);
  });
});
