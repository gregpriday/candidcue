'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Secure defaults (Electron 42). These are the framework defaults
      // since v12/v20, set explicitly here so they cannot regress silently.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Show only once the renderer is ready to avoid a white flash.
  win.once('ready-to-show', () => win.show());

  // Open external links (target=_blank, window.open) in the OS browser
  // instead of spawning new Electron windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---------------------------------------------------------------------------
// IPC handlers — keep channel names hardcoded and specific. Validate every
// argument before acting on it.
// ---------------------------------------------------------------------------
ipcMain.handle('app:get-version', () => app.getVersion());

app.whenReady().then(() => {
  createWindow();

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed, except on macOS where apps stay active
// until the user explicitly quits with Cmd+Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
