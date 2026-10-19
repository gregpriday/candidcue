/**
 * A stand-in for a command-line tool, put early on PATH, that works on every
 * platform the gate tests run on.
 *
 * The release-gate and advisory tests replace `cargo` and `pnpm` with fakes
 * that print the shapes the real tools print. Those fakes used to be
 * `#!/bin/sh` scripts, which Windows cannot execute: the script under test then
 * reached past the fake to the next `cargo` on PATH — the real one, refusing a
 * scratch tree with no Cargo.toml in it — and every assertion failed for a
 * reason that had nothing to do with the gate.
 *
 * So a fake's BEHAVIOUR is a JavaScript module run by the node running this
 * suite, and only its launcher is per-platform: an executable `sh` script that
 * `exec`s node, or on Windows a `.cmd` file, which is what the scripts find
 * when they reach their tools through cmd.exe (`throughCmd` in
 * scripts/generate-notices.mjs). Either way the fake answers to the bare name
 * the script asks for, exactly as the real tool does.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** POSIX single-quoting: everything literal, an embedded `'` closed and reopened. */
const shQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Install `name` in `bin`, behaving as `source` — the text of an ES module
 * that reads its arguments from `process.argv.slice(2)` and answers on
 * stdout, stderr and its exit code.
 */
export function fakeTool(bin: string, name: string, source: string): void {
  const entry = join(bin, `${name}.fake.mjs`);
  writeFileSync(entry, source);
  if (process.platform === 'win32') {
    // `%~dp0` is the directory the .cmd file is in; `%*` passes every argument
    // through as cmd.exe received it.
    writeFileSync(
      join(bin, `${name}.cmd`),
      `@"${process.execPath}" "%~dp0${name}.fake.mjs" %*\r\n@exit /b %ERRORLEVEL%\r\n`,
    );
  } else {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(entry)} "$@"\n`,
      { mode: 0o755 },
    );
  }
}

/**
 * The environment that points a child's home directory at `dir`.
 *
 * `HOME` alone is not enough: Node's `os.homedir()` reads USERPROFILE on
 * Windows and ignores HOME there, so a test that set only HOME would quietly be
 * a test of the real home directory of whoever ran it.
 */
export function homeAt(dir: string): NodeJS.ProcessEnv {
  return { HOME: dir, USERPROFILE: dir };
}
