# What CandidCue does on the network

**This file is the source of truth for every public network claim.** The README,
the security policy, the privacy policy, the Settings privacy section, the
onboarding copy and anything written on a website all describe the same
application, and the way they stay in agreement is that they are all written
from this table rather than from memory.

The 1.0 pre-promotion review found the failure this is for: the stock build
compiles the remote-image importer's command out, and the security policy still
described it as one of two live network paths. Nothing was exploitable — the
policy simply overstated the binary, which is the direction that matters,
because a reader who checks a claim and finds it false stops believing the true
ones.

Everything below is the **current** behaviour of a stock 1.0 build, not a plan.

---

## The inventory

| Activity | Shipping status | Trigger | What is sent | Host | User control |
|---|---|---|---|---|---|
| Speech-model download | **Active** | The user starts it from the Welcome screen or Settings › Speech | Ordinary HTTPS request metadata and no body: a DNS lookup for the host, a TLS handshake carrying the host name, and a `GET` for the archive with the user's IP address, `User-Agent: CandidCue/<version>`, and `Range` with the server's own `If-Range` validator when a partial download is resumed. No script, audio or transcript, and no account or device identifier — the IP address and the version in the User-Agent are the identifying things any HTTPS request carries | The mirror named by the catalogue if one is configured, then the model publisher's own release hosting (`github.com`) — plus any host those redirect to; see below | Start, cancel, remove; the app works without it, without following |
| Remote-image import | **No command in this build** | None. The IPC command is compiled out, so nothing can call it | Nothing | None | Not exposed |
| Application update checks | **None** | None. There is no updater and no endpoint to check | Nothing | None | Updates are downloaded manually from the project's GitHub releases (`docs/updates.md`) |
| Analytics / product telemetry | **None** | — | — | — | — |
| Automatic crash-report upload | **None** | — | — | — | Crashes leave local log lines, which go nowhere unless the user exports a support bundle |
| Licence checks / registration | **None** | Registration is honour-system; nothing verifies it | — | — | — |
| Speech recognition | **On device** | A take, or the microphone test | Nothing leaves the machine | — | Start and stop |
| Alignment / following | **On device** | A take | Nothing leaves the machine | — | — |
| Support-bundle upload | **Never automatic** | The user exports a folder and chooses what to do with it | Whatever the bundle contains, to whoever the user sends it to | The user's own support channel | Explicit, and the bundle can be inspected before it is sent |
| Links out of the app | **Handed to the browser** | The user picks a Help-menu destination, or the model's licence link in the speech picker | CandidCue makes no request; macOS opens the URL in the default browser, which then behaves like a browser — with its own cookies, its own DNS and its own idea of privacy | `github.com/gregpriday/candidcue` for the Help destinations (`src-tauri/src/web.rs`), or the licence URL the model catalogue declares | Clicking it |

### Redirects, and why "the host" is not a promise

`model_download.rs` follows redirects by hand, revalidating every hop through
`net::check_hop` — HTTPS only, no credentials in the URL, and every resolved
address must be publicly routable. What it does **not** have is a host
allow-list. A redirect from the catalogue URL can therefore land on a host this
table does not name.

That is a deliberate trade and it is worth stating plainly rather than papering
over: hosting moves, and a download that breaks because a publisher switched CDN
is a worse failure than one that contacts a CDN. What protects the *user* is not
the host but the digest — the archive is checked against a SHA-256 compiled into
the binary, and a substituted file is rejected wherever it came from.

So the honest public claim is "the download goes to the host named in the app,
and to wherever that host redirects it", never "it only ever contacts GitHub".

### Reading the "no command in this build" row

`remote-images` is a Cargo feature that is **not** in any default set
(`src-tauri/Cargo.toml`). With it off:

- `commands::assets_cmds::import_remote_image` — the IPC command — does not
  exist in the binary; it is behind `#[cfg(feature = "remote-images")]`;
- it is not in the command registry in `src-tauri/src/app.rs`;
- it is not in `src-tauri/permissions/app-commands.toml`, so the control
  window's `allow-control-commands` grant does not cover it;
- the compiler marks a remote image URL as remote and warns; the asset resolver
  then has nothing local to hand the renderer, so the image does not load.

What is **not** true is that the implementation is gone. `assets::remote` and
`assets::import_remote_image` compile unconditionally, and whether their code
survives into the executable is up to optimisation and linking. The precise
claim is that the app exposes no way to reach them — not that the bytes are
absent.

Turning the feature on is a deliberate act that has to add the command to the
registry, to the permissions file and to a UI — and to revise this table and the
privacy policy first.

### The files that reach the network

Both go through `src-tauri/src/net.rs`, which is the only outbound-HTTP
discipline in the **application**: HTTPS only, no credentials in the URL, no
proxy, no cookies, no referer, redirects disabled in the client and revalidated
by hand, every resolved address checked as publicly routable and then pinned so
a DNS rebind cannot move the target.

| Caller | Reachable in a stock build? |
|---|---|
| `src-tauri/src/speech/model_download.rs` | Yes — the model download |
| `src-tauri/src/assets/remote.rs` | No — `remote-images` is off |

Development and build tooling is a different question and does reach the
network: `crates/cc-bench` synthesises benchmark speech through a hosted TTS
API, `scripts/fetch-stt-model.sh` shells out to `curl`, and `sherpa-onnx-sys`
downloads a prebuilt native library **at build time** — which is why
`scripts/verify-supply-chain.mjs native` records what it fetched. None of it is
in the application and none of it runs on a user's machine; they are named here
so that "nothing else in the tree makes a request" is not claimed by omission.

The webviews reach nothing remote: the single CSP in
`src-tauri/tauri.conf.json` gives every window `connect-src 'self' ipc:
http://ipc.localhost`, `img-src 'self' asset: blob: data:`, `frame-src 'none'`
and `object-src 'none'`, so no fetch, socket or subresource can name a remote
origin. That is a statement about fetches and subresources, not about top-level
navigation, which a CSP `connect-src` does not govern.

### The one fetch in the frontend

| File | What it fetches | Why it is not a network path |
|---|---|---|
| `src/stage/preview.ts` | A follow fixture, by URL, in `startFixtureReplay` | It runs only under `?preview=1&replay=…`, which is how the browser suite drives the stage against the Vite dev server. Rust builds the stage window's URL and never sets either parameter, and `connect-src 'self'` means the request could not leave the origin even if it did |

It is listed rather than excluded on purpose. "There is no `fetch` in the
frontend" would be a false sentence, and the gate that enforced it would have to
be taught to look away — which is how a second one gets added later without
anybody noticing.

---

## The wording that follows from it

Precision here is not pedantry. "Offline" and "the model download" are both
true, and only one sentence is both.

**Accurate:**

- "Speech recognition and following run on your Mac."
- "CandidCue does not upload your microphone audio or your scripts."
- "The speech model is downloaded when you choose to install it."
- "CandidCue 1.0 does not check for application updates."
- "Support bundles are created only when you ask for one, and go only where you
  send them."
- "No account, no API key, no analytics client, no crash reporter."

**Not accurate, and not to be written anywhere:**

- "CandidCue never uses the internet."
- "Nothing ever leaves your computer."
- "Completely offline from first launch."
- "There is no network code."
- "Automatic updates."
- "A support bundle can never contain your prose" — see
  `src/control/lib/diagnostics-format.ts` for what is actually promised.

---

## Surfaces that have to agree with this file

These describe the network to a reader and are checked against this file:

- `README.md`
- `.github/SECURITY.md`
- `docs/updates.md`
- `CHANGELOG.md`, which is published verbatim as the release notes
- `legal/PRIVACY_POLICY.md`
- Settings › Data, privacy & updates (`src/control/routes/Settings.svelte`)
- The Welcome screen (`src/control/routes/Welcome.svelte`) and the speech
  picker inside it (`src/control/components/SpeechLanguagePicker.svelte`)
- The About box (`src-tauri/src/menu.rs`)
- Any website page describing privacy, features or system requirements

The three engineering documents — README, security policy and updates — also
have to **link** here, so a reader who wants the whole picture can find it. The
published legal documents deliberately do not cite repository paths: a privacy
policy that tells a reader to consult `docs/` is written for the wrong person.

## How this stays true

`tests/integration/network-inventory.test.ts` is the mechanical half. It fails
when:

- a file in the shipping Rust or the frontend uses an outbound network
  primitive that this file's caller table does not name;
- the remote-image command loses its `#[cfg]`, gains a default feature (directly
  or through another feature), enters the command registry, or enters the
  permissions file, while this file calls it absent;
- one of a named list of updaters, analytics SDKs and crash reporters is
  declared in a manifest the app or its crates build from — a list of names in
  direct manifests, not a proof about the dependency graph;
- the model catalogue names a host this file does not;
- README, the security policy or `docs/updates.md` stop linking here;
- a surface above uses one of the phrases in the "not accurate" list, or this
  file's list and the test's rules stop matching each other exactly.

**It is a tripwire, not a proof, and it is worth being exact about the
difference.** It recognises named primitives and named packages by reading
source. It cannot see a request made through a helper it does not know, a second
request added inside a file that is already allowed, or a paraphrase of a banned
claim. What it does is make the *cheap* mistakes — a new dependency, a new call
site, a feature flipped on, a document that drifted — fail loudly, so that the
expensive ones are the only ones left for a human to find.

It also deliberately does not pin the prose. A test that asserted paragraphs
verbatim would break on a rewording that is just as true, which teaches people to
delete the test rather than read it.
