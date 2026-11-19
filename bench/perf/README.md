# What a presenter waits for

Issue #240. The four wall-clock budgets in the unit suite take the fastest of
five warmed runs (`src/shared/perf-budget.ts`). That keeps them stable under
parallel vitest load, but it also makes them blind to cold starts, collections
every few passes and tails, by design. This folder covers the other half: the
waits a presenter actually sits through, measured in the packaged app on a
named Mac. Each wait is recorded as a distribution and compared by its median
and its 95th percentile, never by its minimum.

## What is measured

The fixture is `bench/scripts/huge.md` (5,073 words, unchanged). The runner
hashes it from the checkout, and the app reports the digest of the copy it
embeds. A mismatch (an old bundle run from a newer checkout) invalidates the
pair.

One **pair** is two launches of a benchmark build on a profile emptied just
before it:

| Series | From | To |
|---|---|---|
| `launch.cold.*` | spawning the process, on a fresh profile | the first painted frame of Welcome |
| `launch.warm.*` | spawning it again, over that profile | the first painted frame of the Library, fixture listed |
| `open.cold` / `open.warm` | double-clicking the fixture's Library row (first / second time in the process) | the first frame that paints the editor with the script loaded, its first compile **succeeded**, the opening panel gone and the text on screen |
| `present.cold` / `present.warm` | clicking Present (reader mode, roll at pace) | the first frame that paints a word of the script with the cover and the opening plate gone |
| `frames.{cold,warm}.{p95,p99,max,long}` | 10 s of rolling at 130 wpm in that take | per take: frame-interval percentiles, the worst frame, and frames over 50 ms |

Launch is split four ways:

- `spawn-to-ready` is the whole wait.
- `spawn-to-entry` runs up to the first statement of `src/control/main.ts`, so it covers native start plus the control bundle.
- `bundle-evaluate` runs from `public/boot-mark.js` to entry. That one-line classic script, at the end of `control.html`'s head, runs before the module graph is requested, so this is the bundle's fetch, parse and evaluation. It is a blocking request in every build, and it costs what it measures: it ran 2 ms after navigation start in 33 of the baseline's 40 launches, and 15 ms at most.
- `entry-to-ready` is the shell's own boot: settings, the library, the first route.

Every end point is a predicate over what is on screen, polled once per
animation frame. The measurement stops at the frame **after** the one where
the predicate first held, and only if the predicate still holds in that frame.
The error is up to one frame, and always late, never early. Beyond the boot
mark and three launch marks (`entry`, `mounted`, `ready`), nothing in the
product is instrumented for this. The scenario reads the DOM and the stores
the way a person reads the screen (`src/control/lib/perf/scenario.ts`).

Frame intervals come from an rAF loop beside the stage's own loop. All
callbacks in a frame share its timestamp, so the loop sees the cadence the
follower runs at, stalls included. The same loop requires the script to keep
moving: a still stretch of more than a second means a stalled renderer, and
the take is invalid even if the frames were perfect. WKWebView has no
`longtask` entry type (the `env` record lists `supportedEntryTypes`), so rAF
intervals are the tail measure. WebKit coarsens these timestamps to whole
milliseconds.

## Running it

```bash
pnpm tauri build --bundles app --config bench/perf/tauri.perf.conf.json
node scripts/perf-run.mjs --pairs 20 --label mac-studio-m4-max          # → bench/perf/runs/…json
node scripts/perf-compare.mjs bench/perf/mac-studio-m4-max.json bench/perf/runs/<that file>
```

A pair takes about 40 s, so 20 pairs take about 14 minutes. The windows open
on the desk display, and the takes are reading-window takes there. Leave that
window uncovered: WKWebView stops animation frames for a covered window, and a
launch that never paints is reported as one after 20 s.

Everything here is wall-clock time, so **load matters**. The runner records
the machine's 1-minute load average before and after each pair, and
`perf-compare` prints both recordings' median load. In the baseline, pairs
10–16 ran while other jobs on this shared Mac pushed the load from 8 to 22.
They carry every slow cold open (129–172 ms, against 93–101 ms in every other
pair) and both slow Presents (584 and 614 ms). Compare like with like, or read
the load line before believing a regression.

`perf-compare` exits:

- **0** when every series is within its threshold.
- **1** when a series regressed at its p50 or p95, a series the baseline has is **missing** from the candidate, or the candidate has an **invalid pair**. A launch that never became ready is the worst regression there is, and reporting only the pairs that survived would hide it.
- **2** when the two cannot be compared: a malformed report, a baseline with no valid pairs, an unusable threshold, or another model, chip, scenario or fixture. The OS version and the display are recorded but not checked, so read them.

Record 20 pairs for a comparison, not a handful. The first launch of a
freshly built binary costs about 0.8 s more (see below): in 20 pairs it
reaches only the maximum, but a one-pair recording of a new build is all
first launch and fails `launch.cold.*` on it.

Maxima are printed but never decide a verdict. The script never rewrites a
baseline. To replace one, copy a recording over it and commit that.

## Isolation

The benchmark build is made under its own bundle identifier,
`com.speakingglass.perf`. The scenario arms only under that identifier and only
when the runner sets `SPEAKING_GLASS_PERF_SCENARIO`. The environment variable
is refused on the real identifier. The identifier decides the data folder, the
WebKit store and the single-instance socket, so a benchmark run cannot read,
write or focus the app people use. The benchmark identity also skips the
CandidCue folder copy (`src-tauri/src/perf.rs`).

Checked on the first run, the build's footprint is
`~/Library/{Application Support,WebKit,Caches}/com.speakingglass.perf`. The
dev build's WebKit store (`~/Library/WebKit/speaking-glass`, keyed by the
executable name because a dev binary has no bundle) was left untouched.

The runner deletes those folders (and the identity's `HTTPStorages` and
saved-state entries) by exact name before every pair, and touches nothing else.
The guards around that:

- It holds a lock for the whole recording: a listening socket on `127.0.0.1:47240`. Binding is atomic and the kernel releases it however the runner dies, so there is never a stale lock to reclaim.
- It refuses to start while any checkout's `Speaking Glass Perf.app`, or the binary it was given, is running.
- It checks the bundle and its executable before deleting anything.

The benchmark profile is disposable by design: anything made in it by opening
the perf build by hand is deleted by the next recording.

The takes roll at a set pace (`fixed`), which never builds the voice
pipeline. No microphone is opened, so no permission prompt can stop an
unattended run, and no speech model is needed. The runner also clears
`SPEAKING_GLASS_MODELS_DIR`, so the profile cannot see models outside it.

## The baseline: Mac Studio, M4 Max

`mac-studio-m4-max.json`: Mac16,9, Apple M4 Max, 64 GB, macOS 26.3.1
(25D2128), main display a Pro Display XDR at 3008×1692 and 60 Hz, window
1240×820 at DPR 2. Twenty pairs, all valid, median load 8.5 (the range is in
the file, pair by pair). Values are in milliseconds. Frame series are per
take, then summarised over the 20 takes.

| Series | p50 | p95 | max |
|---|---:|---:|---:|
| `launch.cold.spawn-to-ready` | 414.3 | 451.1 | 500.9 |
| `launch.cold.spawn-to-entry` | 368.7 | 400.1 | 438.9 |
| `launch.cold.bundle-evaluate` | 103 | 106 | 113 |
| `launch.cold.entry-to-ready` | 41 | 56 | 62 |
| `launch.warm.spawn-to-ready` | 394.4 | 471 | 485.8 |
| `launch.warm.spawn-to-entry` | 355.4 | 419 | 432.8 |
| `launch.warm.bundle-evaluate` | 104 | 109 | 124 |
| `launch.warm.entry-to-ready` | 41 | 53 | 56 |
| `open.cold` | 98 | 139 | 172 |
| `open.warm` | 50 | 66 | 66 |
| `present.cold` | 533 | 584 | 614 |
| `present.warm` | 483 | 484 | 485 |
| `frames.cold.p95` / `.p99` | 18 / 19 | 19 / 21 | 19 / 22 |
| `frames.cold.max` | 25 | 31 | 33 |
| `frames.warm.p95` / `.p99` | 18 / 19 | 19 / 20 | 19 / 21 |
| `frames.warm.max` | 22 | 33 | 40 |
| `frames.{cold,warm}.long` | 0 | 0 | 0 |

**The first launch of a freshly built binary costs ~0.8 s more.** Every
recording that started on a new build showed it in pair 1: 1,217 and 1,271 ms
against ~400 ms for every later launch, with all of the extra time before the
bundle ran. This baseline began on a binary that had already been launched,
so it is not in the table above. The data cannot say why. It looks like
something macOS does on a new executable's first run, and it is what a user
meets on the first launch after an install or update. In a 20-pair recording
it reaches the maximum but not the p95. It is exactly the cost a best-of-N
minimum cannot see.

## Noise, and where the thresholds come from

Two recordings of one unchanged build (40 pairs) were compared against each
other in both directions. Those two predate the load column and the bundle
series. The thresholds in `scripts/perf-report.mjs` (`DEFAULT_THRESHOLDS`,
`base × (1 + relative) + absolute`) are the tightest round numbers that pass
both directions with a margin. The baseline above is within threshold
against both recordings, both ways round, on every series they share. Those
older recordings have no `bundle-evaluate`, so used as a candidate against
this baseline they fail on that missing series, as they should.

| Family | Allowance | Largest unchanged-build swing seen |
|---|---|---|
| launch | +20% + 40 ms | spawn-to-entry p95 342 → 364 ms |
| bundle-evaluate | +20% + 20 ms | p95 106 → 109 ms (cold vs warm in the baseline; one recording only) |
| open | +20% + 30 ms | warm p95 51 → 58 ms |
| present | +10% + 30 ms | cold max 568 → 585 ms (p50 unchanged at 550) |
| frames (p95, p99) | +25% + 4 ms | 18 → 19 ms |
| frames, worst frame per take | +50% + 8 ms | p95 30 → 42 ms |
| long frames (count per take) | +50% + 1 | 0 → 0 |

These catch a tail that only some runs suffer. The unit tests prove it with
supplied numbers (`tests/unit/perf-report.test.ts`). Two cold opens in twenty
taking four times as long fail on the p95, while the p50 and the fastest run
are unchanged. A 60 ms slower bundle fails `bundle-evaluate`, which
`spawn-to-entry`'s allowance would absorb.

## What the numbers say

- **Launch is mostly native start.** Spawn to the bundle's first statement
  takes ~370 ms, and the shell's boot after that ~40 ms.
- **The bundle's load is bimodal.** Head-parse to entry is either ~40–65 ms
  or ~100–125 ms. In this baseline the fast mode appears twice in 40 launches;
  in one of the earlier recordings it was close to half. Spawn→entry does not follow the
  mode: when the bundle is fast, the page simply started later. That pattern
  fits the eager scripts waiting on a native side that is still starting up,
  rather than parse cost. It is an inference: nothing here times the asset
  requests themselves. The fast mode bounds the bundle's own fetch, parse and
  evaluation at roughly 40 ms. This is also why navigation start is a poor
  origin: the page's navigation→entry interval inherits the same two modes,
  so the report keeps it and the comparison does not use it.
- **Present barely varies at a quiet desk.** Cold 531–550 ms and warm
  465–485 ms in every pair outside that busy stretch. A spread that narrow means
  fixed steps dominate the wait (the opening plate's 200 ms fade is one), not
  work that varies. The first Present in a process costs ~50 ms more than the
  second. That cold-warm gap is now recorded, but it is not attributed: the
  first wrap plan is somewhere inside it, and no interval separates it out.
- **The take is smooth on this Mac.** Every take's p95 and p99 sit at one or
  two frames (18–22 ms at 60 Hz). Across the 40 baseline takes the worst
  single frame was 40 ms, and none passed 50 ms.

## The control chunk: left alone

The eager graph `dist/control.html` loads is 1.39 MB of JavaScript (474 kB
gzipped), and the entry chunk alone is 889 kB (303 kB gzipped). Loading,
parsing and evaluating all of it fits inside the bundle interval's fast mode:
**about 40 ms of a ~410 ms launch**. The slow mode's extra ~60 ms is waiting
on native start, and so is the ~300 ms before the page runs at all. A split
could at best save part of those 40 ms, and it would move the cost onto the
first open or the first Present, which are waits too. Splitting is not worth
doing on these numbers. If launch ever needs to get faster, the place to look
is native start, and the A/B to run is this recording against one made with a
lazy boundary.

## What this does not cover

- **The teleprompter display.** Takes here are reading-window takes on the
  desk display. A prompter take on the pinned panel goes through the same
  renderer, but its window move and panel sizing are not timed.
  `docs/real-rig-test-protocol.md` still covers the rig.
- **Voice.** No recogniser, no microphone and no alignment. The follow loop's
  costs are cc-bench's business.
- **A fallback reveal.** If the stage cannot place the script, it reveals
  it anyway 700 ms after the layer mounts. The scenario cannot tell that
  reveal from a placed one, but it cannot hide either: it would land well
  above the 531–550 ms a placed reveal takes here.
- **The compositor.** WebKit can run a frame's callbacks and still show a
  stale frame. These numbers measure the first frame where the page could
  paint, not photons.
- **The filesystem cache.** It is not flushed between pairs. "Cold" means a
  fresh app profile, not a cold disk.
- **Clock steps.** Spawn-based intervals subtract the runner's epoch clock
  from the page's (`performance.timeOrigin`). They share units, but a
  wall-clock adjustment during a recording would bias them; the page-local
  intervals would not be affected.
- **One early pair stalled mid-take** and was killed at the runner's 3-minute
  limit. That happened before the sampler had a watchdog and progress
  records. A recurrence now leaves its last step in the trace, and a take
  whose frames stop reports `stalled` with the window's visibility.
