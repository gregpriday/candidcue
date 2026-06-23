'use strict';

// Runs in the sandboxed renderer. No Node APIs here — only the bridge that
// preload.js exposed on window.candidcue.
async function init() {
  const versionEl = document.getElementById('version');
  try {
    versionEl.textContent = await window.candidcue.getVersion();
  } catch (err) {
    versionEl.textContent = 'unavailable';
    console.error('Failed to load app version:', err);
  }
}

window.addEventListener('DOMContentLoaded', init);
