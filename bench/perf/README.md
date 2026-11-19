# What a presenter waits for

Issue #240. The four wall-clock budgets in the unit suite take the fastest of
five warmed runs (`src/shared/perf-budget.ts`). That keeps them stable under
parallel vitest load, but it also makes them blind to cold starts, collections
every few passes and tails, by design. This folder covers the other half: the
waits a presenter actually sits through, measured in the packaged app on a
named Mac. Each wait is recorded as a distribution and compared by its median
and its 95th percentile, never by its minimum.

## What is measured

The fixture is `bench/scripts/huge.md` (5,073 words, unchanged, SHA-256 in
every report). One **pair** is two launches of a benchmark build on a profile
emptied just before it:

| Series | From | To |
|---|---|---|
| `launch.cold.*` | spawning the process, on a fresh profile | the first painted frame of Welcome |
| `launch.warm.*` | spawning it again, over that profile | the first painted frame of the Library, fixture listed |
| `open.cold` / `open.warm` | double-clicking the fixture's Library row (first / second time in the process) | the first frame that paints the editor with the script loaded, its first compile **succeeded**, the opening panel gone and the text on screen |
| `present.cold` / `present.warm` | clicking Present (reader mode, roll at pace) | the first frame that paints a word of the script with the cover and the opening plate gone |
| `frames.{cold,warm}.{p95,p99,max,long}` | 10 s of rolling at 130 wpm in that take | per take: frame-interval percentiles, the worst frame, and frames over 50 ms |

Launch is split three ways: `spawn-to-ready` is the whole wait.
`spawn-to-entry` runs up to the first statement of `src/control/main.ts`, so
it covers native start plus loading and evaluating the control bundle.
`entry-to-ready` is the shell's own boot: settings, the library, the first
route.

Every end point is a predicate over what is on screen, polled once per
animation frame. The measurement stops at the frame **after** the one where
the predicate first held, which is the first paint that includes it. The error
is up to one frame, and always late, never early. Nothing in the product is
instrumented for this beyond three launch marks (`entry`, `mounted`,
`ready`). The scenario reads the DOM and the stores the way a person reads the
screen (`src/control/lib/perf/scenario.ts`).

Frame intervals come from an rAF loop beside the stage's own loop. All
callbacks in a frame share its timestamp, so the loop sees the cadence the
follower runs at, stalls included. WKWebView has no `longtask` entry type (the
`env` record lists `supportedEntryTypes`), so rAF intervals are the tail
measure. WebKit coarsens these timestamps to whole milliseconds.

## Running it

```bash
pnpm tauri build --bundles app --config bench/perf/tauri.perf.conf.json
node scripts/perf-run.mjs --pairs 20 --label mac-studio-m4-max          # → bench/perf/runs/…json
node scripts/perf-compare.mjs bench/perf/mac-studio-m4-max.json bench/perf/runs/<that file>
```

A pair takes about 40 s, so 20 pairs take about 14 minutes. Record at a quiet
desk with nothing building or testing: everything here is wall-clock time. The
windows open on the desk display, and the takes are reading-window takes there.

`perf-compare` exits 0 when every series is within its threshold. It exits 1
when a series regressed at its p50 or p95, **or the candidate has an invalid
pair**. A launch that never became ready is the worst regression there is, and
reporting only the pairs that survived would hide it. It exits 2 when the two
reports cannot be compared (another Mac, another scenario or fixture). Maxima
are printed but never decide a verdict. The script never rewrites a baseline.
To replace one, copy a recording over it and commit that.

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
runner deletes those folders (and the identity's `HTTPStorages` and saved-state
entries) by exact name before every pair, and touches nothing else. The dev
build's WebKit store (`~/Library/WebKit/speaking-glass`, keyed by the
executable name because a dev binary has no bundle) was left untouched.

The takes roll at a set pace (`fixed`), which never builds the voice
pipeline. No microphone is opened, so no permission prompt can stop an
unattended run, and no speech model is needed.

## The baseline: Mac Studio, M4 Max

`mac-studio-m4-max.json`: Mac16,9, Apple M4 Max, 64 GB, macOS 26.3.1
(25D2128), main display a Pro Display XDR at 3008×1692 and 60 Hz, window
1240×820 at DPR 2. Twenty pairs, all valid:

Milliseconds; frames are per take, then summarised over the 20 takes.

| Series | p50 | p95 | max |
|---|---:|---:|---:|
| `launch.cold.spawn-to-ready` | 388.1 | 422.9 | 1217 |
| `launch.cold.spawn-to-entry` | 346.3 | 381.3 | 1171 |
| `launch.cold.entry-to-ready` | 41 | 47 | 49 |
| `launch.warm.spawn-to-ready` | 372.3 | 388.3 | 393 |
| `launch.warm.spawn-to-entry` | 328.9 | 344 | 351 |
| `launch.warm.entry-to-ready` | 41 | 49 | 49 |
| `open.cold` | 98 | 103 | 106 |
| `open.warm` | 50 | 51 | 52 |
| `present.cold` | 550 | 566 | 566 |
| `present.warm` | 499 | 501 | 516 |
| `frames.cold.p95` / `.p99` | 18 / 18 | 18 / 19 | 18 / 20 |
| `frames.cold.max` | 26 | 36 | 37 |
| `frames.warm.p95` / `.p99` | 18 / 18 | 18 / 19 | 18 / 19 |
| `frames.warm.max` | 20 | 31 | 37 |
| `frames.{cold,warm}.long` | 0 | 0 | 0 |

The cold launch maximum is pair 1: the **first launch of a freshly built
binary** took 1,217 ms against ~390 ms for every later one, with all of the
extra time before the bundle ran. Most likely this is macOS assessing a new
executable on its first run, which is also what a user meets on the first
launch after an install or update. Every recording of a new build has it in
pair 1, so it shows in the maximum and does not move the p95. It is exactly
the cost a best-of-N minimum cannot see.

## Noise, and where the thresholds come from

Two recordings of one unchanged build (40 pairs, before the baseline) were
compared against each other in both directions. The thresholds in
`scripts/perf-report.mjs` (`DEFAULT_THRESHOLDS`, `base × (1 + relative) +
absolute`) are the tightest round numbers that pass both directions with a
margin:

| Family | Allowance | Largest unchanged-build swing seen |
|---|---|---|
| launch | +20% + 40 ms | spawn-to-entry p95 342 → 364 ms |
| open | +20% + 30 ms | warm p95 51 → 58 ms |
| present | +10% + 30 ms | cold max 568 → 585 ms (p50 unchanged at 550) |
| frames (p95, p99) | +25% + 4 ms | 18 → 19 ms |
| frames, worst frame per take | +50% + 8 ms | p95 30 → 42 ms |
| long frames (count per take) | +50% + 1 | 0 → 0 |

Together these catch a tail that only some runs suffer. The unit tests prove
it with supplied numbers: two cold opens in twenty taking four times as long
fail on the p95 while the p50 and the fastest run are unchanged
(`tests/unit/perf-report.test.ts`).

## What the numbers say

- **Launch is native start.** Spawn to the control bundle's first statement
  takes ~340 ms. The shell's boot after that takes ~40 ms.
- **Navigation start is bimodal, so nothing is measured from it.** The page's
  own navigation→entry interval falls at ~40 ms or ~105 ms, in roughly equal
  measure, cold and warm alike. Spawn→entry stays at 320–370 ms either way: the
  difference is when WKWebView stamps navigation start while the native side is
  still starting, not the bundle. The report keeps the field, and the
  comparison uses spawn→entry instead.
- **Present barely varies.** The p50 is 550 ms cold and 499 ms warm in all
  three recordings (59 valid pairs), and no pair is more than 35 ms off it.
  A spread that narrow means fixed steps dominate the wait (the opening
  plate's 200 ms fade is one), not work that varies. The first Present in a
  process pays ~50 ms more than the second. That first-take cost, the first
  wrap plan included, is what the warmed wrap-plan budget stopped seeing, and
  it is now recorded.
- **The take is smooth on this Mac.** Every take's p95 and p99 sit at one
  frame (18–20 ms at 60 Hz). Across all 118 recorded takes the worst single
  frame was 42 ms, and none passed 50 ms.

## The control chunk: left alone

The eager graph `dist/control.html` loads is 1.39 MB of JavaScript (474 kB
gzipped), and the entry chunk alone is 888 kB (302 kB gzipped). Loading,
parsing and evaluating all of it fits inside the fast mode of navigation→entry:
**at most ~40 ms of a ~380 ms launch**, against ~300 ms of native start before
the page can run at all. A split could at best save part of those 40 ms, and
it would move the cost onto the first open or the first Present, which are
waits too. Splitting is not worth doing on these numbers. If launch ever needs
to get faster, the place to look is native start, and the A/B to run is this
recording against one made with a lazy boundary.

## What this does not cover

- **The teleprompter display.** Takes here are reading-window takes on the
  desk display. A prompter take on the pinned panel goes through the same
  renderer, but its window move and panel sizing are not timed.
  `docs/real-rig-test-protocol.md` still covers the rig.
- **Voice.** No recogniser, no microphone and no alignment. The follow loop's
  costs are cc-bench's business.
- **The compositor.** WebKit can run a frame's callbacks and still show a
  stale frame. These numbers measure the first frame where the page could
  paint, not photons.
- **The filesystem cache.** It is not flushed between pairs. "Cold" means a
  fresh app profile, not a cold disk.
- **One pair of the 61 recorded so far** stopped mid-take and was killed at
  the runner's 3-minute limit, leaving no record after Present. The take
  sampler now has a watchdog, so a recurrence reports `stalled` with the
  window's visibility. If no record arrives at all, the main thread itself was
  blocked.
