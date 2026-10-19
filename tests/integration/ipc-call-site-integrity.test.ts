/**
 * Hardens the registration ↔ caller guard, rather than repeating it.
 *
 * `tests/unit/control/ipc-command-reachability.test.ts` owns the "no caller"
 * question and answers it well: it walks the module graph from the real entry
 * points, so a service wrapper nothing imports does not count as a caller. This
 * file does not duplicate that. It covers the two things that guard cannot see,
 * both of which are silent failures in the app:
 *
 *  1. A command name MENTIONED in a reachable module is treated there as proof
 *     of a caller. A quoted command name can also be a stale constant, a type
 *     literal, or a name in an error message — none of which invoke anything.
 *     This file requires a real call site: `ipcInvoke('x')`, `invokeOrMock('x')`
 *     or an aliased `invoke(COMMANDS.something)`.
 *
 *  2. The REVERSE direction — TypeScript invoking a command Rust never
 *     registered. Tauri answers "Command not found", `invokeOrMock` treats that
 *     like any other failure, and the mock backend answers instead. A typo in a
 *     command name is therefore completely invisible: the screen works in dev
 *     and does nothing in a packaged build. Nothing guarded this at all.
 *
 * Both scans are source scans, so both carry the vacuity risk. `the scan finds
 * the call sites it is meant to guard` is the guard on the guard, and it
 * exercises the aliased branch as well as the literal one — the aliased branch
 * broke silently once already while this file was being written (a `<[^>]*>`
 * generic matcher stops at the inner `>` of `invoke<Outer<Inner>>(…)`, and
 * every aliased command then looked uncalled).
 *
 * The aliased branch is exercised against a SYNTHETIC module rather than
 * against whichever production file happens to alias a command name today.
 * When the semantic sidecar was removed, nothing aliased any more and the
 * self-check began failing on its own emptiness — which said nothing about
 * whether the matcher still worked. A fixture keeps the matcher under test
 * whether or not the app currently uses the pattern.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const APP_RS = join(ROOT, 'src-tauri/src/app.rs');

/* -------------------------------------------------------------- registration */

function registeredCommands(): string[] {
  const source = readFileSync(APP_RS, 'utf8');
  const start = source.indexOf('generate_handler![');
  if (start === -1) throw new Error('src-tauri/src/app.rs has no generate_handler! block');
  const end = source.indexOf(']', start);
  if (end === -1) throw new Error('the generate_handler! block does not close');
  return [...source.slice(start, end).matchAll(/commands::(\w+)\s*,/g)].map((m) => m[1] as string);
}

/* ------------------------------------------------------------------ TS scan */

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourcesUnder(path));
    // Forward slashes on every host: the filters and expectations below spell
    // paths the POSIX way, and `join` hands Windows its backslashes.
    else if (/\.(ts|svelte)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(path.replaceAll('\\', '/'));
  }
  return out;
}

const tsSources = sourcesUnder(join(ROOT, 'src'))
  // A mock is not a caller. It names every command it fakes.
  .filter((path) => !path.endsWith('services/mock-backend.ts'))
  .map((path) => ({ path: path.slice(ROOT.length + 1), text: readFileSync(path, 'utf8') }));

/*
 * The generic argument is `[^\n]*?`, not `[^>]*`: these call sites nest, e.g.
 * `invoke<SemanticOperationResponse<SemanticAssistResult>>(…)`. Getting this
 * wrong makes the aliased branch match nothing at all.
 */
const LITERAL_CALL =
  /(?:ipcInvoke|invokeOrMock|invoke)\s*(?:<[^\n]*?>)?\s*\(\s*['"]([a-z][a-z0-9_]*)['"]/g;
const ALIASED_CALL =
  /(?:ipcInvoke|invokeOrMock|invoke)\s*(?:<[^\n]*?>)?\s*\(\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)?)\s*[,)]/g;

const COMMANDS = registeredCommands();
const COMMAND_SET = new Set(COMMANDS);

/** One level of aliasing: `const NAME = 'cmd'` / `key: 'cmd'`. */
const ALIASES = (() => {
  const aliases = new Map<string, string>();
  for (const { text } of tsSources) {
    for (const match of text.matchAll(
      /(?:const\s+)?([A-Za-z_$][\w$]*)\s*[:=]\s*['"]([a-z][a-z0-9_]*)['"]/g,
    )) {
      const [, alias, value] = match;
      if (alias && value && COMMAND_SET.has(value)) aliases.set(alias, value);
    }
  }
  return aliases;
})();

interface Scan {
  /** command → files with a real invoke call site. */
  invoked: Map<string, string[]>;
  /** command → files where the name appears as a quoted literal, anywhere. */
  mentioned: Map<string, string[]>;
  /** command names invoked from TypeScript, registered or not. */
  invokedNames: Set<string>;
}

const scan: Scan = (() => {
  const invoked = new Map<string, string[]>();
  const mentioned = new Map<string, string[]>();
  const invokedNames = new Set<string>();
  const add = (into: Map<string, string[]>, key: string, path: string) => {
    const list = into.get(key) ?? [];
    if (!list.includes(path)) list.push(path);
    into.set(key, list);
  };

  for (const { path, text } of tsSources) {
    for (const match of text.matchAll(LITERAL_CALL)) {
      const command = match[1];
      if (!command) continue;
      invokedNames.add(command);
      if (COMMAND_SET.has(command)) add(invoked, command, path);
    }
    for (const match of text.matchAll(ALIASED_CALL)) {
      const token = match[1];
      if (!token) continue;
      const key = token.includes('.') ? (token.split('.').pop() as string) : token;
      const command = ALIASES.get(key) ?? ALIASES.get(token);
      if (command) {
        invokedNames.add(command);
        add(invoked, command, path);
      }
    }
    for (const command of COMMANDS) {
      if (new RegExp(`(['"])${command}\\1`).test(text)) add(mentioned, command, path);
    }
  }
  return { invoked, mentioned, invokedNames };
})();

/**
 * Commands whose name appears as a quoted literal in a reachable module without
 * a real call site behind it. Each entry has to explain why the mention is not
 * a lie about the feature being wired.
 */
const MENTIONED_WITHOUT_A_CALL_SITE: Record<string, string> = {};

/* ---------------------------------------------------------------------- tests */

describe('IPC call-site integrity', () => {
  it('the scan finds the call sites it is meant to guard', () => {
    // Registration side.
    expect(COMMANDS.length).toBeGreaterThan(50);
    expect(new Set(COMMANDS).size, 'a command is registered twice in app.rs').toBe(COMMANDS.length);

    // Literal branch.
    expect(scan.invoked.get('list_scripts')).toContain('src/control/services/scripts.ts');
    expect(scan.invoked.has('start_session')).toBe(true);

    // Aliased branch, against a synthetic module: both the alias table and the
    // call matcher have to work, including through a nested generic — that is
    // the exact shape that broke silently once.
    const command = COMMANDS[0] as string;
    const fixture = `
      const KEY = '${command}';
      const GROUP = { pick: '${command}' } as const;
      await invoke<Outer<Inner>>(KEY);
      await ipcInvoke(GROUP.pick);
    `;
    const aliases = new Map<string, string>();
    for (const match of fixture.matchAll(
      /(?:const\s+)?([A-Za-z_$][\w$]*)\s*[:=]\s*['"]([a-z][a-z0-9_]*)['"]/g,
    )) {
      const [, alias, value] = match;
      if (alias && value && COMMAND_SET.has(value)) aliases.set(alias, value);
    }
    expect(aliases.get('KEY')).toBe(command);
    expect(aliases.get('pick')).toBe(command);

    const resolved = [...fixture.matchAll(ALIASED_CALL)].map((match) => {
      const token = match[1] as string;
      const key = token.includes('.') ? (token.split('.').pop() as string) : token;
      return aliases.get(key) ?? aliases.get(token);
    });
    expect(resolved).toEqual([command, command]);

    // Mention branch.
    expect(scan.mentioned.size).toBeGreaterThanOrEqual(scan.invoked.size);
  });

  /**
   * A quoted command name is not a caller. The sibling reachability test
   * accepts one as proof, which is the right trade for its purpose (it is
   * asking "is this feature wired at all?") but leaves room for a name that
   * outlives the call that used it.
   */
  it('every command named in the frontend is actually invoked from it', () => {
    const namedOnly = [...scan.mentioned.keys()].filter(
      (command) =>
        !scan.invoked.has(command) && !(command in MENTIONED_WITHOUT_A_CALL_SITE),
    );
    expect(
      namedOnly.map((c) => `${c} (named in ${scan.mentioned.get(c)?.join(', ')})`),
      'these commands are NAMED in frontend source but never invoked. A quoted ' +
        'command name with no call site behind it reads as a wired feature to ' +
        'anything that greps — including the reachability guard.',
    ).toEqual([]);
  });

  /**
   * The direction nothing guarded. Rust rejects an unknown command with
   * "Command <x> not found"; `invokeOrMock` cannot tell that apart from a
   * genuine failure and serves the mock backend instead, so a typo works
   * perfectly in browser dev and does nothing in the packaged app.
   */
  it('no TypeScript call site names a command Rust does not register', () => {
    // Guard on the guard: an empty scan would make this vacuous.
    expect(scan.invokedNames.size).toBeGreaterThan(25);

    const unregistered = [...scan.invokedNames].filter((name) => !COMMAND_SET.has(name));
    expect(
      unregistered,
      'these command names are invoked from TypeScript but are absent from ' +
        'generate_handler! in src-tauri/src/app.rs. The invoke fails, invokeOrMock ' +
        'swallows it, and the mock backend answers — so the screen works in dev and ' +
        'is dead in a packaged build.',
    ).toEqual([]);
  });

  it('the mention allowlist does not outlive the mentions it excuses', () => {
    for (const [command, reason] of Object.entries(MENTIONED_WITHOUT_A_CALL_SITE)) {
      expect(reason.length, `${command} needs a real reason`).toBeGreaterThan(30);
      expect(
        COMMAND_SET.has(command),
        `"${command}" is allowlisted but not registered in app.rs — delete the entry`,
      ).toBe(true);
      expect(
        scan.invoked.has(command),
        `"${command}" now has a real call site — remove its allowlist entry`,
      ).toBe(false);
    }
  });
});
