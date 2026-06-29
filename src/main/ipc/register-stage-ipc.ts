import { ipcMain, type IpcMainEvent } from 'electron';
import { z } from 'zod';
import { CHANNELS } from '@shared/contracts';
import type { SessionCommand } from '@shared/domain';
import { setupAudioPort } from './audio-port';
import type { AppController } from '../app-controller';
import type { makeSenderGuard } from './sender-guards';

type Guard = ReturnType<typeof makeSenderGuard>;

const playbackEventSchema = z.object({ turnId: z.string(), atMs: z.number().optional() });
const playbackErrorSchema = z.object({ turnId: z.string(), reason: z.string() });
const meterSchema = z.object({ peak: z.number(), average: z.number(), clipping: z.boolean() });
const stageCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('COMMIT'), reason: z.enum(['manual', 'automatic']) }),
  z.object({ type: z.literal('BEGIN') }),
  z.object({ type: z.literal('PAUSE') }),
  z.object({ type: z.literal('RESUME') }),
  z.object({ type: z.literal('REPEAT') }),
  z.object({ type: z.literal('SKIP') }),
  z.object({ type: z.literal('RETAKE') }),
  z.object({ type: z.literal('EXIT_STAGE') }),
  z.object({ type: z.literal('END_AFTER_TURN') }),
]);

/** Register StageWindow channels (low-frequency control; PCM uses the port). */
export function registerStageIpc(app: AppController, guard: Guard): void {
  const stage = (event: IpcMainEvent): void => guard(event.sender, ['stage']);

  ipcMain.handle(CHANNELS.stageBootstrap, (e) => {
    guard(e.sender, ['stage']);
    const boot = app.buildStageBootstrap();
    // The stage just mounted and registered its event listeners, so (re)send the
    // capture config now to cover a freshly-loaded window (MIC-01).
    app.sendCaptureConfig();
    return boot;
  });

  ipcMain.on(CHANNELS.stageOpenAudioPort, (e) => {
    stage(e);
    // Hand the disposer to the controller, which disposes any prior audio port
    // first — a re-bootstrap must not leak the old port1 listener or let two
    // ports forward PCM into one STT turn (spec §20.9).
    app.setAudioPortDisposer(setupAudioPort(e.sender, app.pcmSink));
  });

  ipcMain.on(CHANNELS.stageReportMeter, (e, raw) => {
    stage(e);
    const parsed = meterSchema.safeParse(raw);
    if (parsed.success) app.reportStageMeter(parsed.data);
  });

  ipcMain.on(CHANNELS.stagePlaybackReady, (e, raw) => {
    stage(e);
    app.reportStagePlayback('ready', playbackEventSchema.parse(raw).turnId);
  });
  ipcMain.on(CHANNELS.stagePlaybackStarted, (e, raw) => {
    stage(e);
    app.reportStagePlayback('started', playbackEventSchema.parse(raw).turnId);
  });
  ipcMain.on(CHANNELS.stagePlaybackEnded, (e, raw) => {
    stage(e);
    app.reportStagePlayback('ended', playbackEventSchema.parse(raw).turnId);
  });
  ipcMain.on(CHANNELS.stagePlaybackError, (e, raw) => {
    stage(e);
    app.reportStagePlayback('error', playbackErrorSchema.parse(raw).turnId);
  });

  ipcMain.on(CHANNELS.stageCommand, (e, raw) => {
    stage(e);
    const cmd = stageCommandSchema.parse(raw);
    const mapped = mapStageCommand(cmd);
    if (mapped) void app.command(mapped);
  });
}

export function mapStageCommand(cmd: z.infer<typeof stageCommandSchema>): SessionCommand | null {
  switch (cmd.type) {
    case 'COMMIT': return { type: 'COMMIT_USER_TURN', reason: cmd.reason };
    case 'BEGIN': return { type: 'BEGIN_SESSION' };
    case 'PAUSE': return { type: 'PAUSE_SESSION' };
    case 'RESUME': return { type: 'RESUME_SESSION' };
    case 'REPEAT': return { type: 'REPEAT_QUESTION' };
    case 'SKIP': return { type: 'SKIP_QUESTION' };
    case 'RETAKE': return { type: 'RETAKE_TURN' };
    case 'EXIT_STAGE': return { type: 'PAUSE_SESSION' };
    case 'END_AFTER_TURN': return { type: 'END_AFTER_TURN' };
    default: return null;
  }
}
