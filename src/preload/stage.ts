import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '@shared/contracts';
import type { CandidCueStageApi, Unsubscribe } from '@shared/contracts';

function subscribe(channel: string, listener: (payload: any) => void): Unsubscribe {
  const wrapped = (_event: unknown, payload: any): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: CandidCueStageApi = {
  bootstrap: () => ipcRenderer.invoke(CHANNELS.stageBootstrap),
  audio: {
    // Main creates a MessageChannelMain and transfers one port to the stage for
    // high-frequency PCM (spec §20.9). We await the transferred port here.
    openCapturePort: (input) =>
      new Promise((resolve) => {
        const onPort = (event: Electron.IpcRendererEvent): void => {
          const port = event.ports[0];
          if (port) {
            ipcRenderer.removeListener(CHANNELS.stageOpenAudioPort, onPort);
            resolve(port as unknown as MessagePort);
          }
        };
        ipcRenderer.on(CHANNELS.stageOpenAudioPort, onPort);
        ipcRenderer.send(CHANNELS.stageOpenAudioPort, input);
      }),
    reportMeter: (level) => ipcRenderer.send(CHANNELS.stageReportMeter, level),
  },
  playback: {
    reportReady: (input) => ipcRenderer.send(CHANNELS.stagePlaybackReady, input),
    reportStarted: (input) => ipcRenderer.send(CHANNELS.stagePlaybackStarted, input),
    reportEnded: (input) => ipcRenderer.send(CHANNELS.stagePlaybackEnded, input),
    reportError: (input) => ipcRenderer.send(CHANNELS.stagePlaybackError, input),
  },
  commands: {
    send: (command) => ipcRenderer.send(CHANNELS.stageCommand, command),
  },
  events: {
    onState: (listener) => subscribe(CHANNELS.evtStageState, listener),
    onPlaybackPlan: (listener) => subscribe(CHANNELS.evtPlaybackPlan, listener),
    onSpeechChunk: (listener) => subscribe(CHANNELS.evtSpeechChunk, listener),
    onPlayBackchannel: (listener) => subscribe(CHANNELS.evtPlayBackchannel, listener),
    onCaptureConfig: (listener) => subscribe(CHANNELS.evtCaptureConfig, listener),
  },
};

contextBridge.exposeInMainWorld('candidcueStage', Object.freeze(api));
