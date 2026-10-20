import { mount } from 'svelte';
import '../styles/tokens.css';
// The brand face, for this window only: see the header of brand-fonts.css.
import '../styles/brand-fonts.css';
import App from './App.svelte';
import { bindRealVoiceFacadeIfAvailable } from './services/voice-live';
import { applyPlatformAttribute } from './lib/platform';
import { followSystemAppearance } from './lib/appearance';

// Bind the real audio/realtime services behind the voice facade before any
// screen asks for microphones (falls back to the mock in plain-node tests).
bindRealVoiceFacadeIfAvailable();

// Before the first paint, so no rule that depends on it lands one frame late.
applyPlatformAttribute(document.documentElement);
// Light or dark, as the system is, and as it changes.
followSystemAppearance(document.documentElement);

const target = document.getElementById('root');
if (!target) {
  throw new Error('Control window mount point #root is missing');
}

const app = mount(App, { target });

export default app;
