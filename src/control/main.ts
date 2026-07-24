import { mount } from 'svelte';
import '../styles/tokens.css';
import App from './App.svelte';
import { bindRealVoiceFacadeIfAvailable } from './services/voice-live';

// Bind the real audio/realtime services behind the voice facade before any
// screen asks for microphones (falls back to the mock in plain-node tests).
bindRealVoiceFacadeIfAvailable();

const target = document.getElementById('root');
if (!target) {
  throw new Error('Control window mount point #root is missing');
}

const app = mount(App, { target });

export default app;
