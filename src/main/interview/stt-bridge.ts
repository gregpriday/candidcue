import type { SpeechToTextAdapter, Unsubscribe } from '@shared/contracts';
import type { SessionOrchestrator } from './orchestrator';
import type { Clock } from './ports';

/**
 * Subscribe an orchestrator to a live STT adapter's normalized events (MIC-04):
 * partial/final transcripts, speech start/stop, and stream errors. Returns the
 * unsubscribe handles so the caller can detach on session teardown.
 *
 * Extracted from the session bootstrap so the wiring is unit-testable against a
 * fake STT adapter without constructing real provider clients.
 */
export function bridgeSttToOrchestrator(
  stt: SpeechToTextAdapter,
  orchestrator: SessionOrchestrator,
  now: Clock,
): Unsubscribe[] {
  return [
    stt.on('partial', (text) => orchestrator.onSttPartial(asText(text))),
    stt.on('finalSegment', (text) => orchestrator.onSttFinalSegment(asText(text))),
    stt.on('speechStarted', () => orchestrator.onSpeechStarted(now())),
    stt.on('speechStopped', () => orchestrator.onSpeechStopped(now())),
    stt.on('error', (message) => orchestrator.onSttError(asText(message))),
  ];
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
