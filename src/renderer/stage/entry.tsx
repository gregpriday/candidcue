import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tokens.css';
import './entry.css';
import { StageApp } from './stage-app';

const CURSOR_IDLE_MS = 2000;

/** Hide the cursor after a period of pointer inactivity; reveal it on motion. */
function installCursorAutohide(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const hidden = 'cursorHidden';

  const hide = (): void => {
    document.body.classList.add(hidden);
  };
  const show = (): void => {
    document.body.classList.remove(hidden);
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(hide, CURSOR_IDLE_MS);
  };

  window.addEventListener('mousemove', show, { passive: true });
  window.addEventListener('mousedown', show, { passive: true });
  show();
}

function main(): void {
  const container = document.getElementById('root');
  if (container === null) {
    throw new Error('Stage root element #root not found');
  }
  installCursorAutohide();
  createRoot(container).render(
    <StrictMode>
      <StageApp />
    </StrictMode>,
  );
}

main();
