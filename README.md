# CandidCue

A minimal, security-hardened Electron desktop app skeleton.

## Stack

- **Electron** `^42.4.1` (Node 24 / Chromium 148)
- Plain `electron .` — no bundler, no framework yet

## Getting started

```bash
npm install
npm start
```

`npm run dev` launches with DevTools open and the main process inspector attached.

## Project structure

```
src/
  main.js              # Main process: app lifecycle, BrowserWindow, IPC handlers
  preload.js           # contextBridge — the only thing the renderer can call
  renderer/
    index.html         # UI entry (with Content-Security-Policy)
    renderer.js        # Renderer logic (sandboxed, no Node access)
    styles.css
```

## Security model

The skeleton follows current Electron hardening guidance:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Renderer talks to the main process **only** through hardcoded channels
  exposed on `window.candidcue` via `contextBridge` — never the raw
  `ipcRenderer`.
- A `Content-Security-Policy` meta tag locks resource loading to `'self'`.
- `window.open` / external links open in the system browser, not new
  Electron windows.

When adding IPC, register a specific `ipcMain.handle('domain:action', …)` in
`main.js`, expose a single matching method in `preload.js`, and validate every
argument in the handler.
