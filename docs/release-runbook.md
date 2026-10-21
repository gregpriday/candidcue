# Release runbook

**What to do, in order, to put a build in somebody else's hands — and what to
do when one of them turns out to be bad.**

This is the release-engineering half. The product half is
`docs/real-rig-test-protocol.md`, which is the only thing that can say whether a
build actually follows a voice on real glass, and no amount of green CI stands
in for it.

Two gates, and they are not the same gate. Do not collapse them into one
"ready to launch" feeling:

| Gate | Who gets it | What it needs |
|---|---|---|
| **A — signed tester build** | A small invited group | Everything in §1–§5 below |
| **B — public beta** | Anyone who finds the download page | A, plus a download page, a guide, known issues, published checksums, and a hardware matrix with more than one row |

Every tagged build, A included, has to clear the native licence review first.
A full `release-verify.mjs` run refuses while any statically linked native
component in `sbom/native-components.json` is still `"reviewed": false`, and
the release workflow runs the full plan. CI does not run that step, so a green
CI does not mean a tag will build. Only a person can clear it, by confirming
each licence against the build that ships.

Releases follow gitflow. `develop` is the integration branch, and every
feature and fix merges there. `main` moves only when a release is cut: `develop`
is merged into it, and the `v*` tag goes on that merge commit. So §1–§4 below
happen on `develop` (the version bump and the `CHANGELOG.md` section reach it
through ordinary pull requests), and §5 merges it into `main` and tags the
result.

---

## 1. Prepare the repository

Stop merging feature work into `develop` first. A release candidate is a thing
you are measuring, and a moving one cannot be measured.

```bash
# From a fresh clone, not from the tree you have been working in.
git clone https://github.com/gregpriday/candidcue speaking-glass-release-check
cd speaking-glass-release-check
git switch develop         # what is about to be released; main has not moved yet

git lfs install && git lfs pull
git lfs ls-files          # the bench corpora must be real files, not pointers

corepack enable
pnpm install --frozen-lockfile

node scripts/release-verify.mjs
git status --short         # must be empty: no gate may depend on an untracked file
```

The clean-clone drill is not ceremony. `scripts/verify-repository.mjs` exists
because the readiness review could not certify a release whose inputs nobody
could prove were committed, and it is the first step of `release-verify.mjs` for
that reason. Run it somewhere that has never built this project.

Then, from the same checkout:

```bash
cargo test  --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test  --locked --manifest-path crates/Cargo.toml
cargo clippy --locked --manifest-path crates/Cargo.toml --all-targets -- -D warnings
```

Before going further, confirm by reading rather than by memory:

- [ ] CI is green on the `develop` commit you intend to release.
- [ ] No model weights are bundled — `pnpm exec node scripts/verify-no-model-weights.mjs <path to .app>` after a local `pnpm tauri build --bundles app`.
- [ ] The speech catalogue names the model and digests you meant to ship.
- [ ] `docs/network-inventory.md` still describes this build, and the surfaces it lists still agree with it.
- [ ] `CHANGELOG.md` has a section for the version, written for somebody deciding whether to install it.
- [ ] Known issues are written down somewhere the tester will actually see.

## 2. Set the version

One command. Never edit the manifests by hand — there are five of them and they
have disagreed before.

```bash
pnpm version:set 1.0.0-rc.2
pnpm version:check
```

Commit that on a branch off `develop` and merge it through a pull request, like
any other change.

`version:check` reads `package.json`, `src-tauri/Cargo.toml`,
`src-tauri/tauri.conf.json` and `src/shared/version.ts` and refuses if they
disagree. The tag is checked against the same value in CI, before anything is
built, because a `v1.0.0` tag on a `1.0.0-rc.2` source tree produces a signed,
notarised artifact whose About box contradicts its own download page.

**Release identity is frozen.** `com.speakingglass.app` is the permanent bundle
identifier. Changing it after a tester has installed an RC makes the next build
a different application to macOS: new microphone permission, new data
directory, no continuity. If it ever has to change, that is a migration with a
plan, not a config edit.

It has changed once, before anything was released: the app was CandidCue, with
`com.candidcue.app`, until October 2026. `src-tauri/src/legacy_data.rs` is that
migration. On the first launch it copies the old data folder into place, and an
export or a `.candidcue` bundle from before the rename still restores and
imports.

## 3. Write the release notes before you build

The workflow refuses a tag with no `## v<version>` section in `CHANGELOG.md`,
and it checks that *before* the build rather than at the publish step — a
notarisation round trip is an expensive way to discover an undescribed release.

A tester's notes need, at minimum: what changed, what to focus on, known
limitations, that the app is English-only, the OS and hardware claim, how
the update check behaves and how to turn it off, whether data from the
previous version survives, the privacy and network note, and how to report a problem.

The section reaches `develop` the same way the version bump did, through a pull
request.

## 4. Prove the credentials without publishing anything

There are three release workflows, one per operating system —
`release-macos.yml`, `release-windows.yml` and `release-linux.yml` — and the
same `v*` tag starts all three. Each is a full vertical slice (gates, tests,
build, inspection, R2, GitHub Release) and publishes the moment its own
pipeline is green, so a failing Windows run never strands a good macOS build.

Dispatch each one against `develop` with `dry_run` ticked (the default). They
build, sign where they sign, inspect and stage the release, and the `publish`
jobs do not run.

```bash
for os in macos windows linux; do
  gh workflow run "release-$os.yml" --ref develop -f dry_run=true
done
gh run list --limit 3
gh run watch <id>
```

Read the macOS log for: the keychain import, the universal build,
notarisation of the app AND the DMG, the step that compares each link map
against the slice lipo packaged, the copyleft check for both architectures,
`verify-signed-bundle.mjs`, the DMG and updater-payload inspection, the smoke
launch, and the credential cleanup step reporting that it ran. Read the Windows
and Linux logs for the TTS-free recogniser (`sherpa-no-tts.mjs`), the GPL check
on the linked binary (`verify-no-gpl-in-binary.mjs`), and the installer smoke
test.

In every one of them, the `Stage the release` step is the one that matters
most for updates: it refuses a payload with no `.sig` and verifies the
signature against the public key in `tauri.conf.json`. A signing secret that
does not match that key would otherwise publish cleanly and be refused by every
installed copy.

## 5. Publish the tag deliberately

Merge `develop` into `main` first, through a pull request, and only then tag.
Use a merge commit, not a squash or a rebase, so `main` keeps `develop`'s
history and the next release merges cleanly. Leave out `--delete-branch`, which
would delete `develop`.

```bash
gh pr create --base main --head develop --title "Release 1.0.0-rc.2" --body "Speaking Glass 1.0.0-rc.2"
gh pr merge <number> --merge   # once CI is green on the pull request
```

Wait for CI to pass on the merge commit's own push run, then tag that commit:

```bash
git fetch origin
git switch -C main origin/main # the release merge, and nothing after it
pnpm version:tag v1.0.0-rc.2   # the tag must name the version the artifact reports
pnpm notes:check v1.0.0-rc.2   # CHANGELOG.md must describe it
git tag -s v1.0.0-rc.2 -m "Speaking Glass 1.0.0-rc.2"
git show v1.0.0-rc.2        # right commit? signed?
git push origin v1.0.0-rc.2
```

A hyphen in the version is what makes it a prerelease: the workflows pass
`--prerelease --latest=false` for `v1.0.0-rc.2`, and mark `v1.0.0` Latest
unless a newer stable release already exists. A prerelease publishes to its
own update channel (`rc`, or `beta` when the prerelease part says so), which
no stable install polls. Check which one you are about to become before
pushing.

The gates refuse a tag whose commit is not on `main`.

### What publishing does

Each OS's `publish` job runs `.github/actions/publish-speaking-glass`, in this
order, and stops at the first failure:

1. Receives the build job's artifact and checks every file against its
   `SHA256SUMS` (`.github/actions/receive-speaking-glass`, which the build job
   also runs on its own upload, so a dry run proves this handover too).
2. Refuses a version older than what that OS's update feed already serves.
   The same version is allowed through, so a re-run can finish a publish
   that failed half way.
3. Refuses to change a file that is already published: every file already
   under `releases/<version>/` must be byte for byte the one staged.
4. Uploads the installers, the updater payload and its `.sig`, and
   `SHA256SUMS-<os>.txt` to `releases/<version>/` in the `speaking-glass` R2
   bucket, cached as immutable.
5. Downloads every one of them back from `https://updates.speakingglass.com` and
   compares the bytes.
6. Only then uploads the feed: `releases/<channel>-<target>-<arch>.json`,
   which installed copies poll, and `releases/<channel>-<os>.json`, which a
   download page reads. Both are served `no-cache`, and both are read back.
7. Creates the GitHub Release (empty, so no draft is ever left for another
   OS to lose its files in), or finds the one another OS created, then
   attaches its files and checks each one arrived.

Only one publish per OS runs at a time, across tags. GitHub keeps one more
waiting behind it and cancels that one if a third arrives, so release one
version at a time and let it finish publishing before tagging the next.

**If a publish fails**, re-run only the failed `publish` job. It reuses the
build that was staged, so step 3 passes and the rest repairs whatever the
first attempt left undone. Re-running the whole workflow rebuilds every
file with new bytes under the same names, and step 3 refuses that once any
of them is published: release a new version instead.

`scripts/release-feed.mjs` is the whole layout, with the reasons.

A stable tag routes its publication through the `release-stable` GitHub
Environment. Give that environment a required reviewer in Settings →
Environments and every stable release then waits for a person to press a
button; prereleases go through `release-prerelease` and flow.

---

## 6. Ask the artifact, not the workflow

"The run was green" is not an inspection. Download the DMG the workflow
produced — the same file a user would get — and interrogate it.

```bash
APP="/Volumes/Speaking Glass/Speaking Glass.app"      # or /Applications/Speaking Glass.app
DMG="SpeakingGlass_1.0.0-rc.2_universal.dmg"
# `speaking-glass`, lowercase — the Cargo bin name. `Speaking Glass` is the product name
# and is not what lives in MacOS/. Read it rather than typing it:
BIN="$APP/Contents/MacOS/$(plutil -extract CFBundleExecutable raw "$APP/Contents/Info.plist")"
```

**Signature, notarisation, Gatekeeper**

```bash
codesign --verify --deep --strict --verbose=4 "$APP"
codesign -dv --verbose=4 "$APP" 2>&1        # identity, Team ID, bundle id, runtime flags
spctl --assess --type execute --verbose=4 "$APP"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"
```

Expect a Developer ID Application identity, the right Team ID,
`com.speakingglass.app`, the hardened runtime, a valid ticket, no ad-hoc signature
and no unsigned nested code.

**Entitlements** — compare the signed output against
`src-tauri/entitlements/entitlements.macos.plist`, not against your memory of
it:

```bash
codesign -d --entitlements :- "$APP"
```

Audio input where it is needed. No `get-task-allow`, no debug entitlement, no
broad file access, no JIT, no camera, contacts, automation or accessibility.

**Architectures** — a universal header is not proof both slices run:

```bash
lipo -archs "$BIN"      # arm64 x86_64
file "$BIN"
```

Then launch it on both. `verify-signed-bundle.mjs` now fails a build that has
only one slice, but nothing automated can tell you the Intel slice actually
works.

**Bundle metadata**

```bash
plutil -p "$APP/Contents/Info.plist"
```

Product name, bundle id, short version, build version, minimum macOS,
copyright, the microphone usage description. No dev URL, no placeholder, no
absolute path from the build machine.

**Contents** — walk the payload and confirm what is *not* there: no `.onnx`
weights, no model archive, no `.env`, no signing material, no source control
metadata, no test corpus, no localhost or dev-server reference, no updater
resources. The notices and font licences the
bundle is supposed to carry must be present.

**The DMG itself**

```bash
hdiutil verify "$DMG"
```

Open it: sensible layout, obvious drag-to-Applications, correct icon at every
size, no stale volume name. Copying to `/Applications` must preserve the
signature, and the user must never be told to use "Open Anyway".

## 7. Prove it installs on a machine that has never seen it

The most important installation test is not on the development Mac. Use a clean
macOS user account — ideally a different machine — with no developer tools, no
environment variables, and no cached speech model.

- [ ] Download from the actual hosted URL in a browser, so the file is quarantined.
- [ ] Verify the filename and the published SHA-256.
- [ ] Open the DMG, drag to Applications, eject, launch from Applications.
- [ ] No Gatekeeper bypass is required at any point.
- [ ] Complete the microphone permission flow. Deny it once, then recover.
- [ ] Download the speech model. Cancel midway. Resume. Confirm a cancelled install left the previous state intact.
- [ ] Create or open a script and complete a voice-followed take.
- [ ] Quit and reopen: scripts, settings and calibration survive.
- [ ] Install the next RC over the top: data, model, calibration and permissions all survive.
- [ ] Export a support bundle, reveal it, and read it before deciding to send it.

No terminal command may be required for any of this. If one is, that is a
release defect, not a documentation gap.

## 8. Long sessions, before a build goes wide

Short takes prove the happy path and nothing about the third hour. Run these on
the packaged app and record numbers, not impressions:

| Run | Duration | What it is for |
|---|---:|---|
| Repeated short takes | 30–50 takes | Lifecycle leaks, stale generations, start/stop races |
| A normal creator session | 30 min | Thermals, memory, audio and stage behaviour together |
| One long presentation | 60 min | Sustained recogniser and renderer stability |
| Idle with preflight open | 30 min | Device and display changes before a take |
| A pause-heavy take | 20 min | Prediction settling |
| A large script | 10,000+ words | Compile, layout and navigation cost |
| An image-heavy script | Realistic maximum | Asset decode and memory |
| RC N → RC N+1 | — | Update continuity |

Track CPU, memory at rest after the session, thermal pressure, audio dropouts,
first-lock time, and database and log growth. Establish the baseline on the
slowest machine you support and treat a material regression as a release
failure — but do not invent a performance promise before you have measured one.

---

## 9. Withdrawing a bad release

Assume it will happen once. The point of writing this down now is that the
decision gets made calmly and the steps are not improvised while a download
page is serving something broken.

**Stop distribution immediately** for any of: an invalid signature or
notarisation, data loss, script corruption, a support bundle disclosing content
it should not, a model-integrity failure, the microphone activating outside an
explicit user action, a repeatable launch failure on an advertised system,
licence-compliance doubt about the exact artifact, a stable build identifying
itself as prerelease or the reverse, or a download button pointing at the wrong
file.

The procedure:

1. **Take the download away first, explain second.** Installed copies update
   themselves from the R2 feed, so the feed is the first thing to stop. Point
   each affected `releases/latest-<target>-<arch>.json` (and the download
   page's `releases/latest-<os>.json`) back at the previous good version — the
   previous release's feed files are in its GitHub Actions artifact
   (`speaking-glass-release-<os>`, under `stage/feed/`) — and upload them with the
   same `no-cache` header the workflow uses:
   ```bash
   wrangler r2 object put speaking-glass/releases/latest-darwin-aarch64.json \
     --file stage/feed/latest-darwin-aarch64.json --remote \
     --content-type application/json --cache-control "no-cache, no-store, must-revalidate"
   ```
   That stops new installs of the bad build; copies that already took it stay
   on it, because the updater never downgrades. A page that serves a bad build
   while you write an announcement keeps making the problem bigger.
2. **Mark the release.** Do not delete it — a deleted release breaks every link
   anyone has shared and destroys the evidence.
   ```bash
   gh release edit v1.0.0-rc.2 --prerelease --latest=false
   gh release edit v1.0.0-rc.2 --notes-file withdrawn.md   # lead with WITHDRAWN and why
   ```
   Delete the *assets* only if leaving them installable is itself the harm:
   ```bash
   gh release delete-asset v1.0.0-rc.2 SpeakingGlass_1.0.0-rc.2_universal.dmg
   ```
3. **Leave the tag.** The tag is what ties the artifact to a commit; removing it
   destroys the provenance of a build people are already running.
4. **Tell the people who have it.** Every tester, by the channel you gave them,
   naming: what is wrong, what it can do to their data, whether to stop using
   it, and what to do instead. The fix-forward release in step 5 is what
   reaches everybody who installed it: the updater offers a newer version, and
   nothing older.
5. **Fix forward.** Never re-cut a tag that has been published. The replacement
   is a new version — `1.0.0-rc.3` — even if the fix is one line, and the fix
   lands on `develop` and reaches `main` through a release merge like any other.
6. **Write it down.** Add the withdrawal to `CHANGELOG.md` under the withdrawn
   version, so the record survives the incident.
7. **If it was a security or signing problem**, revoke the signing certificate
   as well, re-sign the replacement with a new one, and say so in the notes.
   Apple's revocation is what stops an already-distributed copy from launching.

## 10. Hardware qualification

`docs/real-rig-test-protocol.md` is the per-rig sheet: copy it to
`docs/rig-runs/<version>-<date>.md`, fill in the hardware, run the sections the
change touches, and — the part that makes it honest — list what you skipped.

One sheet is one rig. A release claim covers a matrix, so keep a table of which
cells actually passed for each version, and **do not advertise a cell that has
no sheet behind it**:

| Dimension | Cells a 1.0 claim would need |
|---|---|
| CPU | Apple Silicon; Intel, if Intel is advertised |
| macOS | The oldest supported version; one in between; the current one |
| Display | Laptop only; one external; two displays |
| Resolution | Retina; a 4K/5K external |
| Connection | Direct HDMI or USB-C; a dock, if the audience uses one |
| Microphone | Built-in; USB; an interface; Bluetooth |
| Teleprompter | A second screen alone; real beamsplitter glass |
| Room | Quiet; some noise; a speaker near the microphone |
| Input | Pointer; keyboard only |
| Accessibility | VoiceOver; reduced motion; large display scaling |

`minimumSystemVersion` in `tauri.conf.json` is a configuration value, not
evidence. It becomes a claim when a Mac running that version has completed the
core journey.

---

## 11. Support, for the first cohort

Ask for: the Speaking Glass version, the macOS version, the Mac model, the
microphone, the display arrangement, the rig, what they expected, what
happened, how to reproduce it, how often, whether a restart helps, and a
support bundle **only with explicit consent**.

Severity, and what each one does to the release:

| | Definition | Treatment |
|---|---|---|
| **P0** | Data loss, a privacy or security breach, the app cannot launch, the artifact is invalid | Stop distribution (§9) |
| **P1** | A take cannot complete, microphone or display failure, unread text advancing on its own, an unrecoverable presentation state | Fix before the next cohort |
| **P2** | A recoverable workflow defect, repeated confusion, a significant visual problem | Fix before stable where practical |
| **P3** | Cosmetic, with a workaround | Backlog |
| Feedback | A preference or a feature request | Not a defect |

Ask the reporter to reproduce once and export the bundle immediately
afterwards, remind them they can reveal and read it first, and never ask for a
private script when a synthetic one reproduces the problem. Delete bundles you
receive on whatever schedule you told them you would.

Two testers confused by the same thing is a P1 documentation or interface
issue, not a coincidence.
