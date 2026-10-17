/**
 * The network inventory, checked against the code it describes.
 *
 * `docs/network-inventory.md` is the single source of truth for every public
 * claim about what CandidCue does on the network — the README, the security
 * policy, the privacy policy, the Settings privacy section and any website page
 * are all written from it. A source of truth nothing checks is a comment.
 *
 * The pre-promotion review found the exact drift this closes: the stock build
 * compiled a since-removed remote-image importer's command out and
 * `.github/SECURITY.md` still described it as one of two live network paths.
 * Nothing was exploitable; the policy simply overstated the binary, which is
 * the direction that matters, because a reader who checks one claim and finds
 * it false stops believing the true ones.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * It is a TRIPWIRE over named primitives and named packages, read out of
 * source. It is not a proof, and the difference is worth stating precisely
 * because the version of this comment that claimed "no network path can be
 * added silently" was itself the kind of overclaim this file exists to stop.
 *
 * It cannot see a request made through a helper it does not know, a second
 * request added inside a file that is already declared, a paraphrase of a
 * banned claim, or a URL assembled at runtime. What it does is make the cheap
 * mistakes fail loudly — a new dependency, a new call site, a feature flipped
 * on, a document that drifted — so the expensive ones are the only ones left
 * for a human to find.
 *
 * The failure mode it works hardest to avoid is UNDER-reading. A scanner that
 * quietly returns half a file passes every assertion below it on nothing; one
 * that reads too much produces a noisy failure somebody investigates. So
 * `maskRustLiterals` and `withoutTestModules` throw on an unterminated literal,
 * comment or module rather than guessing, the frontend primitive scan runs on
 * raw source where a false hit is only noise, and the phrase bans — where a
 * missed match costs nothing but a weaker prose check — are the only place
 * comments are stripped.
 *
 * One case it cannot decide: `'x` is a lifetime and `'x'` is a character, and
 * an unterminated character literal is indistinguishable from the former. It is
 * read as a lifetime, which over-reads rather than under-reads.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INVENTORY = 'docs/network-inventory.md';

const read = (relPath: string) => readFileSync(join(REPO_ROOT, relPath), 'utf8');
const inventory = read(INVENTORY);

/* ------------------------------------------------------- reading Rust source */

/**
 * Blank out everything in Rust source that is not code: comments, strings,
 * char literals, raw strings and byte strings.
 *
 * Length is preserved (contents become spaces) so offsets still line up. The
 * reason this exists at all is that everything below counts braces or matches
 * patterns, and Rust is full of `'{'`, `"}"`, `// see reqwest::Client` and
 * `r#"…"#`. Counting those is how a brace matcher walks off the end of a module
 * and deletes the production code after it — silently, because the result is
 * still a plausible-looking string.
 *
 * Nested block comments are handled because Rust allows them. An unterminated
 * literal or comment THROWS: it means either the file is not valid Rust or this
 * scanner has met a form it does not know, and both are reasons to stop rather
 * than to return a shorter file.
 */
const RAW_STRING = /(?:[bc]?r)(#*)"/y;

export function maskRustLiterals(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (two === '/*') {
      let depth = 0;
      let j = i;
      for (; j < source.length; j += 1) {
        if (source.slice(j, j + 2) === '/*') {
          depth += 1;
          j += 1;
        } else if (source.slice(j, j + 2) === '*/') {
          depth -= 1;
          j += 1;
          if (depth === 0) {
            j += 1;
            break;
          }
        }
      }
      if (depth !== 0) throw new Error(`unterminated block comment at offset ${i}`);
      blank(i, j);
      i = j;
      continue;
    }
    /*
     * Raw strings: r"…", r#"…"#, br##"…"##, cr#"…"#. The hash count closes it.
     *
     * Matched STICKY against the whole source rather than against a fixed
     * window. A window is a silent under-read waiting to happen: miss a raw
     * string with many hashes and the ordinary quote scanner below pairs that
     * literal's closing quote with the NEXT literal's opening one, blanking
     * every line between them and returning a shorter file that still looks
     * like Rust.
     */
    RAW_STRING.lastIndex = i;
    const raw = RAW_STRING.exec(source);
    if (raw && (i === 0 || !/[\w]/.test(source[i - 1]!))) {
      const close = `"${raw[1]}`;
      const start = i + raw[0].length;
      const end = source.indexOf(close, start);
      if (end === -1) throw new Error(`unterminated raw string at offset ${i}`);
      blank(i, end + close.length);
      i = end + close.length;
      continue;
    }
    // c"…" is a C string; its body is a literal like any other.
    if (source[i] === '"' || (source[i] === 'c' && source[i + 1] === '"' && !/[\w]/.test(source[i - 1] ?? ''))) {
      if (source[i] === 'c') i += 1;
      let j = i + 1;
      for (; j < source.length; j += 1) {
        if (source[j] === '\\') {
          j += 1;
          continue;
        }
        if (source[j] === '"') break;
      }
      if (j >= source.length) throw new Error(`unterminated string at offset ${i}`);
      blank(i, j + 1);
      i = j + 1;
      continue;
    }
    if (source[i] === "'") {
      /*
       * A char literal or a lifetime, and telling them apart is the whole
       * difficulty: `'static` opens a quote that never closes, so treating it
       * as a literal swallows the rest of the file. A lifetime is `'` followed
       * by an identifier that is NOT then followed by `'`.
       */
      const rest = source.slice(i);
      const charLit = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|.)|[^\\'])'/.exec(rest);
      if (charLit) {
        blank(i, i + charLit[0].length);
        i += charLit[0].length;
        continue;
      }
      i += 1; // a lifetime, or a label — ordinary code
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * The file with its `#[cfg(test)]` modules removed, on masked source.
 *
 * Test code is not a shipping network path. The obvious "cut at the first
 * `#[cfg(test)]`" is wrong: `net.rs` carries `#[cfg(test)]` on a struct FIELD
 * a long way above the code being scanned, so cutting there truncates the file
 * and stops seeing the only client construction in the tree — an assertion
 * that then passes on nothing.
 *
 * Nested `#[cfg(test)] mod` blocks are handled by only ever moving forwards; a
 * match inside an already-removed region is skipped rather than rewinding the
 * cursor. An unbalanced module THROWS, for the same reason as above.
 */
export function withoutTestModules(masked: string): string {
  const MODULE = /#\[cfg\(test\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/g;
  let out = '';
  let cursor = 0;
  for (const match of masked.matchAll(MODULE)) {
    const start = match.index!;
    if (start < cursor) continue; // inside a module already removed
    out += masked.slice(cursor, start);
    let depth = 0;
    let i = start + match[0].length - 1; // at the opening brace
    let closed = false;
    for (; i < masked.length; i += 1) {
      if (masked[i] === '{') depth += 1;
      else if (masked[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          closed = true;
          break;
        }
      }
    }
    if (!closed) throw new Error(`unbalanced #[cfg(test)] module at offset ${start}`);
    cursor = i + 1;
  }
  return out + masked.slice(cursor);
}

/** Shipping Rust: the app, and the crates it links. Benchmarks are not shipped. */
const SHIPPING_RUST_DIRS = ['src-tauri/src', 'crates/cc-align/src', 'crates/cc-stt/src'];

/** Every `.rs` file under a directory, repo-relative and POSIX-separated. */
function rustFiles(relDir: string): string[] {
  const abs = join(REPO_ROOT, relDir);
  return readdirSync(abs, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.rs'))
    .map((entry) => relative(REPO_ROOT, join(abs, entry)).split('\\').join('/'))
    .sort();
}

/**
 * The shared outbound-HTTP discipline. Every caller goes through it, so it is
 * the one file allowed to build a client without being a network path itself.
 */
const TRANSPORT = 'src-tauri/src/net.rs';

/**
 * Ways Rust code can start talking to something outside this machine.
 *
 * Named forms, not a proof — a helper this list does not know still evades it.
 * The list is what the tree could plausibly grow, ordered roughly by how likely
 * somebody is to reach for it.
 */
const OUTBOUND_RUST = [
  /reqwest::(?:Client|ClientBuilder|get|post|blocking)\b/,
  /net::client_for\s*\(/,
  /\bureq::/,
  /\bhyper::(?:Client|client)\b/,
  /\bTcpStream::connect\b/,
  /\bUdpSocket::bind\b/,
  /tokio::net::(?:TcpStream|UdpSocket)\b/,
  /tauri_plugin_http\b/,
];

const usesOutboundRust = (code: string) => OUTBOUND_RUST.some((pattern) => pattern.test(code));

/* ----------------------------------------------------- reading the inventory */

/**
 * The inventory names its callers in a table of backticked paths. Parsing them
 * out — rather than repeating the list here — is what makes the document
 * authoritative instead of merely parallel.
 *
 * Table ROWS only. The prose around the table names `net.rs` as the shared
 * discipline, and reading that as a caller would add the transport to the
 * allowed set from the wrong direction.
 */
function declaredCallers(): string[] {
  const section = inventory.split('### The files that reach the network')[1] ?? '';
  const table = section.split('\n---')[0] ?? '';
  const rows = table.split('\n').filter((line) => line.trim().startsWith('|'));
  return [...rows.join('\n').matchAll(/`(src-tauri\/src\/[^`]+\.rs)`/g)]
    .map((match) => match[1]!)
    .filter((relPath) => relPath !== TRANSPORT)
    .sort();
}

/** Frontend files the inventory declares as using a web primitive, with a reason. */
function declaredFrontendFetches(): string[] {
  const section = inventory.split('### The one fetch in the frontend')[1] ?? '';
  const table = section.split('\n---')[0] ?? '';
  const rows = table.split('\n').filter((line) => line.trim().startsWith('|'));
  return [...rows.join('\n').matchAll(/`(src\/[^`]+\.(?:ts|svelte))`/g)]
    .map((match) => match[1]!)
    .sort();
}

/** The bullets under "Not accurate, and not to be written anywhere". */
function bannedBullets(): string[] {
  const section = inventory.split('**Not accurate, and not to be written anywhere:**')[1] ?? '';
  const list = section.split('\n---')[0] ?? '';
  return [...list.matchAll(/^-\s+("[^"]+")/gm)].map((match) => match[1]!);
}

/* ------------------------------------------------------------- the call sites */

describe('outbound network call sites', () => {
  it('the inventory names at least one caller', () => {
    // Without this, the parity assertion below would pass vacuously the moment
    // somebody reformatted the table or renamed its heading.
    expect(
      declaredCallers(),
      `${INVENTORY} declares no caller paths. Either the table was rewritten ` +
        `or its heading changed and the parser here has rotted — fix the ` +
        `parser, because the check below is worthless until this is non-empty.`,
    ).not.toEqual([]);
  });

  it('every shipping Rust file that reaches the network is named in the inventory', () => {
    const scanned = SHIPPING_RUST_DIRS.flatMap(rustFiles);
    expect(scanned.length, 'the Rust scan found almost no files').toBeGreaterThan(30);

    const found = scanned.filter((relPath) =>
      usesOutboundRust(withoutTestModules(maskRustLiterals(read(relPath)))),
    );

    // The scan finding nothing would satisfy every assertion below it, so the
    // one file guaranteed to construct a client has to turn up first.
    expect(
      found,
      `The call-site scan did not find ${TRANSPORT}, which builds the one HTTP ` +
        `client in the application. Either the transport moved, its client ` +
        `construction was rewritten into a form OUTBOUND_RUST does not know, ` +
        `or the masking is eating real code. Until this is fixed the whole ` +
        `file passes on an empty set.`,
    ).toContain(TRANSPORT);

    const allowed = new Set([TRANSPORT, ...declaredCallers()]);
    const undeclared = found.filter((relPath) => !allowed.has(relPath));

    expect(
      undeclared,
      `These files reach the network and ${INVENTORY} does not name them:\n` +
        undeclared.map((relPath) => `  ${relPath}`).join('\n') +
        `\n\nA new outbound path changes what the privacy policy, the security ` +
        `policy and the website all have to say. Add it to the inventory's ` +
        `caller table and revise the surfaces listed there — do not add it here.`,
    ).toEqual([]);
  });

  it('the callers the inventory names still exist and still reach the network', () => {
    // The other direction. A caller that was deleted or rewritten leaves the
    // inventory describing a network path the product no longer has, which is
    // the same defect pointing the other way.
    const missing: string[] = [];
    const quiet: string[] = [];
    for (const relPath of declaredCallers()) {
      let source: string;
      try {
        source = read(relPath);
      } catch {
        missing.push(relPath);
        continue;
      }
      if (!usesOutboundRust(withoutTestModules(maskRustLiterals(source)))) quiet.push(relPath);
    }

    expect(
      missing,
      `${INVENTORY} names these caller files and they are not in the tree:\n` +
        missing.map((relPath) => `  ${relPath}`).join('\n') +
        `\n\nIf the path was removed, remove its row too — an inventory that ` +
        `overstates the binary is the defect this file exists for.`,
    ).toEqual([]);

    expect(
      quiet,
      `${INVENTORY} names these as network callers and no outbound primitive ` +
        `is visible in them:\n` +
        quiet.map((relPath) => `  ${relPath}`).join('\n') +
        `\n\nTwo possibilities, and they need different fixes: the path really ` +
        `was removed, in which case delete the row; or it was rewritten into a ` +
        `form OUTBOUND_RUST does not recognise, in which case teach the ` +
        `pattern list about it. Do not delete the row to make this pass.`,
    ).toEqual([]);
  });

  /**
   * The frontend half. The CSP blocks a remote origin, but a CSP is a runtime
   * control on a file nobody re-reads; a `fetch` appearing in the control
   * window is a decision worth surfacing at review time.
   */
  it('the frontend uses no outbound web primitive', () => {
    const WEB = /\bfetch\s*\(|XMLHttpRequest|new WebSocket\b|new EventSource\b|sendBeacon\b/;
    const files = ['src/control', 'src/stage', 'src/shared', 'src/workers'].flatMap((dir) => {
      const abs = join(REPO_ROOT, dir);
      return readdirSync(abs, { recursive: true, encoding: 'utf8' })
        .filter((entry) => /\.(ts|svelte)$/.test(entry) && !entry.includes('.test.'))
        .map((entry) => relative(REPO_ROOT, join(abs, entry)).split('\\').join('/'));
    });
    expect(files.length, 'the frontend scan found almost no files').toBeGreaterThan(50);

    /*
     * Raw source, comments included. `stripSourceComments` is a regex pass, and
     * a string containing an opening block-comment marker followed later by
     * another containing the closing one would delete the code between them —
     * silently, and in the one scan where silence means "no network path found".
     * A `fetch` mentioned in a comment fails this instead, which is a noisy
     * false alarm somebody reads.
     */
    const found = files.filter((relPath) => WEB.test(read(relPath)));
    const declared = declaredFrontendFetches();
    expect(
      declared,
      `${INVENTORY} declares no frontend fetch, and the tree has one. Either ` +
        `the section was renamed and the parser here has rotted, or a file was ` +
        `removed without its row.`,
    ).not.toEqual([]);

    const undeclared = found.filter((relPath) => !declared.includes(relPath));
    expect(
      undeclared,
      `These frontend files use a network primitive and ${INVENTORY} does not ` +
        `name them:\n` +
        undeclared.map((relPath) => `  ${relPath}`).join('\n') +
        `\n\nThe webviews are supposed to reach nothing but Tauri IPC. If this ` +
        `is deliberate, it is a row in the inventory's frontend table — with ` +
        `the reason it is not a network path — and a revision to the privacy ` +
        `policy before it is a code review.`,
    ).toEqual([]);

    const stale = declared.filter((relPath) => !found.includes(relPath));
    expect(
      stale,
      `${INVENTORY} names these frontend files as fetching and they no longer ` +
        `do:\n` + stale.map((relPath) => `  ${relPath}`).join('\n') +
        `\n\nRemove the row. An inventory that overstates the binary is the ` +
        `defect this file exists for.`,
    ).toEqual([]);
  });
});

/* ------------------------------------------------- no image is fetched by URL */

describe('no image is fetched by URL', () => {
  /*
   * There used to be a URL-based image importer, compiled into every build with
   * only its command gated off, and every privacy claim had to footnote it. It
   * was deleted rather than kept dormant. Bringing it back is a new network
   * path, so it has to arrive through the inventory, not past it.
   */
  const IMPORTER = /\b(?:import_remote_image|fetch_remote_image)\b/;

  it('the shipping Rust has no importer and no build switch for one', () => {
    const scanned = SHIPPING_RUST_DIRS.flatMap(rustFiles);
    expect(scanned.length, 'the Rust scan found almost no files').toBeGreaterThan(30);

    const found = scanned.filter((relPath) =>
      IMPORTER.test(withoutTestModules(maskRustLiterals(read(relPath)))),
    );
    expect(
      found,
      `These files define or call a URL-based image importer:\n` +
        found.map((relPath) => `  ${relPath}`).join('\n') +
        `\n\n${INVENTORY} says no image is fetched by URL, and the privacy ` +
        `policy and .github/SECURITY.md say the same. Revise them first.`,
    ).toEqual([]);

    expect(
      read('src-tauri/Cargo.toml'),
      `src-tauri/Cargo.toml mentions remote-images again. A feature that gates ` +
        `a network path is one the inventory has to describe — see ${INVENTORY}.`,
    ).not.toMatch(/remote-images/);
  });

  it('no permission grants the importer’s command', () => {
    const permissions = read('src-tauri/permissions/app-commands.toml');
    expect(
      permissions.includes('import_remote_image'),
      `import_remote_image appears in src-tauri/permissions/app-commands.toml. ` +
        `A permission entry is half of making a command reachable from the ` +
        `control window — see ${INVENTORY}.`,
    ).toBe(false);
  });
});

/* ------------------------------------------------------------- the model hosts */

describe('the model catalogue', () => {
  it('names no host the inventory does not', () => {
    const catalogue = JSON.parse(read('src-tauri/models/catalogue.json')) as {
      mirrorBaseUrl: string | null;
      models: { id: string; archive: { upstreamUrl: string } }[];
    };
    expect(catalogue.models.length, 'the catalogue parsed to no models').toBeGreaterThan(0);

    const hosts = new Set<string>();
    if (catalogue.mirrorBaseUrl) hosts.add(new URL(catalogue.mirrorBaseUrl).hostname);
    for (const model of catalogue.models) hosts.add(new URL(model.archive.upstreamUrl).hostname);

    const unnamed = [...hosts].filter((host) => !inventory.includes(host));
    expect(
      unnamed,
      `The speech-model catalogue points at hosts ${INVENTORY} does not name:\n` +
        unnamed.map((host) => `  ${host}`).join('\n') +
        `\n\nThe host a download contacts is a privacy fact, and the policy ` +
        `names it. Add the host to the inventory and to legal/PRIVACY_POLICY.md ` +
        `together.`,
    ).toEqual([]);
  });
});

/* ---------------------------------------------------------------- dependencies */

describe('nothing arrives that phones home on the app’s behalf', () => {
  /**
   * Named packages rather than a heuristic. The point is not to catch a
   * determined author — it is that adding one of these is a decision somebody
   * makes on purpose, and this is where they are reminded that the privacy
   * policy is a document with their name on it.
   */
  const FORBIDDEN = [
    'tauri-plugin-updater',
    'tauri-plugin-http',
    'sentry',
    'posthog',
    'mixpanel',
    'amplitude',
    'segment-analytics',
    '@sentry/',
    'bugsnag',
    'crashlytics',
    'datadog',
  ];

  const manifests = [
    'src-tauri/Cargo.toml',
    'crates/Cargo.toml',
    'crates/cc-align/Cargo.toml',
    'crates/cc-stt/Cargo.toml',
    'package.json',
  ];

  it('has something to check', () => {
    // `it.each` over an empty array registers no tests and reports success.
    expect(FORBIDDEN.length).toBeGreaterThan(5);
    expect(manifests.length).toBeGreaterThan(3);
  });

  it.each(manifests)('%s declares no updater, analytics or crash-reporting client', (relPath) => {
    const source = read(relPath);
    const present = FORBIDDEN.filter((name) => source.includes(name));
    expect(
      present,
      `${relPath} pulls in ${present.join(', ')}. CandidCue 1.0 makes no ` +
        `background network request of any kind (${INVENTORY}), and the ` +
        `security policy and the privacy policy both say so in as many words.`,
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------- the documents */

/**
 * Source with its comments removed, so a ban is about what a reader sees.
 *
 * The scoping matters. An HTML comment is a comment anywhere in Svelte or
 * Markdown. A double slash is a code comment only when it opens the line —
 * anchored, because an https URL in ordinary prose contains one and an
 * unanchored rule would delete the rest of that sentence. Markdown gets only
 * the HTML-comment pass.
 */
function stripSourceComments(relPath: string): string {
  const source = read(relPath);
  if (relPath.endsWith('.md')) return source.replace(/<!--[\s\S]*?-->/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

describe('the surfaces that describe the network', () => {
  /**
   * Engineering surfaces only. The published legal documents deliberately do
   * not cite repository paths — a privacy policy that tells a reader to consult
   * `docs/` is written for the wrong person — so their agreement is enforced by
   * the phrase ban below rather than by a link.
   */
  const LINKED = ['README.md', '.github/SECURITY.md', 'docs/updates.md'];

  it('has something to check', () => {
    expect(LINKED.length).toBeGreaterThan(2);
  });

  it.each(LINKED)('%s points at the inventory', (relPath) => {
    expect(
      stripSourceComments(relPath).includes('network-inventory.md'),
      `${relPath} describes what CandidCue does on the network without ` +
        `pointing at ${INVENTORY}. Two descriptions with no link between them ` +
        `is exactly how the last one went stale.`,
    ).toBe(true);
  });
});

describe('claims the inventory bans', () => {
  /**
   * Each rule carries the bullet it enforces, and the two lists are compared in
   * both directions — by prefix, so the document's line may carry a trailing
   * clause the rule's label does not. That is what keeps them honest: the code
   * cannot quietly enforce more than the document says, and — the failure that
   * actually happened — the document cannot quietly grow a bullet no rule
   * covers.
   */
  const BANNED: { pattern: RegExp; bullet: string }[] = [
    { pattern: /never uses the internet/i, bullet: '"CandidCue never uses the internet."' },
    { pattern: /nothing (ever )?leaves your/i, bullet: '"Nothing ever leaves your computer."' },
    { pattern: /completely offline/i, bullet: '"Completely offline from first launch."' },
    { pattern: /(there is )?no network code/i, bullet: '"There is no network code."' },
    { pattern: /\bautomatic updates\b/i, bullet: '"Automatic updates."' },
    {
      pattern: /support bundle can never contain/i,
      bullet: '"A support bundle can never contain your prose"',
    },
  ];

  const SCANNED = [
    'README.md',
    '.github/SECURITY.md',
    'docs/updates.md',
    'CHANGELOG.md',
    'legal/PRIVACY_POLICY.md',
    'src/control/routes/Settings.svelte',
    'src/control/routes/Welcome.svelte',
    'src/control/components/SpeechLanguagePicker.svelte',
    // The About box's one-line description of the product is a privacy claim
    // in the place a user is most likely to read one.
    'src-tauri/src/menu.rs',
  ];

  it('the rules and the document describe the same list', () => {
    const bullets = bannedBullets();
    expect(
      bullets.length,
      `${INVENTORY} lists no banned claims. Either the section was removed or ` +
        `its heading changed and the parser here has rotted — every assertion ` +
        `below is vacuous until this is non-empty.`,
    ).toBeGreaterThan(3);

    // Bullets are matched by prefix: the document's line may carry a trailing
    // clause ("— see …") that the rule's label does not.
    const uncovered = bullets.filter(
      (bullet) => !BANNED.some((rule) => bullet.startsWith(rule.bullet.slice(0, -1))),
    );
    expect(
      uncovered,
      `${INVENTORY} bans these and no rule in this file enforces them:\n` +
        uncovered.map((bullet) => `  ${bullet}`).join('\n') +
        `\n\nAdd a pattern, or drop the bullet. A banned claim nothing checks ` +
        `is the state this whole file was written to end.`,
    ).toEqual([]);

    const unexplained = BANNED.filter(
      (rule) => !bullets.some((bullet) => bullet.startsWith(rule.bullet.slice(0, -1))),
    ).map((rule) => rule.bullet);
    expect(
      unexplained,
      `This file bans phrases ${INVENTORY} no longer lists:\n` +
        unexplained.map((bullet) => `  ${bullet}`).join('\n') +
        `\n\nRestore the bullet or drop the rule — one of them is now ` +
        `unexplained, and the next person to hit it will not know which.`,
    ).toEqual([]);
  });

  it('every rule can still match something', () => {
    // A pattern that matches nothing is a rule switched off by a typo.
    const dead = BANNED.filter((rule) => !rule.pattern.test(rule.bullet)).map((rule) => rule.bullet);
    expect(
      dead,
      `These patterns do not match their own bullet, so they cannot match a ` +
        `document either:\n` + dead.map((bullet) => `  ${bullet}`).join('\n'),
    ).toEqual([]);
  });

  it('has something to scan', () => {
    expect(SCANNED.length).toBeGreaterThan(5);
  });

  it.each(SCANNED)('%s makes none of them', (relPath) => {
    const source = stripSourceComments(relPath);
    const broken = BANNED.filter(({ pattern }) => pattern.test(source)).map((rule) => {
      const hit = pattern_hit(source, rule.pattern);
      return `${rule.bullet}  — matched: “${hit}”`;
    });
    expect(
      broken,
      `${relPath} uses wording ${INVENTORY} rules out:\n` +
        broken.map((line) => `  ${line}`).join('\n') +
        `\n\nThe accurate forms are in the same section of the inventory. Each ` +
        `of these is false about a build that downloads a speech model.`,
    ).toEqual([]);
  });
});

/** The matched text with a little context, so the reader does not have to grep. */
function pattern_hit(source: string, pattern: RegExp): string {
  const match = pattern.exec(source);
  if (!match) return '';
  const from = Math.max(0, match.index - 30);
  return source.slice(from, match.index + match[0].length + 30).replace(/\s+/g, ' ');
}

/* --------------------------------------------- the scanners scan what they say */

describe('the Rust scanners', () => {
  /*
   * Fixtures, because these two functions are where this gate can be silently
   * wrong. Everything above them reports on what they return, so a masker that
   * eats a file or a stripper that walks off the end turns every assertion into
   * a pass — the exact failure the rest of this file exists to prevent.
   */
  it('does not let a brace inside a literal or a comment move the depth', () => {
    const source = [
      '#[cfg(test)]',
      'mod tests {',
      "    const OPEN: char = '{';",
      '    const SHUT: &str = "}";',
      '    // a stray } in a comment',
      '    const RAW: &str = r#"{{{"#;',
      '}',
      'pub fn reaches() { let _ = reqwest::Client::new(); }',
    ].join('\n');
    const shipping = withoutTestModules(maskRustLiterals(source));
    expect(shipping).toContain('pub fn reaches');
    expect(usesOutboundRust(shipping)).toBe(true);
  });

  it('keeps a lifetime from opening a character literal', () => {
    const source = "pub fn hold<'a>(s: &'a str) -> &'a str { s }\npub const N: u8 = 1;";
    expect(maskRustLiterals(source)).toContain('pub const N');
  });

  it('removes a test module and everything a test module says', () => {
    const source = [
      'pub fn quiet() {}',
      '#[cfg(test)]',
      'mod tests {',
      '    fn probe() { let _ = reqwest::Client::new(); }',
      '    mod deeper { fn also() { let _ = ureq::get("x"); } }',
      '}',
      'pub fn also_quiet() {}',
    ].join('\n');
    const shipping = withoutTestModules(maskRustLiterals(source));
    expect(usesOutboundRust(shipping)).toBe(false);
    expect(shipping).toContain('pub fn also_quiet');
  });

  it('refuses a module it cannot close rather than truncating the file', () => {
    expect(() => withoutTestModules('#[cfg(test)]\nmod tests {\n  fn a() {\n')).toThrow(
      /unbalanced/,
    );
  });

  it('closes a raw string however many hashes it uses', () => {
    /*
     * The window this used to look through was 16 characters, so a long
     * delimiter was missed — and a missed raw string is not a missed match, it
     * is a shifted one: the plain-quote scanner then pairs this literal's
     * closing quote with the next literal's opening quote and blanks everything
     * between. Two literals, one line of production code between them, is the
     * whole reproduction.
     */
    const source = [
      'pub const A: &str = r####"a " quote"####;',
      'pub fn reaches() { let _ = reqwest::Client::new(); }',
      'pub const B: &str = r####"another " quote"####;',
    ].join('\n');
    expect(usesOutboundRust(maskRustLiterals(source))).toBe(true);
  });

  it('masks a C string like any other literal', () => {
    const source = 'pub const A: &CStr = c"reqwest::Client::new(";\npub const N: u8 = 1;';
    expect(usesOutboundRust(maskRustLiterals(source))).toBe(false);
    expect(maskRustLiterals(source)).toContain('pub const N');
  });
});
