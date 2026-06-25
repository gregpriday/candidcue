import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Bundle Source Serif 4 (refinement §7) so the live question and review prose
// render identically across macOS/Windows instead of falling through to
// whatever host serif (Iowan, Palatino, Georgia) happens to be installed.
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/500.css';
import '@fontsource/source-serif-4/400-italic.css';
import '@fontsource/source-serif-4/500-italic.css';
import '../styles/tokens.css';
import { App } from './app';
import { ErrorBoundary } from '../shared/ErrorBoundary';

const container = document.getElementById('root');
if (!container) {
  throw new Error('CandidCue control window: #root element not found.');
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary surface="CandidCue">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
