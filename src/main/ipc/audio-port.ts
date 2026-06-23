import { MessageChannelMain } from 'electron';
import type { WebContents } from 'electron';
import type { AudioChunkPacket } from '@shared/contracts';
import { CHANNELS } from '@shared/contracts';

/** What the stage posts over the audio port (PCM + minimal metadata). */
interface RawAudioMessage {
  sessionId: string;
  turnId: string;
  sequence: number;
  capturedAtMs: number;
  payload: ArrayBuffer;
}

export type PcmSink = (packet: AudioChunkPacket) => void;

/**
 * Wire a dedicated MessagePort for high-frequency PCM (spec §20.9). One port is
 * transferred to the stage renderer; the other stays in main and forwards
 * validated packets to the active STT sink. The normal IPC surface is only used
 * for low-frequency control events.
 */
export function setupAudioPort(stage: WebContents, sink: PcmSink): () => void {
  const { port1, port2 } = new MessageChannelMain();

  port1.on('message', (event) => {
    const msg = event.data as RawAudioMessage;
    if (!msg || typeof msg.sequence !== 'number' || !(msg.payload instanceof ArrayBuffer)) return;
    // Reasonable bound: 100ms of 16kHz mono PCM16 ≈ 3200 bytes; cap generously.
    if (msg.payload.byteLength > 64_000) return;
    sink({
      sessionId: msg.sessionId,
      turnId: msg.turnId,
      sequence: msg.sequence,
      sampleRate: 16000,
      channels: 1,
      format: 'pcm_s16le',
      capturedAtMs: msg.capturedAtMs,
      payload: msg.payload,
    });
  });
  port1.start();

  // Transfer the far end to the stage renderer.
  stage.postMessage(CHANNELS.stageOpenAudioPort, null, [port2]);

  return () => {
    try {
      port1.close();
    } catch {
      /* already closed */
    }
  };
}
