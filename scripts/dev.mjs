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

/*
 * A dev run is a tree — pnpm → the Tauri CLI → Vite (with its own esbuild
 * service) and cargo → the app binary — and killing the root leaves the rest
 * of it alive. An orphaned Vite goes on holding the port, so the next run
 * drifts to a higher one and the ports march upward; worse, when its esbuild
 * helper is eventually killed, Vite dies on an unhandled `write EPIPE` and
 * sprays a stack trace over a terminal whose prompt came back minutes ago.
 *
 * So the child gets its own process group and the whole group is signalled as
 * a unit. `detached: true` means the terminal's Ctrl-C reaches this launcher
 * and not the group, which is why SIGINT is forwarded explicitly rather than
 * relied upon.
 */
const overlay = JSON.stringify({ build: { devUrl: `http://localhost:${port}` } });
const child = spawn(
  'pnpm',
  ['tauri', 'dev', '--config', overlay, ...process.argv.slice(2)],
  {
    // stdin is deliberately NOT inherited. In its own process group the tree is
    // a background job as far as the terminal is concerned, and a background
    // process that reads the TTY takes SIGTTIN and stops — which Vite would do,
    // since it binds stdin for its keyboard shortcuts whenever stdin is a TTY.
    // Nothing in a dev run needs typed input; output still goes to the terminal.
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
    env: { ...process.env, CANDIDCUE_DEV_PORT: String(port) },
  },
);

let exiting = false;

/** Signal the child's entire process group, ignoring an already-dead group. */
function signalGroup(signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH: the group is already gone, which is the outcome we wanted.
  }
}

function shutdown(signal) {
  if (exiting) return;
  exiting = true;
  signalGroup(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
  // The Tauri CLI gets a moment to stop cargo and close the app cleanly;
  // anything still standing after that is not going to leave on its own.
  const sweep = setTimeout(() => signalGroup('SIGKILL'), 5000);
  sweep.unref();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => shutdown(signal));
}

child.on('exit', (code, signal) => {
  // The root died — reap whatever it left behind before going quiet, or the
  // survivors keep the port and the terminal keeps receiving their output.
  exiting = true;
  signalGroup('SIGTERM');
  // Deliberately not unref'd: this timer is the only thing left holding the
  // event loop open, and without it node exits immediately and the sweep never
  // runs.
  setTimeout(() => {
    signalGroup('SIGKILL');
    process.exit(signal ? 1 : (code ?? 0));
  }, 500);
});
