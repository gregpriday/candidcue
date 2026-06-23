import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '@shared/contracts';
import type { CandidCueControlApi, Unsubscribe } from '@shared/contracts';

function subscribe(channel: string, listener: (payload: any) => void): Unsubscribe {
  const wrapped = (_event: unknown, payload: any): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

// Each method maps to ONE hardcoded channel. The raw ipcRenderer and any
// generic invoke(channel, ...args) wrapper are never exposed (spec §20.6).
const api: CandidCueControlApi = {
  projects: {
    list: () => ipcRenderer.invoke(CHANNELS.projectsList),
    get: (projectId) => ipcRenderer.invoke(CHANNELS.projectsGet, projectId),
    save: (input) => ipcRenderer.invoke(CHANNELS.projectsSave, input),
    remove: (projectId) => ipcRenderer.invoke(CHANNELS.projectsRemove, projectId),
    prepare: (projectId) => ipcRenderer.invoke(CHANNELS.projectsPrepare, projectId),
    export: (projectId) => ipcRenderer.invoke(CHANNELS.projectsExport, projectId),
    importDocument: () => ipcRenderer.invoke(CHANNELS.projectsImportDocument),
  },
  settings: {
    getPublic: () => ipcRenderer.invoke(CHANNELS.settingsGetPublic),
    saveProviders: (input) => ipcRenderer.invoke(CHANNELS.settingsSaveProviders, input),
    testProvider: (provider) => ipcRenderer.invoke(CHANNELS.settingsTestProvider, provider),
    clearProvider: (provider) => ipcRenderer.invoke(CHANNELS.settingsClearProvider, provider),
  },
  characters: {
    list: () => ipcRenderer.invoke(CHANNELS.charactersList),
  },
  devices: {
    listDisplays: () => ipcRenderer.invoke(CHANNELS.devicesListDisplays),
    setSelectedDisplay: (displayId) => ipcRenderer.invoke(CHANNELS.devicesSetDisplay, displayId),
    identifyDisplays: () => ipcRenderer.invoke(CHANNELS.devicesIdentifyDisplays),
  },
  sessions: {
    prepare: (input) => ipcRenderer.invoke(CHANNELS.sessionsPrepare, input),
    command: (command) => ipcRenderer.invoke(CHANNELS.sessionsCommand, command),
    getSnapshot: () => ipcRenderer.invoke(CHANNELS.sessionsSnapshot),
    review: (sessionId) => ipcRenderer.invoke(CHANNELS.sessionsReview, sessionId),
    editTranscript: (turnId, text) => ipcRenderer.invoke(CHANNELS.sessionsEditTranscript, turnId, text),
    export: (sessionId, format) => ipcRenderer.invoke(CHANNELS.sessionsExport, sessionId, format),
    resumable: () => ipcRenderer.invoke(CHANNELS.sessionsResumable),
  },
  events: {
    onSessionSnapshot: (listener) => subscribe(CHANNELS.evtSessionSnapshot, listener),
    onPreflight: (listener) => subscribe(CHANNELS.evtPreflight, listener),
    onError: (listener) => subscribe(CHANNELS.evtError, listener),
  },
};

contextBridge.exposeInMainWorld('candidcue', Object.freeze(api));
