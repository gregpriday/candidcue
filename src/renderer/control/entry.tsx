import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tokens.css';
import { App } from './app';

const container = document.getElementById('root');
if (!container) {
  throw new Error('CandidCue control window: #root element not found.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
