'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a narrow, explicitly-enumerated API to the renderer. Never forward
// the raw ipcRenderer or a generic (channel, ...args) wrapper — each method
// here maps to a single, hardcoded channel.
contextBridge.exposeInMainWorld('candidcue', {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
});
