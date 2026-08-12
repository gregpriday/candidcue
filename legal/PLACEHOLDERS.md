# Placeholder register and release gate

**This is not a legal document.** It is the checklist that has to be cleared
before CandidCue is sold. It does not get published to the website.

The documents in this directory are written and structurally complete, but every
fact that could not be established from this repository is left as a placeholder
token rather than guessed at. Inventing a business address or a retention period
would have produced a document that reads finished and is wrong, which is worse
than one that is visibly unfinished.

Placeholders look like `@@LEGAL_SOMETHING@@`. They are deliberately ugly so that
a missed one is obvious on the page and trivial to grep for.

---

## The gate

Before the first paid build ships, both of these must return nothing:

```bash
pnpm legal:check
```

`scripts/legal-gate.mjs` is the executable form of this gate. It exits non-zero
today, on purpose — the tokens are still unresolved — and is deliberately **not**
wired into `pnpm test`. It runs the two searches below, and it also fails when a
legal document is missing or trivially short and when this register itself yields
no tokens, so a broken search cannot be mistaken for a clean sheet.

```bash
rg -n '@@LEGAL_[A-Z0-9_]+@@' \
  LICENSE legal/EULA.md legal/PRIVACY_POLICY.md legal/REFUND_POLICY.md \
  README.md package.json src-tauri/tauri.conf.json .github/SECURITY.md

rg -n -i '\b(TODO|TBD|FIXME|example\.com)\b' \
  LICENSE legal/EULA.md legal/PRIVACY_POLICY.md legal/REFUND_POLICY.md
```

`tests/unit/legal-docs.test.ts` runs in the normal suite and holds the token set
used across the documents equal to the set declared in the tables below, in both
directions, so a document cannot grow an undeclared placeholder and this register
cannot quietly lose one.

(Run them from the repository root. `legal/PLACEHOLDERS.md` is excluded from
both — this file names the tokens on purpose.)

**Run this first, every time.** A gate whose whole success condition is "no
output" passes just as quietly when the search itself is broken — a shell alias,
a wrapper, a mistyped path or a `--glob` matching nothing all produce a
clean sheet. This file contains `@@LEGAL_SOMETHING@@` in the paragraph above,
so the control below must find it. If it prints nothing, the two commands above
prove nothing and their result must be discarded.

```bash
rg -n '@@LEGAL_[A-Z0-9_]+@@' legal/PLACEHOLDERS.md
```

This is not hypothetical: during drafting, `rg -o` under this environment's
command wrapper returned empty against files that were full of tokens, and
reported it as a clean pass.

---

## What has to be filled in

### The business

| Token | What it is | Where to get it |
|---|---|---|
| `LEGAL_COPYRIGHT_YEARS` | e.g. `2026` or `2025–2026` | First publication year through current |
| `LEGAL_COPYRIGHT_HOLDER` | Who owns the copyright | The entity, or the individual if unincorporated |
| `LEGAL_LICENSOR_NAME` | Party to the EULA | Registered company name, or trading name if a sole trader |
| `LEGAL_CONTROLLER_NAME` | GDPR controller | Usually the same as the licensor — must be a real legal person |
| `LEGAL_BUSINESS_ADDRESS` | Postal address | GDPR Art. 13 requires a real one; a PO box may not be enough |
| `LEGAL_SUPPORT_EMAIL` | Support and refunds | Must be monitored — the refund policy promises a reply. Must not contradict the address already published in `.github/SECURITY.md` (greg@siteorigin.com); change both together if it moves |
| `LEGAL_PRIVACY_EMAIL` | Data-subject requests | May be the same address |
| `LEGAL_WEBSITE_ORIGIN` | e.g. `https://candidcue.com` | The distribution site (#193) |
| `LEGAL_EFFECTIVE_DATE` | Date these take effect | Set when they are published, not when written |

### Jurisdiction

| Token | What it is | Note |
|---|---|---|
| `LEGAL_GOVERNING_LAW` | Governing law | Follows where the business is established |
| `LEGAL_COURTS` | Competent courts | Consumer-protection carve-outs are already in EULA §16 |

### Merchant of Record — blocked on #193

| Token | What it is |
|---|---|
| `LEGAL_MOR_NAME` | Polar or Lemon Squeezy, once chosen |
| `LEGAL_MOR_PRIVACY_URL` | Their published privacy policy |
| `LEGAL_MOR_FIELDS_RETURNED` | **Verify, do not assume.** Run a sandbox purchase and record exactly which fields land on our side — likely name, email, country and order status, but confirm it |

### Website — requires evidence from the host, not a guess

| Token | What it is |
|---|---|
| `LEGAL_WEB_HOST_NAME` | Who serves the site |
| `LEGAL_WEB_LOG_FIELDS` | The fields the host actually logs. **Verify against the host's documentation** — the policy used to assert IP, timestamp, path, referrer and user-agent as though every server logs exactly that set |
| `LEGAL_WEB_LOG_RETENTION` | How long the host keeps access logs — get this from their documentation or DPA |
| `LEGAL_TRANSFER_SAFEGUARDS` | e.g. Standard Contractual Clauses, UK IDTA, or an adequacy decision |
| `LEGAL_WEBSITE_ANALYTICS_STATEMENT` | See below |
| `LEGAL_ORDER_RETENTION` | Driven by the tax-record retention your jurisdiction requires |
| `LEGAL_SUPPORT_RETENTION` | Your own choice; state something and honour it |

`LEGAL_WEBSITE_ANALYTICS_STATEMENT` is a full sentence, not a value, and it
cannot be written until the site exists. If the site sets no cookies and runs no
analytics, say so plainly — it is a strong claim and worth making. If it runs
anything at all, that has to be disclosed here, and a cookie banner may be
required. **Do not claim the site is cookie-free before auditing the deployed
site.**

---

## Also required before sale

Not placeholders, but on the same gate:

- **Legal review.** These documents were drafted against the product's actual
  behaviour, not by a lawyer. An adversarial review raised the following, which
  were left as drafting decisions and need a qualified opinion once the
  governing law and target markets are fixed:

  - **The evaluation trigger (EULA §3).** Evaluation now ends on the earlier of
    your own decision and an objective "pattern of use" test. The purely
    subjective version was probably unprovable, given that the product
    deliberately collects no evidence. Confirm the objective limb is workable in
    the chosen jurisdiction, and that an open-ended evaluation period does not
    read as a licence to never pay.
  - **Breach versus infringement (EULA §6, §15).** The draft deliberately makes
    unregistered use a *contractual breach* and says so explicitly, rather than
    putting the use outside the copyright licence. That matches the trusting
    tone but is the softer of the two theories. It is a deliberate choice, and
    a lawyer should confirm it is the intended one.
  - **Estoppel and implied licence (EULA §6, §17).** Permanent, advertised,
    deliberate non-enforcement is exactly the fact pattern from which an implied
    licence or estoppel argument is built. §17 addresses it directly, but a
    waiver clause cannot abolish estoppel where the law does not permit it.
  - **The liability cap (EULA §14).** Now the price of the Registration, not
    "paid in the last twelve months" — the earlier wording produced a cap of
    zero for anyone who bought more than a year ago, which is an exclusion
    rather than a cap and hard to defend against a consumer.
  - **Warranty framing (EULA §13).** Rewritten to lead with statutory consumer
    rights and then disclaim, rather than disclaiming and carving out. The
    "speech recognition is probabilistic" disclosure needs checking against
    unfair-terms rules, since voice-following is the product's central
    description.
  - **Transferability (EULA §4, §8).** Carve-out added for mandatory resale
    rights, which exist in parts of Europe for perpetual downloaded licences.
  - **Withdrawal mechanics (Refund Policy).** What legally constitutes "supply"
    is not obvious here: the app is already usable during evaluation, and the
    purchase delivers only a receipt and permission. Confirm with the Merchant
    of Record which party begins supply and whether the withdrawal right is in
    fact extinguished.
  - **Merchant-of-Record role.** An MoR is usually a principal reseller, not the
    developer's agent. The wording is deliberately neutral pending the actual
    merchant agreement; confirm this policy is incorporated into the checkout
    terms the MoR presents and reproduced or linked in the receipt.

- **Assent for people who never buy.** The EULA relies on "by installing or
  using CandidCue you accept this Agreement." Someone who evaluates and never
  reaches checkout may never affirmatively accept anything, and a bare
  by-using notice is materially weaker than a click-through. If the registration
  obligation is to mean anything, the person who never pays is precisely the
  person it has to bind. An acceptance step at first run would fix it and needs
  no key, account, check or network call — but it is a product change, so it is
  filed here rather than assumed. **Decide before sale.**

- **Pre-contract product information.** EU/UK digital-content rules generally
  require functionality, compatibility and interoperability information *before*
  the contract is formed. Publish and verify on the product page or checkout:
  supported macOS versions and hardware, microphone and second-display
  requirements, the separate ~161 MB speech-model download and that it is not in
  the installer, and the absence of any registration-related technical
  protection. Preserve it in the order confirmation.
- **Bundle metadata.** Deliberately left out of the docs PR, because unresolved
  placeholders must not be baked into a build artifact. Once
  `LEGAL_COPYRIGHT_HOLDER` is known, add to `src-tauri/tauri.conf.json` under
  `bundle`:

  ```json
  "copyright": "Copyright © <years> <holder>. All rights reserved."
  ```

  `bundle.licenseFile` is also supported and would attach a licence pane to the
  DMG installer. That changes the install flow and cannot be verified by the
  test suite, so decide it deliberately and check the mounted DMG by eye. Leave
  `bundle.license` unset — there is no SPDX identifier for this agreement.
- **Website publication.** #193 publishes these at `/legal/eula`,
  `/legal/privacy` and `/legal/refunds`. Generate those pages from these files;
  do not hand-maintain a second copy that can drift.
- **Checkout mechanics** (#193): an unticked terms checkbox, a separate unticked
  immediate-supply/withdrawal acknowledgement, the accepted document version
  recorded against the order, and the durable-medium confirmation in the receipt
  email. The privacy link is a notice, not consent — do not fold it into a
  consent checkbox.

---

## Re-verifying the privacy policy against the code

The privacy policy makes factual claims about the application. They were true
when it was written and were checked against this tree. Re-run these before
release, and again after any change that touches the network, storage or
microphone.

**No updater, and update checks report honestly**

```bash
rg -n 'tauri-plugin-updater|@tauri-apps/plugin-updater' \
  package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/capabilities
```

Expect no matches. CandidCue 1.0 updates manually and has **no update surface
at all** — no plugin, no endpoint, no commands, no settings field. See
`docs/updates.md`.

This paragraph used to say that `check_for_update` and `install_update` return
`NOT_IMPLEMENTED` and that `src-tauri/src/updates/mod.rs` is an unwired stub.
All three are gone, along with an `update_check` setting that defaulted to
`"daily"` and a "Check for updates" button. A privacy statement should describe
behaviour that exists; a dormant half-updater is exactly the thing that turns a
true privacy claim into a false one without anyone editing the policy.

```bash
rg -n 'check_for_update|install_update|update_check|updateCheck|update://' \
  src src-tauri/src src-tauri/permissions src-tauri/capabilities
```

Expect no matches outside comments recording the removal.

**Nothing transmits telemetry, analytics or crash reports**

```bash
rg -n -i 'telemetry|sentry|posthog|segment|mixpanel|amplitude|bugsnag|crashlytics' \
  src src-tauri/src package.json src-tauri/Cargo.toml
```

Matches on "telemetry" in stage code refer to local motion measurements. There
is no analytics or crash-upload client. Note that `analytics_enabled` in
`src-tauri/src/settings/mod.rs` is a dead field — declared and defaulted to
`false`, never read. The policy deliberately does not mention it: legal text
should describe behaviour, not unused schema. If that field ever becomes live,
this policy needs revising.

**Every outbound network path**

```bash
rg -n -S -e '\breqwest\b' -e '\bureq\b' -e '\bfetch\s*\(' -e 'XMLHttpRequest' \
  -e '\bWebSocket\b' -e 'EventSource' -e 'sendBeacon' -e 'https?://' \
  src src-tauri/src crates --glob '!**/target/**'
```

The expected inventory, and the only one the policy is written against:

1. **The speech-model download** — `src-tauri/src/speech/model_download.rs`,
   through the shared hardened client in `src-tauri/src/net.rs`. User-initiated
   from Speech settings, hash-pinned. This is the one the policy describes.
2. **A remote-image importer** — `src-tauri/src/assets/remote.rs`, reachable as
   the `import_remote_image` command, wrapped by
   `src/control/services/assets.ts`. **It has no UI caller**; nothing in the
   editor invokes it. The policy does not
   describe it, on the same reasoning that #180 used for the in-app copy: naming
   an action a user cannot take is its own kind of inaccuracy. **If a future
   version surfaces it, the policy must be revised** — it would send a
   user-supplied URL to a third-party host.
3. **`src/stage/preview.ts`** — fetches a replay fixture. Dev/preview only, and
   the shipped CSP confines it to local URLs.
4. **`cc-bench` TTS** — benchmark tooling, gated behind
   `CANDIDCUE_ALLOW_TTS_GENERATION=1` and `FAL_KEY`. Not linked into the app.
5. **`sherpa-onnx-sys` build script** — downloads prebuilt native libraries at
   *build* time via `ureq`. Not present at runtime.

Only (1) is a request the shipped application makes.

**The CSP still permits no remote host**

```bash
jq '.app.security.csp, .app.security.assetProtocol.scope' src-tauri/tauri.conf.json
```

`connect-src` must remain `'self' ipc: http://ipc.localhost`, and the asset
scope must keep its `deny` floor over script bodies, revisions, the database and
logs. The policy's security section relies on that floor.

**Take audio never reaches disk**

```bash
rg -n -e 'std::fs' -e 'tokio::fs' -e 'File::create' -e 'OpenOptions' -e 'write_all' \
  src-tauri/src/speech/session.rs src-tauri/src/commands/speech_cmds.rs crates/cc-stt/src
```

Expect no file writer on the live audio path. The microphone test's in-memory
`Blob` lives in `src/control/services/audio/micTest.ts` and is revoked after
playback.

**Transcript retention is off by default**

```bash
rg -n 'save_transcript' src-tauri/src/settings/mod.rs
```

Default `"off"`; permitted values `off`, `1d`, `7d`, `30d`, `forever`. Also
confirm whether a settings control has since been added — the policy currently
states the setting is not exposed in the interface.

**The local data inventory still matches the schema**

```bash
rg -n 'CREATE TABLE' src-tauri/migrations/
```

**Retention numbers**

```bash
rg -n 'MAX_REVISIONS_PER_SCRIPT' src-tauri/src/scripts/repo.rs
rg -n 'MAX_PRE_MIGRATION_BACKUPS' src-tauri/src/database/mod.rs
rg -n 'MAX_DAILY_LOG_FILES' src-tauri/src/diagnostics/logging.rs
```

The policy states 100 revisions per script, five pre-migration backups, 24-hour
and 30-day revision thinning, and a 30-day trash purge. The thinning and purge
windows are in `src-tauri/src/scripts/repo.rs`.

**The in-app privacy copy and this policy must agree**

```bash
./node_modules/.bin/vitest run tests/unit/control/settings-privacy-truth.test.ts
```

That suite (from #180) holds the "Data, privacy & updates" section in
`src/control/routes/Settings.svelte` to what the application actually does. This
policy was written to expand that copy, not to compete with it. If one changes,
change both.
