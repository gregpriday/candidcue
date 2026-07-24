import { mount } from 'svelte';
import '../styles/tokens.css';
import App from './App.svelte';

const target = document.getElementById('root');
if (!target) {
  throw new Error('Control window mount point #root is missing');
}

const app = mount(App, { target });

export default app;
