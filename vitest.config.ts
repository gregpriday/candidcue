import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  test: {
    include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    environment: 'node',
    // Node's navigator reports the HOST's platform; this pins it to a Mac so the
    // suite asserts the same copy and shortcuts on every machine. Why a Mac, and
    // how the other platforms are covered: tests/setup/node-platform.ts.
    setupFiles: ['tests/setup/node-platform.ts'],
  },
});
