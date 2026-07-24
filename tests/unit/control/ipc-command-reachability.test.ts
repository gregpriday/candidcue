/**
 * The test that would have caught C1 and C11 on the day they landed.
 *
 * Both defects had the same shape: a Rust command registered in
 * `app.rs::invoke_handler` with NO TypeScript caller anywhere in the tree. That
 * is invisible to every other kind of test — Rust unit tests exercise the
 * command's body, TS unit tests exercise a mock, and neither notices that the
 * two are never connected. `start_session` was the whole session subsystem AND
 * the only writer of the coordinator's session generation, so its absence
 * silently disabled the stage: `validate_stage_payload_header` compared
 * control's hard-coded 1 against a coordinator still at 0 and dropped every
 * snapshot.
 *
 * So: every registered command must either have a caller in the frontend, or be
 * named in the allowlist below with a reason. Wiring a command removes it from
 * the list; adding one to the list is a deliberate, reviewable act.
 *
 * `tests/e2e/` and `tests/integration/` are still empty (§55.1 layers 2 and 4),
 * which is the deeper gap. This is the cheap structural half of it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const APP_RS = join(ROOT, 'src-tauri/src/app.rs');
const SRC = join(ROOT, 'src');

/**
 * Commands with no frontend caller, each with the reason it is acceptable.
 * A command whose absence would break a user-visible guarantee does NOT belong
 * here — that is precisely the mistake this test exists to prevent.
 */
const UNWIRED_BY_DESIGN: Record<string, string> = {
  remove_asset_reference: 'Asset GC runs from the compiler side; no UI affordance yet.',
  download_listener:
    'NOT_IMPLEMENTED in Rust (no CandidCue pack host); Settings deliberately shows no download affordance.',
  cancel_listener_download:
    'NOT_IMPLEMENTED in Rust (no CandidCue pack host); there is no download to cancel.',
  install_update: 'No updater plugin is wired in v1 (§44.10).',
};

/** Commands whose absence is a user-visible failure, so they must stay wired. */
const MUST_BE_WIRED = [
  'start_session',
  'end_session',
  'append_session_transcript',
  'publish_stage_snapshot',
  'publish_stage_document',
  'open_stage',
  'update_settings',
];

function registeredCommands(): string[] {
  const source = readFileSync(APP_RS, 'utf8');
  const handler = source.slice(source.indexOf('invoke_handler'));
  return [...handler.matchAll(/commands::([a-z_][a-z0-9_]*)\s*,/g)].map((m) => m[1]!);
}

function allSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|svelte)$/.test(entry)) continue;
      // The mock backend names commands it fakes; a mock is not a caller.
      if (entry === 'mock-backend.ts') continue;
      files.push(full);
    }
  };
  walk(SRC);
  return files;
}

/**
 * Modules actually reachable from the app entry points.
 *
 * Presence of a command name somewhere under `src/` proves nothing — a service
 * wrapper that no screen imports is exactly as dead as no wrapper at all, which
 * is the state `services/session-records.ts` would be in if the Preflight call
 * were removed again. So the graph is walked from the real entries and only
 * modules that survive the walk count as callers.
 */
function reachableFromEntries(): Set<string> {
  const entries = [join(SRC, 'control/main.ts'), join(SRC, 'stage/main.ts')];
  const seen = new Set<string>();
  const queue = entries.filter((entry) => existsSync(entry));

  const resolveSpecifier = (fromFile: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null;
    const base = resolve(dirname(fromFile), spec);
    const candidates = [base, `${base}.ts`, `${base}.svelte`, join(base, 'index.ts')];
    return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
  };

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    const specs = [
      ...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g),
    ].map((m) => m[1]!);
    for (const spec of specs) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

const COMMANDS = registeredCommands();
const REACHABLE = reachableFromEntries();
const SOURCES = allSources()
  .filter((path) => REACHABLE.has(path))
  .map((path) => ({ path, text: readFileSync(path, 'utf8') }));

/**
 * Quoted string literals only — a command NAMED in a doc comment (which this
 * codebase does constantly, in backticks) is documentation, not a call site.
 */
function callersOf(command: string): string[] {
  const needle = new RegExp(`(['"])${command}\\1`);
  return SOURCES.filter((f) => needle.test(f.text)).map((f) => f.path.slice(ROOT.length + 1));
}

describe('every registered IPC command is reachable from the frontend', () => {
  it('finds the command list in app.rs', () => {
    expect(COMMANDS.length).toBeGreaterThan(40);
    expect(COMMANDS).toContain('start_session');
  });

  it('has a caller for every command that is not explicitly allowlisted', () => {
    const orphans = COMMANDS.filter(
      (command) => !(command in UNWIRED_BY_DESIGN) && callersOf(command).length === 0,
    );
    expect(
      orphans,
      `These Rust commands have no TypeScript caller. Wire them, or add them to ` +
        `UNWIRED_BY_DESIGN with the reason they are unreachable on purpose.`,
    ).toEqual([]);
  });

  it('keeps the allowlist honest — a wired command must not stay on it', () => {
    const stale = Object.keys(UNWIRED_BY_DESIGN).filter(
      (command) => callersOf(command).length > 0,
    );
    expect(stale, 'These commands are wired now and should leave the allowlist.').toEqual([]);
  });

  it.each(MUST_BE_WIRED)('%s is called from the control frontend', (command) => {
    expect(COMMANDS).toContain(command);
    expect(callersOf(command).length, `${command} has no caller`).toBeGreaterThan(0);
  });
});

/**
 * C1, stated as the source-level invariant it actually was. The generation is
 * assigned by Rust and adopted by control; a literal is the bug.
 */
describe('the stage envelope never carries a hard-coded session generation', () => {
  it('Preflight starts the session record and uses the generation it returns', () => {
    const preflight = SOURCES.find((f) => f.path.endsWith('routes/Preflight.svelte'));
    expect(preflight).toBeDefined();
    expect(preflight!.text).toMatch(/startSessionRecord\(/);
    expect(preflight!.text).toMatch(/record\.sessionGeneration/);
  });

  it('no control source assigns a literal session generation', () => {
    /*
     * Exempt:
     *  - services/realtime/**: the realtime transport's `sessionGeneration` is
     *    its own per-CONNECTION counter (CommitLedger), unrelated to the
     *    coordinator's per-SESSION one;
     *  - services/session-records.ts: the plain-browser fallback, which runs
     *    only when there is no Tauri runtime and therefore no coordinator to
     *    disagree with — and no stage to publish to either.
     */
    const offenders = SOURCES.filter(
      (f) =>
        f.path.includes('/src/control/') &&
        !f.path.includes('/realtime/') &&
        !f.path.endsWith('services/session-records.ts') &&
        /sessionGeneration:\s*\d+/.test(f.text),
    ).map((f) => f.path.slice(ROOT.length + 1));
    expect(
      offenders,
      'A literal sessionGeneration is the C1 defect: Rust assigns it, control adopts it.',
    ).toEqual([]);
  });
});

/**
 * C2: `stage://semantic-frame` is documented as "emitted directly from the
 * control webview like the heartbeat", and for a long time the only dispatcher
 * was the in-browser preview driver — so the stage's v2 motion engine received
 * nothing in a packaged build.
 */
describe('stage://semantic-frame has a producer outside the preview driver', () => {
  it('is emitted from the control window', () => {
    const producers = SOURCES.filter(
      (f) =>
        f.path.includes('/src/control/') &&
        /STAGE_EVENT\.semanticFrame/.test(f.text) &&
        /emit/i.test(f.text),
    ).map((f) => f.path.slice(ROOT.length + 1));
    expect(producers.length, 'no control-side producer for stage://semantic-frame').toBeGreaterThan(
      0,
    );
  });

  it('is consumed by the stage', () => {
    const consumers = SOURCES.filter(
      (f) => f.path.includes('/src/stage/') && /STAGE_EVENT\.semanticFrame/.test(f.text),
    );
    expect(consumers.length).toBeGreaterThan(0);
  });
});
