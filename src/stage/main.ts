import { mount } from 'svelte';
import '../styles/tokens.css';
import '../styles/stage.css';
import StageApp from './StageApp.svelte';

const target = document.getElementById('root');
if (!target) {
  throw new Error('Stage window mount point #root is missing');
}

const app = mount(StageApp, { target });

export default app;
