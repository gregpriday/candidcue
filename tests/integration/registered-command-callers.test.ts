/**
 * registration ↔ caller drift (the "no caller" class).
 *
 * `src-tauri/tests/acl_tests.rs` guards registration ↔ permission: every
 * command in `generate_handler!` must appear in `permissions/app-commands.toml`.
 * Nothing guarded registration ↔ CALLER, and 21 of 62 registered commands had
 * no TypeScript caller at all — including whole features with working, tested
 * Rust behind them. The most expensive instance was `start_session`: the
 * command existed, the coordinator behind it was correct, and because nothing
 * invoked it the session generation stayed at its `Default` of 0 while control
 * stamped every stage payload with 1. Every tracking snapshot was then dropped
 * by `validate_stage_payload_header` and the stage never moved.
 *
 * A command with no caller is not automatically a bug — some are genuinely
 * ahead of their UI, and two are honest NOT_IMPLEMENTED stubs. What is a bug is
 * nobody NOTICING. So every unwired command must be named here with a reason,
 * and wiring one up means deleting its entry.
 *
 * This is a source-scanning test, which has a specific failure mode: a scan
 * that silently matches nothing passes vacuously and is worse than no test.
 * `the scan finds …` below is the guard on the guard, and it exercises both
 * branches of the scanner — direct literals AND the aliased form, which is the
 * only way the semantic commands are reachable.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const APP_RS = join(ROOT, 'src-tauri/src/app.rs');

/* -------------------------------------------------------------- registration */

/** Every command name inside `tauri::generate_handler![ … ]`. */
function registeredCommands(): string[] {
  const source = readFileSync(APP_RS, 'utf8');
  const start = source.indexOf('generate_handler![');
  if (start === -1) throw new Error('src-tauri/src/app.rs has no generate_handler! block');
  const end = source.indexOf(']', start);
  if (end === -1) throw new Error('the generate_handler! block does not close');
  const block = source.slice(start, end);
  return [...block.matchAll(/commands::(\w+)\s*,/g)].map((m) => m[1] as string);
}

/* ------------------------------------------------------------------ TS scan */

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourcesUnder(path));
    else if (/\.(ts|svelte)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

const tsSources = sourcesUnder(join(ROOT, 'src')).map((path) => ({
  path,
  text: readFileSync(path, 'utf8'),
}));

/*
 * The generic argument is matched with `[^\n]*?` rather than `[^>]*` because
 * these call sites nest: `invoke<SemanticOperationResponse<SemanticAssistResult>>(…)`.
 * A `[^>]*` stops at the inner `>` and the whole aliased branch silently
 * matches nothing — which is precisely the vacuous-scan failure this file's
 * guard test exists to catch, and did.
 */

/** `ipcInvoke('x')`, `invokeOrMock('x', …)`, `invoke('x')` — the literal form. */
const LITERAL_CALL =
  /(?:ipcInvoke|invokeOrMock|invoke)\s*(?:<[^\n]*?>)?\s*\(\s*['"`]([a-z][a-z0-9_]*)['"`]/g;

/** The same call sites, but with a non-literal first argument. */
const ALIASED_CALL =
  /(?:ipcInvoke|invokeOrMock|invoke)\s*(?:<[^\n]*?>)?\s*\(\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)?)\s*[,)]/g;

/** `const NAME = 'cmd'` and `key: 'cmd'` — one level of aliasing, as in stage-event-relay. */
function aliasTable(commands: Set<string>): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const { text } of tsSources) {
    for (const match of text.matchAll(/(?:const\s+)?([A-Za-z_$][\w$]*)\s*[:=]\s*['"`]([a-z][a-z0-9_]*)['"`]/g)) {
      const [, alias, value] = match;
      if (alias && value && commands.has(value)) aliases.set(alias, value);
    }
  }
  return aliases;
}

interface CallSites {
  direct: Map<string, string[]>;
  aliased: Map<string, string[]>;
}

function callSites(commands: Set<string>): CallSites {
  const aliases = aliasTable(commands);
  const direct = new Map<string, string[]>();
  const aliased = new Map<string, string[]>();
  const record = (into: Map<string, string[]>, command: string, path: string) => {
    const list = into.get(command) ?? [];
    list.push(path.slice(ROOT.length + 1));
    into.set(command, list);
  };

  for (const { path, text } of tsSources) {
    for (const match of text.matchAll(LITERAL_CALL)) {
      const command = match[1];
      if (command && commands.has(command)) record(direct, command, path);
    }
    for (const match of text.matchAll(ALIASED_CALL)) {
      const token = match[1];
      if (!token) continue;
      // `SEMANTIC_COMMANDS.classify` resolves through its last segment.
      const key = token.includes('.') ? (token.split('.').pop() as string) : token;
      const command = aliases.get(key) ?? aliases.get(token);
      if (command) record(aliased, command, path);
    }
  }
  return { direct, aliased };
}

/* ------------------------------------------------------------------ allowlist */

/**
 * Registered commands with no TypeScript caller, and why.
 *
 * Every entry is a decision someone has to defend. `hasBackend: true` means the
 * Rust side is real and tested — the feature works and simply is not reachable
 * from the UI, which is the shape that cost the most last time.
 */
const KNOWN_UNCALLED: Record<string, { reason: string; hasBackend: boolean }> = {
  // --- Assets
  remove_asset_reference: {
    reason:
      'The editor never detaches an image; deleting the markdown leaves the asset row and ' +
      'the file behind. Rust side implemented (assets_cmds.rs).',
    hasBackend: true,
  },

  // --- OpenAI / analysis
  get_model_capabilities: {
    reason:
      'Settings shows a static model list rather than asking Rust what the key can reach ' +
      '(openai_cmds.rs:143).',
    hasBackend: true,
  },
  analyze_vocabulary: {
    reason:
      'Vocabulary analysis (§27) is implemented in Rust but no screen requests it, so the ' +
      'transcription prompt is never primed with script-specific terms.',
    hasBackend: true,
  },

  // --- Listeners (spec §46.7)
  download_listener: {
    reason:
      'Honest stub: returns NOT_IMPLEMENTED in v1 — there is no CandidCue-controlled pack ' +
      'host (listeners_cmds.rs:37). Nothing to call.',
    hasBackend: false,
  },
  cancel_listener_download: {
    reason: 'Honest stub, paired with download_listener (listeners_cmds.rs:45).',
    hasBackend: false,
  },

  // --- Updates (spec §46.8)
  install_update: {
    reason:
      'Honest stub: NOT_IMPLEMENTED until an updater plugin is wired (§44.10, ' +
      'settings_cmds.rs:302). check_for_update IS called and maps this to "unsupported".',
    hasBackend: false,
  },
};

/* ---------------------------------------------------------------------- tests */

describe('registered commands ↔ TypeScript callers', () => {
  const registered = registeredCommands();
  const commandSet = new Set(registered);
  const { direct, aliased } = callSites(commandSet);

  it('the scan finds the registration, literal and aliased call sites it guards', () => {
    // Registration side.
    expect(registered.length).toBeGreaterThan(50);
    expect(registered).toContain('list_scripts');
    expect(registered).toContain('start_session');
    expect(new Set(registered).size, 'a command is registered twice').toBe(registered.length);

    // Literal branch.
    expect([...direct.keys()]).toContain('list_scripts');
    expect([...direct.keys()]).toContain('start_session');
    expect(direct.get('list_scripts')).toContain('src/control/services/scripts.ts');

    // Aliased branch. The semantic commands are reachable ONLY through
    // `SEMANTIC_COMMANDS.*`, so if this goes empty the alias resolution is
    // broken and every aliased command would look uncalled.
    expect([...aliased.keys()]).toContain('classify_semantic_tracking_window');
    expect([...aliased.keys()]).toContain('retrieve_semantic_landmarks');
  });

  it('every registered command has a caller or a documented reason', () => {
    const uncalled = registered.filter(
      (command) => !direct.has(command) && !aliased.has(command),
    );
    const undocumented = uncalled.filter((command) => !(command in KNOWN_UNCALLED));

    expect(
      undocumented,
      `${undocumented.length} registered command(s) have no TypeScript caller and no entry ` +
        'in KNOWN_UNCALLED. Either wire the command up, or add it with a reason — a ' +
        'working backend nothing invokes is how start_session shipped dead and the stage ' +
        'never received a tracking snapshot.',
    ).toEqual([]);
  });

  it('the allowlist does not outlive the commands it excuses', () => {
    for (const command of Object.keys(KNOWN_UNCALLED)) {
      expect(
        registered.includes(command),
        `KNOWN_UNCALLED lists "${command}", which is not registered in app.rs — delete it`,
      ).toBe(true);
      expect(
        direct.has(command) || aliased.has(command),
        `"${command}" now has a TypeScript caller (${[
          ...(direct.get(command) ?? []),
          ...(aliased.get(command) ?? []),
        ].join(', ')}) — remove its KNOWN_UNCALLED entry`,
      ).toBe(false);
    }
  });

  it('every excuse says something', () => {
    for (const [command, entry] of Object.entries(KNOWN_UNCALLED)) {
      expect(entry.reason.length, `${command} needs a real reason`).toBeGreaterThan(40);
    }
  });

  /**
   * The reverse direction: a caller naming a command Rust does not register.
   * Tauri answers that with "Command <x> not found", which `invokeOrMock`
   * converts into… nothing, because the mock backend answers instead. A typo
   * here is completely silent in the app.
   */
  it('no TypeScript call site names an unregistered command', () => {
    const invoked = new Set<string>();
    for (const { text } of tsSources) {
      for (const match of text.matchAll(
        /(?:ipcInvoke|invokeOrMock)\s*(?:<[^>]*>)?\s*\(\s*['"`]([a-z][a-z0-9_]*)['"`]/g,
      )) {
        if (match[1]) invoked.add(match[1]);
      }
    }
    // Guard on the guard.
    expect(invoked.size).toBeGreaterThan(20);
    const unknown = [...invoked].filter((command) => !commandSet.has(command));
    expect(
      unknown,
      'these commands are invoked from TypeScript but not registered in ' +
        'src-tauri/src/app.rs; the invoke fails and invokeOrMock silently serves the mock',
    ).toEqual([]);
  });

  /**
   * A summary the reader can act on. Not an assertion about a number — a count
   * threshold would just be edited when it moved — but it does assert the
   * distinction that matters: a stub with no caller is fine, a WORKING backend
   * with no caller is a feature the user cannot reach.
   */
  it('records which unreachable features have real backends', () => {
    const stranded = Object.entries(KNOWN_UNCALLED)
      .filter(([, entry]) => entry.hasBackend)
      .map(([command]) => command);
    const stubs = Object.entries(KNOWN_UNCALLED)
      .filter(([, entry]) => !entry.hasBackend)
      .map(([command]) => command);

    expect(stranded.length + stubs.length).toBe(Object.keys(KNOWN_UNCALLED).length);
    // Every stub must actually be one, so "stub" cannot become a way to park a
    // real feature out of sight.
    for (const command of stubs) {
      const rust = readFileSync(
        join(ROOT, 'src-tauri/src/commands', rustFileFor(command)),
        'utf8',
      );
      expect(
        rust.includes('not_implemented'),
        `${command} is filed as a NOT_IMPLEMENTED stub but its command body implements something`,
      ).toBe(true);
    }
  });
});

/** Which command module a command lives in — enough for the stub check above. */
function rustFileFor(command: string): string {
  if (command.includes('listener')) return 'listeners_cmds.rs';
  if (command.includes('update')) return 'settings_cmds.rs';
  throw new Error(`no module mapping for ${command}; extend rustFileFor`);
}
