import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  // Lets <script lang="ts"> and other Vite-handled languages work inside
  // Svelte components (and keeps svelte-check in sync with the build).
  preprocess: vitePreprocess(),
};
