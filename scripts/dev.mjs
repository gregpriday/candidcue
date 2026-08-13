#!/usr/bin/env node
/*
 * `pnpm dev` — start the real app (control + stage windows), on a port that is
 * actually free.
 *
 * Two things used to go wrong. `pnpm dev` ran plain Vite, so the everyday
 * command started a browser-only frontend against the mock backend rather than
 * the app; and the dev port was pinned at 1420 with `strictPort`, so a dev
 * server left running in another checkout (the normal state when worktrees are
 * in play) made it fail outright instead of moving aside.
 *
 * So: find a free port, hand it to Vite through `CANDIDCUE_DEV_PORT`, and hand
 * the matching `devUrl` to the Tauri CLI through an inline `--config` overlay
 * so both halves agree. `pnpm tauri dev` on its own still works and still uses
 * 1420 from tauri.conf.json — this launcher is the only thing that moves.
 */
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

const DEFAULT_PORT = 1420;
const PORT_SCAN_LIMIT = 100;

/**
 * A port counts as free only if it is free on both loopback families. Vite
 * binds `localhost`, which resolves to `::1` on this machine, while other
 * tooling reaches for `127.0.0.1`; a check against one family alone happily
 * reports a port that the other half then fails to bind.
 */
function isPortFree(port, host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen({ port, host, exclusive: true });
  });
}

async function findFreePort(start) {
  for (let port = start; port < start + PORT_SCAN_LIMIT; port += 1) {
    if ((await isPortFree(port, '127.0.0.1')) && (await isPortFree(port, '::1'))) {
      return port;
    }
  }
  throw new Error(
    `No free port in ${start}-${start + PORT_SCAN_LIMIT - 1}. Something is holding a very ` +
      'wide range; check with `lsof -nP -iTCP -sTCP:LISTEN`.',
  );
}

const requested = Number(process.env['CANDIDCUE_DEV_PORT'] ?? DEFAULT_PORT);
const port = await findFreePort(Number.isFinite(requested) ? requested : DEFAULT_PORT);

if (port !== DEFAULT_PORT) {
  console.log(`[dev] port ${DEFAULT_PORT} is busy — using ${port} instead`);
}

const overlay = JSON.stringify({ build: { devUrl: `http://localhost:${port}` } });
const child = spawn(
  'pnpm',
  ['tauri', 'dev', '--config', overlay, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, CANDIDCUE_DEV_PORT: String(port) },
  },
);

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
