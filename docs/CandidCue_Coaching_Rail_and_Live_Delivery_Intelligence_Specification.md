# CandidCue Coaching Rail and Live Delivery Intelligence

## Normative Product, UX, Signal-Processing, and AI Specification

**Document ID:** CC-COACH-001  
**Version:** 1.0  
**Date:** 24 July 2026  
**Status:** Implementation-ready companion specification  
**Primary application:** CandidCue desktop teleprompter for Tauri 2.0  
**Primary model:** GPT-5.6 Luna through the OpenAI Responses API  
**Related systems:** Realtime transcription, local script alignment, smooth following, stage compositor, session review

---

# 0. Normative status and precedence

This document defines the complete CandidCue **Coaching Rail** and the supporting **Live Delivery Intelligence** subsystem.

It is intended to be implemented after the core teleprompter, realtime transcription, smooth scrolling, and intelligent alignment systems are working. It is not a replacement for those systems. It consumes their output and adds delivery feedback without becoming part of the scroll-control loop.

Where this document conflicts with earlier requirements concerning the coach rail, coaching tips, filler detection, pace coaching, vocal variety, or delivery analytics, this document takes precedence. In particular, it replaces the earlier high-level coach-rail requirements with the detailed architecture, calculations, UI behavior, model prompts, schemas, and acceptance tests below.

The keywords **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

---

# 1. Product intent

The Coaching Rail is a narrow, reserved area at the bottom of the teleprompter stage that helps a speaker improve a take while remaining focused on the script and camera.

It should answer four glanceable questions:

1. **Am I speaking at the intended pace?**
2. **Am I becoming flat, rushed, choppy, or overly repetitive?**
3. **Am I using fillers or repeatedly restarting?**
4. **Is there one specific adjustment worth making now?**

The rail must not resemble a live grading dashboard. The user is already performing a cognitively demanding task: reading, sounding natural, maintaining eye contact, operating a camera, and possibly managing a retake. The rail therefore presents only information that is either continuously glanceable or immediately actionable.

The feature has two complementary outputs:

- **Live rail:** sparse telemetry and at most one short coaching instruction.
- **Post-take review:** the full evidence, event map, trends, and detailed recommendations that would be distracting during the take.

The live experience is deliberately restrained. The review experience may be detailed.

---

# 2. Core product decisions

## 2.1 Coaching is advisory and never controls the teleprompter

The Coaching subsystem MUST NOT directly:

- set scroll position;
- modify the semantic cursor;
- authorize section jumps;
- commit or reject a retake;
- change alignment confidence;
- change microphone gain;
- rewrite the script;
- pause the take;
- interrupt a voice command.

It may read alignment, pacing, transcript, and stage state. It may emit a tip candidate. The final display policy remains local and deterministic.

## 2.2 Local-first, model-assisted architecture

Immediate delivery measurements MUST be calculated locally from the microphone stream and the existing script-tracking state. These include:

- speaking rate;
- speech-versus-silence timing;
- pause distribution;
- pitch movement;
- loudness variation;
- clipping and noise indicators;
- cadence patterns;
- script-relative insertions, repetitions, and restarts;
- provisional filler candidates.

GPT-5.6 Luna accepts text and images but not audio. It therefore cannot directly listen to pitch, cadence, energy, or raw fillers. Luna receives only finalized transcript text, exact authored spans, alignment evidence, and compact numerical features calculated locally. It performs semantic classification and tip selection under a strict schema.[^luna]

## 2.3 Filler detection is layered rather than assumed

CandidCue MUST NOT assume that the live transcript is a verbatim record of every hesitation. OpenAI’s speech-to-text guidance states that transcription models may omit common filler words unless they are prompted to preserve them. The current `gpt-realtime-whisper` path does not support a prompt in GA Realtime sessions, so the live model cannot be instructed to preserve every “um,” “uh,” or false start.[^stt-fillers][^realtime]

CandidCue therefore uses three evidence layers:

1. **Realtime lexical evidence:** fillers that do appear in finalized Realtime transcript items.
2. **Local acoustic candidates:** hesitation-like events and repetitions detected from raw audio and local timing.
3. **Optional precision transcription:** short completed audio chunks sent to a promptable transcription model to obtain a more verbatim, disfluency-preserving transcript.

A filler may be counted without being localized precisely when the evidence is strong but timing is uncertain. The interface must distinguish confirmed, probable, and unlocalized events.

## 2.4 “And” is not automatically a filler

Words such as **and**, **so**, **but**, **well**, **like**, **actually**, and **okay** are legitimate language. They become coaching candidates only when context shows that they are being used as repeated discourse openers, hesitation devices, or unnecessary insertions.

CandidCue MUST NOT put a red filler mark on every “and.” It should separately track:

- strict vocalized fillers such as “um” and “uh”;
- contextual fillers such as “you know” or a hesitation-like “like”;
- repeated sentence openers such as “and,” “so,” or “basically”;
- repetitions and false starts;
- authored words that happen to resemble filler vocabulary.

## 2.5 More vocal variety is not always better

The user may select a delivery style and a target range for vocal variety. The feature measures the **amount** of variation, then evaluates whether that amount falls inside the selected target band. It MUST NOT reward users for maximizing pitch swings, loudness changes, or pacing variation.

The stage may show:

```text
VARIETY 68 · BALANCED
```

It must not imply that 100 is universally better than 68.

## 2.6 Silence is a valid coaching decision

The correct output for most analysis windows is no tip. A user who is reading comfortably should see stable status indicators, not a stream of praise or criticism.

---

# 3. Research-grounded capability conclusions

## 3.1 What Realtime transcription supplies

The current Realtime transcription API can stream incremental transcript deltas and finalized transcript items. `gpt-realtime-whisper` exposes a configurable delay/accuracy tradeoff, and optional log probabilities may be requested. Completion events from different items are not guaranteed to arrive in order, so all evidence must be associated with the application’s audio-commit ledger and OpenAI `item_id`.[^realtime]

Useful evidence from Realtime includes:

- partial lexical content for low-latency script following;
- final lexical content for stable delivery analytics;
- item identity;
- optional token log probabilities when supported;
- the application’s own known audio interval for each committed item.

Realtime transcription does not provide a guaranteed verbatim disfluency transcript, and CandidCue must not depend on word-level timestamps being present.

## 3.2 What a promptable precision transcription pass adds

The file-oriented OpenAI transcription models accept prompt guidance. OpenAI specifically documents a prompt containing “umm,” “hmm,” and “like” as a way to encourage preservation of common filler words.[^stt-fillers]

The default precision pass SHOULD use `gpt-4o-mini-transcribe` because it accepts audio and text, is designed for speech-to-text, and is cheaper than the larger transcription model. A high-accuracy option MAY use `gpt-4o-transcribe`.[^mini-transcribe][^transcribe]

The precision pass is asynchronous. It should improve filler recall and post-take accuracy, but it must not be required for immediate WPM, pitch, cadence, or microphone coaching.

## 3.3 What Luna can and cannot do

GPT-5.6 Luna supports streaming, function calling, and Structured Outputs, but does not accept audio. It is well suited to compact, high-volume classification of text and numerical feature summaries.[^luna][^structured]

Luna can help determine:

- whether a spoken deviation preserves the authored meaning;
- whether a contextual word functions as a filler in this sentence;
- whether an ad-lib is useful elaboration or redundant wordiness;
- whether a restart has already corrected the problem;
- whether a proposed coaching tip is still relevant;
- which one of several locally generated tip candidates has the highest value.

Luna cannot independently determine:

- the user’s pitch;
- microphone clipping;
- loudness or absolute sound pressure;
- raw cadence;
- a true acoustic “um” that was omitted from all transcripts;
- pronunciation quality from transcript text alone;
- emotion, confidence, honesty, charisma, or audience reaction.

## 3.4 Competitive baseline

Microsoft Speaker Coach publicly evaluates pace, pitch, filler words, repetitive language, and related delivery qualities, and presents one live critique at a time. Microsoft’s broad presentation guidance cites approximately 100–165 words per minute as a general range, while acknowledging that different speakers and audiences vary.[^ms-coach][^ms-suggestions]

CandidCue should not merely reproduce a generic speaker report. Its advantage is that it knows the exact script, the active line, the intended timing, the retake state, the authored emphasis, and the current teleprompter geometry. Coaching can therefore be better timed and more context-aware.

---

# 4. Scope and non-goals

## 4.1 In scope

Version 1 of Live Delivery Intelligence includes:

- local microphone feature extraction;
- continuous pace estimation;
- user-selectable pace target;
- optional target-duration pacing;
- strict and contextual filler tracking;
- optional disfluency-preserving precision transcription;
- filler event timeline;
- optional past-line gutter marks;
- pitch and loudness variation analysis;
- cadence and pause analysis;
- a personalized vocal-variety score;
- microphone quality alerts;
- script-relative mismatch and restart evidence;
- Luna semantic classification;
- deterministic tip selection and wording;
- post-take coaching summary;
- local privacy controls and BYOK cost controls.

## 4.2 Explicit non-goals

Version 1 MUST NOT claim to diagnose or score:

- anxiety;
- confidence as an internal emotional state;
- truthfulness;
- personality;
- neurological or speech disorders;
- vocal health;
- attractiveness of the voice;
- accent quality;
- cultural appropriateness of an accent;
- gender, age, ethnicity, or identity from voice;
- audience engagement without audience evidence;
- pronunciation solely because ASR produced a different word.

The product may describe observable behavior, such as “pace increased” or “pitch range narrowed.” It must not turn those observations into psychological judgments.

---

# 5. System architecture

## 5.1 High-level data flow

```text
Microphone MediaStream
        │
        ├── OpenAI Realtime transcription
        │       ├── transcript deltas
        │       ├── finalized transcript items
        │       └── optional log probabilities
        │
        ├── Local AudioWorklet / DSP worker
        │       ├── VAD and speech clock
        │       ├── RMS, peak, clipping, noise floor
        │       ├── pitch and voicing confidence
        │       └── frame-level acoustic features
        │
        └── Short in-memory audio ring buffer
                └── optional precision transcription chunks

Script tracker + renderer
        ├── active authored span
        ├── semantic cursor and confidence
        ├── retake / command / reacquisition state
        ├── punctuation and emphasis map
        └── script-relative token operations

Local Delivery Analyzer
        ├── pace state
        ├── filler events
        ├── cadence state
        ├── variety state
        ├── microphone state
        └── deterministic tip candidates

Luna Coach Observer
        └── semantic classification of bounded candidates

Local Coach Policy
        ├── validity and staleness checks
        ├── priority, cooldown, and suppression
        └── deterministic copy selection

Stage Coaching Rail
        ├── persistent telemetry
        ├── one active tip
        └── recent-event ribbon
```

## 5.2 Process separation

The stage window MUST remain a renderer, not an analysis engine.

Preferred ownership:

- **Control webview / audio worker:** microphone stream, WebRTC connection, AudioWorklet, feature aggregation.
- **Rust core or dedicated worker:** durable session clock, rolling metrics, event ledger, optional persistence, IPC validation.
- **Alignment worker:** script-relative evidence already defined by the tracking specifications.
- **Luna service:** bounded Responses API requests.
- **Stage window:** receives a compact `CoachRailState` snapshot and renders it.

The stage must continue to scroll smoothly if all coaching processes fail.

## 5.3 One capture, multiple consumers

CandidCue SHOULD request microphone access once and fan out the same `MediaStreamTrack` to:

- the Realtime WebRTC peer connection;
- a `MediaStreamAudioSourceNode` feeding an `AudioWorkletNode`;
- an in-memory circular buffer when precision coaching is enabled.

The app SHOULD NOT open a second microphone capture session solely for coaching. This reduces permission complexity, clock drift, device contention, and inconsistent automatic gain processing.

## 5.4 Clock authority

All coaching evidence MUST use the application’s monotonic audio clock, not wall-clock arrival time from API responses.

Every Realtime commit and precision chunk receives:

- `audio_start_ms`;
- `audio_end_ms`;
- `commit_sequence`;
- `tracking_epoch`;
- `take_pass_id`.

Delayed model results are mapped back to this interval. Arrival time is only used for latency diagnostics.

---

# 6. Coaching modes

The user selects a rail mode globally, with optional per-script override.

## 6.1 Off

- No coaching rail.
- Critical microphone and transcription failures still use the application’s existing system-notice mechanism.
- Analysis may also be disabled to save CPU and API usage.

## 6.2 Minimal

Shows:

- current WPM and pace status;
- critical microphone problems;
- critical authored number, name, unit, or negation discrepancy;
- no filler ribbon;
- no variety score;
- no ordinary coaching tips.

## 6.3 Coach — default

Shows:

- current WPM and target state;
- one actionable coaching tip when warranted;
- confirmed filler count for the current take;
- a subtle recent-event ribbon;
- microphone alerts;
- vocal variety as a status label when enough evidence exists.

## 6.4 Studio

Shows all Coach-mode features plus:

- numeric variety score;
- pace sparkline;
- fuller recent-event ribbon;
- optional pause and restart markers;
- optional past-line gutter marks;
- more frequent, but still bounded, coaching.

## 6.5 Review only

- No live rail except critical system alerts.
- All enabled analytics are calculated for the post-take report.
- Useful for users who find live feedback distracting.

## 6.6 Custom

Individual modules may be enabled or disabled:

- pace number;
- pace status;
- target-duration status;
- variety score;
- filler count;
- filler event ribbon;
- inline past-line marks;
- live tips;
- positive reinforcement;
- precision transcription;
- post-take report.

---

# 7. Rail layout and visual behavior

## 7.1 Reserved geometry

The Coaching Rail occupies a permanently reserved band at the bottom of the safe stage viewport. It MUST NOT overlay or move the script.

Recommended default geometry for a 16:9 stage:

- minimum height: 52 CSS px;
- preferred height: 64 CSS px;
- maximum height: 8% of safe viewport height;
- horizontal padding: equal to or slightly wider than script-column padding;
- separation from script: 10–18 CSS px;
- one text row plus a 4–8 px event ribbon.

The rail may collapse to a smaller layout when the stage is narrow. It must never force the active reading line upward after the take begins.

## 7.2 Three-zone desktop layout

At sufficient width, the rail uses three zones:

```text
┌─────────────────┬──────────────────────────────────┬──────────────────────┐
│ PACE 142        │ Use a silent pause              │ VARIETY 68           │
│ ON TARGET       │                                  │ BALANCED · FILLERS 2 │
└─────────────────┴──────────────────────────────────┴──────────────────────┘
  ───── speech activity ──│ filler │────── now ────────────────────────────
```

- **Left:** persistent pace telemetry.
- **Center:** one active tip or quiet status message.
- **Right:** variety and filler summary.
- **Bottom ribbon:** recent time-based events.

## 7.3 Responsive degradation

When width is constrained:

1. Hide the pace sparkline.
2. Replace numeric variety with a label.
3. Hide the filler count but retain event ticks.
4. Collapse left and right telemetry into a single compact row.
5. Preserve the active tip.
6. At the smallest safe layout, show only the active tip or critical alert.

## 7.4 Visual hierarchy

The script remains dominant. The rail SHOULD use:

- smaller typography than the script;
- lower contrast for stable telemetry;
- moderate contrast for an actionable tip;
- high contrast only for system-critical alerts;
- no pulsing, bouncing, or vertical movement;
- a 120–220 ms opacity transition;
- no animated number rolling.

A new filler tick may fade into the ribbon but MUST NOT flash.

## 7.5 Mirror mode

The entire stage—including coaching text, event order, and directional indicators—must appear correct through the teleprompter glass.

Implementation should use the same mirror transform boundary as the script rather than individually reversing strings or icons. Icons that imply direction MUST be visually tested through an actual mirrored teleprompter setup.

## 7.6 Accessibility

- Never rely on red/green alone.
- Pair status color with text or shape.
- Filler markers use both color and a distinct tick shape.
- Respect reduced-motion preferences.
- Allow rail text scale from 80% to 150%.
- Support high-contrast mode.
- Provide a color-blind-safe palette.
- Do not use a hue-only gradient for pace or variety.

---

# 8. Persistent rail telemetry

## 8.1 Pace tile

Default content:

```text
PACE 142
ON TARGET
```

Possible states:

- `LEARNING`;
- `ON TARGET`;
- `SLIGHTLY FAST`;
- `FAST`;
- `SLIGHTLY SLOW`;
- `SLOW`;
- `PAUSED`;
- `LOW CONFIDENCE`.

The number updates smoothly and no faster than four visual updates per second. It is rounded to the nearest whole WPM, or nearest two WPM when transcript evidence is noisy.

## 8.2 Target-duration mode

If the user enters a desired take duration, the pace tile MAY show schedule status instead of a generic range:

```text
PACE 148
ON TIME
```

or:

```text
PACE 148
12 SEC AHEAD
```

The app should avoid prompting the user to chase small timing fluctuations. Schedule coaching begins only after a sustained projected error greater than the configured tolerance.

## 8.3 Variety tile

Before sufficient evidence:

```text
VARIETY —
LEARNING
```

After calibration:

```text
VARIETY 68
BALANCED
```

Possible labels:

- `VERY STEADY`;
- `STEADY`;
- `BALANCED`;
- `EXPRESSIVE`;
- `HIGHLY ANIMATED`;
- `LOW CONFIDENCE`.

These labels describe amount, not quality. The target band is determined by the selected delivery profile.

## 8.4 Filler summary

The rail shows a take-local count:

```text
FILLERS 2
```

A count may include only confirmed events by default. Probable events appear in the post-take report and optionally as hollow ticks.

If precision transcription is disabled, the UI should disclose in settings that filler recall may be incomplete. It should not place a permanent warning on the stage.

## 8.5 Quiet positive state

The rail can communicate success without issuing a tip:

```text
PACE 144 · ON TARGET
VARIETY 61 · BALANCED
```

Optional positive messages such as `Good pace` are allowed only when the user enables encouragement. They should appear no more than once per minute and should never displace a more important actionable message.

---

# 9. Active coaching tip

## 9.1 One tip at a time

Only one non-system tip may be visible. If multiple candidates are eligible, the local coach policy selects the highest-value one.

## 9.2 Copy requirements

A live tip SHOULD:

- contain 2–7 words;
- fit on one line at normal rail scale;
- state an action, not a judgment;
- avoid technical terminology;
- avoid blame;
- remain useful despite 1–3 seconds of model delay.

Preferred:

```text
Ease back slightly
Use a silent pause
Let the sentence land
Lift the key words
Keep this sentence flowing
Move a little closer to the mic
```

Avoid:

```text
Your prosodic variability score is suboptimal
You sound boring
You keep making mistakes
The AI has detected low confidence
You should speak better
```

## 9.3 Tip lifecycle

A tip has:

- candidate creation time;
- evidence interval;
- earliest safe display time;
- expiry time;
- minimum display duration;
- maximum display duration;
- cooldown key;
- priority;
- `tracking_epoch`;
- `take_pass_id`;
- optional script-token anchor.

Typical display duration is 2.5–4.5 seconds. A critical microphone alert may persist until resolved.

## 9.4 Safe display opportunity

Ordinary tips SHOULD appear at a low-load moment:

- immediately after a sentence boundary;
- during the first third of a new sentence;
- during a natural pause;
- after scroll acceleration has settled;
- after the user has completed a retake correction.

A candidate may wait up to three seconds for a safe opportunity. If it becomes stale, it is discarded.

## 9.5 Suppression states

Suppress ordinary coaching while:

- a wake-word command is being parsed;
- a command acknowledgement is visible;
- alignment confidence is low;
- global or section-level reacquisition is underway;
- a retake is pending or reversing;
- the user is rapidly manually scrolling;
- the stage is reconnecting;
- the microphone device changed;
- the script layout is being rebuilt;
- the active sentence is marked `coach: off`;
- a critical alert is visible.

---

# 10. Recent-event ribbon

## 10.1 Purpose

The ribbon provides the user with a nonverbal answer to: “Where, recently, did that happen?” It is more useful than repeatedly displaying the word “um” as a textual warning.

## 10.2 Default time window

- Coach mode: last 20 seconds.
- Studio mode: last 30 seconds.
- Right edge: current audio time.
- Leftward motion: continuous and frame-rate independent.

## 10.3 Event encoding

Recommended markers:

- **Confirmed filler:** solid red vertical tick.
- **Probable filler:** hollow amber tick.
- **Repeated word / false start:** double tick.
- **Long pause:** thin neutral gap in speech-activity trace.
- **Restart / retake:** small backward-hook marker.
- **Critical script discrepancy:** diamond marker.
- **Microphone clipping:** short top-edge block.

Marker shapes must remain distinguishable without color.

## 10.4 Retroactive insertion

Precision-transcription results may arrive after the corresponding speech has moved leftward in the ribbon. The new marker should fade into its historical position over 150–250 ms. It must not jump to “now.”

## 10.5 Ribbon restraint

The default ribbon shows only:

- speech activity;
- confirmed fillers;
- current-time edge.

Other event types are Studio-mode or user-selected options. The ribbon should not become an oscilloscope.

---

# 11. Optional script-gutter marks

## 11.1 Purpose

A user may enable small markers beside already-read script lines. These answer “which line contained the filler?” and remain useful when the speaker scrolls or retakes upward.

## 11.2 Rules

- Marks appear only behind the active reading rail, never in unread text.
- A filler inserted between authored tokens anchors to the nearest preceding token.
- The script text itself is not recolored.
- A line with multiple events collapses to a marker with a count.
- Older pass markers fade when the user begins a new take pass over the same line.
- The control window may reveal details on hover or click; the stage remains noninteractive.
- Marks are session-local unless the user saves a rehearsal report.

## 11.3 Retake semantics

Every event carries a `take_pass_id`. If the user rereads a sentence, events from the old pass and new pass must not be conflated. The stage may show only the most recent pass by default, while the review screen shows all passes.

---

# 12. Local audio-analysis pipeline

## 12.1 Processing location

Preferred implementation uses an `AudioWorkletProcessor` or equivalent dedicated real-time worker. The Web Audio specification supports graph-based processing and direct audio processing; worklet code must remain isolated from the UI thread.[^webaudio]

The processing code SHOULD be implemented in Rust/WASM or carefully bounded TypeScript. It must not allocate per frame, block on IPC, call Luna, perform network I/O, or manipulate the DOM.

## 12.2 Input format

The worklet receives the browser’s native microphone sample rate, commonly 44.1 or 48 kHz. It MAY maintain native-rate analysis while separately resampling the OpenAI stream to the required format.

Recommended frame configuration:

- analysis frame: 20 ms;
- pitch window: 40–50 ms;
- pitch hop: 10 ms;
- aggregation update: 100 ms;
- rail state publication: 200 ms or on material state change.

## 12.3 Signal conditioning

The local analysis path MAY apply:

- DC removal;
- a gentle high-pass filter below approximately 60–80 Hz;
- channel downmix to mono;
- adaptive noise-floor estimation;
- no automatic gain changes to the audio sent to OpenAI unless separately configured.

Analysis filters must not modify the source track that is recorded or transmitted unless the user explicitly enables microphone processing.

## 12.4 Frame-level features

Each frame produces:

```ts
interface AudioFrameFeatures {
  audioTimeMs: number;
  rmsDbfs: number;
  peakDbfs: number;
  clippingRatio: number;
  noiseFloorDbfs: number;
  estimatedSnrDb: number;
  speechProbability: number;
  voicedProbability: number;
  f0Hz: number | null;
  f0Confidence: number;
  spectralFlux: number;
  zeroCrossingRate: number;
  processorDropout: boolean;
}
```

Not every field must be surfaced to users. They exist to support robust aggregation and diagnostics.

## 12.5 Voice activity and the speech clock

CandidCue maintains a local VAD with hysteresis. It is independent of OpenAI’s commit behavior and acts as the timing authority for coaching.

Suggested initial behavior:

- speech begins after 80–140 ms of sustained speech probability;
- speech ends after 180–350 ms below threshold;
- preserve micro-pauses shorter than the end threshold as internal pauses;
- label pauses rather than deleting them from the clock;
- adapt thresholds slowly to background noise;
- never train the noise floor on frames currently classified as voiced speech.

The VAD emits:

```ts
interface SpeechInterval {
  startMs: number;
  endMs: number;
  voicedMs: number;
  silenceMs: number;
  meanSnrDb: number;
  takePassId: string;
}
```

## 12.6 Audio ring buffer

When precision coaching is enabled, keep a rolling in-memory PCM ring buffer.

Defaults:

- capacity: 30 seconds;
- hard maximum without recording consent: 60 seconds;
- memory only;
- overwritten continuously;
- cleared on take end, microphone stop, application lock, or user request;
- never written to disk merely to call the transcription API.

The ring buffer also supports precise reconstruction of short diagnostic intervals when a delayed transcript result arrives.

## 12.7 Microphone quality measurements

### 12.7.1 Clipping

Flag clipping when either condition persists:

- peak approaches full scale on repeated frames; or
- clipping ratio exceeds the calibrated threshold over a one-second interval.

Do not react to a single isolated clipped sample.

### 12.7.2 Low level

A low-level warning requires:

- active speech is confidently detected;
- rolling RMS remains materially below the user’s calibration range;
- estimated SNR is poor or OpenAI transcript confidence deteriorates;
- condition persists for at least two seconds.

### 12.7.3 Noise

Estimate noise floor during non-speech. Warn only when background noise materially reduces SNR for several seconds. Avoid a generic “noise” alert when the user is simply speaking quietly.

### 12.7.4 Absolute loudness limitation

Without a calibrated microphone and known distance, CandidCue measures relative digital level, not physical sound-pressure level. It MUST NOT tell the user that they are speaking at a specific decibel SPL.

---

# 13. Pitch extraction

## 13.1 Algorithm

Use a real-time fundamental-frequency estimator such as YIN or a probabilistic YIN derivative. YIN was designed for fundamental-frequency estimation of speech and music and is suitable as the reference algorithm for the first implementation.[^yin]

## 13.2 Initial parameters

- window length: 40–50 ms;
- hop: 10 ms;
- initial F0 search range: 60–500 Hz;
- expand only when calibration evidence supports it;
- reject frames below voicing or pitch-confidence threshold;
- apply a short median filter;
- detect and suppress isolated octave jumps;
- preserve genuine sustained changes.

## 13.3 Speaker-relative units

Raw Hertz is unsuitable for comparing pitch movement across speakers. Convert accepted pitch frames to semitones around a slowly learned reference:

```text
pitch_st(t) = 12 × log2(f0(t) / f0_reference)
```

`f0_reference` is the rolling median of reliable voiced frames, initialized from a 10–20 second calibration period.

## 13.4 Reliability gate

Pitch-derived coaching is disabled when:

- fewer than 45% of recent speech frames have reliable F0;
- SNR is below threshold;
- background music or another speaker is detected;
- the microphone is clipping heavily;
- pitch tracking shows repeated unresolved octave errors;
- less than 12 seconds of usable voiced audio exists.

The rail shows `VARIETY — · LEARNING` or hides the tile rather than inventing a score.

## 13.5 No fixed “male” or “female” pitch target

CandidCue does not classify the speaker by gender and does not compare median pitch against gendered norms. It evaluates movement relative to the speaker’s own usable range and selected style.

---

# 14. Pace measurement

## 14.1 Definitions

CandidCue maintains three related rates:

1. **Audible WPM:** all spoken lexical tokens, including confirmed fillers and repetitions, divided by elapsed delivery time.
2. **Content WPM:** meaningful delivered words, excluding wake commands and confirmed fillers.
3. **Articulation WPM:** spoken words divided by active voiced time, excluding silence.

The live rail displays **Audible WPM** when sufficiently reliable. Before precision filler evidence arrives, it uses the best available lexical count and may be lower by a small amount. The post-take report shows Audible WPM and Articulation WPM separately.

## 14.2 Token counting

Count spoken lexical units, not rendered Markdown tokens.

Exclude:

- wake word and voice commands;
- stage acknowledgements;
- non-spoken headings and image descriptions;
- duplicate partial-transcript revisions;
- words emitted by background audio when rejected by VAD/speaker checks.

Include:

- ad-libs;
- repeated words;
- fillers when confirmed;
- spoken numbers as the number of lexical words actually delivered when known.

## 14.3 Timing tokens without word timestamps

Because word timestamps are not assumed, token timing is reconstructed from:

- application-owned audio interval for each Realtime commit;
- local VAD sub-intervals;
- partial transcript arrival corrected by measured transcription delay;
- script-alignment progress;
- syllable or speech-weight estimates;
- final transcript reconciliation.

For a finalized segment, distribute token centers across its voiced sub-intervals proportionally to estimated speech weights. If a silence break exists, do not place tokens inside it.

This timing need not be phoneme-perfect. It must be stable enough for rolling pace and event placement.

## 14.4 Exponentially weighted moving rate

The user-facing pace is an **exponentially weighted moving estimate**, commonly called an EWMA. A weighted linear regression over cumulative word count is preferred to a simple moving-window division because transcript updates arrive irregularly.

Let each observation contain audio time `t_i` and cumulative spoken word count `N_i`. Over the recent horizon:

```text
w_i = exp(-(t_now - t_i) / τ)
```

where `τ = half_life / ln(2)`.

Compute the weighted least-squares slope of `N` against `t`, then convert to words per minute:

```text
WPM_raw = 60 × weightedSlope(N, t)
```

Recommended defaults:

- observation horizon: 14 seconds;
- display half-life: 4 seconds;
- trend half-life: 15 seconds;
- minimum usable active evidence: 3.5 seconds;
- outlier rejection: robust residual threshold;
- maximum displayed change: 12 WPM per second unless a true section/retake reset occurs.

## 14.5 Pauses

Short and medium pauses are part of delivery and influence Audible WPM. However, the number should not visibly fall toward zero during a deliberate pause.

Behavior:

- hold the last stable WPM for the first 1.5 seconds of silence;
- after 1.5 seconds, show `PAUSED` while retaining the last number at lower contrast;
- after 8 seconds or a command/manual pause, hide the number or show `—`;
- resume the filter from its previous state with a bounded warm start.

## 14.6 Target profiles

Initial presets:

| Profile | Target WPM | Intent |
|---|---:|---|
| Calm explainer | 110–145 | reflective, instructional, premium presentation |
| Natural presentation | 115–160 | broad default |
| Conversational camera | 130–170 | direct-to-camera delivery |
| Energetic short-form | 150–190 | fast, concise social/video content |
| Custom | user-defined | exact production requirement |

These values are starting presets, not universal truths. Microsoft’s general presentation range of 100–165 WPM is a useful broad reference, but CandidCue allows the speaker, script, audience, and production format to define the target.[^ms-suggestions]

## 14.7 Hysteresis and state classification

For target band `[L, U]`:

- `ON TARGET`: filtered pace within `[L, U]`;
- `SLIGHTLY FAST`: `U < pace ≤ U + 12`;
- `FAST`: `pace > U + 12` for at least 4 seconds;
- `SLIGHTLY SLOW`: `L - 12 ≤ pace < L`;
- `SLOW`: `pace < L - 12` for at least 5 seconds.

Use 4–6 WPM hysteresis when returning to a less severe state. Initial thresholds are provisional and must be tuned in user testing.

## 14.8 Pace tip eligibility

A pace tile may change state immediately after filtering. A textual pace tip requires more evidence.

Show `Ease back slightly` only when:

- pace has remained above the fast threshold for at least 6 seconds;
- the user is not intentionally reading a marked fast section;
- the line-tracking system is not catching up after a transcript delay;
- at least one sentence boundary has passed;
- no higher-priority tip exists;
- the same tip has not appeared within 25 seconds.

Show `Bring the pace up a touch` only after a similarly sustained slow pattern. Never show it during a pause, reflective line, list, quotation, retake, or system delay.

## 14.9 Terminal-rush detection

For a sufficiently long sentence, compare delivery rate over the final 25–35% against the earlier portion:

```text
terminalRushRatio = finalSegmentWpm / earlierSegmentWpm
```

A candidate is created when:

- ratio exceeds approximately 1.25;
- sentence contains at least eight spoken words;
- the pattern occurs in at least two of the last three eligible sentences;
- transcript/alignment confidence is high.

Suggested tip:

```text
Don’t rush the ending
```

## 14.10 Target-duration pacing

If the user specifies a target duration, derive a rolling required pace:

```text
requiredWpm = remainingSpokenWordEquivalents / remainingTargetMinutes
```

Smooth this value and cap changes around skipped sections, commands, and retakes.

The live schedule state should use projected finish time, not instantaneous pace alone. Avoid displaying schedule error smaller than 5–10 seconds. A user may configure tolerance.

---

# 15. Filler and disfluency taxonomy

## 15.1 Strict vocalized fillers

Examples:

- um;
- uh;
- er;
- erm;
- hmm when used to hold the floor;
- mm when used as hesitation;
- ah when used as hesitation rather than expression.

Strict fillers receive the highest default confidence when present in a finalized verbatim transcript.

## 15.2 Contextual fillers and discourse markers

Examples:

- like;
- you know;
- I mean;
- kind of;
- sort of;
- basically;
- actually;
- literally;
- right;
- okay;
- well;
- so.

These require context. A word is not a filler merely because it appears in the list.

## 15.3 Repetitive openers

Track sentence or clause openers separately:

- and;
- so;
- but;
- basically;
- now;
- okay;
- right.

A repetitive opener is a session pattern, not necessarily an individual filler event. It is normally post-take feedback. Live coaching is allowed only when the pattern is extreme, user-enabled, and confidently absent from the script.

## 15.4 Repetitions and false starts

Examples:

```text
I, I think we should begin.
The next— the next thing is...
We can use the, um, the second option.
```

Classify separately:

- repeated token;
- repeated phrase;
- abandoned phrase;
- self-correction;
- retake of authored content.

A successful self-correction should not trigger a semantic-error tip. It may still count as a disfluency in review mode.

## 15.5 Intentional authored fillers

If the script explicitly contains a filler-like word, speaking it is not an insertion and should not be marked by default.

The author may annotate intentional delivery:

```markdown
I was, *um*, not expecting that.
```

or:

```markdown
<!-- cc:filler intentional -->
Um, let me think.
```

## 15.6 Custom dictionary

The user may:

- add custom filler phrases;
- disable built-in contextual fillers;
- mark a word as an intentional style word;
- choose whether repeated openers count;
- set a filler-rate target;
- select strict-only or broad detection.

Customizations apply locally and are included in Luna requests only as compact classification rules.

---

# 16. Filler-detection pipeline

## 16.1 Layer A: Realtime transcript detection

On every finalized Realtime item:

1. Normalize punctuation and casing without deleting apostrophes.
2. Preserve repeated tokens.
3. Search strict filler lexicon.
4. Search multiword contextual patterns.
5. Compare against the aligned script span.
6. Check authored intentional-filler annotations.
7. Use log probabilities when available as one confidence feature.
8. Emit candidates with audio interval and script anchor.

Partial transcript fillers may update an internal candidate but MUST NOT create a visible solid tick.

## 16.2 Layer B: local acoustic candidates

A local acoustic candidate detector may identify hesitation-like regions from:

- VAD-defined voiced segment duration;
- relatively stable pitch;
- low spectral movement;
- low lexical progress despite continued voicing;
- location between script tokens;
- proximity to a repetition or restart.

This layer is intentionally conservative. A generic sustained vowel is not automatically “um.” Local acoustic evidence may:

- create a hollow probable marker;
- trigger retention of the audio region for precision analysis;
- increase confidence in a transcript-derived filler;
- never alone produce a high-severity live critique in v1.

A future compact on-device classifier may improve this layer, but it requires a licensed, representative training set and separate evaluation across accents, microphones, and noise conditions.

## 16.3 Layer C: precision transcription

### 16.3.1 Chunking

Create a precision chunk at one of these boundaries:

- finalized Realtime commit lasting 3–12 seconds;
- sentence boundary with at least 2 seconds of speech;
- candidate filler cluster;
- take end;
- long pause.

Use 300–600 ms overlap between adjacent chunks and de-duplicate by audio time.

### 16.3.2 Model

Default:

```text
gpt-4o-mini-transcribe
```

Optional high-accuracy setting:

```text
gpt-4o-transcribe
```

### 16.3.3 Precision transcription prompt

```text
Transcribe this audio verbatim. Preserve every audible hesitation,
filler, repeated word, false start, abandoned phrase, and self-correction.
Preserve forms such as “um,” “uh,” “er,” “erm,” “ah,” “hmm,” “like,”
and “you know” when they are actually spoken. Do not clean up grammar,
do not silently remove disfluencies, and do not add words that are not
audible. Use punctuation only to reflect the spoken phrasing.

Contextual spellings and proper nouns:
{{short_script_dictionary}}
```

The script dictionary is short and limited to nearby names, terms, and acronyms. The prompt is not the whole script.

### 16.3.4 Alignment of precision result

Align three sequences:

1. finalized Realtime transcript;
2. precision verbatim transcript;
3. eligible local script span.

Use weighted dynamic programming. Tokens present only in the precision transcript become candidate disfluencies. Map an insertion to audio time using:

- matched neighboring token intervals;
- local VAD boundaries;
- local acoustic candidate peaks;
- proportional placement within the chunk.

If localization confidence is low, count the filler but mark it `unlocalized`. Do not place a precise red gutter dot.

### 16.3.5 Delay behavior

Precision results are expected to be delayed. They may:

- backfill the event ribbon;
- update the filler count;
- contribute to a pattern-level tip;
- improve post-take review.

They SHOULD NOT trigger a reprimand for one isolated filler several seconds after the speaker has moved on.

## 16.4 Contextual classification

A local rule or Luna may classify a contextual token. Required contextual evidence includes some combination of:

- token is absent from authored text;
- token appears at a pause boundary;
- token carries little propositional meaning;
- token repeats frequently;
- deleting it leaves the sentence meaning intact;
- acoustic timing resembles hesitation;
- it is not part of a quotation or fixed phrase.

Examples:

- `I like this approach` → “like” is lexical, not filler.
- `It was, like, a completely different result` → possible contextual filler.
- `And then we continue` once → normal connector.
- twelve consecutive sentences beginning with `And` when not authored → repetitive opener pattern.

## 16.5 Confidence levels

```ts
type FillerConfidence = 'probable' | 'confirmed' | 'rejected';
```

Suggested interpretation:

- **Confirmed:** final transcript or precision transcript contains the event, contextual classification passes, and timing is credible.
- **Probable:** acoustic/local evidence is meaningful but lexical evidence is incomplete.
- **Rejected:** later transcript revision or context shows a legitimate word.

Only confirmed events count in the default stage total.

## 16.6 Filler rates

Maintain:

- fillers per minute;
- fillers per 100 audible words;
- strict fillers per minute;
- contextual fillers per minute;
- most frequent filler phrase;
- cluster count;
- filler-free speaking streak.

Do not show all these live. They belong in review.

## 16.7 Filler tip threshold

Do not show a live tip for the first isolated filler.

Initial pattern candidate thresholds:

- three confirmed fillers in 20 seconds; or
- five confirmed fillers in 60 seconds; or
- the same strict filler three times in 30 seconds; or
- two clusters separated by less than 15 seconds.

Thresholds are personalized slowly and configurable. A first-time user receives a forgiving default.

Suggested tip:

```text
Use a silent pause
```

For repeated strict filler, optionally:

```text
Pause instead of “um”
```

Do not quote a contextual word unless classification confidence is very high.

## 16.8 Filler improvement status

The rail MAY quietly recognize a sustained improvement with a neutral status such as:

```text
30 SEC FILLER-FREE
```

This is off by default and must not appear more than once per take segment.

---

# 17. Vocal variety

## 17.1 Product definition

**Vocal variety** is the amount of controlled change in pitch, vocal energy, and delivery tempo over recent speech. It is not an emotion score and not a universal measure of quality.

CandidCue calculates a `varietyLevel` from 0–100 and compares it against the user’s selected target band.

## 17.2 Input features

Over a rolling, speech-only analysis horizon, calculate:

### Pitch features

- robust pitch span: `P90 - P10` in semitones;
- pitch interquartile range;
- median absolute pitch movement per second;
- number of meaningful contour turns;
- phrase-final pitch movement;
- emphasis peaks relative to local baseline.

### Energy features

- robust RMS range: `P90 - P10` in dB;
- phrase-level energy contrast;
- percentage of speech near the same narrow level;
- clipping-adjusted dynamic range.

### Tempo features

- phrase-to-phrase WPM variation;
- within-sentence acceleration and deceleration;
- sentence-duration variation after controlling for word count;
- terminal-rush frequency.

### Pause features

Pause behavior supports cadence coaching but contributes only lightly to variety. Random or poorly placed pauses should not inflate the score.

## 17.3 Analysis horizons

Maintain:

- short horizon: 8–12 seconds for responsiveness;
- medium horizon: 20–35 seconds for stable variety;
- session baseline: 60 seconds or more.

The live score uses the medium horizon with an EWMA half-life around 8 seconds. It updates visually no faster than twice per second.

## 17.4 Normalization

Each feature is normalized using:

1. a broad human-speech prior;
2. the user’s microphone calibration;
3. the user’s slowly learned personal baseline;
4. the selected delivery-style profile.

Normalization MUST use semitone pitch movement and relative energy, not raw median pitch or absolute dB SPL.

## 17.5 Variety-level formula

Initial formula:

```text
V = 100 × clamp(
      0.35 × pitchSpanNorm
    + 0.20 × pitchMotionNorm
    + 0.20 × energyRangeNorm
    + 0.15 × tempoVariationNorm
    + 0.10 × emphasisContrastNorm,
    0,
    1
)
```

If emphasis contrast is unavailable, redistribute its weight proportionally. If pitch reliability is insufficient, do not fabricate a score from the remaining features; show `LOW CONFIDENCE` or use an explicitly labeled `ENERGY VARIETY` fallback in the review screen only.

The numeric mapping is an application scale, not a scientifically universal score. It must be validated and calibrated with human raters before release.

## 17.6 Style targets

Provisional target bands:

| Style | Variety target | Description |
|---|---:|---|
| Calm / authoritative | 35–60 | controlled and steady, with selective emphasis |
| Natural / conversational | 45–75 | noticeable movement without performance exaggeration |
| Expressive / story | 55–85 | larger pitch, energy, and tempo contrasts |
| Broadcast / neutral | 40–65 | polished consistency with clear sentence shaping |
| Custom | user-defined | chosen for the production |

These bands are internal CandidCue scales and require user testing.

## 17.7 Personalized calibration

During the first 15 seconds of reliable voiced speech:

- learn median pitch reference;
- learn typical RMS range;
- estimate microphone noise and gain behavior;
- do not show a numeric score.

After 30–60 seconds:

- establish a session baseline;
- optionally update the user’s stored profile using a slow EMA;
- never allow the target band to drift automatically until any current behavior becomes “ideal.”

Persistent personal calibration is opt-in and local.

## 17.8 Variety state

Given target band `[L, U]`:

- `VERY STEADY`: `V < L - 15`;
- `STEADY`: `L - 15 ≤ V < L`;
- `BALANCED`: `L ≤ V ≤ U`;
- `EXPRESSIVE`: `U < V ≤ U + 15`;
- `HIGHLY ANIMATED`: `V > U + 15`.

Use hysteresis of 4–6 points and a minimum persistence time.

## 17.9 Low-variety tip

A tip candidate requires:

- at least 18 seconds of reliable medium-horizon evidence;
- score below target by at least eight points;
- at least two completed sentences;
- no active microphone-quality problem;
- no list, legal disclaimer, quotation, intentionally calm passage, or script directive suppressing variety coaching;
- no same-category tip within 45 seconds.

Preferred generic tip:

```text
Lift the key words
```

Alternative:

```text
Add a little more shape
```

Do not display `You sound monotone`.

## 17.10 High-variety tip

High variety is not inherently a problem. A live tip is allowed only when:

- the user selected a restrained style;
- level remains well above target for at least 20 seconds;
- energy and pitch changes are both extreme rather than one expressive sentence;
- the tip does not suppress useful enthusiasm.

Suggested copy:

```text
Settle the delivery slightly
```

This tip is disabled by default.

## 17.11 Emphasis-aware coaching

The script compiler may identify emphasis opportunities from:

- Markdown bold and italics;
- headings;
- quoted key phrases;
- numbers and contrasts;
- explicit CandidCue directives;
- optional Luna script-preparation output.

When word-to-audio localization confidence is high, CandidCue may compare the marked phrase’s pitch and energy against nearby words. In v1 this feature SHOULD be post-take by default. Live `Give that phrase more emphasis` coaching is Phase 2 because inaccurate word-level acoustic alignment would be distracting.

---

# 18. Cadence and pause analysis

## 18.1 Cadence definition

Cadence describes the pattern of speech, pauses, phrase lengths, and changes in rate. It is not reducible to WPM.

CandidCue should identify persistent patterns that a user can adjust during a take:

- run-on delivery;
- choppy delivery;
- rushing sentence endings;
- pausing in awkward places;
- failing to let important boundaries land;
- repeated restart loops.

## 18.2 Pause classification

Using local VAD and script alignment, classify silence intervals:

- **micro-pause:** 80–180 ms;
- **short pause:** 180–400 ms;
- **medium pause:** 400–900 ms;
- **long pause:** 900 ms or more;
- **manual/system pause:** excluded from delivery scoring.

Thresholds should adapt modestly to the user’s speaking style and language.

Map each pause to the nearest authored location:

- within a word or uncertain;
- between words;
- comma/semicolon boundary;
- sentence boundary;
- paragraph boundary;
- retake boundary;
- ad-lib interval.

## 18.3 Boundary-pause quality

For eligible sentence boundaries, compute whether the user allowed a perceptible boundary without forcing a rigid pause after every period.

A boundary is considered adequately shaped when any combination occurs:

- a short or medium silence;
- meaningful pitch reset;
- energy reset;
- clear rate deceleration;
- next sentence begins with a new contour.

This avoids equating good phrasing with silence alone.

## 18.4 Run-on pattern

A run-on candidate requires:

- continuous delivery across multiple strong script boundaries;
- no sufficient silence, pitch reset, or energy reset;
- sustained active speech longer than the profile threshold, initially 12–18 seconds;
- pattern repeated at least twice.

Suggested tip:

```text
Let the next full stop breathe
```

## 18.5 Choppy pattern

A choppy candidate requires:

- repeated mid-clause pauses or abandoned starts;
- pauses are not explained by commas, parentheticals, difficult names, commands, or retake behavior;
- at least three eligible events within 20 seconds;
- alignment confidence high.

Suggested tip:

```text
Keep this sentence flowing
```

## 18.6 Long breath group

Track the length of uninterrupted active speech. A long breath group may be useful in review, but live coaching should be conservative because breathing capacity varies.

A gentle prospective tip may appear at the next boundary:

```text
Take the next pause
```

Do not instruct users on medical breathing technique.

## 18.7 Pace variation

Healthy delivery may vary rate intentionally. Cadence scoring should distinguish:

- meaningful variation around story beats or emphasis;
- random speed oscillation;
- systematic rush at endings;
- systematic slowdown caused by difficult text;
- a one-off deliberate pause.

Luna may classify the textual context, but the numerical rate pattern remains locally calculated.

## 18.8 Repeated stumble

A repeated stumble candidate occurs when:

- the same sentence or phrase is restarted two or more times;
- local alignment confirms return to the same region;
- the speaker has not yet completed it cleanly;
- the system is not mistaking a deliberate rehearsal loop for confusion.

The live rail may show:

```text
Take the sentence from the top
```

only if the user enabled retake coaching. Otherwise record it for review.

## 18.9 Cadence score

The stage does not need a separate cadence number. Internally maintain a 0–1 `cadenceBalance` composed of:

- boundary shaping;
- mid-clause interruption rate;
- terminal-rush rate;
- run-on rate;
- phrase-rate stability relative to style.

Use it for tip gating and post-take review, not as a gamified live score.

---

# 19. Script-derived coaching map

## 19.1 Purpose

Because CandidCue knows the script, it can prepare a lightweight delivery map before the take. This map provides context for local rules and Luna without dictating a single “correct” performance.

## 19.2 Deterministic annotations

The compiler derives:

- sentence and clause boundaries;
- punctuation strength;
- Markdown emphasis;
- headings and section starts;
- numbers, dates, units, names, URLs, and acronyms;
- difficult or unusually long sentences;
- quotations and lists;
- explicit pause and pace directives;
- non-spoken blocks.

## 19.3 Optional Luna preparation

Luna may annotate each paragraph with:

- one or two key propositions;
- critical words whose omission changes meaning;
- likely emphasis candidates;
- whether delivery is informational, reflective, energetic, cautionary, or neutral;
- whether a slower pace is advisable because of numerical or concept density;
- phrase IDs suitable for future coaching evidence.

This is preparation, not generation. The user’s script remains authoritative.

## 19.4 Script directives

Recommended optional directives:

```markdown
<!-- cc:coach off -->
<!-- cc:pace 125-145 -->
<!-- cc:style calm -->
<!-- cc:pause short -->
<!-- cc:pause medium -->
<!-- cc:emphasis -->
<!-- cc:filler intentional -->
<!-- cc:duration 00:45 -->
```

Directives apply to the following block or explicitly bounded range. The editor should expose a simple UI so users do not need to memorize syntax.

## 19.5 Front matter

```yaml
---
coach:
  mode: coach
  style: conversational
  target_wpm: [130, 165]
  target_variety: [45, 75]
  target_duration: "08:30"
  filler_detection: precision
  live_tips: normal
  positive_feedback: false
---
```

Unknown fields are preserved but ignored.

---

# 20. Luna Coach Observer

## 20.1 Role

Luna is a delayed semantic observer. It receives a bounded window and may validate or reject locally generated candidates. It never produces pixels, scroll coordinates, raw prose for the stage, or new navigation instructions.

## 20.2 When to call Luna

Call Luna when one or more of these conditions occurs:

- a contextual filler needs classification;
- a spoken deviation may materially change meaning;
- an ad-lib may be useful or redundant;
- multiple tip candidates compete;
- a repeated opener pattern needs context;
- a critical number/name/negation mismatch is uncertain;
- an acoustic pattern needs text-aware interpretation;
- enhanced coaching is enabled and a stable 8–15 second window is ready.

Do not call Luna merely to calculate WPM or determine whether pitch is changing.

## 20.3 Scheduling

### Standard mode

- event-triggered;
- coalesce candidates for 600–1,200 ms;
- no more than one request every three seconds;
- no more than 12 requests per minute by default;
- cancel or ignore stale requests.

### Enhanced mode

- event-triggered plus compact periodic observation every 2.5–4 seconds during active delivery;
- maximum 20 requests per minute;
- intended for users who explicitly accept additional API usage;
- still not part of the motion loop.

## 20.4 Request window

A normal request contains:

- 1–3 authored sentences around the active span;
- finalized spoken text for approximately 6–15 seconds;
- optional stable partial tail clearly labeled provisional;
- local candidate events;
- compact pace, cadence, and variety summaries;
- user profile and target bands;
- script annotations;
- state flags such as retake, command, and low confidence;
- opaque evidence IDs.

Never send the entire session transcript on each request.

## 20.5 Staleness

A response is invalid when any of these changed materially:

- `session_id`;
- `script_revision`;
- `tracking_epoch`;
- `take_pass_id`;
- active section authorization;
- evidence candidate status;
- speaker already corrected the issue;
- response arrived after `valid_until_audio_ms`;
- a higher-priority local state began.

Invalid responses are logged as stale and never displayed.

## 20.6 Prompt caching

Keep stable instructions and schemas at the beginning of the request, with dynamic speech data at the end. Reuse a stable `prompt_cache_key` per user/session/schema version where appropriate. OpenAI’s current prompt-caching guidance recommends stable prefixes and explicit cache keys for GPT-5.6-family workloads.[^prompt-cache]

## 20.7 Output length

The response should be compact. Luna returns codes and evidence references, not an explanation essay. Typical output should remain below a few hundred tokens.

---

# 21. Luna system prompt

The following system prompt is normative. The implementation may make wording improvements only when evals demonstrate an improvement without changing the safety and authority boundaries.

```text
You are CandidCue Coach Observer, an asynchronous classifier inside a
live teleprompter. The speaker is currently performing. Your job is to
validate or reject a small set of coaching candidates and, at most,
select one predefined tip code.

PRIMARY RULE: silence is valid and usually preferred. Return no tip
unless the evidence is strong, the issue is actionable now, and showing
it is more useful than leaving the speaker alone.

AUTHORITY BOUNDARIES
- You do not control scrolling, script position, navigation, microphone,
  recording, or take state.
- You do not generate the user-facing tip text. You return an allowed
  code only.
- You do not infer acoustic facts. Pitch, loudness, pace, cadence,
  clipping, pauses, and filler-audio evidence are supplied by the local
  engine. Treat missing or unreliable metrics as unknown.
- You do not invent words, fillers, mistakes, or events that are not in
  the supplied evidence.
- You do not diagnose emotion, anxiety, confidence, personality,
  accent quality, disability, health, honesty, or audience reaction.

TRANSCRIPT RULES
- Finalized speech has more authority than provisional speech.
- ASR can omit fillers or misrecognize names and phonetic spellings.
- A difference from the script is not automatically an error.
  Paraphrases and useful ad-libs may preserve meaning.
- If the speaker self-corrected, prefer no tip unless a continuing
  pattern remains.
- Never classify “and,” “so,” “but,” “like,” “well,” “right,” “okay,”
  “actually,” or similar words as fillers solely because they appear.
  Require contextual evidence that the use is nonessential,
  hesitation-like, repeated, and absent from the authored wording.
- Authored filler-like words are intentional unless explicitly marked
  otherwise.

TIP SELECTION
- Choose no more than one tip.
- Prefer system-critical and meaning-critical issues over style.
- Prefer a prospective, actionable adjustment over retroactive blame.
- Do not select a pace or variety tip for one short sentence.
- Do not select a stale issue that ended or was corrected.
- Do not select ordinary coaching during a command, retake,
  reacquisition, low alignment confidence, or microphone failure.
- Use only the enumerated tip codes in the schema.
- Confidence reflects confidence that the selected tip is appropriate
  now, not merely confidence that an event occurred.

Return only the structured response required by the schema.
```

---

# 22. Luna request contract

```ts
interface LunaCoachRequest {
  schemaVersion: '1.0';
  sessionId: string;
  scriptId: string;
  scriptRevision: number;
  trackingEpoch: number;
  takePassId: string;
  requestAudioTimeMs: number;
  validUntilAudioTimeMs: number;
  language: string;

  state: {
    alignmentConfidence: number;
    commandActive: boolean;
    retakeState: 'none' | 'pending' | 'reversing' | 'settling';
    reacquiring: boolean;
    microphoneHealthy: boolean;
  };

  profile: {
    coachingMode: 'minimal' | 'coach' | 'studio';
    deliveryStyle: 'calm' | 'natural' | 'conversational' | 'expressive' | 'broadcast' | 'custom';
    targetWpmLow: number;
    targetWpmHigh: number;
    targetVarietyLow: number;
    targetVarietyHigh: number;
    liveTipFrequency: 'low' | 'normal' | 'high';
  };

  authoredSpans: Array<{
    spanId: string;
    text: string;
    criticalTokens: string[];
    emphasisTokens: string[];
    punctuationClass: 'weak' | 'medium' | 'strong' | 'paragraph';
    coachingDisabled: boolean;
  }>;

  speech: {
    finalText: string;
    provisionalTail: string;
    finalAudioStartMs: number;
    finalAudioEndMs: number;
  };

  metrics: {
    displayWpm: number | null;
    paceState: 'learning' | 'on_target' | 'slightly_fast' | 'fast' | 'slightly_slow' | 'slow' | 'paused' | 'low_confidence';
    pacePersistenceMs: number;
    terminalRushRatio: number | null;
    varietyLevel: number | null;
    varietyState: 'learning' | 'very_steady' | 'steady' | 'balanced' | 'expressive' | 'highly_animated' | 'low_confidence';
    varietyPersistenceMs: number;
    cadenceBalance: number | null;
    runOnCount: number;
    choppyPauseCount: number;
    confirmedFillersLast20s: number;
    confirmedFillersLast60s: number;
  };

  candidates: Array<{
    evidenceId: string;
    type: CoachCandidateType;
    localConfidence: number;
    audioStartMs: number;
    audioEndMs: number;
    scriptSpanId: string | null;
    detailCode: string;
    spokenFragment: string;
    authoredFragment: string;
  }>;
}
```

---

# 23. Luna response schema

Use Structured Outputs with `strict: true`. All object fields are required and all objects set `additionalProperties: false`.[^structured]

```json
{
  "name": "candidcue_live_coach_decision_v1",
  "strict": true,
  "schema": {
    "type": "object",
    "properties": {
      "decision": {
        "type": "string",
        "enum": ["none", "candidate"]
      },
      "tip_code": {
        "type": "string",
        "enum": [
          "NONE",
          "PACE_EASE_BACK",
          "PACE_LIFT_SLIGHTLY",
          "TERMINAL_RUSH",
          "USE_SILENT_PAUSE",
          "REPEATED_FILLER",
          "LET_BOUNDARY_BREATHE",
          "KEEP_SENTENCE_FLOWING",
          "LIFT_KEY_WORDS",
          "SETTLE_DELIVERY",
          "REPETITIVE_OPENER",
          "TAKE_SENTENCE_FROM_TOP",
          "CRITICAL_NUMBER",
          "CRITICAL_NAME",
          "CRITICAL_UNIT",
          "CRITICAL_NEGATION",
          "MATERIAL_MEANING_CHANGE"
        ]
      },
      "confidence": {
        "type": "number"
      },
      "evidence_ids": {
        "type": "array",
        "items": { "type": "string" }
      },
      "scope": {
        "type": "string",
        "enum": ["none", "current_phrase", "next_boundary", "session_pattern"]
      },
      "reason_code": {
        "type": "string",
        "enum": [
          "NO_ACTIONABLE_ISSUE",
          "INSUFFICIENT_EVIDENCE",
          "ISSUE_SELF_CORRECTED",
          "ISSUE_STALE",
          "COACHING_SUPPRESSED",
          "HIGH_VALUE_LOCAL_PATTERN",
          "CONTEXTUAL_FILLER_CONFIRMED",
          "CONTEXTUAL_FILLER_REJECTED",
          "PARAPHRASE_PRESERVES_MEANING",
          "MATERIAL_DIFFERENCE_CONFIRMED",
          "BEST_OF_MULTIPLE_CANDIDATES"
        ]
      },
      "valid_for_ms": {
        "type": "integer"
      }
    },
    "required": [
      "decision",
      "tip_code",
      "confidence",
      "evidence_ids",
      "scope",
      "reason_code",
      "valid_for_ms"
    ],
    "additionalProperties": false
  }
}
```

## 23.1 Local response validation

Even a schema-valid response is only a candidate. Reject it when:

- `decision` and `tip_code` disagree;
- confidence is below the per-code threshold;
- any evidence ID is unknown or stale;
- the selected code is not allowed by local candidate types;
- current state suppresses the code;
- `valid_for_ms` has expired;
- the response references an old tracking epoch or take pass;
- a local deterministic rule has already invalidated the event.

## 23.2 Refusal and API failure

A model refusal, timeout, malformed result, quota error, or network failure produces no tip. Local pace, microphone, and strict filler features continue normally.

---

# 24. Tip candidate types and priority

```ts
type CoachCandidateType =
  | 'system_mic_clipping'
  | 'system_mic_low'
  | 'system_noise_high'
  | 'system_transcription_degraded'
  | 'critical_number_mismatch'
  | 'critical_name_mismatch'
  | 'critical_unit_mismatch'
  | 'critical_negation_mismatch'
  | 'material_meaning_change'
  | 'pace_too_fast'
  | 'pace_too_slow'
  | 'terminal_rush'
  | 'filler_cluster'
  | 'repeated_filler'
  | 'contextual_filler'
  | 'run_on_delivery'
  | 'choppy_delivery'
  | 'low_variety'
  | 'high_variety'
  | 'repetitive_opener'
  | 'repeated_stumble'
  | 'positive_pace'
  | 'positive_filler_streak';
```

Recommended priority bands:

| Priority | Category |
|---:|---|
| 100 | microphone unavailable, clipping severe, transcription failed |
| 90 | critical number, unit, name, negation, meaning reversal |
| 75 | repeated restart blocking progress |
| 65 | sustained fast pace, terminal rush, filler cluster |
| 55 | run-on or choppy cadence |
| 45 | sustained low variety |
| 35 | repetitive opener and stylistic pattern |
| 10 | positive reinforcement |

The local scheduler may adjust within a band using confidence, recency, actionability, and repetition.

---

# 25. Deterministic tip catalog

Luna never writes stage copy. The app selects copy from a localized catalog.

## 25.1 System and microphone tips

| Code | Default copy | Trigger | Display behavior |
|---|---|---|---|
| `MIC_CLIPPING` | `Mic is clipping` | sustained clipping | persists until clear for 2 seconds |
| `MIC_LEVEL_LOW` | `Move a little closer to the mic` | reliable speech with sustained low level | 4 seconds, then cooldown |
| `NOISE_HIGH` | `Background noise is rising` | sustained poor SNR | 4 seconds |
| `TRANSCRIPTION_DEGRADED` | `Transcription is struggling` | repeated empty/low-confidence results | persists or uses system notice |
| `MIC_DISCONNECTED` | `Microphone disconnected` | device loss | critical persistent alert |

System messages may bypass ordinary coaching cooldowns.

## 25.2 Pace tips

| Luna/local code | Default copy | Alternative copy | Minimum cooldown |
|---|---|---|---:|
| `PACE_EASE_BACK` | `Ease back slightly` | `Give the words more room` | 25 s |
| `PACE_LIFT_SLIGHTLY` | `Bring the pace up a touch` | `Keep the thought moving` | 30 s |
| `TERMINAL_RUSH` | `Don’t rush the ending` | `Let the ending land` | 30 s |

Copy variants may be selected by style profile but not generated dynamically.

## 25.3 Filler and disfluency tips

| Code | Default copy | Notes |
|---|---|---|
| `USE_SILENT_PAUSE` | `Use a silent pause` | preferred generic filler coaching |
| `REPEATED_FILLER` | `Pause instead of “{filler}”` | only for a confirmed strict filler and safe quoted value |
| `REPETITIVE_OPENER` | `Vary the sentence openings` | normally Studio mode or review |
| `TAKE_SENTENCE_FROM_TOP` | `Take the sentence from the top` | optional retake coaching |

Any inserted `{filler}` must come from a strict allowlist and be escaped. Never quote arbitrary model text.

## 25.4 Cadence and variety tips

| Code | Default copy | Minimum cooldown |
|---|---|---:|
| `LET_BOUNDARY_BREATHE` | `Let the next full stop breathe` | 35 s |
| `KEEP_SENTENCE_FLOWING` | `Keep this sentence flowing` | 35 s |
| `LIFT_KEY_WORDS` | `Lift the key words` | 45 s |
| `SETTLE_DELIVERY` | `Settle the delivery slightly` | 60 s; disabled by default |

## 25.5 Critical script tips

The existing critical-discrepancy behavior remains, but the Coaching Rail may display it:

```text
Script says “fifty percent”
Script says “not available”
Name in script: “Ndlovu”
Unit in script: “milliseconds”
```

Requirements:

- use exact authored text, escaped and length-limited;
- show only after final/highly stable evidence;
- suppress when a self-correction is underway;
- avoid an alert if a phonetic spelling likely represents the correct name;
- allow Luna only to classify materiality, never to invent the correction.

## 25.6 Positive feedback

Positive feedback is represented primarily by stable telemetry states. Optional tips:

| Code | Copy | Eligibility |
|---|---|---|
| `POSITIVE_PACE` | `Good pace` | at least 20 seconds on target; once per minute |
| `POSITIVE_FILLER_STREAK` | `Clean, unhurried phrasing` | meaningful improvement; once per take section |
| `POSITIVE_VARIETY` | `Nice vocal balance` | sustained target variety; once per minute |

Positive tips must never feel patronizing. They are disabled by default.

---

# 26. Tip scheduling policy

## 26.1 Candidate score

For each eligible candidate, calculate:

```text
score =
    priorityWeight
  × confidence
  × actionability
  × recency
  × persistence
  × safeMomentFactor
  × userPreferenceFactor
```

All factors are clamped to `[0, 1]` except priority weight.

## 26.2 Cooldowns

Default global policy:

- minimum 10 seconds between ordinary tips;
- maximum three ordinary tips per minute in Coach mode;
- maximum five per minute in Studio High-frequency mode;
- at least 25–60 seconds between tips of the same style category;
- no ordinary tip for 5 seconds after a command jump;
- no ordinary tip for 5 seconds after a committed retake reversal;
- no ordinary tip for 3 seconds after a critical discrepancy;
- positive feedback does not reset critical alert eligibility.

## 26.3 Repetition escalation

Do not repeat identical copy at the same severity. If a pattern persists:

1. show one live tip;
2. continue quiet telemetry;
3. record the pattern for review;
4. optionally show a second differently worded tip only after a long cooldown and a new evidence cluster.

## 26.4 User response inference

The app may infer that a tip was followed when the metric returns to target, but it must not claim causality. In the post-take report it may say:

```text
Your pace returned to target shortly after the prompt.
```

It must not say:

```text
The prompt fixed your delivery.
```

## 26.5 Tip cancellation

Immediately cancel a queued or visible ordinary tip if:

- its evidence is revised away;
- the user self-corrects;
- a voice command begins;
- a retake starts;
- a critical system notice appears;
- the active script span changes outside the tip’s scope;
- the user disables coaching;
- the take ends.

Fade out; never animate it off-screen.

---

# 27. Coaching state model

```ts
type CoachRailMode = 'off' | 'minimal' | 'coach' | 'studio' | 'review_only' | 'custom';

type CoachTipSeverity = 'status' | 'gentle' | 'important' | 'critical';

interface CoachTip {
  tipId: string;
  code: string;
  textKey: string;
  interpolations: Record<string, string>;
  severity: CoachTipSeverity;
  priority: number;
  createdAudioTimeMs: number;
  evidenceStartMs: number;
  evidenceEndMs: number;
  earliestDisplayMs: number;
  expiresAudioTimeMs: number;
  minimumDisplayMs: number;
  maximumDisplayMs: number;
  cooldownKey: string;
  trackingEpoch: number;
  takePassId: string;
  scriptAnchorTokenId: string | null;
  evidenceIds: string[];
  source: 'local' | 'luna_validated';
}

interface CoachRailState {
  schemaVersion: 1;
  stageRevision: number;
  sessionId: string;
  takePassId: string;
  mode: CoachRailMode;
  visible: boolean;
  mirrored: boolean;
  reducedMotion: boolean;
  pace: PaceDisplayState;
  variety: VarietyDisplayState;
  fillers: FillerDisplayState;
  microphone: MicrophoneCoachState;
  activeTip: CoachTip | null;
  ribbonEvents: CoachRibbonEvent[];
}
```

## 27.1 Pace display contract

```ts
interface PaceDisplayState {
  wpm: number | null;
  confidence: number;
  state:
    | 'learning'
    | 'on_target'
    | 'slightly_fast'
    | 'fast'
    | 'slightly_slow'
    | 'slow'
    | 'paused'
    | 'low_confidence';
  targetLow: number;
  targetHigh: number;
  targetDurationMs: number | null;
  projectedFinishDeltaMs: number | null;
  recentSeries: Array<{ audioTimeMs: number; wpm: number }>;
}
```

## 27.2 Variety display contract

```ts
interface VarietyDisplayState {
  level: number | null;
  confidence: number;
  state:
    | 'learning'
    | 'very_steady'
    | 'steady'
    | 'balanced'
    | 'expressive'
    | 'highly_animated'
    | 'low_confidence';
  targetLow: number;
  targetHigh: number;
  pitchSpanSemitones: number | null;
  energyRangeDb: number | null;
}
```

## 27.3 Filler event contract

```ts
type FillerKind =
  | 'strict_vocalized'
  | 'contextual'
  | 'repetitive_opener'
  | 'repeated_word'
  | 'false_start'
  | 'self_correction';

interface FillerEvent {
  eventId: string;
  kind: FillerKind;
  normalizedForm: string;
  displayForm: string | null;
  confidence: 'probable' | 'confirmed' | 'rejected';
  evidenceSources: Array<'realtime' | 'local_audio' | 'precision_transcript' | 'luna'>;
  audioStartMs: number;
  audioEndMs: number;
  timingConfidence: number;
  scriptAnchorTokenId: string | null;
  takePassId: string;
  authoredIntentional: boolean;
  countedLive: boolean;
}
```

## 27.4 Ribbon event contract

```ts
type CoachRibbonEventType =
  | 'speech'
  | 'confirmed_filler'
  | 'probable_filler'
  | 'repetition'
  | 'pause'
  | 'retake'
  | 'critical_mismatch'
  | 'clipping';

interface CoachRibbonEvent {
  eventId: string;
  type: CoachRibbonEventType;
  startMs: number;
  endMs: number;
  confidence: number;
  takePassId: string;
}
```

---

# 28. Local analyzer modules

Recommended module boundaries:

```text
coaching/
  audio/
    audio-worklet.ts
    ring-buffer.ts
    frame-features.ts
    vad.ts
    pitch-yin.ts
    noise-estimator.ts
    microphone-health.ts
  pace/
    speech-clock.ts
    token-timing.ts
    weighted-rate.ts
    target-duration.ts
    terminal-rush.ts
  disfluency/
    filler-lexicon.ts
    realtime-filler-detector.ts
    acoustic-candidate-detector.ts
    precision-transcriber.ts
    transcript-reconciler.ts
    contextual-classifier.ts
  prosody/
    pitch-aggregator.ts
    energy-aggregator.ts
    variety-score.ts
    cadence-analyzer.ts
    emphasis-analyzer.ts
  coach/
    candidate-generator.ts
    luna-observer.ts
    luna-schema.ts
    tip-policy.ts
    tip-catalog.ts
    cooldowns.ts
    coach-state.ts
  review/
    session-summary.ts
    event-map.ts
    report-store.ts
```

Each module must be independently testable with recorded fixtures and deterministic clocks.

---

# 29. Precision-transcription queue

## 29.1 Queue behavior

The queue is bounded. It must not accumulate indefinitely when API latency rises.

Defaults:

- maximum pending audio: 45 seconds;
- maximum concurrent requests: 1 or 2 depending on platform and account tier;
- maximum chunk: 12 seconds;
- oldest-first processing;
- drop low-value ordinary chunks before candidate-triggered chunks;
- always process final take tail when review is enabled;
- expose delayed/degraded status in diagnostics, not necessarily on stage.

## 29.2 De-duplication

Adjacent chunks overlap. Reconcile by audio interval and token sequence. A filler occurring in the overlap must produce one event.

Event identity SHOULD hash:

```text
session + takePass + normalizedForm + roundedAudioCenter + neighboringTokenIds
```

## 29.3 Cost modes

- **Off:** no secondary transcription.
- **On candidates:** send only chunks containing acoustic or lexical ambiguity.
- **Full precision:** send all eligible speech chunks.
- **Review only:** send chunks after the take or during idle windows.

Settings must explain that Full precision makes additional OpenAI transcription calls using the user’s API key.

## 29.4 Failure behavior

If precision transcription fails:

- keep Realtime-derived confirmed events;
- retain acoustic candidates as probable only;
- do not retry indefinitely;
- optionally retry once after a transient error;
- never pause or degrade teleprompter scrolling.

---

# 30. Coaching settings

## 30.1 Setup panel

Add a **Live Coaching** section to Preflight and Settings.

Controls:

- coaching mode;
- pace target preset;
- custom pace range;
- target duration;
- vocal style;
- custom variety target;
- show numeric variety score;
- filler detection level;
- custom filler words;
- track repeated openers;
- show event ribbon;
- show past-line marks;
- tip frequency;
- positive feedback;
- precision transcription mode;
- save post-take report;
- retain audio recording;
- reset personal calibration.

## 30.2 Filler detection choices

Recommended labels:

### Basic

```text
Uses the live transcript and local audio cues. Fast and inexpensive,
but some fillers may be missed.
```

### Precision

```text
Runs short audio segments through an additional verbatim transcription
pass. Better filler and false-start detection, with extra API usage and
a small delay.
```

### Strict only

```text
Counts clear fillers such as “um,” “uh,” “er,” and “erm.”
```

### Broad

```text
Also evaluates contextual phrases such as “you know,” “like,” and
repeated sentence openers. Contextual items require higher confidence.
```

## 30.3 Calibration preview

During microphone test, show:

- input level;
- noise floor;
- clipping status;
- pitch detection confidence, not raw pitch unless expanded;
- sample WPM after a short read;
- variety status after enough audio;
- live example of the rail.

The calibration should use a short neutral passage or the first script paragraph. It is optional; live adaptation remains authoritative.

## 30.4 User-defined goals

Users may choose goals such as:

- fewer than 3 fillers per minute;
- fewer than 2 fillers per 100 words;
- pace within a range;
- finish within a target duration;
- keep variety within a profile band;
- review only, with no live interruption.

Goals influence tips and review, not script tracking.

---

# 31. Post-take review

## 31.1 Rationale

Many useful insights are too detailed or delayed for the live rail. A short review screen converts the rail from a distracting novelty into a genuine practice tool.

## 31.2 Summary cards

Recommended cards:

- average Audible WPM;
- average Articulation WPM;
- percentage of time inside target pace;
- projected versus actual duration;
- confirmed fillers and fillers per 100 words;
- most frequent filler;
- longest filler-free stretch;
- average and range of variety level;
- sentence-ending rush count;
- run-on and choppy cadence events;
- retake count;
- critical script discrepancies;
- microphone quality summary.

## 31.3 Timeline

Display synchronized tracks:

- speech activity;
- WPM;
- variety level;
- fillers;
- pauses;
- retakes;
- tips shown;
- script position.

Clicking an event selects the aligned script passage. Audio playback is available only if recording was enabled.

## 31.4 Script view

Render the script with session-local annotations:

- filler insertion markers;
- false starts;
- repeated passages;
- critical mismatches;
- strong or weak boundary shaping;
- optional emphasis observations.

Do not permanently edit the source Markdown.

## 31.5 Recommendations

Generate at most three primary recommendations, based on the highest-impact repeated patterns. Prefer concrete summaries:

```text
Your pace was on target for 78% of the take, but you rushed the ending
of five sentences.
```

```text
You used “um” eight times, mostly before section transitions. Try
adding a silent pause at those transitions.
```

```text
Your pitch and energy variation narrowed in the final two minutes.
Mark two or three key phrases for emphasis before the next take.
```

Luna may help select and phrase the longer review recommendations, but factual counts and measurements remain local and must be inserted from validated data.

## 31.6 Comparison over time

Only compare the user with their own prior sessions unless a future, explicitly researched benchmark product is introduced.

Useful personal trends:

- filler rate change;
- time in pace target;
- terminal rush frequency;
- average variety relative to selected profile;
- microphone quality consistency;
- number of retakes.

Avoid population percentile claims without a representative dataset.

---

# 32. Privacy and data handling

## 32.1 Default behavior

- Raw audio processing is local.
- Audio ring buffer is memory-only.
- Realtime audio is sent to OpenAI because transcription is the core application behavior.
- Precision coaching sends additional bounded audio only when enabled.
- Coaching metrics are session-only unless the user enables saved reports.
- Personal calibration remains on-device.

## 32.2 Recording

Saving a coaching report does not imply saving audio. Separate toggles are required:

- save metrics/report;
- save transcript;
- save audio recording.

The UI must state exactly what is retained.

## 32.3 Sensitive inferences

Do not store or expose inferred demographic or psychological labels. The system should persist observable measurements and user-selected goals only.

## 32.4 API request minimization

Luna receives the minimum nearby script and transcript context required for the candidate. Precision transcription receives only the bounded audio chunk and a short dictionary.

## 32.5 Diagnostic export

A user-initiated diagnostic export may include:

- anonymized numerical feature traces;
- event types and timestamps;
- API latency and errors;
- configuration;
- optional transcript only with explicit consent;
- no raw audio unless separately selected.

---

# 33. Performance requirements

## 33.1 Audio thread

The audio processor MUST:

- avoid unbounded allocations;
- avoid locks that can block the audio callback;
- batch feature messages;
- recover from dropped frames;
- report processor overload;
- keep analysis independent of stage frame rate.

## 33.2 CPU targets

Provisional targets on a typical modern laptop:

- frame features + VAD: under 1% average CPU;
- pitch extraction: under 3% of one core;
- all local coaching analysis: under 5% of one core average;
- stage rail rendering: negligible relative to script rendering;
- no measurable increase in scroll-frame misses.

These are targets, not guarantees, and must be profiled on representative Intel, Apple Silicon, and Windows hardware.

## 33.3 Memory targets

- frame-feature history: under 10 MB;
- 30-second mono PCM ring buffer: bounded according to sample format;
- no unbounded transcript or event arrays;
- compact long-session downsampling for review charts.

## 33.4 Rail update rate

- local metrics calculated at their native cadence;
- aggregate state published at 5 Hz maximum;
- visual number updates at 2–4 Hz;
- event ribbon position animated with stage `requestAnimationFrame` from the monotonic audio clock;
- no IPC message per audio frame.

## 33.5 Network isolation

Luna and precision-transcription latency must not block:

- Realtime transcription;
- microphone capture;
- script alignment;
- stage scrolling;
- command recognition;
- local coach telemetry.

---

# 34. Error and degraded modes

## 34.1 No Luna

Continue:

- WPM;
- pitch/variety;
- cadence;
- microphone health;
- strict transcript fillers;
- local tip rules.

Disable or reduce:

- contextual filler classification;
- semantic wordiness;
- ambiguous meaning-change tips.

## 34.2 No precision transcription

Continue basic filler detection and label review accuracy accordingly.

## 34.3 Poor audio

Hide variety and cadence judgments when the signal is unreliable. Show the microphone issue rather than coaching on corrupted measurements.

## 34.4 Missing transcript

Local audio metrics continue, but WPM confidence falls because word counts are uncertain. Do not infer fillers solely from pitch or silence.

## 34.5 AudioWorklet unavailable

Capability-detect. Options:

- use a Rust/native DSP capture path;
- fall back to AnalyserNode-level microphone health only;
- disable variety and cadence with a clear Settings explanation;
- never silently display fabricated metrics.

## 34.6 Long application suspension

After sleep, display disconnect, or a large clock discontinuity:

- reset short-window filters;
- retain user profile and long-term target;
- show `LEARNING` briefly;
- invalidate pending Luna and precision requests;
- begin a new tracking epoch.

---

# 35. Reference algorithms and pseudocode

## 35.1 Continuous pace estimator

```ts
class WeightedPaceEstimator {
  private points: Array<{ tSec: number; cumulativeWords: number; quality: number }> = [];
  private displayWpm: number | null = null;
  private lastUpdateSec = 0;

  addObservation(tSec: number, cumulativeWords: number, quality: number): void {
    if (!Number.isFinite(tSec) || !Number.isFinite(cumulativeWords)) return;
    this.points.push({ tSec, cumulativeWords, quality: clamp01(quality) });
    this.points = this.points.filter((p) => tSec - p.tSec <= 14);
  }

  update(nowSec: number, speaking: boolean): PaceEstimate {
    const usable = this.points.filter((p) => p.quality >= 0.45);
    if (usable.length < 3 || nowSec - usable[0].tSec < 3.5) {
      return { wpm: null, confidence: 0, state: 'learning' };
    }

    const halfLifeSec = 4;
    const tau = halfLifeSec / Math.log(2);
    const weighted = usable.map((p) => ({
      ...p,
      w: p.quality * Math.exp(-(nowSec - p.tSec) / tau),
    }));

    const slopeWordsPerSec = robustWeightedSlope(
      weighted.map((p) => p.tSec),
      weighted.map((p) => p.cumulativeWords),
      weighted.map((p) => p.w),
    );

    const rawWpm = clamp(slopeWordsPerSec * 60, 40, 260);
    const dt = Math.max(0, nowSec - this.lastUpdateSec);
    const maxDelta = 12 * dt;

    if (this.displayWpm === null) {
      this.displayWpm = rawWpm;
    } else {
      const desired = ewma(this.displayWpm, rawWpm, dt, 4);
      this.displayWpm += clamp(desired - this.displayWpm, -maxDelta, maxDelta);
    }

    this.lastUpdateSec = nowSec;

    return {
      wpm: this.displayWpm,
      confidence: estimatePaceConfidence(weighted, speaking),
      state: classifyPaceWithHysteresis(this.displayWpm),
    };
  }
}
```

## 35.2 Pitch and variety aggregation

```ts
function updateVariety(window: DeliveryWindow, profile: VoiceProfile): VarietyEstimate {
  const voiced = window.frames.filter(
    (f) => f.f0Hz !== null && f.f0Confidence >= 0.78 && f.estimatedSnrDb >= profile.minimumSnrDb,
  );

  const reliability = computePitchReliability(voiced, window.frames);
  if (window.voicedDurationMs < 12_000 || reliability < 0.65) {
    return { level: null, confidence: reliability, state: 'learning' };
  }

  const pitchSt = voiced.map((f) => 12 * Math.log2(f.f0Hz! / profile.f0ReferenceHz));
  const pitchSpan = percentile(pitchSt, 0.90) - percentile(pitchSt, 0.10);
  const pitchMotion = medianAbsoluteDerivative(pitchSt, voiced.map((f) => f.audioTimeMs));
  const energyRange = robustRangeDb(window.speechRmsDbfs);
  const tempoVariation = phraseRateVariation(window.phrases);
  const emphasisContrast = window.emphasisConfidence >= 0.7
    ? window.emphasisContrast
    : null;

  const components = renormalizeAvailableWeights([
    { weight: 0.35, value: normalizePitchSpan(pitchSpan, profile) },
    { weight: 0.20, value: normalizePitchMotion(pitchMotion, profile) },
    { weight: 0.20, value: normalizeEnergyRange(energyRange, profile) },
    { weight: 0.15, value: normalizeTempoVariation(tempoVariation, profile) },
    { weight: 0.10, value: emphasisContrast === null ? null : normalizeEmphasis(emphasisContrast) },
  ]);

  const rawLevel = 100 * weightedSum(components);
  const level = ewma(profile.lastVarietyLevel ?? rawLevel, rawLevel, window.deltaSec, 8);

  return {
    level,
    confidence: reliability,
    state: classifyVarietyWithHysteresis(level, profile.targetVariety),
  };
}
```

## 35.3 Realtime filler reconciliation

```ts
function reconcileFillerEvidence(input: {
  realtimeFinal: TimedTranscript;
  precisionFinal?: TimedTranscript;
  scriptSpan: ScriptToken[];
  acousticCandidates: AcousticDisfluencyCandidate[];
  customRules: FillerRules;
}): FillerEvent[] {
  const realtimeTokens = tokenizePreservingRepetition(input.realtimeFinal.text);
  const precisionTokens = input.precisionFinal
    ? tokenizePreservingRepetition(input.precisionFinal.text)
    : [];

  const scriptAlignment = alignSpeechToScript(realtimeTokens, input.scriptSpan);
  const transcriptAlignment = input.precisionFinal
    ? alignRealtimeToPrecision(realtimeTokens, precisionTokens)
    : null;

  const candidates = collectLexicalCandidates({
    realtimeTokens,
    precisionTokens,
    scriptAlignment,
    rules: input.customRules,
  });

  return candidates.map((candidate) => {
    const acoustic = nearestCompatibleAcousticCandidate(candidate, input.acousticCandidates);
    const contextual = classifyLocally(candidate, scriptAlignment, input.customRules);

    const evidenceSources = unique([
      candidate.inRealtime ? 'realtime' : null,
      candidate.inPrecision ? 'precision_transcript' : null,
      acoustic ? 'local_audio' : null,
    ].filter(Boolean));

    const confidence = deriveFillerConfidence(candidate, acoustic, contextual);
    const timing = localizeCandidate(candidate, transcriptAlignment, acoustic, input.realtimeFinal);

    return makeFillerEvent(candidate, confidence, timing, evidenceSources);
  });
}
```

## 35.4 Coach policy tick

```ts
function coachPolicyTick(ctx: CoachPolicyContext): CoachTip | null {
  expireCandidates(ctx.nowAudioMs);

  if (ctx.systemCriticalCandidate) {
    return renderSystemCritical(ctx.systemCriticalCandidate);
  }

  if (isOrdinaryCoachingSuppressed(ctx)) {
    return null;
  }

  const eligible = ctx.candidates
    .filter((c) => c.isCurrent(ctx))
    .filter((c) => c.confidence >= thresholdFor(c.type))
    .filter((c) => cooldownAllows(c, ctx.cooldowns))
    .filter((c) => userAllows(c, ctx.profile))
    .filter((c) => !c.requiresLuna || c.lunaValidation === 'accepted')
    .map((c) => ({ c, score: scoreCandidate(c, ctx) }))
    .sort((a, b) => b.score - a.score);

  const winner = eligible[0]?.c;
  if (!winner) return null;

  if (!isSafeDisplayOpportunity(ctx, winner)) {
    queueUntilSafeMoment(winner);
    return null;
  }

  return instantiateDeterministicTip(winner, ctx.tipCatalog);
}
```

---

# 36. Data storage

## 36.1 Session-level in-memory stores

Maintain:

- frame features, downsampled after 60 seconds;
- speech intervals;
- token timing points;
- pace estimates;
- pitch and energy aggregates;
- filler events;
- cadence events;
- Luna request/response metadata;
- tips shown;
- retake pass boundaries;
- script anchors.

## 36.2 Optional persistent tables

Suggested SQLite additions:

```sql
CREATE TABLE coaching_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  delivery_style TEXT NOT NULL,
  target_wpm_low REAL NOT NULL,
  target_wpm_high REAL NOT NULL,
  target_variety_low REAL NOT NULL,
  target_variety_high REAL NOT NULL,
  filler_detection_mode TEXT NOT NULL,
  tip_frequency TEXT NOT NULL,
  positive_feedback INTEGER NOT NULL DEFAULT 0,
  custom_rules_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE coaching_sessions (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL,
  script_revision INTEGER NOT NULL,
  profile_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  summary_json TEXT,
  transcript_saved INTEGER NOT NULL DEFAULT 0,
  audio_saved INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(profile_id) REFERENCES coaching_profiles(id)
);

CREATE TABLE coaching_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  take_pass_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  confidence REAL NOT NULL,
  script_token_id TEXT,
  payload_json TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES coaching_sessions(id)
);

CREATE INDEX idx_coaching_events_session_time
  ON coaching_events(session_id, start_ms);
```

Do not store frame-by-frame raw features permanently unless required for an explicitly enabled diagnostic mode. Persist downsampled series and event summaries.

## 36.3 Schema versioning

Every stored report includes:

- coaching schema version;
- algorithm version;
- tip-policy version;
- Luna prompt version;
- transcription models used;
- target profile;
- whether precision transcription was active.

Historical reports must not be silently reinterpreted using new scoring formulas.

---

# 37. Diagnostics

## 37.1 Developer overlay

A hidden developer overlay MAY show:

- raw and filtered WPM;
- pace confidence;
- VAD state;
- pitch confidence and semitone contour;
- RMS and noise floor;
- variety components;
- active candidate queue;
- suppression reason;
- Luna request age and result;
- precision queue depth;
- current tip cooldowns;
- audio and transcript clock offset.

This overlay is never part of normal stage UI.

## 37.2 Explainability log

Every displayed tip should be reproducible from a log entry:

```ts
interface CoachDecisionLog {
  decisionId: string;
  audioTimeMs: number;
  displayedTipCode: string | null;
  candidateScores: Array<{
    evidenceId: string;
    type: CoachCandidateType;
    confidence: number;
    score: number;
    rejectedReason: string | null;
  }>;
  suppressionState: string | null;
  lunaRequestId: string | null;
  lunaAccepted: boolean | null;
  policyVersion: string;
}
```

Users need not see this by default, but it is essential for tuning false positives.

---

# 38. Evaluation corpus

## 38.1 Required speech corpus

Build a versioned internal corpus covering:

- clean scripted delivery;
- deliberate fast and slow delivery;
- rate changes within a sentence;
- sentence-ending rush;
- deliberate rhetorical pauses;
- choppy mid-clause pauses;
- run-on delivery;
- strict fillers;
- contextual fillers;
- legitimate lexical “like,” “right,” “well,” and “actually”;
- legitimate sentence-initial “and,” “so,” and “but”;
- repeated openers;
- false starts and self-corrections;
- local phrase retakes;
- section retakes;
- ad-libs that preserve meaning;
- ad-libs that change a critical fact;
- intentional monotone and expressive delivery;
- quiet, loud, clipped, and noisy microphones;
- far-field laptop microphones and close-talking microphones;
- multiple English accents;
- different median pitch ranges;
- background listener video audio leakage tests, even though Listener videos should be silent;
- long sessions of at least 30–60 minutes.

## 38.2 Ground truth

Annotate:

- exact speech start/end;
- words and fillers with timestamps;
- filler category;
- sentence and clause boundaries;
- retakes and self-corrections;
- intended script position;
- phrase-level WPM;
- pitch reliability regions;
- microphone faults;
- human-rated delivery style and variety;
- whether a live tip would have been useful at each candidate moment.

At least two annotators should label contextual filler and tip usefulness. Resolve disagreements and track inter-annotator agreement.

## 38.3 Synthetic audio limitation

Synthetic speech may supplement timing tests but cannot be the sole basis for filler, cadence, pitch, or comfort evaluation. OpenAI also recommends testing Realtime transcription against representative microphones, accents, noise, vocabulary, and long sessions rather than synthetic audio alone.[^realtime]

---

# 39. Quantitative targets

All initial targets are release gates to be confirmed or revised through measured evals.

## 39.1 Pace

- 10-second WPM mean absolute error: ≤ 5 WPM on clean speech;
- 20-second WPM mean absolute error: ≤ 3 WPM;
- displayed WPM update jitter: no more than 8 WPM peak-to-peak during constant-rate read after warm-up;
- state transition delay for sustained fast/slow delivery: 3–6 seconds;
- false pace tip rate during target delivery: < 0.1 per minute.

## 39.2 Fillers

### Basic mode

- strict filler precision: ≥ 95%;
- strict filler recall: measured and disclosed; target ≥ 70% on representative speech;
- contextual filler precision: ≥ 90% before live display;
- false filler classification for legitimate “and”: < 1% of occurrences;
- duplicate event rate after overlapping chunks: < 0.5%.

### Precision mode

- strict filler precision: ≥ 96%;
- strict filler recall: ≥ 88%;
- event localization within 500 ms: ≥ 85% of confirmed fillers;
- no live textual tip from one stale isolated filler.

## 39.3 Variety

- pitch octave-error rate after filtering: < 2% of accepted voiced frames on clean speech;
- score unavailable rather than wrong when reliability gate fails;
- test-retest score difference for repeated same-style read: median ≤ 8 points;
- human-rating correlation sufficient to distinguish intentionally steady, conversational, and expressive corpus groups;
- false low-variety live tip during human-rated balanced delivery: < 0.1 per minute.

## 39.4 Cadence

- terminal-rush precision: ≥ 90% before live enablement;
- run-on precision: ≥ 90%;
- choppy-delivery precision: ≥ 85%;
- no cadence tip from a single deliberate rhetorical pause;
- no more than one cadence tip per 35 seconds.

## 39.5 Luna

- schema-valid response rate: ≥ 99.9% excluding refusals/network failures;
- stale response display rate: 0;
- invalid evidence-ID acceptance rate: 0;
- `none` decision should remain the majority of ordinary windows;
- contextual filler false-positive rate must improve over local-only rules before Luna classification ships;
- median output size: under 200 tokens.

## 39.6 Stage comfort

- one tip at a time: 100%;
- no script layout shift: 100%;
- no coaching-caused dropped scroll frames in performance tests;
- ordinary tips per minute in default mode: ≤ 3;
- users can correctly interpret pace and variety state in a one-second glance;
- coaching does not measurably increase reading errors in usability tests.

---

# 40. Human comfort study

## 40.1 Study conditions

Compare:

1. coaching off;
2. persistent WPM only;
3. WPM plus one-tip rail;
4. full Coach mode;
5. Studio mode.

Test on:

- ordinary second monitor beside camera;
- Elgato-style lens-adjacent teleprompter display;
- mirrored and non-mirrored modes;
- short and long scripts.

## 40.2 Measures

Collect:

- take completion time;
- script errors;
- retake frequency;
- gaze departures from camera;
- self-reported cognitive load;
- perceived usefulness;
- annoyance;
- tip comprehension;
- trust in filler marks;
- whether the user changed delivery after a tip;
- preference for persistent versus event-only telemetry.

## 40.3 Release principle

A technically accurate metric does not belong live if it makes performance worse. Move distracting metrics to post-take review even when their detection accuracy is high.

---

# 41. Acceptance scenarios

## 41.1 Clean natural read

The user reads at 145 WPM, with balanced variation and no fillers.

Expected:

- pace shows `145 · ON TARGET`;
- variety learns, then shows `BALANCED`;
- no ordinary tip;
- empty event ribbon except speech activity;
- optional positive feedback only if enabled.

## 41.2 One isolated “um”

Expected:

- one red tick after confirmation;
- filler count increments;
- no textual tip;
- no interruption to tracking.

## 41.3 Filler cluster

The user says three “ums” within 18 seconds.

Expected:

- three confirmed ticks;
- after a safe boundary, one `Use a silent pause` tip;
- no repeated tip for at least the category cooldown;
- post-take report identifies the cluster.

## 41.4 Legitimate “and”

The script contains: `And this is the important result.`

Expected:

- no filler event;
- no repetitive-opener event from one occurrence;
- no Luna call required unless another ambiguity exists.

## 41.5 Repeated unauthored “and” openers

The user begins eight nearby sentences with “and,” absent from the script.

Expected:

- no red strict-filler ticks for each “and”;
- session pattern records repeated opener;
- live tip only in Studio/broad mode after semantic confirmation;
- review shows frequency and examples.

## 41.6 Realtime transcript omits “uh”

Local audio candidate detects hesitation; precision transcript contains “uh.”

Expected:

- probable hollow marker may appear only if enabled;
- precision result replaces it with a confirmed solid tick at historical time;
- count updates;
- no duplicate event.

## 41.7 Realtime and precision disagree

Realtime says `I think`; precision says `I, um, think` with low audio localization confidence.

Expected:

- confirmed filler may count;
- timing may be marked unlocalized;
- no precise gutter mark if confidence is inadequate;
- review explains detection source.

## 41.8 Sustained fast delivery

The user exceeds the selected upper target by 20 WPM for ten seconds.

Expected:

- tile transitions through `SLIGHTLY FAST` to `FAST`;
- one `Ease back slightly` tip at a safe moment;
- no flicker when pace briefly touches the boundary;
- tip clears after display duration, while tile remains truthful.

## 41.9 Intentional pause

The user pauses for three seconds at a paragraph break.

Expected:

- pace number holds briefly, then shows `PAUSED`;
- no slow-pace tip;
- pause appears as normal boundary shaping, not choppiness.

## 41.10 Terminal rush

The user consistently accelerates through the final words of sentences.

Expected:

- no tip after the first sentence;
- after repeated high-confidence pattern, show `Don’t rush the ending`;
- post-take report lists affected sentences.

## 41.11 Naturally steady voice

The user’s selected style is Calm and their variety level is 46.

Expected:

- state is in target;
- no low-variety tip;
- app does not compare median pitch to gendered norms.

## 41.12 Sustained flat delivery

Selected style is Conversational; variety remains 25 with reliable audio for 25 seconds.

Expected:

- variety tile shows `VERY STEADY`;
- one `Lift the key words` tip at a safe boundary;
- no claim about boredom or confidence.

## 41.13 Poor pitch signal

Fan noise and low input cause unreliable F0.

Expected:

- variety shows `LOW CONFIDENCE` or hides;
- microphone/noise tip takes priority;
- no flat-delivery coaching.

## 41.14 Self-correction

The user says the wrong number and immediately corrects it.

Expected:

- event ledger records self-correction;
- no stale critical-number tip;
- Luna response arriving after correction is rejected.

## 41.15 Retake

The user returns to the prior sentence and reads it again.

Expected:

- tips suppress during reversal and settling;
- filler events remain attached to their original `take_pass_id`;
- new pass gets separate metrics;
- no false pace spike from semantic cursor reversal.

## 41.16 Command phrase

The user says `CandidCue, go to chapter three`.

Expected:

- command words excluded from WPM and filler analysis;
- ordinary coaching suppressed;
- pending Luna coach requests invalidated when tracking epoch changes.

## 41.17 Microphone clipping

Expected:

- immediate critical `Mic is clipping` alert after persistence gate;
- variety/cadence coaching suppressed;
- alert clears only after stable recovery.

## 41.18 Luna offline

Expected:

- local rail continues;
- contextual and semantic tips reduce gracefully;
- no user-facing error unless repeated API failure affects an enabled feature;
- scrolling remains unaffected.

## 41.19 Precision queue backlog

Expected:

- ordinary chunks drop before high-value candidate chunks;
- stage rail remains responsive;
- delayed historical ticks are allowed;
- no unbounded memory growth.

## 41.20 Mirrored teleprompter

Expected:

- text reads correctly in glass;
- event ribbon time direction appears natural to the reflected user;
- no reversed directional icon meaning;
- all metrics remain glanceable.

---
# 42. Implementation sequence

The Coaching Rail should be added only after microphone capture, Realtime transcription, script alignment, retake handling, and stage rendering are stable. The phases below are ordered to reduce technical and product risk. Each phase must be independently feature-flagged so the implementation team can compare the stage experience with and without coaching.

## 42.1 Phase 0 — technical validation spikes

Before production implementation, complete five narrow spikes.

### Spike A: lossless microphone fan-out

Prove that a single selected microphone can feed:

- the OpenAI Realtime connection;
- the local `AudioWorklet` analysis path;
- the in-memory precision-transcription ring buffer;
- optional local recording;

without opening the device multiple times, changing gain unexpectedly, introducing feedback, or causing drift between the paths.

Required output:

- one shared audio clock;
- measured end-to-end timestamp error between local features and committed Realtime audio;
- confirmed behavior after device changes, sleep/wake, Bluetooth route changes, and permission revocation;
- evidence that the analysis worklet does not block or starve audio capture.

Pass criterion: local feature timestamps and application-owned Realtime commit intervals remain within 40 ms of the same audio clock during a ten-minute test.

### Spike B: real-time pitch reliability

Implement YIN or a comparable algorithm and test it on:

- several adult pitch ranges;
- soft, conversational, and energetic delivery;
- laptop, USB, headset, and teleprompter-adjacent microphones;
- air-conditioning and fan noise;
- clipped input;
- music or another voice in the background.

The spike must quantify voiced-frame coverage, octave-error rate, and CPU cost. The feature is not production-ready merely because a pitch trace looks plausible.

### Spike C: Realtime versus verbatim filler recall

Build a small paired corpus in which each clip has a human transcript preserving:

- strict fillers;
- contextual fillers;
- repetitions;
- abandoned phrases;
- self-corrections;
- intentional authored filler-like words.

For each clip, compare:

1. Realtime final transcript;
2. `gpt-4o-mini-transcribe` with the normative verbatim prompt;
3. the optional larger transcription model;
4. local acoustic candidate output.

Measure filler precision, recall, timing error, and API delay. This spike determines whether probable local markers are useful live and whether Precision mode should be opt-in or recommended by default.

### Spike D: rail attention and legibility

Create interactive prototypes for:

- ordinary monitor use;
- a small lens-adjacent teleprompter display;
- mirrored glass;
- one-line and two-line script layouts;
- dark Listener backgrounds;
- different rail sizes.

Test whether users can identify pace state, active tip, and a new filler tick with a glance shorter than one second. If users repeatedly look away from the camera, reduce the information density.

### Spike E: Luna utility and delay

Replay deterministic local evidence bundles through the exact Luna schema. Compare:

- fully deterministic local tip policy;
- Luna validation only;
- Luna candidate selection among two or three local candidates;
- periodic Enhanced mode.

Measure accepted-result latency, stale-result rate, disagreement with human labels, and the percentage of requests that correctly return `NONE`. Luna is justified only where it improves semantic precision enough to offset delay and cost.

## 42.2 Phase 1 — audio foundation and microphone health

Implement:

- shared microphone capture;
- monotonic audio clock;
- AudioWorklet feature extraction;
- VAD;
- RMS, peak, clipping, noise-floor, and SNR estimates;
- bounded feature ring buffers;
- microphone-health state;
- immediate critical microphone alerts;
- developer diagnostics.

Do not implement pitch-based coaching or fillers yet. This phase must establish that local analysis is stable and never affects scrolling or transcript delivery.

Exit criteria:

- no unbounded allocation on the audio thread;
- no audible or measurable capture interruption;
- clipping and no-signal tests pass;
- local analysis survives window resizing and stage fullscreen changes;
- telemetry stops immediately when microphone capture stops.

## 42.3 Phase 2 — pace and pause intelligence

Implement:

- speech intervals;
- reconstructed token timing;
- cumulative word observations;
- EWMA/weighted-regression WPM;
- Audible WPM, Content WPM, and Articulation WPM;
- pace target profiles;
- pause handling;
- terminal-rush detection;
- pace state and trend;
- post-take pace graph;
- deterministic pace tips.

Release this phase internally with the rail showing only pace and microphone state. Validate that transcript batching does not cause WPM jumps and that a deliberate pause does not look like slow speech.

## 42.4 Phase 3 — rail shell and event timeline

Implement the reserved rail geometry, all responsive layouts, mirror behavior, accessibility semantics, and a generic event ledger. Initially populate the ribbon with only:

- speech activity;
- current-time edge;
- microphone clipping;
- command/retake suppression state in diagnostics.

The central tip area must be operational before more categories are added. At most one instruction may appear.

## 42.5 Phase 4 — pitch, energy, variety, and cadence

Implement:

- reliable F0 extraction;
- speaker-relative semitone conversion;
- pitch reliability gates;
- relative energy features;
- phrase segmentation;
- pause-shape and run-on detection;
- choppy-flow detection;
- variety feature aggregation;
- style profiles;
- learning/calibration states;
- review visualizations;
- conservative live variety and cadence tips.

For the first internal release, show a categorical variety state without a number. Enable the 0–100 number only after raters find the scale stable and interpretable.

## 42.6 Phase 5 — transcript-derived disfluencies

Implement strict filler, repetition, false-start, and repeated-opener detection from finalized Realtime transcripts and script alignment.

Required safeguards:

- partial transcript revisions never create confirmed events;
- authored filler-like words are excluded;
- commands are excluded;
- a normal “and” is not a filler;
- immediate self-correction invalidates stale discrepancy coaching;
- retake passes remain separate;
- event markers can be retroactively inserted at their original audio time.

This phase can ship in Basic filler mode before local acoustic candidates and Precision mode are ready.

## 42.7 Phase 6 — precision filler analysis

Implement:

- in-memory audio ring buffer;
- chunk extraction and overlap;
- priority queue and budgets;
- promptable verbatim transcription;
- three-sequence reconciliation;
- event confidence and localization;
- delayed ribbon insertion;
- post-take transcript reconstruction;
- privacy and usage controls.

Precision mode must remain asynchronous and nonblocking. It must not be a dependency of scrolling, pace, pitch, or immediate microphone alerts.

## 42.8 Phase 7 — Luna Coach Observer

Implement:

- local candidate generation;
- request scheduler;
- strict schema;
- system prompt;
- stable prompt prefix and cache key strategy;
- tracking-epoch and take-pass validation;
- stale-response rejection;
- local confidence thresholds;
- logging of accepted and rejected recommendations;
- cost and request-rate controls.

Begin with Luna used only for contextual filler and material script-difference candidates. Add broader tip arbitration only after offline evaluation.

## 42.9 Phase 8 — post-take review

Implement:

- summary cards;
- pace, variety, filler, and pause timelines;
- annotated script view;
- pass-aware event filtering;
- recommendations;
- comparison with personal goals;
- export and deletion;
- optional local history.

The review must explain how each metric was calculated and indicate low-confidence intervals.

## 42.10 Phase 9 — personalization and release hardening

Implement:

- optional persistent personal baseline;
- target presets and Custom mode;
- per-category sensitivity;
- learned suppression from user dismissals;
- language-specific filler packs;
- broad hardware and operating-system QA;
- accessibility validation;
- performance profiling;
- human comfort study;
- telemetry-free local diagnostics export.

Personalization must remain bounded. The system may learn a baseline, but it must not silently redefine poor microphone conditions, chronic clipping, or every habitual delivery pattern as ideal.

---

# 43. Feature flags and rollout controls

Every major coaching subsystem must have an independent runtime feature flag:

```ts
interface CoachingFeatureFlags {
  railShell: boolean;
  microphoneHealth: boolean;
  livePace: boolean;
  targetDuration: boolean;
  transcriptFillers: boolean;
  acousticFillerCandidates: boolean;
  precisionFillers: boolean;
  pitchAnalysis: boolean;
  liveVariety: boolean;
  cadenceAnalysis: boolean;
  lunaContextValidation: boolean;
  lunaTipArbitration: boolean;
  scriptGutterMarks: boolean;
  postTakeReview: boolean;
  persistentPersonalBaseline: boolean;
}
```

Flags exist for development, staged release, A/B comfort testing, and emergency disablement. They must not create contradictory settings. The UI derives availability from both product settings and effective flags.

Recommended release order:

1. microphone health;
2. pace tile and pause-aware WPM;
3. event ribbon shell;
4. Basic strict filler marks;
5. post-take review;
6. cadence and variety;
7. Precision fillers;
8. contextual Luna coaching;
9. optional Enhanced mode.

A server-side kill switch may disable a network-backed coaching operation, but local user settings and API keys remain local. The application must not require a CandidCue server merely to calculate local metrics.

---

# 44. Normative default configuration

These defaults define the first-run Coach mode. They are starting values and must be calibrated through the specified corpus and comfort study.

## 44.1 Live rail defaults

```ts
const DEFAULT_COACHING_PROFILE: CoachingProfile = {
  mode: 'coach',
  pacePreset: 'natural_presentation',
  targetWpmLow: 115,
  targetWpmHigh: 160,
  targetDurationSeconds: null,
  deliveryStyle: 'natural',
  targetVarietyLow: 45,
  targetVarietyHigh: 75,
  showNumericVariety: false,
  fillerDetection: 'basic',
  contextualFillers: true,
  repeatedOpeners: true,
  eventRibbon: true,
  scriptGutterMarks: false,
  liveTipFrequency: 'normal',
  positiveFeedback: 'minimal',
  precisionTranscription: 'off',
  lunaMode: 'standard',
  saveReview: true,
  saveAudio: false,
  persistentPersonalBaseline: false
};
```

First-run users therefore receive:

- a visible WPM number once stable;
- a pace state;
- categorical variety after calibration;
- confirmed Basic filler ticks and count;
- one central tip when warranted;
- no saved audio;
- no paid precision pass unless enabled;
- no script-gutter clutter;
- a post-take report.

## 44.2 Default visible composition

At normal width, the rail is:

```text
┌──────────────┬──────────────────────────────────┬──────────────────────┐
│ 142 WPM      │                                  │ BALANCED · 1 FILLER  │
│ ON PACE      │       Ease back slightly         │ recent event ribbon  │
└──────────────┴──────────────────────────────────┴──────────────────────┘
```

When there is no active tip, the center remains visually quiet. It may contain a very faint status such as `COACHING ACTIVE` only during the first few seconds, then become empty.

The variety number is hidden by default because a categorical state is easier to interpret while performing. The detailed numeric value appears in Settings, Studio mode, and post-take review.

## 44.3 Default tip cadence

- no more than one new noncritical tip every 18 seconds;
- no more than three noncritical tips in any rolling two-minute window;
- no repeat of the same tip code within its category cooldown;
- at least one sentence boundary between ordinary tips;
- critical microphone alerts are exempt;
- meaning-critical alerts follow their own conservative rules;
- positive feedback no more than once every 90 seconds and off when another issue is pending.

## 44.4 Default event ribbon

The ribbon shows the last 30 seconds. Default visible marks:

- speech activity trace;
- confirmed strict or contextual filler;
- current-time edge.

Probable acoustic fillers, repetitions, retakes, critical differences, and clipping are available in Studio mode or diagnostics. The live default is intentionally sparse.

## 44.5 Precision-mode recommendation

Do not silently enable Precision mode merely because a user turns on fillers. In Settings, explain:

```text
Basic mode detects fillers that appear in the live transcript and uses
local timing clues. OpenAI's live transcript may clean up some hesitations.
Precision mode sends short audio segments for an additional, more verbatim
transcription pass. Results can appear a few seconds later and use extra API
credits.
```

Offer a one-click test during setup. The test plays back or records a short sentence containing deliberate fillers and shows what Basic and Precision modes detected.

---

# 45. What belongs live and what belongs after the take

The product must be strict about this division.

## 45.1 Information useful live

The following can change what the speaker does in the next few seconds and is suitable for the stage:

- current smoothed WPM and whether it is on target;
- schedule projection when recording to a target duration;
- one short instruction;
- current categorical variety state;
- current confirmed filler count;
- recent filler locations;
- microphone clipping, no-signal, or severe noise;
- a persistent run-on, choppy-flow, or terminal-rush pattern;
- a critical uncorrected number, name, unit, or negation difference when enabled;
- `PAUSED`, `LEARNING`, or `LOW CONFIDENCE` when a number would mislead.

## 45.2 Information not useful live

The following is distracting, retrospective, too uncertain, or too complex for the stage and belongs in review:

- a table of all filler phrases;
- exact pitch span in semitones;
- raw median pitch in Hertz;
- acoustic graphs;
- sentence-by-sentence accuracy percentage;
- all substitutions and omissions;
- detailed pronunciation claims;
- a leaderboard or grade;
- trend comparison with previous sessions;
- multiple simultaneous tips;
- explanations longer than a short phrase;
- a live transcript of the model’s reasoning;
- a constantly changing composite “performance score.”

## 45.3 Stage-to-review continuity

Every visible event must be explainable in review. Selecting a review event should show:

- the relevant audio interval when recording was enabled;
- spoken text from available transcripts;
- the aligned authored text;
- event confidence;
- evidence sources;
- whether Luna participated;
- whether the event was shown live, suppressed, corrected, or arrived late.

The review must not invent certainty that the live system did not have.

---

# 46. Product answers and non-negotiable conclusions

This section states the direct implementation decisions behind the feature.

## 46.1 Will OpenAI Realtime transcription detect “um,” “uh,” and similar fillers?

Sometimes, but not reliably enough to be the only detector. A clearly spoken filler may appear in the final Realtime transcript. Common fillers may also be omitted as the model produces a cleaned transcript. The current `gpt-realtime-whisper` Realtime path cannot be prompted to preserve them, so CandidCue must represent Basic filler detection honestly.[^stt-fillers][^realtime]

The implementation must never promise that Basic mode finds every filler.

## 46.2 Can CandidCue detect fillers from raw microphone audio?

It can detect acoustic regions that resemble hesitation and use them as supporting evidence, but a robust lexical distinction between “uh,” a sustained vowel inside a word, breathing, and background speech is not safely solved by a few signal-processing thresholds.

Version 1 therefore uses local audio to:

- identify likely hesitation timing;
- retain the right audio region;
- corroborate transcript evidence;
- create a probable marker when confidence is meaningful;
- prioritize a region for precision transcription.

A future on-device acoustic classifier may promote this layer, but only after representative cross-accent evaluation.

## 46.3 What is the most reliable filler solution?

A layered solution:

1. Realtime final transcript for immediate explicit fillers;
2. local acoustic and alignment evidence for timing and candidate generation;
3. promptable precision transcription for higher-recall verbatim analysis;
4. deterministic/Luna contextual classification for ambiguous discourse words;
5. delayed reconciliation and post-take correction.

No single layer is authoritative in every case.

## 46.4 Should “and” be marked red?

Not by default. `And` is a normal conjunction. It is useful coaching only when the user repeatedly inserts it at clause or sentence openings, it is absent from the script, the pattern persists, and deleting it does not change meaning. The stage should normally say `Vary the sentence openings` rather than branding each `and` as a mistake.

## 46.5 What is the correct WPM calculation?

Use an exponentially weighted estimate over audio time and cumulative finalized/reconstructed spoken words, not a raw count divided by the last arbitrary five seconds. The calculation must:

- tolerate irregular transcript delivery;
- include natural pauses in Audible WPM;
- freeze gracefully during silence;
- distinguish articulation speed from overall delivery pace;
- remove commands;
- revise historical word counts without visually jumping;
- use hysteresis before changing the coaching state.

The live number is an estimate, not a stopwatch-grade measurement of every phoneme.

## 46.6 Can CandidCue assess cadence and vocal variety?

Yes, as observable signal patterns. From raw microphone audio it can calculate relative pitch movement, relative energy change, voiced/silent intervals, phrase lengths, pause placement, pace changes, and sentence-ending acceleration. From transcripts and alignment it can associate those patterns with sentence boundaries, key phrases, retakes, and deviations.

It should report descriptions such as:

- `steady`;
- `balanced`;
- `highly animated`;
- `long runs without a pause`;
- `frequent short breaks`;
- `sentence endings accelerate`.

It must not convert those measurements into unsupported statements such as “you sound anxious,” “you lack confidence,” or “the audience is bored.”

## 46.7 Should there be a single variety score?

Yes, provided it is explicitly a CandidCue delivery scale and not presented as a universal scientific quality score. The number combines pitch, energy, and tempo variation, then compares it with a selected style band. More is not always better.

For live use, the default should be a category such as `BALANCED`. The number belongs in Studio mode and review until the mapping has been validated.

## 46.8 What should Luna do?

Luna should interpret text and locally calculated evidence, not run the signal-processing loop. Its highest-value tasks are:

- decide whether a contextual word was actually a filler;
- distinguish a useful paraphrase from a material meaning change;
- recognize that a user already self-corrected;
- choose the best single tip from a small eligible set;
- suppress low-value or stale coaching.

Luna must not receive an open-ended instruction to “coach this speaker” and generate arbitrary live prose. It returns a strict code that the local application validates and renders with predetermined text.

## 46.9 How should model delay affect the UI?

Model delay must never cause a late tip to masquerade as a current one. Every request includes exact audio time, tracking epoch, script revision, take pass, evidence IDs, and expiry. A response that arrives after the relevant behavior ended is either:

- discarded;
- used only to update a historical marker;
- saved for post-take review;
- converted into a future-oriented session-pattern tip if the pattern is still active.

The rail should feel immediate because pace, variety, cadence, and microphone health are local. Luna improves selectivity rather than providing the heartbeat.

## 46.10 What is the most useful live layout?

Three stable zones and one timeline:

1. left: smoothed pace and pace state;
2. center: at most one short actionable tip;
3. right: variety state and confirmed filler count;
4. bottom edge: recent event ribbon.

This layout answers the user’s most important questions without forcing them to scan a dashboard.

---

# 47. Definition of done

The Coaching Rail is complete only when all requirements below are met.

## 47.1 Functional completion

- microphone audio is analyzed locally without a second capture session;
- coaching uses the same monotonic audio clock as transcription commits;
- live WPM remains smooth through transcript batching;
- intentional pauses do not trigger slow-pace coaching;
- pitch-derived feedback hides when pitch evidence is unreliable;
- Basic and Precision filler modes are clearly distinguished;
- contextual fillers require contextual evidence;
- every event carries confidence, audio interval, source, script anchor, and take pass;
- only one noncritical tip appears at a time;
- tips suppress correctly during commands, retakes, reacquisition, and poor microphone conditions;
- Luna responses are schema-valid, bounded, validated, and stale-safe;
- post-take review reconciles delayed evidence;
- audio retention defaults to off;
- coaching can be completely disabled without changing teleprompter behavior.

## 47.2 UX completion

- the rail occupies permanently reserved space and never shifts script text when a tip appears;
- the ordinary-display and teleprompter-display layouts are separately tested;
- mirrored use is correct;
- no state relies on color alone;
- a user can understand pace state, active tip, and filler marker with a brief glance;
- no more than one ordinary live tip is shown at a time;
- the empty/healthy state is quiet;
- `LEARNING`, `PAUSED`, and `LOW CONFIDENCE` states are explicit;
- users can disable every category independently;
- every live item has a more detailed explanation in review.

## 47.3 Accuracy completion

- quantitative corpus targets in Section 39 pass on held-out speakers;
- filler evaluation includes multiple accents and microphone types;
- contextual-word false positives meet the release threshold;
- `and`, `like`, `so`, and `well` test sets pass;
- retakes and self-corrections do not generate stale meaning-error tips;
- pitch octave errors are below the specified reliability threshold;
- pace estimates are tested against manually timed speech;
- Luna adds measurable precision on its target classes and returns `NONE` appropriately;
- no model-derived acoustic claim is accepted without local evidence.

## 47.4 Performance completion

- audio analysis has no sustained allocation pressure;
- UI rendering does not block the audio worklet;
- the rail maintains stage frame rate under normal load;
- precision queue memory is bounded;
- no network-backed coaching request occurs on every audio frame or transcript delta;
- an offline or quota-exhausted Luna path leaves local coaching intact;
- ten-minute and sixty-minute soak tests show no audio-clock drift or memory growth.

## 47.5 Privacy completion

- the setup UI explains which audio and text leave the device;
- Basic local coaching and Realtime transcription are distinguished from Precision audio requests;
- no microphone audio is saved by default;
- the ring buffer is memory-only and cleared at required lifecycle events;
- saved reviews can be deleted completely;
- diagnostic export excludes raw audio unless the user explicitly includes it;
- no protected-trait or psychological voice inference exists in prompts, schemas, UI, or analytics.

## 47.6 Product release gate

Do not release live contextual coaching merely because the model can generate plausible comments. Release it only when:

- human raters find the tip correct and currently actionable;
- the issue persists long enough to justify interruption;
- the user can act on it without losing their place;
- false and stale tips remain rare;
- comfort scores are no worse than the no-coaching condition;
- the rail demonstrably improves at least one objective or self-rated outcome over repeated rehearsals.

---

# 48. Future extensions

The following are valid future directions but are outside the version-1 release gate.

## 48.1 On-device filler classifier

A small locally executed model could classify hesitation vocalizations and breaths from short spectrogram windows. It would reduce dependence on delayed precision transcription, but requires:

- licensed training data;
- accent and language diversity;
- false-positive tests against vowels inside words;
- background-speaker rejection;
- hardware performance evaluation;
- model-update and versioning strategy.

## 48.2 Pronunciation and name rehearsal

For user-selected names or terms, a dedicated feature could compare audio against a supplied pronunciation or phoneme target. It must be explicitly configured and must not infer that ASR disagreement alone means the user pronounced a word incorrectly.

## 48.3 Script-aware emphasis rehearsal

Before a take, CandidCue could identify likely emphasis points from contrast, structure, Markdown emphasis, and user annotations. During review it could show whether those phrases received relative pitch or energy contrast. Live emphasis coaching should remain opt-in and sparse.

## 48.4 Camera and visual-delivery coaching

A future computer-vision module could analyze eye line, head movement, or framing. It must be architecturally separate from audio coaching, permission-gated, and disabled by default. It is not part of this specification.

## 48.5 Personal rehearsal plan

Across saved sessions, the application could select one focus goal per rehearsal, such as pace stability or fewer strict fillers. It should not combine every metric into an opaque score. Historical comparison remains local unless the user explicitly enables synchronization.

## 48.6 Audience- or format-specific profiles

Additional profiles might include:

- investor pitch;
- course lesson;
- sales video;
- audiobook narration;
- technical demonstration;
- short social clip;
- keynote;
- legal or compliance read.

Profiles adjust targets and suppression rules. They must not claim universal correctness.

---

# Appendix A. Canonical user-facing copy

This appendix defines initial copy. Product localization may adapt phrasing while preserving brevity and meaning.

## A.1 Pace tile states

| State | Primary | Secondary |
|---|---|---|
| Learning | `— WPM` | `LEARNING` |
| On target | `{n} WPM` | `ON PACE` |
| Slightly fast | `{n} WPM` | `A LITTLE FAST` |
| Fast | `{n} WPM` | `FAST` |
| Slightly slow | `{n} WPM` | `A LITTLE SLOW` |
| Slow | `{n} WPM` | `SLOW` |
| Paused | `{last} WPM` | `PAUSED` |
| Low confidence | `— WPM` | `LOW CONFIDENCE` |

## A.2 Variety tile states

| State | Live copy |
|---|---|
| Learning | `VARIETY · LEARNING` |
| Very steady | `VARIETY · VERY STEADY` |
| Steady | `VARIETY · STEADY` |
| Balanced | `VARIETY · BALANCED` |
| Expressive | `VARIETY · EXPRESSIVE` |
| Highly animated | `VARIETY · HIGHLY ANIMATED` |
| Low confidence | `VARIETY · LOW CONFIDENCE` |

Studio mode may prepend the numeric level.

## A.3 Live tip text

| Code | Stage copy |
|---|---|
| `PACE_EASE_BACK` | `Ease back slightly` |
| `PACE_LIFT_SLIGHTLY` | `Bring the pace up a touch` |
| `TERMINAL_RUSH` | `Don’t rush the ending` |
| `USE_SILENT_PAUSE` | `Use a silent pause` |
| `REPEATED_FILLER` | `Pause instead of “{filler}”` |
| `LET_BOUNDARY_BREATHE` | `Let the sentence land` |
| `KEEP_SENTENCE_FLOWING` | `Keep the sentence flowing` |
| `LIFT_KEY_WORDS` | `Lift the key words` |
| `SETTLE_DELIVERY` | `Settle the delivery slightly` |
| `REPETITIVE_OPENER` | `Vary the sentence openings` |
| `TAKE_SENTENCE_FROM_TOP` | `Take the sentence from the top` |
| `CRITICAL_NUMBER` | `Check that number` |
| `CRITICAL_NAME` | `Check that name` |
| `CRITICAL_UNIT` | `Check that unit` |
| `CRITICAL_NEGATION` | `Check the meaning` |
| `MATERIAL_MEANING_CHANGE` | `Check that phrase` |

Only an allowlisted, locally validated filler may be interpolated. Otherwise use `Use a silent pause`.

## A.4 Microphone alerts

| Condition | Copy |
|---|---|
| clipping | `Mic is clipping` |
| no input | `No microphone signal` |
| input too low | `Mic level is very low` |
| severe noise | `Background noise is masking the voice` |
| device changed | `Microphone changed` |
| analysis unavailable | `Voice analysis unavailable` |

---

# Appendix B. Precision-transcription request template

Use a transcription endpoint and a promptable transcription model. The API wrapper must pass only the selected short audio chunk and compact context.

```ts
interface PrecisionTranscriptJob {
  jobId: string;
  sessionId: string;
  takePassId: string;
  trackingEpoch: number;
  audioStartMs: number;
  audioEndMs: number;
  priority: 'critical' | 'candidate_cluster' | 'sentence' | 'background';
  audioBytes: Uint8Array;
  mimeType: 'audio/wav' | 'audio/webm' | 'audio/mp4';
  prompt: string;
  nearbyScriptTerms: string[];
  expiresAtAudioMs: number;
}
```

Canonical prompt:

```text
Transcribe this speech verbatim. Preserve every audible hesitation,
filler, repeated word, false start, abandoned phrase, and self-correction.
Preserve “um,” “uh,” “er,” “erm,” “ah,” “hmm,” “mm,” “like,” “you know,”
and similar forms only when they are actually audible. Do not clean up the
speaker's grammar. Do not silently remove disfluencies. Do not infer words
that are not audible. Use punctuation to reflect the spoken phrasing.

Nearby spellings and proper nouns, for spelling context only:
{{nearby_terms}}
```

Request construction rules:

- cap nearby terms;
- do not send the whole script when unnecessary;
- do not claim every listed filler occurred;
- preserve the original audio interval;
- reject a result from an old take pass or tracking epoch;
- de-duplicate overlapped results by aligned token identity and audio time.

---

# Appendix C. Post-take Luna summary prompt

A post-take summary may use a separate Luna request because latency is no longer stage-critical. It still receives structured evidence, not unrestricted raw session history.

```text
You are CandidCue Review Analyst. Summarize observable delivery patterns
from the supplied verified metrics and event records. Select at most three
priorities for the next rehearsal. Prefer repeated, high-confidence patterns
with a clear action. Do not diagnose emotion, confidence, personality,
health, accent quality, honesty, or audience reaction. Do not invent acoustic
facts or transcript events. Acknowledge low-confidence intervals. Do not
reduce the session to a single quality score. Return only the required
structured response.
```

Recommended response fields:

```ts
interface PostTakeCoachSummary {
  schemaVersion: '1.0';
  headline: string;
  strengths: Array<{
    code: string;
    evidenceIds: string[];
  }>;
  priorities: Array<{
    code: string;
    evidenceIds: string[];
    practiceAction: string;
  }>;
  excludedLowConfidenceCategories: string[];
}
```

All final user-facing wording should be assembled from local templates or validated length-limited fields.

---

# Appendix D. Metric definitions

## D.1 Audible WPM

```text
all spoken lexical tokens, including confirmed fillers and repetitions
----------------------------------------------------------------------- × 60
                elapsed delivery seconds including pauses
```

The live implementation uses the weighted regression in Section 14 rather than recomputing this quotient over an abrupt fixed window.

## D.2 Content WPM

```text
meaning-bearing spoken lexical tokens excluding commands and confirmed fillers
------------------------------------------------------------------------------ × 60
                         elapsed delivery seconds
```

## D.3 Articulation WPM

```text
all spoken lexical tokens
------------------------- × 60
 active voiced seconds
```

## D.4 Filler rate

Report both:

```text
confirmed fillers / delivery minute
```

and:

```text
100 × confirmed fillers / audible words
```

Do not compare users solely by fillers per minute when their speaking rates differ substantially.

## D.5 Pitch movement

Pitch variation is calculated from reliable voiced frames in speaker-relative semitones. Robust percentiles, median absolute movement, and phrase contours are preferred to minimum/maximum because one octave error can corrupt a range.

## D.6 Energy movement

Energy variation uses relative dBFS after rejecting clipping and adapting to microphone baseline. It is not an SPL measurement and is not comparable across devices without calibration.

## D.7 Cadence balance

`cadenceBalance` is an internal 0–100 fit-to-profile estimate based on:

- speech-run length distribution;
- punctuation-aligned pause placement;
- pause-duration distribution;
- phrase-rate stability;
- terminal-rush frequency;
- choppy internal-break frequency.

It should be retained for policy and review. Do not show it as a live universal quality score in v1.

---

# Appendix E. Research source register

The implementation team must re-check these sources when upgrading OpenAI models or APIs. Behavior and model availability may change.

[^realtime]: OpenAI, **Realtime transcription**, retrieved 24 July 2026. <https://developers.openai.com/api/docs/guides/realtime-transcription>

[^stt-fillers]: OpenAI, **Speech to text**, including guidance that common filler words may be omitted and may be encouraged through a prompt on prompt-capable transcription models, retrieved 24 July 2026. <https://developers.openai.com/api/docs/guides/speech-to-text>

[^luna]: OpenAI, **GPT-5.6 Luna model**, including supported input/output modalities and Structured Outputs support, retrieved 24 July 2026. <https://developers.openai.com/api/docs/models/gpt-5.6-luna>

[^mini-transcribe]: OpenAI, **GPT-4o mini Transcribe model**, retrieved 24 July 2026. <https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe>

[^transcribe]: OpenAI, **GPT-4o Transcribe model**, retrieved 24 July 2026. <https://developers.openai.com/api/docs/models/gpt-4o-transcribe>

[^structured]: OpenAI, **Structured model outputs**, retrieved 24 July 2026. <https://developers.openai.com/api/docs/guides/structured-outputs>

[^prompt-cache]: OpenAI, **Prompt caching**, retrieved 24 July 2026. <https://developers.openai.com/api/docs/guides/prompt-caching>

[^ms-coach]: Microsoft Support, **Rehearse your slide show with Speaker Coach**, retrieved 24 July 2026. <https://support.microsoft.com/en-us/office/rehearse-your-slide-show-with-speaker-coach-cd7fc941-5c3b-498c-a225-83ef3f64f07b>

[^ms-suggestions]: Microsoft Support, **Suggestions from Speaker Coach**, retrieved 24 July 2026. <https://support.microsoft.com/en-us/office/suggestions-from-speaker-coach-25e7d866-c895-4aa1-9b90-089b70a4ea38>

[^webaudio]: W3C, **Web Audio API**, retrieved 24 July 2026. <https://www.w3.org/TR/webaudio-1.1/>

[^yin]: Alain de Cheveigné and Hideki Kawahara, **YIN, a fundamental frequency estimator for speech and music**, *Journal of the Acoustical Society of America* 111(4), 2002. <https://pubs.aip.org/asa/jasa/article/111/4/1917/547221/YIN-a-fundamental-frequency-estimator-for-speech>

---

# Appendix F. Final implementation checklist

## Product

- [ ] Rail is optional and quiet by default.
- [ ] Default stage contains pace, one tip slot, variety state, filler count, and a sparse event ribbon.
- [ ] Precision filler behavior and API use are explained before enabling.
- [ ] No live composite performance grade exists.
- [ ] Post-take review contains the detail omitted from stage.

## Audio

- [ ] Shared microphone source fans out without duplicate capture.
- [ ] All events use one monotonic audio clock.
- [ ] AudioWorklet has bounded memory and no network/UI work.
- [ ] VAD, clipping, noise, and dropout behavior pass tests.
- [ ] Pitch output is reliability-gated and speaker-relative.

## Pace

- [ ] WPM uses weighted regression/EWMA behavior.
- [ ] Commands and transcript revisions are handled.
- [ ] Pauses show `PAUSED`, not a collapsing number.
- [ ] Target duration uses projected finish rather than instantaneous panic.
- [ ] Terminal rush requires repeated evidence.

## Fillers

- [ ] Realtime omissions are expected and disclosed.
- [ ] Authored filler-like words are excluded.
- [ ] `and`, `so`, `like`, and related words require context.
- [ ] Basic and Precision modes have separate labels.
- [ ] Delayed results are placed at historical audio time.
- [ ] Probable and confirmed markers are visually distinct.
- [ ] Retake passes are not merged.

## Variety and cadence

- [ ] Variety evaluates a target band, not maximum movement.
- [ ] Numeric score is hidden by default.
- [ ] Low-confidence pitch disables pitch coaching.
- [ ] Silence and punctuation boundaries are treated as intentional when appropriate.
- [ ] No psychological or demographic inference is made.

## Luna

- [ ] Exact system prompt is installed.
- [ ] Strict schema is used.
- [ ] Luna receives only bounded evidence.
- [ ] Every response is checked for epoch, pass, evidence IDs, expiry, and local eligibility.
- [ ] Failure produces no tip and does not affect scrolling.
- [ ] Prompt prefix remains stable for caching where applicable.

## UI and accessibility

- [ ] Rail height is reserved before take start.
- [ ] No tip causes script reflow.
- [ ] Mirror behavior is verified through actual glass.
- [ ] Marker shapes work without color.
- [ ] Text meets contrast and minimum-size requirements.
- [ ] Reduced-motion mode removes unnecessary marker animation.
- [ ] Screen-reader labels describe state without announcing every numeric update.

## Privacy and lifecycle

- [ ] Audio is not saved by default.
- [ ] Memory ring buffer clears on required events.
- [ ] Precision jobs expire and are bounded.
- [ ] Saved reports can be deleted.
- [ ] Diagnostic export is explicit and inspectable.
- [ ] API-key behavior remains BYOK.

## Validation

- [ ] Corpus and human-study release gates pass.
- [ ] All acceptance scenarios pass.
- [ ] One-hour soak test passes.
- [ ] Offline, quota, and model-delay tests pass.
- [ ] No-coaching comparison confirms the rail does not reduce comfort or place retention.

