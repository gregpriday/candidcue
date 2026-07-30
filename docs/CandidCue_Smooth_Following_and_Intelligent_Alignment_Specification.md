# CandidCue
## Smooth Following, Intelligent Alignment, Retakes, and Live Coaching
### Mandatory Companion Specification to the Product and Technical Specification

**Document status:** Build-ready enhancement and algorithm specification  
**Companion version:** 1.0  
**Research cut-off:** 24 July 2026  
**Applies to:** CandidCue desktop v1 unless explicitly deferred by the product owner  
**Primary stack:** Tauri 2, Svelte + TypeScript, Rust  
**Realtime transcription:** OpenAI Realtime transcription  
**Semantic sidecar:** `gpt-5.6-luna` through the OpenAI Responses API  
**Relationship to primary document:** Normative supplement and partial override  

---

## 0. How to use this document

This document is the implementation specification for CandidCue’s first major refinement: the teleprompter must not merely jump the active sentence into a reading band whenever a new transcript match arrives. It must create the impression of a calm, continuous, intelligently paced sheet of text that is moving with the presenter.

Use this document together with **CandidCue — Product, UX, Architecture, and Implementation Specification**. The primary specification remains authoritative except where this document explicitly changes or narrows it.

### 0.1 Normative precedence

This document:

- **replaces** the ordinary voice-follow movement behavior in primary Sections 32.1–32.5;
- **extends and partially replaces** the alignment behavior in primary Sections 31.1–31.14;
- **changes** the earlier rule that Luna must never influence ordinary reading position: Luna may now contribute bounded semantic evidence, but it remains advisory and can never be the sole authority for a navigation jump;
- **tightens** global reacquisition: an uncommanded non-contiguous section jump is prohibited;
- **extends** the tracking worker, OpenAI service, stage message contract, diagnostics, speech corpus, metrics, and acceptance criteria;
- **replaces** Appendix G.6, “Stage target,” with the continuous trajectory and motion controller defined here;
- leaves microphone, credential, command, editor, Listener, security, storage, packaging, and other unaffected requirements unchanged.

When the documents appear to conflict, apply this order:

1. explicit hard invariant in this companion document;
2. explicit requirement in the primary specification;
3. starting parameter or illustrative value in either document;
4. implementation choice made from evaluation data.

### 0.2 Mandatory versus tunable content

Words such as **must**, **must not**, **required**, and **prohibited** are normative. Numerical thresholds are initial defaults unless identified as a release gate. They must be stored in versioned profiles and calibrated against the speech and motion corpus.

### 0.3 Core implementation instruction

Do not implement this as a collection of CSS `scrollIntoView`, browser-native smooth-scroll calls, or one-off easing animations. The required behavior is a continuously running estimation-and-control system with explicit state, velocity, acceleration, confidence, authority, and correction rules.

---

# Part I — Product behavior

## 1. Executive summary

CandidCue must continuously estimate two different things:

1. **What part of the script the presenter is attempting to deliver.**
2. **How the text should move at this instant so that reading remains comfortable.**

Those are related but not identical.

Realtime transcription is intermittent and imperfect. It arrives in deltas, is finalized in chunks, may lag the speaker, and may contain substitutions. A naïve teleprompter reacts to those events by moving after each recognized phrase. Even with easing, the result feels like a series of corrections: hold, jump, hold, jump. CandidCue must instead infer a continuous reading trajectory between transcript events.

The required system has five cooperating layers:

1. **Streaming transcript reconciliation** turns provider events into stable, time-stamped text evidence.
2. **Multi-hypothesis script alignment** estimates likely script positions while tolerating omissions, insertions, paraphrases, recognition errors, pauses, and repeated passages.
3. **Pace and progress estimation** converts sparse position evidence into a continuous semantic position and speaking velocity.
4. **Line-aware visual trajectory planning** maps semantic progress onto rendered line geometry so that each next line naturally arrives in the same comfortable reading area as the current line ends.
5. **A jerk-limited stage motion controller** follows that trajectory at the display refresh rate without twitching, abruptly stopping, or racing through corrections.

GPT-5.6 Luna may run as an asynchronous semantic sidecar. It may classify a transcript span as near-exact, paraphrased, ad-libbed, restarted, corrected, or returned to script; rank only the candidate spans supplied by the local aligner; and identify high-confidence fidelity issues. It must not choose an arbitrary place in the full script, cross a hard section boundary, or directly write the stage scroll position.

### 1.1 Essential experience promise

> The text should feel as though it already knows the presenter’s pace, while quietly correcting itself when new evidence arrives.

### 1.2 What “smooth” means

“Smooth” does not merely mean an animation has easing. It means:

- movement continues between transcript events when recent evidence supports continued speech;
- the active line drifts at a stable velocity rather than repeatedly snapping to a fixed Y coordinate;
- velocity changes gradually;
- small alignment corrections are absorbed over time;
- uncertainty causes a graceful slowdown, not a sudden stop;
- a confident local catch-up accelerates within comfortable limits;
- a short retake reverses in a controlled way;
- a distant correction uses a brief re-anchor transition instead of visibly racing through text;
- normal line wrapping produces no discontinuity in the desired scroll target;
- a provisional transcript revision does not create a visible oscillation.

### 1.3 What “intelligent” means

“Intelligent” means the engine understands likely reading intent rather than demanding verbatim speech. It should distinguish:

- a minor recognition error from a genuine script mismatch;
- a conversational paraphrase from an unrelated ad-lib;
- skipped filler from skipped meaning;
- a self-correction from a backward navigation request;
- a sentence restart from a quotation of an earlier phrase;
- an ordinary sequential section boundary from an implausible jump to a distant section;
- a critical omission such as a number or negation from an inconsequential wording variation.

---

## 2. Enhancement goals

### 2.1 Primary goals

1. Make normal voice following appear continuously paced rather than event-driven.
2. Keep the next line naturally available when the presenter reaches the end of the current line.
3. Tolerate slight off-script delivery without freezing unnecessarily.
4. Slow down safely when position confidence falls.
5. Catch up smoothly after the engine obtains stronger evidence.
6. Detect and follow natural retakes, including a presenter returning to a sentence or recent paragraph.
7. Apply a strong forward bias without making backward motion impossible.
8. Prohibit uncommanded jumps to unrelated or non-contiguous sections.
9. Use Luna where semantic interpretation adds value without putting an LLM in the frame-critical control loop.
10. Optionally surface concise, non-distracting delivery or script-fidelity tips.
11. Make every important behavior measurable in deterministic playback tests.

### 2.2 Secondary goals

- Learn a stable pace profile during a session without requiring calibration.
- Adapt to different speaking rates, punctuation styles, font sizes, line widths, and display refresh rates.
- Keep the stage readable during network latency, incomplete Luna responses, and Realtime reconnection.
- Let advanced users choose a calmer or more responsive follow feel without exposing raw control-system parameters.
- Collect local, privacy-respecting diagnostics that make tracking defects reproducible.

### 2.3 Non-goals

This enhancement does not add:

- eye tracking;
- camera-based gaze estimation;
- automatic script rewriting;
- an AI speaking coach that converses with the presenter;
- generated commentary while the presenter is talking;
- autonomous navigation to any arbitrary section inferred from semantic similarity alone;
- cloud training on user scripts or recordings;
- audio storage by default;
- a guarantee that every paraphrase can be matched without ambiguity.

---

## 3. Non-negotiable experience contract

### 3.1 Continuous-motion contract

During a confident ordinary read, the stage must update motion on every animation frame. New transcript evidence adjusts the estimated trajectory; it does not directly command a pixel jump.

The stage must never wait motionless for each finalized utterance and then scroll to the next matched sentence. A temporary hold is valid only when the state machine intentionally chooses to hold.

### 3.2 Line-handoff contract

At the end of a rendered line, the next line must already be positioned at the same comfortable visual entry area that the previous line occupied near its beginning. The target trajectory must be continuous across the line boundary.

There must not be a line-end “step” caused by changing the target from one line element to the next.

### 3.3 Conservative-location contract

The system may be slightly behind or temporarily held. It must not confidently display the wrong remote passage.

In ordinary voice-follow mode:

- small forward progression is expected;
- moderate skips within the active section are possible;
- short backward retakes are possible;
- sequential movement into the next section is possible when reading reaches the boundary;
- a non-contiguous jump to another section is impossible without command or manual authority.

### 3.4 Retake contract

When the presenter clearly restarts a recent sentence or paragraph, CandidCue must follow them back. It must not remain irreversibly biased forward.

Backward movement requires stronger evidence than forward movement and must use hysteresis so that repeated wording cannot make the stage bounce between two locations.

### 3.5 Uncertainty contract

When evidence degrades:

1. coast briefly using the recent pace estimate;
2. reduce velocity smoothly;
3. hold if uncertainty persists;
4. keep collecting local and semantic evidence;
5. resume or re-anchor only when an allowed candidate has sufficient support.

The engine must not continue scrolling indefinitely on a stale pace estimate.

### 3.6 LLM authority contract

Luna may:

- classify the relationship between recent speech and supplied script candidates;
- identify paraphrase coverage;
- distinguish ad-lib, correction, restart, and return-to-script behavior;
- contribute a bounded confidence adjustment;
- propose a structured coach-tip code.

Luna may not:

- return an unrestricted token index;
- search the entire script on every call;
- authorize a non-contiguous section jump;
- override a command collision rule;
- directly set scroll position, velocity, or acceleration;
- make an irreversible change from provisional speech alone;
- generate arbitrary stage text.

### 3.7 Stage-calm contract

No diagnostic score, alignment candidate, raw transcript, API status, or verbose coaching message may appear on the stage during ordinary use. Optional coaching is a single concise strip in a reserved safe area and follows strict rate limits.

---

## 4. User-visible behavior

### 4.1 Normal reading

The presenter begins speaking. Once the engine acquires the script, text starts moving gently at the estimated pace. The active line gradually travels upward by approximately the distance to the next line while the presenter reads across it. When the speaker reaches the final words, the next line is already at the preferred starting height.

The presenter should perceive one coherent flow, not a cursor chasing recognized words.

### 4.2 A slight off-script phrase

Example:

Script:

> Today I want to show you the simplest way to organize a product launch.

Spoken:

> Today I’m going to show you a really simple way to organize your product launch.

The local matcher should retain a strong hypothesis because the content words, order, and phonetic anchors agree. Luna may classify the delivery as a paraphrase of the current sentence. Motion continues at a reduced-confidence pace rather than freezing. Once later anchors confirm the sentence, the committed cursor advances normally.

### 4.3 A longer ad-lib

The presenter leaves the script to add an example. Local lexical support drops. The stage coasts very briefly, then decelerates and holds with the next scripted material still visible. It does not consume script tokens merely because speech continues.

When the presenter returns to a recognizable phrase near the current position, the engine resumes smoothly.

### 4.4 A small forward skip

The presenter omits one clause and starts the next sentence. The engine identifies a later local candidate. If the visual correction is small, it is absorbed by modestly increasing scroll speed for a short period. The stage does not flash, snap, or visibly race.

### 4.5 A large forward skip inside the section

The presenter jumps several paragraphs forward within the current section. The engine initially slows because the local path has failed. A later phrase provides strong distinctive anchors. Once final and semantic evidence agree, CandidCue re-anchors to the destination using the large-correction transition. It does not scroll rapidly through the skipped paragraphs.

### 4.6 An apparent jump to another section

The presenter says a phrase that also exists in a distant chapter. The distant candidate may appear in diagnostics, but it is ineligible. The stage remains in the current section unless:

- the presenter has read sequentially to the next section boundary;
- a wake-gated command selects the other section; or
- the user manually navigates there.

### 4.7 A sentence retake

The presenter reaches the next sentence, stops, and repeats the opening of the previous sentence. The retake hypothesis accumulates evidence. Once committed, the semantic cursor moves backward and the stage reverses gently if the destination is nearby. Passed styling is restored from the destination onward.

### 4.8 A distant retake

The presenter restarts a paragraph that is no longer comfortably visible. CandidCue does not reverse-scroll through a large distance. It decelerates, performs a brief re-anchor transition to the paragraph, and resumes forward motion from there.

### 4.9 A transcription correction

A provisional transcript initially matches the wrong nearby phrase, then the completed event corrects it. The semantic filter treats provisional evidence as a noisy measurement. The stage may drift slightly but must not visibly reverse twice. The final correction is absorbed into the trajectory within bounded error.

---

# Part II — Conceptual and mathematical model

## 5. Separate coordinate systems

The implementation must keep the following coordinates separate.

### 5.1 Integer script token index

`tokenIndex` identifies a compiled spoken token in the canonical script. It is stable for one compiled revision.

### 5.2 Continuous semantic position

`scriptPosition` is a floating-point position in token space. For example, `125.4` means the estimated delivery point is partway between token 125 and token 126.

This is the primary state used for smooth prediction.

### 5.3 Committed semantic position

`committedPosition` is the latest position supported by finalized evidence and transition rules. It changes conservatively.

### 5.4 Provisional semantic measurement

`provisionalMeasurement` is a lower-trust position inferred from partial transcript text. It may influence the filter within bounded limits but does not redefine history.

### 5.5 Semantic velocity

`semanticVelocity` is the estimated speaking progress in weighted script units per second. It is not identical to raw words per minute.

### 5.6 Rendered document coordinate

`documentY(position)` maps a semantic position to a vertical coordinate in the laid-out stage document. Because several tokens share a line, this mapping is piecewise and uses line progress rather than merely token-top interpolation.

### 5.7 Stage scroll coordinate

`scrollPosition` is the actual translation or scroll offset rendered by the stage.

### 5.8 Desired visual trajectory

`targetScroll(t)` is the smooth position the motion controller is trying to follow at time `t`. It is derived from predicted semantic progress, line geometry, reading-band geometry, and transition mode.

### 5.9 Motion state

The stage maintains:

- position `q` in pixels;
- velocity `v` in pixels per second;
- acceleration `a` in pixels per second squared;
- optional estimated jerk for diagnostics;
- current transition class;
- target position and feed-forward velocity.

A transcript event must never write `q` directly during ordinary following.

---

## 6. Weighted speech units

Raw token count is an inadequate pace coordinate. “A” and “internationalization” are both one token but do not take the same delivery time. Punctuation also changes timing.

Each spoken token receives a positive `speechWeight`. The compiler produces a cumulative coordinate:

```text
speechUnit[0] = 0
speechUnit[i + 1] = speechUnit[i] + speechWeight[i]
```

The continuous semantic filter may operate in speech-unit space and map back to token space.

### 6.1 Initial token weighting

Use a deterministic, language-aware starting model:

- short function word: approximately `0.65–0.85` units;
- ordinary word: approximately `1.0` unit;
- long or multi-syllable word: `1.1–1.8` units;
- comma or light clause boundary: virtual pause weight;
- sentence-ending punctuation: larger virtual pause weight;
- explicit pause directive: authored duration or weight;
- non-spoken Markdown and cue content: zero spoken weight.

The exact formula is tunable. Prefer an inexpensive pronunciation or syllable estimate when available; otherwise use clamped character-length and word-class heuristics.

### 6.2 Why punctuation belongs in the pace model

A sentence ending should allow the predicted trajectory to slow without requiring the transcript aligner to interpret silence as loss. Punctuation weights are not commitments to exact pause duration; they are priors that are adapted by observed delivery.

### 6.3 User-specific adaptation

During a session, estimate separate scaling factors for:

- ordinary words;
- long words;
- commas and clause boundaries;
- sentence boundaries;
- authored pauses.

Do not attempt a complex personalized model before enough evidence exists. The initial release may adapt only a global speech-unit rate plus a pause factor.

---

## 7. Rendered line map

After fonts, margins, images, directives, and stage scaling are final, the stage must build an immutable `RenderedLineMap` for the active layout generation.

```ts
interface RenderedLine {
  lineId: string;
  blockId: string;
  sectionId: string;
  firstTokenIndex: number;
  lastTokenIndex: number;
  spokenUnitStart: number;
  spokenUnitEnd: number;
  topY: number;
  baselineY: number;
  bottomY: number;
  nextBaselineY: number | null;
  visibleTextWidthPx: number;
  tokenStops: RenderedTokenStop[];
  startsParagraph: boolean;
  endsParagraph: boolean;
  startsSection: boolean;
  endsSection: boolean;
}

interface RenderedTokenStop {
  tokenIndex: number;
  spokenUnit: number;
  xStart: number;
  xEnd: number;
  visualFractionStart: number;
  visualFractionEnd: number;
}

interface LineMotionKnot {
  lineId: string;
  spokenUnit: number;
  scrollPx: number;
  slopePxPerUnit: number;
  boundaryKind: 'ordinary' | 'paragraph' | 'visual_block' | 'section';
}

interface LineMotionSample {
  scrollPx: number;
  derivativePxPerUnit: number;
  lineId: string | null;
  lineProgress: number;
}

interface RenderedLineMap {
  generation: number;
  lines: RenderedLine[];
  motionKnots: LineMotionKnot[];
  sampleMotionPath(spokenUnit: number): LineMotionSample | null;
}
```

### 7.1 Obtaining actual line boxes

Do not infer line wrapping from character counts. The stage must measure the rendered text.

Acceptable implementation strategies include:

- rendering spoken token spans and grouping them by measured baseline/top within a tolerance;
- using `Range.getClientRects()` over tokenized spans;
- a layout measurement pass that records token rects after `document.fonts.ready` and all layout-affecting assets are resolved.

Use a hidden or offscreen measurement layer only if it is guaranteed to share identical typography and width with the visible layer.

### 7.2 Layout generation

Every map is tagged with:

- script compile hash;
- stage generation;
- layout generation;
- display scale factor;
- viewport size;
- font family and loaded font hash where applicable;
- font size, line height, margins, mirror state, cue layout, and Listener geometry.

Snapshots referencing an old layout generation must not drive the new map.

### 7.3 Images, tables, and diagrams

Visual blocks create vertical distance without spoken tokens. The compiler and line map must define how voice following passes them:

- an image anchored between spoken blocks remains visible according to authored layout rules;
- the transition from the last spoken line before a visual block to the first spoken line after it may use a visual-block trajectory rather than one-line interpolation;
- the engine must not continuously crawl across a very tall image solely because speech units advanced slightly;
- authored `hold`, `show`, or cue directives take precedence;
- a large visual block may be treated as a discrete layout boundary requiring a gentle re-anchor.

---

## 8. The line-handoff trajectory

The defining visual algorithm is a continuous semantic-to-scroll path whose line-start knots all place the relevant line at the same comfortable reading position.

For rendered line `i`, define:

- `U_i` as the spoken-unit coordinate at the start of the line;
- `B_i` as the line baseline in document coordinates;
- `R` as the preferred line-entry baseline in viewport coordinates;
- `Y_i = B_i - R` as the scroll offset that places line `i` at the reading position.

The trajectory must pass through every knot `(U_i, Y_i)`. Therefore, when semantic progress reaches the start of the next line, that line is already at `R`.

### 8.1 Conceptual segment equation

For one line interval, let:

- `L` be the current rendered line;
- `B_L` be its document baseline;
- `B_N` be the next line’s document baseline;
- `p` be progress from the current line start to the next line start, in `[0, 1]`.

The minimum position-continuous equation is:

```text
targetScroll = B_L - R + H(p) × (B_N - B_L)
```

with:

```text
H(0) = 0
H(1) = 1
```

At `p = 1`:

```text
targetScroll = B_N - R
```

which is exactly the target at the beginning of the next line. Changing the active line therefore creates no position step.

This equation explains the required experience, but independent per-line easing curves can still create a target-velocity change when adjacent lines contain different amounts of speech. Production Voice Follow must therefore build the shared-slope path in Section 8.2.

### 8.2 Production path: monotone cubic line spline

Build a piecewise monotone cubic Hermite path `S(u)` through the ordered line-start knots `(U_i, Y_i)`.

For interval `i`:

```text
h = U_(i+1) - U_i
t = clamp((u - U_i) / h, 0, 1)
```

and:

```text
S_i(u) = ( 2t³ - 3t² + 1)Y_i
       + ( t³ - 2t² + t)h m_i
       + (-2t³ + 3t²    )Y_(i+1)
       + ( t³ - t²      )h m_(i+1)
```

where `m_i` and `m_(i+1)` are the shared slopes at the two knots in pixels per spoken unit.

Choose knot slopes with a monotonicity-preserving method such as the Fritsch–Carlson/PCHIP family:

1. calculate each secant slope `d_i = (Y_(i+1) - Y_i) / (U_(i+1) - U_i)`;
2. derive each interior `m_i` from its adjacent secants using a weighted harmonic mean when both have the same sign;
3. set `m_i = 0` at a genuine hold/discontinuity boundary;
4. clamp endpoint and interior slopes so the cubic cannot overshoot or reverse;
5. apply visual-velocity limits around paragraph and media gaps.

The exact monotone-cubic routine may come from a small audited implementation rather than custom algebra, but its behavior must be covered by deterministic tests.

This path provides:

- exact target-position continuity at every line start;
- a shared first derivative at every ordinary line boundary;
- no overshoot between line knots;
- an analytic derivative `S′(u)` for feed-forward velocity;
- a calm response when adjacent rendered lines contain different numbers of words.

The path is normally `C1` continuous. The stage controller’s explicit jerk limit smooths the remaining target-acceleration changes so actual rendered acceleration does not kick at a knot. A monotone `C2` path may be evaluated later, but it is not required if the measured motion gates pass.

### 8.3 Line semantic coordinate

Use cumulative spoken units, not equal token fractions, to locate `u`. The compiler and line map must ensure that ordinary spoken lines have strictly increasing line-start coordinates.

For a simple fallback interval `[u0, u1]`:

```text
p = clamp((predictedUnit - u0) / max(u1 - u0, epsilon), 0, 1)
```

Measured token stops may refine progress inside the line so a very long final word does not collapse into an abrupt final movement.

Lines containing no spoken units do not create zero-length spline intervals. Treat their vertical contribution as authored layout between neighboring spoken knots, a visual-block transition, or a virtual pause interval.

### 8.4 Near-linear feel

Do not make every line visibly ease in and out. The monotone path should remain close to its secant line unless adjacent slopes require gentle blending.

For a diagnostic or fallback path, a low-strength smoothstep blend is acceptable:

```text
H(p) = mix(p, p²(3 - 2p), handoffSoftness)
```

This fallback does not replace the production shared-slope path.

### 8.5 Paragraph spacing

A paragraph break may create a larger `Y` delta. Do not force the same speech-rate mapping to race across decorative whitespace.

Use one or more of:

- punctuation/pause speech weight before the next knot;
- virtual intermediate knots;
- a clamped paragraph-gap slope;
- a short boundary profile that distributes the gap without violating monotonicity.

The target must remain position-continuous, and ordinary paragraph transitions must not require a visual re-anchor.

### 8.6 Images, tables, and large visual gaps

Large non-spoken blocks may not be suitable for the ordinary line spline. The line-map builder marks these boundaries explicitly.

Depending on the authored directive and block size:

- insert virtual semantic duration so the visual can remain on screen;
- hold the trajectory;
- use a dedicated visual-block transition;
- perform a gentle re-anchor to the next spoken block.

Never crawl through a full-screen image merely because one semantic unit advanced, and never let a media block create an unbounded spline slope.

### 8.7 First and last lines

Use a clamped one-sided tangent for the first knot. For the final spoken line, create a virtual next knot from ordinary line pitch plus end padding, then clamp document-end exposure so the final line can complete in the reading area without revealing an empty screen.

The tangent at the start of the final spoken line should prefer the final
interval's secant, subject to the ordinary monotonicity and slope limits. This
makes a short closing line traverse at a steady pace and moves the necessary
acceleration into the preceding line, instead of reaching peak speed as the
script ends.

### 8.8 Reading-area customization

The user-facing reading-position setting controls `R`, not a point to which each transcript event snaps. Default `R` should be calibrated around the existing reading band, approximately the upper-middle portion of the safe viewport.

### 8.9 Required invariants

For every ordinary boundary between line `i` and `i + 1`:

```text
S(U_(i+1)^-) = S(U_(i+1)^+) = Y_(i+1)
S′(U_(i+1)^-) ≈ S′(U_(i+1)^+)
```

The position equality is exact within floating-point and measurement tolerance. The derivative equality must hold within the spline implementation’s numerical tolerance before state-specific velocity clamps are applied.

### 8.10 Why this model is required

A fixed-anchor model repeatedly pulls the recognized phrase back to one Y coordinate. A collection of independent smooth-scroll animations still restarts velocity after every event. The line spline instead defines one continuous document path, while the semantic filter determines how quickly the presenter moves along it. The eyes can finish the current line and transfer to the next line without a wrap bump, target-velocity step, or transcript-triggered animation restart.

## 9. Timing model and clocks

### 9.1 Session time

All tracking events must carry a monotonically increasing session-relative timestamp. Do not base ordering on wall-clock time alone.

The coordinator defines `sessionTimeMs = 0` at session start. Transport, transcript, worker, Luna, and stage payloads use this time domain or include a verified conversion.

### 9.2 Important timestamps

Track, where available:

- audio buffer start and end;
- local VAD speech start and end;
- commit time;
- transcript delta receipt;
- transcript completion receipt;
- alignment measurement generation;
- Luna request and response time;
- semantic frame generation;
- stage frame receipt;
- rendered frame time.

### 9.3 Do not require word timestamps

The algorithm must work when the transcription service does not provide reliable word-level audio timestamps. It may use utterance boundaries, local VAD timing, receipt timing, and the matched token span to estimate progress.

If a future model supplies stable word timestamps, expose them through the provider-neutral event model as optional evidence.

### 9.4 Latency estimate

Maintain a robust estimate of end-to-end evidence delay. Use it only to compute bounded look-ahead. Do not subtract a fixed assumed latency from every event.

---

# Part III — Alignment engine v2

## 10. Alignment overview

The original weighted local sequence alignment remains useful, but one winning candidate per update is insufficient. The enhanced aligner maintains a compact set of plausible trajectories.

Treat script position as a latent state observed through noisy transcript tokens. The implementation should combine:

- banded weighted local sequence alignment;
- a beam or particle-like set of hypotheses;
- explicit transition priors;
- a current-section eligibility graph;
- provisional/final measurement quality;
- optional Luna semantic evidence;
- hysteresis and authority rules.

The implementation need not reproduce a textbook HMM, DTW, or particle filter exactly. It must expose equivalent concepts clearly enough to test: hypotheses, transitions, emissions/evidence, normalization, pruning, and confidence margin.

## 11. Alignment hypothesis

```ts
interface AlignmentHypothesis {
  id: string;
  lineageId: string;
  sectionId: string;
  tokenPosition: number;
  spokenUnitPosition: number;
  velocityUnitsPerSecond: number;
  mode: 'following' | 'holding' | 'adlib' | 'skip' | 'retake' | 'boundary';
  logScore: number;
  lexicalScore: number;
  phoneticScore: number;
  sequenceScore: number;
  semanticScore: number;
  continuityPrior: number;
  authority: 'ordinary' | 'manual' | 'command';
  evidenceItemIds: string[];
  matchedTokenIndexes: number[];
  lastStrongAnchorAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}
```

Maintain a small bounded beam, initially around 8–16 hypotheses. More hypotheses are not automatically better; tune from ambiguity accuracy and worker cost.

## 12. Candidate scopes

Generate candidates in this priority order.

### 12.1 Continuity corridor

A narrow window around predicted position, adjusted for observed pace and elapsed time.

### 12.2 Current sentence and nearby sentence starts

Include the current sentence start, next sentence starts, and recent sentence starts behind the cursor for restarts.

### 12.3 Current paragraph and recent paragraph starts

Paragraph openings are strong retake anchors.

### 12.4 Current section

Search the active section for rare tokens and ordered n-grams when local evidence fails.

### 12.5 Sequential section boundary corridor

When the committed cursor is near the end of the current section, include the opening of the immediately following section. When a recent retake is plausible near the start, include a bounded tail of the immediately previous section.

### 12.6 Authority-supplied destination

A validated command or manual action may supply an arbitrary section or target. This creates an authoritative hypothesis and resets ordinary eligibility around it.

### 12.7 Prohibited candidate scope

Do not generate ordinary executable hypotheses in unrelated sections. A diagnostic search may note that text resembles a distant passage, but that result is not eligible for automatic movement.

## 13. Script eligibility graph

Compile an explicit graph of allowed ordinary transitions.

Nodes are sections and optionally subsection units. Edges include:

- remain in current section;
- advance sequentially to the immediate next section when near its boundary;
- retake into the immediately previous section only within a recent-boundary window;
- command/manual edge to any valid target.

A candidate whose transition has no allowed edge receives probability zero, not merely a large penalty.

### 13.1 Definition of a non-contiguous section jump

A jump is non-contiguous when the candidate is in:

- neither the current section;
- nor the immediate next section while progressing through the current end boundary;
- nor the immediate previous section during a recent boundary retake;
- nor an authority-supplied target.

Such a jump is prohibited even if a distinctive phrase matches perfectly.

### 13.2 Sequential heading behavior

Headings themselves may be non-spoken. The engine may cross them when the last spoken tokens before the heading and the first spoken tokens after it form a contiguous reading path. It must not require the heading text to be spoken unless the document marks it as spoken.

## 14. Transcript normalization and token features

For every transcript token, derive:

- original text;
- lowercase Unicode-normalized form;
- punctuation-stripped form;
- deterministic number/date/currency normalization;
- contraction expansion alternatives;
- possessive and simple morphological alternatives;
- phonetic key where supported;
- likely script aliases;
- model confidence/log probability where available;
- provisional or final status;
- item ID and timing;
- command masking disposition.

### 14.1 Number equivalence

Treat forms such as the following as potential equivalents when context agrees:

- `twenty five` ↔ `25`;
- `five percent` ↔ `5%`;
- `two thousand and twenty-six` ↔ `2026`;
- currency names and symbols;
- ordinal words and numerals.

Do not collapse all numeric differences. A wrong number is often a critical fidelity issue even when the general sentence matches.

### 14.2 Proper nouns and unusual terms

Script preparation should create aliases for unusual names, products, acronyms, and technical terms. Sources may include:

- user dictionary entries;
- deterministic acronym expansion;
- known pronunciation dictionary results;
- Luna preparation analysis;
- aliases observed during microphone test;
- user corrections.

Aliases aid CandidCue’s local matcher whether or not the Realtime transcription endpoint accepts prompt vocabulary.

### 14.3 Stopwords and content weights

Common words contribute little to global distinction. Compute script-local inverse frequency and combine it with a language stopword weight. Preserve function words that change meaning, especially negation.

Example categories:

- rare product name: very high anchor weight;
- ordinary noun or verb: medium-high;
- pronoun/article: low;
- negation: high fidelity weight despite commonness;
- number/date: high fidelity weight;
- repeated boilerplate phrase: low global-distinction weight.

### 14.4 Compiled candidate indexes

Build candidate indexes once per compiled script revision. Ordinary transcript updates must not scan the full document.

Required indexes:

- normalized token and alias inverted index;
- phonetic-key index for unusual and content-heavy words;
- rare ordered bigram, trigram, and configurable n-gram index;
- sentence-start and paragraph-start anchor index;
- section-local number, date, currency, negation, and proper-noun index;
- repetition index with global and section-local distinctiveness;
- recently visited span ring buffer;
- direct mapping from every index result to hard section ID and spoken-unit range.

Candidate retrieval combines several weak signals rather than trusting one nearest string. The candidate generator should be able to explain which indexes admitted each span.

### 14.5 Optional Luna semantic landmark preparation

When Intelligent Assist is enabled, CandidCue may create a cached semantic landmark index during script preparation. This is a preparation-time optimization, not a requirement for Local-only operation.

The local compiler first chooses immutable sentence or short-paragraph spans and assigns opaque IDs. Luna may annotate those supplied spans with structured fields such as:

- a concise proposition or “what this passage means” label;
- critical facts, names, numbers, and negations that must not be lost;
- likely conversational equivalents;
- likely pronunciation/transcription aliases for unusual terms;
- whether the span is safe to paraphrase or should remain exact;
- a compact topic label used only for current-section retrieval.

Luna must not invent boundaries or token positions. Local code owns the span IDs and verifies every returned ID. Cache the resulting artifact by script compile hash, preparation schema version, language, and model snapshot/capability identifier.

A semantic landmark is retrieval metadata, not evidence that the presenter has spoken the passage.

```ts
interface SemanticLandmark {
  schemaVersion: 1;
  spanId: string;
  sectionId: string;
  tokenStart: number;
  tokenEnd: number;
  unitStart: number;
  unitEnd: number;
  proposition: string;
  topicLabels: string[];
  criticalTerms: Array<{
    kind: 'name' | 'number' | 'negation' | 'date' | 'currency' | 'meaning';
    canonical: string;
  }>;
  conversationalAliases: string[];
  exactness: 'flexible' | 'balanced' | 'exact';
}
```

### 14.6 Hierarchical current-section map

For a long section, create two levels:

1. paragraph or scene landmarks;
2. sentence/short-span landmarks inside each paragraph.

A semantic recovery request may first identify one or two eligible paragraphs and then rank exact spans inside those paragraphs. All levels remain inside the current hard section or the specifically allowed adjacent-boundary corridor.

Do not create a global semantic map that can silently authorize remote navigation. Global preparation data may exist for search or manual controls, but ordinary tracking queries it only after section eligibility has already narrowed the scope.

### 14.7 Preparation transparency and fallback

The Preflight UI should state that Intelligent Assist may send script excerpts to Luna to improve paraphrase matching. Preparation must:

- be cancellable;
- show progress for long scripts;
- reuse a valid cached result;
- fail non-destructively;
- leave deterministic indexes available;
- avoid blocking Live when preparation is skipped.


## 15. Weighted local alignment

For each transcript tail and candidate window, run a banded local or semi-global alignment that supports:

- exact matches;
- aliases and deterministic equivalents;
- phonetic substitutions;
- fuzzy lexical substitutions;
- transcript insertions;
- script omissions;
- bounded phrase reordering only where explicitly justified;
- order-preserving content runs;
- provisional token uncertainty.

### 15.1 Starting scoring profile

Illustrative values only:

| Evidence | Score contribution |
|---|---:|
| Exact distinctive token | `+3.0 × tokenWeight` |
| Exact common token | `+0.4–1.0` |
| Explicit alias | `+2.6 × tokenWeight` |
| Deterministic number/contraction equivalent | `+2.4 × tokenWeight` |
| Strong phonetic match | `+1.4–2.0 × tokenWeight` |
| High edit similarity on a long token | `+1.2–1.8 × tokenWeight` |
| Transcript insertion/ad-lib token | `−0.2–0.7` |
| Script omission | `−0.5–1.2`, depending on criticality |
| Contradictory number/negation | strong penalty |
| Out-of-order content run | strong penalty |

### 15.2 Match windows

Use multiple transcript tails rather than one fixed length, for example:

- short tail: fast local response;
- medium tail: ambiguity resolution;
- longer finalized tail: retake or reacquisition.

Combine results without triple-counting the same evidence.

### 15.3 Provisional evidence

Provisional tokens receive lower measurement weight and a bounded forward influence. They may update pace and visual lead but may not:

- commit a large skip;
- commit a backward retake;
- cross a section boundary except by ordinary contiguous progression already supported by final history;
- trigger a fidelity tip;
- clear passed history.

## 16. Hypothesis transition model

At each transcript update:

1. predict each surviving hypothesis forward using its recent pace and elapsed speech time;
2. generate candidate windows around predictions and eligible anchors;
3. score transcript evidence against each window;
4. create or update following, holding, skip, and retake branches;
5. incorporate bounded semantic sidecar evidence when available;
6. apply hard eligibility gates;
7. normalize scores;
8. merge near-identical hypotheses;
9. prune the beam;
10. derive a measurement distribution rather than only one token index.

### 16.1 Forward prior

The highest prior belongs to small forward movement consistent with the pace estimate. The prior decays with unexpected distance.

### 16.2 Hold/ad-lib prior

Remaining near the same script position while speech contains insertions is plausible. This branch prevents continuous speech from automatically consuming script.

### 16.3 Skip prior

A forward skip inside the section is plausible when multiple distinctive anchors support it. The prior is lower than continuity but far above an uncommanded remote section transition.

### 16.4 Retake prior

A short move backward to a recent sentence or paragraph start is plausible after:

- a silence;
- restart language;
- repeated opening words;
- a trailing false start;
- a strong match to a visited span.

The prior falls quickly with distance and section separation.

### 16.5 Hysteresis

Once a hypothesis becomes active, a competitor must beat it by a movement-specific margin for a sustained evidence interval. Retake and large-skip transitions require more persistence than ordinary forward movement.

### 16.6 Measurement output

The aligner outputs:

```ts
interface AlignmentMeasurement {
  revision: number;
  sessionTimeMs: number;
  bestPosition: number;
  committedCandidatePosition: number | null;
  positionVariance: number;
  confidence: number;
  secondBestMargin: number;
  state: TrackingStateV2;
  behavior: TrackingBehavior;
  sectionId: string;
  finalEvidence: boolean;
  sourceItemIds: string[];
  hypotheses: AlignmentHypothesisSummary[];
  semanticAssistId?: string;
  transitionProposal?: TransitionProposal;
}
```

Position variance is important. Two close hypotheses should produce less concern than two equally likely candidates several paragraphs apart.

## 17. Tracking states

Use explicit states with entry, output, and exit behavior.

```text
ACQUIRING
FOLLOWING
COASTING
UNCERTAIN
ADLIB_HOLD
CATCHING_UP
RETAKE_PENDING
REWINDING
REANCHORING
COMMAND_PENDING
PAUSED
RECONNECTING
LOST_LOCAL
```

### 17.1 ACQUIRING

The session has started but no position has adequate evidence. Stage remains at the manual/start position. A strong local match establishes the initial state. Starting from a user-selected target narrows acquisition.

### 17.2 FOLLOWING

Evidence supports ordinary progression. Pace prediction and line handoff are active.

### 17.3 COASTING

Fresh evidence is briefly absent, but recent speech and pace support a short prediction horizon. Velocity continues with a decay schedule.

### 17.4 UNCERTAIN

Several local hypotheses compete or transcript quality is weak. Target influence is reduced and motion slows.

### 17.5 ADLIB_HOLD

Speech continues but appears off-script. Semantic position remains near the last credible point. Motion settles to zero or a tiny safe drift.

### 17.6 CATCHING_UP

A valid forward candidate is ahead of the current visual trajectory. The controller uses bounded additional velocity to reduce error.

### 17.7 RETAKE_PENDING

A backward candidate exists but lacks sufficient final evidence or margin. Forward velocity decays; the stage does not reverse yet.

### 17.8 REWINDING

A nearby retake is committed. The semantic trajectory moves backward under reverse-motion limits.

### 17.9 REANCHORING

A large valid correction cannot be comfortably traversed. Stage performs the controlled re-anchor transition.

### 17.10 LOST_LOCAL

No eligible candidate is credible. Search remains restricted to the current section and allowed boundary corridor. Stage holds. Control may offer manual candidate buttons.

### 17.11 COMMAND_PENDING, PAUSED, RECONNECTING

Retain the primary specification behavior, but the stage must preserve motion state so it can stop and resume cleanly.

---

# Part IV — Off-script speech, skips, and retakes

## 18. Slightly off-script delivery

The engine should remain useful when the presenter changes small words, contractions, syntax, or conversational framing.

### 18.1 Three levels of divergence

#### Lexical variation

Most content and order match; several words differ. Handle locally without Luna when possible.

#### Semantic paraphrase

The sentence meaning and local context match, but lexical overlap is insufficient. Luna may supply bounded evidence over local candidates.

#### Ad-lib

The speech adds material not represented by the script. Hold script progress until the presenter returns.

### 18.2 Local paraphrase indicators

Before calling Luna, derive inexpensive indicators:

- content-word overlap;
- shared proper nouns/numbers;
- ordered anchor subsequence;
- edit distance at phrase level;
- same sentence neighbors before and after;
- transcript insertion ratio;
- candidate score distribution;
- duration of divergence.

### 18.3 Advancing through a paraphrase

A paraphrase may advance semantic progress only when:

- candidate span is inside the eligibility graph;
- local evidence identifies a small candidate set;
- Luna selects one supplied candidate with sufficient confidence, or deterministic evidence alone is strong;
- later lexical anchors do not contradict it;
- the proposed advancement is limited to the candidate span;
- the influence is introduced as a noisy measurement, not a direct jump.

### 18.4 Do not over-credit semantics

A generic utterance such as “This is really important” may be semantically compatible with many passages. Luna must be given candidate IDs and allowed to return `unresolved`. Semantic similarity without distinctive local context is not position evidence.

## 19. Ad-lib handling

### 19.1 Entry

Enter `ADLIB_HOLD` when:

- speech is present;
- local alignment remains weak beyond a grace period;
- the best position remains near the previous cursor rather than forming a credible skip;
- command routing has not consumed the phrase;
- optional Luna evidence indicates ad-lib or unresolved speech.

### 19.2 Motion schedule

Starting defaults:

1. continue current motion for approximately `150–250 ms` if confidence had been high;
2. decay toward roughly `30–45%` of current velocity over the next `250–450 ms`;
3. settle toward zero by approximately `700–1,100 ms` after loss of credible progress;
4. never coast beyond a configurable maximum semantic distance, initially less than one line.

Tune from user tests. The important requirement is a graceful slowdown with a strict runaway limit.

### 19.3 Return to script

Prefer candidates near or ahead of the held cursor. A strong ordered anchor run returns to `FOLLOWING`. A valid later candidate inside the current section may enter `CATCHING_UP` or `REANCHORING`.

## 20. Forward skips

### 20.1 Small omission

If the corrected target differs by less than approximately one rendered line, absorb it through the semantic filter and ordinary controller. Do not label it a jump.

### 20.2 Medium skip

For a correction of approximately one to three lines:

- enter `CATCHING_UP`;
- preserve forward direction;
- cap speed at a comfortable multiple of estimated normal scroll velocity;
- cap acceleration and jerk;
- end catch-up before the active phrase overtakes the preferred reading area;
- return to ordinary following once visual error enters the deadband.

### 20.3 Large skip

For a correction beyond the comfortable traversal threshold:

1. require final transcript evidence;
2. require a strong candidate margin and distinctive anchors;
3. require eligibility within the current section or sequential boundary;
4. decelerate briefly;
5. use the re-anchor transition;
6. preserve context by showing the destination line and at least one following line;
7. resume motion from the corrected pace estimate.

### 20.4 Re-anchor visual design

Use one tested design consistently. Recommended starting design:

- 90–130 ms fade-down or subtle blur/focus reduction;
- change the document transform while obscured;
- 90–130 ms fade-up;
- no white flash;
- no long travel animation;
- no large “jumped” label on stage;
- optional brief destination acknowledgement only for explicit commands, not automatic reacquisition.

Respect reduced motion with a near-instant opacity transition.

## 21. Retake detection

A retake is an intentional restart of recently delivered text, not any backward lexical match.

### 21.1 Evidence features

Positive retake evidence includes:

- repeated beginning of the current or recent sentence;
- repeated paragraph opening;
- strong match behind the cursor within the active section;
- a pause before the repetition;
- a false-start ending;
- local language such as “again,” “let me say that again,” “sorry,” or “from the top,” when not wake-gated as a command;
- the destination was visited recently;
- the match starts near a semantic boundary;
- Luna classifies the relation as restart or correction.

Negative evidence includes:

- the phrase is a common quotation repeated later in the script;
- later transcript words support the forward candidate;
- destination is in an unrelated section;
- only one or two generic words match;
- evidence is provisional only;
- the speaker is reading a deliberate repeated refrain at the current forward location.

### 21.2 Retake thresholds by distance

Use increasing evidence requirements:

- within current sentence: moderate threshold;
- previous sentence: high threshold;
- recent paragraph: very high threshold plus boundary evidence;
- previous section near a just-crossed boundary: very high threshold;
- unrelated/distant section: prohibited without authority.

### 21.3 Retake persistence

A backward proposal must remain best across either:

- a minimum number of finalized meaningful tokens; or
- a minimum time interval with stable evidence;

unless explicit local restart language and a highly distinctive phrase make the intent unambiguous.

### 21.4 Retake lock

After committing a retake:

- create a retake epoch;
- suppress the old forward hypothesis unless new speech strongly supports it;
- require sustained evidence to move past the prior high-water mark;
- do not let delayed completion events from the previous utterance pull the cursor forward;
- clear provisional evidence predating the retake boundary where appropriate.

## 22. Backward visual behavior

### 22.1 Nearby retake

If the destination is inside the configured reverse-travel range and the required text is already rendered:

1. decelerate forward velocity to zero;
2. reverse under a lower speed cap than ordinary forward catch-up;
3. track a backward trajectory to the destination;
4. settle with the destination line in its line-start reading area;
5. resume forward line handoff from the new retake epoch.

### 22.2 Distant retake

If reverse travel would exceed the distance or duration budget, use `REANCHORING`. A long reverse scroll is visually disorienting and wastes time.

### 22.3 Forward bias

Forward bias is implemented through priors and asymmetric thresholds, not by forbidding reverse velocity. Once a retake is committed, the motion controller must follow it cleanly.

### 22.4 Passed styling

On retake commit:

- clear passed/faded state from the destination onward within the active take;
- retain previous-delivery history separately for diagnostics;
- do not visually erase earlier take history through a slow cascade;
- update styling atomically with the semantic epoch.

## 23. Repeated passages

### 23.1 Repetition index

During compilation, identify:

- repeated n-grams;
- repeated sentence openings;
- repeated full sentences;
- boilerplate phrases;
- refrain-like blocks.

Store a `distinctiveness` score for each anchor.

### 23.2 Ambiguity policy

When two eligible candidates are close:

- prefer continuity;
- prefer the current retake epoch;
- prefer candidates supported by surrounding content;
- reduce motion and hold if ambiguity is material;
- ask Luna only with the bounded candidate set;
- never use one common repeated phrase as a large-jump trigger.

### 23.3 Delayed disambiguation

It is acceptable to remain slightly behind for another phrase. Once a later anchor resolves the branch, the stage may catch up or re-anchor according to distance.

---

# Part V — Pace and continuous semantic estimation

## 24. Pace estimator

The pace estimator turns discrete alignment measurements into a continuous position and velocity estimate.

### 24.1 Required state

```ts
interface SemanticMotionEstimate {
  positionUnits: number;
  velocityUnitsPerSecond: number;
  accelerationUnitsPerSecond2: number;
  positionVariance: number;
  velocityVariance: number;
  lastMeasurementAtMs: number;
  lastStrongMeasurementAtMs: number;
  state: TrackingStateV2;
  epoch: number;
}
```

### 24.2 Filter choice

Use an alpha-beta-gamma filter, a small Kalman filter, or an equivalent deterministic state estimator. The implementation must support:

- prediction between measurements;
- measurement noise based on confidence and finality;
- bounded innovation;
- velocity estimation;
- asymmetric treatment of forward and backward corrections;
- state reset on command/manual navigation;
- covariance or an equivalent uncertainty measure.

A simple exponentially smoothed WPM value without position uncertainty is insufficient.

### 24.2.1 Reference state-space implementation

The recommended initial implementation is a small constant-acceleration Kalman-style filter in spoken-unit space.

State:

```text
x = [positionUnits, velocityUnitsPerSecond, accelerationUnitsPerSecond²]ᵀ
```

Prediction for interval `dt`:

```text
F = [1  dt  0.5dt²]
    [0   1     dt  ]
    [0   0      1  ]

xPredicted = F x
PPredicted = F P Fᵀ + Q
```

A position measurement uses:

```text
H = [1 0 0]
innovation = clamp(z - HxPredicted, innovationLimitForState)
S = H PPredicted Hᵀ + R
K = PPredicted Hᵀ S⁻¹
xUpdated = xPredicted + K × innovation
PUpdated = (I - K H) PPredicted
```

Use the Joseph covariance form if numerical tests show loss of symmetry or positive semidefiniteness.

`Q` is state-dependent process noise:

- low during stable following;
- higher after a measured pace change;
- higher while acquiring or returning from an ad-lib;
- tightly constrained while uncertain so noise does not become permission to drift;
- reset around an authoritative command/manual destination.

`R` is measurement variance derived from finality, local confidence, candidate margin, beam position variance, transcript quality, and semantic-assist disposition. A final distinctive multi-token match has low `R`; a provisional or semantically inferred match has high `R`.

Optional pace observations may update velocity through a second measurement model `H_v = [0 1 0]`. Do not derive a velocity sample from spans contaminated by ad-lib, skip, retake, command speech, or silence.

After each update, apply state constraints:

- ordinary states cannot acquire a meaningful negative velocity;
- `RETAKE_PENDING` may approach zero but not reverse;
- negative semantic velocity is allowed only for a committed rewind trajectory;
- velocity and acceleration are bounded by plausible speech profiles;
- the predicted position cannot cross a prohibited section boundary;
- a stale filter prediction cannot exceed the state’s coast-distance budget.

The implementation may use an equivalent alpha-beta-gamma filter if corpus results are equal or better, but it must retain explicit uncertainty and all state/authority constraints.

### 24.3 Measurement construction

A strong finalized alignment span supplies:

- observed position at a known session time;
- confidence-derived variance;
- optional span start/end time from local VAD;
- a local pace observation from matched script-unit distance over speech time.

A provisional match supplies a noisier position observation and normally no durable history update.

### 24.4 Robust pace samples

Exclude or down-weight samples containing:

- ad-lib;
- command speech;
- reconnect gaps;
- a committed skip;
- a retake transition;
- microphone clipping or severe packet loss;
- implausible token-rate outliers;
- long silence counted as speech.

Use robust trimming or median-based rejection before updating the longer-term pace.

### 24.5 Short-term and baseline pace

Maintain:

- a short-term pace responsive over roughly the latest few seconds;
- a baseline pace stable over a longer window;
- a blended output weighted by measurement quality.

The short-term estimate lets the stage follow deliberate slowing. The baseline prevents one rushed phrase from causing a large velocity swing.

### 24.6 Prediction horizon

Continue predicting only for a bounded horizon after fresh evidence. Starting behavior:

- high confidence and active speech: up to approximately `600–900 ms`;
- moderate confidence: shorter horizon;
- low confidence or no speech: immediate decay path;
- punctuation boundary: reduce predicted velocity according to pause prior;
- after the horizon: velocity decays toward zero.

### 24.7 Lead compensation

Define a predicted display position:

```text
displayUnit = estimatedUnit + semanticVelocity × leadSeconds
```

`leadSeconds` combines measured transcription delay, stage transport delay, and a small reading comfort lead. Clamp it by:

- confidence;
- state;
- line boundary;
- section boundary;
- maximum spoken units;
- maximum visual pixels.

Do not lead across a non-spoken heading or large visual block without confirmed contiguous progression.

## 25. Semantic correction policy

### 25.1 Innovation

For a new measurement `z` and predicted position `x`, define innovation `e = z - x`.

Classify by rendered distance using the active line map:

- micro correction;
- local correction;
- medium catch-up;
- large re-anchor;
- backward candidate;
- prohibited transition.

### 25.2 Micro corrections

Absorb through the filter. The user should not perceive them.

### 25.3 Local corrections

Change target pace and position gradually. Preserve direction.

### 25.4 Medium forward corrections

Set `CATCHING_UP` and expose a larger but capped target velocity.

### 25.5 Large corrections

Do not force the continuous filter to traverse the entire gap. Create a validated transition proposal for the stage re-anchor state.

### 25.6 Backward corrections

Do not apply until the retake gate commits. Before commitment, reduce forward prediction but retain the current epoch.

### 25.7 Stale evidence

Every measurement includes source item IDs and semantic epoch. Discard measurements whose transcript items have been superseded, masked as commands, or belong to an earlier epoch.

---

# Part VI — Stage trajectory and motion controller

## 26. Stage motion architecture

The control side estimates semantic progress. The stage side owns rendered geometry and frame-by-frame visual motion.

### 26.1 Control-to-stage semantic frames

The tracking worker emits compact semantic frames, normally at `15–30 Hz` when values change and less frequently while held.

```ts
interface SemanticMotionFrame {
  sessionId: string;
  sessionGeneration: number;
  scriptCompileHash: string;
  layoutGeneration: number;
  revision: number;
  epoch: number;
  sessionTimeMs: number;

  estimatedUnit: number;
  committedUnit: number;
  velocityUnitsPerSecond: number;
  accelerationUnitsPerSecond2: number;
  positionVariance: number;
  confidence: number;

  sectionId: string;
  tokenIndex: number;
  sentenceId: string;
  blockId: string;
  state: TrackingStateV2;
  behavior: TrackingBehavior;
  finalEvidence: boolean;

  transition?: StageTransitionDirective;
  motionProfileId: string;
}
```

The stage discards stale revisions, wrong epochs, wrong script hashes, and wrong layout generations.

### 26.2 Stage frame loop

The stage runs one `requestAnimationFrame` loop that:

1. predicts semantic progress from the latest accepted frame;
2. clamps prediction by state and evidence age;
3. maps predicted progress into the rendered line trajectory;
4. calculates target position and feed-forward velocity;
5. advances the motion controller with frame-time compensation;
6. applies the actual document transform or controlled scroll offset;
7. updates optional active/passed styling at a separately capped rate;
8. records lightweight performance counters.

Do not start a new animation for every semantic frame. One persistent controller owns motion for the life of the stage session.

### 26.3 Separation of target and plant state

A new semantic frame updates the desired path. It must not overwrite actual stage position, velocity, or acceleration except during an authorized re-anchor/reset transition.

## 27. Predicting semantic position on the stage

On receipt of a frame, cache its semantic state. For each display frame at session time `t`:

```text
age = t - semanticFrame.sessionTimeMs
predictedUnit = estimatedUnit
              + velocityUnitsPerSecond × effectiveAge
              + 0.5 × accelerationUnitsPerSecond2 × effectiveAge²
```

`effectiveAge` is capped by the state-specific prediction horizon.

### 27.1 State-specific prediction

- `FOLLOWING`: use the normal horizon.
- `COASTING`: use a decaying velocity model.
- `UNCERTAIN`: shorten the horizon and reduce velocity.
- `ADLIB_HOLD`: converge toward the held unit.
- `CATCHING_UP`: use the semantic target supplied by the correction policy.
- `RETAKE_PENDING`: do not predict backward; reduce forward velocity.
- `REWINDING`: use the committed backward trajectory.
- `PAUSED` or `RECONNECTING`: target zero velocity.

### 27.2 Evidence-age decay

After the trusted prediction horizon, use a smooth decay rather than a hard cutoff. One acceptable form is exponential velocity decay with a strict maximum distance.

```text
v(age) = v0 × exp(-lambda × excessAge)
```

The exact function is less important than:

- continuity at the horizon;
- a finite drift budget;
- state-dependent decay;
- no stale indefinite scrolling.

## 28. Target position and feed-forward velocity

### 28.1 Target position

Use the line-handoff function from Section 8 to calculate `targetScroll` for `predictedUnit`.

### 28.2 Feed-forward velocity

Estimate how quickly the target itself is moving:

```text
feedForwardVelocity = d(targetScroll) / d(unit) × semanticVelocity
```

Compute the derivative analytically where convenient or numerically from nearby semantic positions. Clamp unstable derivatives around layout boundaries.

Feed-forward is important. A controller that only responds to positional error will always lag a steadily moving target and will repeatedly accelerate after falling behind.

### 28.3 Boundary-aware velocity

At punctuation and paragraph boundaries, semantic velocity may fall before a new transcript measurement arrives. Blend:

- observed pace;
- authored pause prior;
- VAD speech state;
- current line progress;
- confidence.

Do not make punctuation cause an obvious mechanical brake on every sentence. It is a modest predictive prior.

## 29. Jerk-limited motion controller

Use a critically damped or near-critically damped target follower with explicit velocity, acceleration, and jerk limits.

### 29.1 Recommended controller form

Let:

- `q` = actual scroll position;
- `v` = actual velocity;
- `a` = actual acceleration;
- `qTarget` = desired target;
- `vTarget` = feed-forward target velocity;
- `e = qTarget - q`;
- `dt` = frame interval in seconds.

Calculate a desired acceleration using a damped second-order controller:

```text
aDesired = omega² × e - 2 × zeta × omega × (v - vTarget)
```

Then apply limits:

```text
aDesired = clamp(aDesired, -aMax, aMax)
a = approach(a, aDesired, jerkMax × dt)
v = clamp(v + a × dt, -vMaxBackward, vMaxForward)
q = q + v × dt
```

Starting `zeta` should be near `1.0`. `omega`, velocity limits, acceleration limits, and jerk limits vary by state and follow-feel profile.

### 29.2 Why jerk is explicit

Limiting only velocity still permits abrupt changes in acceleration that look like small visual kicks. Jerk limiting makes target revisions and state changes blend into the existing motion.

### 29.3 Position deadband

When all of the following are true:

- target error is below the state’s pixel deadband;
- target velocity is near zero;
- actual velocity is near zero;
- no transition is pending;

snap internal state to rest to avoid subpixel shimmer. This is a rest condition, not ordinary follow behavior.

### 29.4 Do not round every frame

Retain fractional internal position. Rendering may use fractional pixels when text remains sharp on the target WebView. If a platform produces visible text blur, use a tested quantization strategy that preserves average velocity, such as error-diffused half-pixel or device-pixel snapping, rather than discarding fractional motion.

## 30. Motion profiles by state

Use profile multipliers rather than unrelated controller implementations.

### 30.1 Ordinary following

- direction: forward;
- low-to-moderate acceleration;
- low jerk;
- velocity near feed-forward pace;
- small error correction;
- no target snapping.

### 30.2 Coasting and uncertainty

- reduce semantic target velocity gradually;
- lower maximum forward speed;
- increase damping;
- disallow new large visual lead;
- retain enough motion to avoid an instant freeze.

### 30.3 Catch-up

- allow greater forward velocity and acceleration;
- preserve jerk limit;
- cap catch-up duration;
- reduce boost as the active line approaches the leading edge of the reading corridor;
- never let catch-up place the spoken line above the user’s configured upper safety boundary.

### 30.4 Retake pending

- reduce forward feed-forward contribution;
- decelerate toward zero;
- do not reverse until semantic commit;
- keep destination candidate out of stage UI.

### 30.5 Rewinding

- use lower absolute velocity than forward catch-up;
- use sufficient damping to prevent overshoot;
- target the destination line-start position;
- complete within a maximum duration or convert to re-anchor.

### 30.6 Manual wheel or keyboard interaction

Manual interaction has immediate authority. Cancel or suspend the automatic controller according to the primary mode rules. On returning to voice follow:

- initialize semantic position from the nearest valid script coordinate;
- set controller actual state to the current visual position;
- reacquire without snapping;
- use a short manual-grace interval that suppresses automatic correction back to the old target.

## 31. Rendering mechanism

### 31.1 Preferred strategies

Benchmark both of these on supported WebViews:

1. transform an immutable document layer with `translate3d(0, -q, 0)`;
2. apply a directly controlled scroll offset with browser smooth behavior disabled.

Select the default per platform based on:

- text sharpness;
- frame stability;
- fractional movement quality;
- CPU/GPU use;
- accessibility behavior;
- interaction with mirrored rendering;
- media and Listener layers.

### 31.2 Prohibited rendering patterns

Do not use:

- `scrollIntoView({ behavior: "smooth" })` for tracking;
- CSS `scroll-behavior: smooth`;
- overlapping per-update CSS transitions;
- repeated tween creation without preserving current velocity;
- layout-affecting `top` changes on hundreds of text nodes;
- a timer interval as the primary renderer.

### 31.3 Layer composition

Recommended stage layers:

1. Listener/video background;
2. optional dim or gradient treatment;
3. immutable script document layer moved by the controller;
4. active-line/focus treatment tied to semantic state;
5. optional coach strip and command acknowledgement;
6. stage safety overlays used only intentionally.

Only the script document layer should move for normal scroll.

## 32. Frame-time and hitch handling

### 32.1 Delta time

Use measured `requestAnimationFrame` delta time and clamp it to a safe integration range. Do not assume 60 Hz.

### 32.2 Large hitch

If a frame gap exceeds the normal integration threshold:

- do not integrate a huge movement in one frame;
- cap the integration step;
- re-evaluate semantic target;
- preserve visual continuity where possible;
- if the document is now far from target, choose catch-up or re-anchor rather than one-frame teleportation.

### 32.3 120 Hz and variable refresh

Controller gains must be expressed in time-based units and produce comparable behavior at 60 Hz, 90 Hz, 120 Hz, and variable frame rates.

### 32.4 Hidden stage

When the stage is hidden or minimized:

- stop the animation loop or reduce work;
- preserve semantic state;
- on visibility restoration, re-anchor actual motion state to the current rendered position and current semantic target;
- do not replay all missed motion.

## 33. Layout invalidation during Live

Layout may change because the user adjusts font size, margin, line height, or display profile.

Required sequence:

1. freeze semantic styling updates;
2. capture current semantic position and its viewport position;
3. rebuild the rendered line map;
4. find the same semantic position in the new map;
5. initialize actual scroll so the semantic position remains at approximately the same viewport height;
6. zero unsafe accumulated acceleration;
7. resume with a short settling profile;
8. increment layout generation and reject old frames.

Do not preserve raw `scrollTop`; preserve semantic position.

---

# Part VII — GPT-5.6 Luna semantic sidecar

## 34. Purpose and boundaries

Luna adds semantic interpretation where fuzzy lexical matching becomes uncertain. It is not the primary tracker.

Use it for:

- local paraphrase recognition;
- ad-lib versus script distinction;
- restart and self-correction classification;
- ranking a small set of locally generated candidates;
- deciding whether a suspected omission is meaningful enough for a tip;
- classifying a return to the script after divergence.

Do not use it for:

- frame-by-frame motion;
- every transcript character delta;
- unconstrained full-script search;
- ordinary exact matches;
- deterministic commands already resolved locally;
- generating scrolling text or rewriting the script.

## 35. Intelligence modes

Expose a simple user setting while retaining detailed internal policy.

### 35.1 Local only

- no Luna calls during Live;
- deterministic fuzzy matching and motion remain fully functional;
- no semantic paraphrase advancement;
- deterministic delivery and microphone tips may still appear.

### 35.2 Balanced intelligence — default

Call Luna only when it can resolve a material ambiguity or validate a high-value tip.

Typical triggers:

- local confidence stays in a middle band beyond a short delay;
- transcript has strong topic/context continuity but weak lexical overlap;
- retake evidence is plausible but ambiguous;
- speech returns after an ad-lib;
- a potentially critical number, name, or negation mismatch is detected;
- two eligible local candidates remain close.

### 35.3 Enhanced intelligence

In addition to ambiguity-triggered calls, periodically analyze stable finalized speech windows for semantic coverage and coaching. This mode may make materially more API calls and must show a cost explanation.

It still obeys all authority gates.

## 36. Request scheduler

### 36.1 Coalescing and lanes

Maintain at most one active semantic request per scheduling lane. New transcript evidence updates a pending snapshot. Do not queue every intermediate state.

Use explicit lanes with a shared global budget:

- `candidate_classification` — ranks exact eligible spans;
- `landmark_recovery` — retrieves local semantic landmark IDs after sustained lexical failure;
- `coaching_validation` — validates a high-value fidelity issue when it is not already covered by a tracking request.

Candidate classification has priority when it can immediately resolve tracking. Landmark recovery is rarer and may produce a follow-up candidate-classification call. Coaching must not delay either tracking lane and should reuse a recent classification result where possible.

### 36.2 Minimum useful input

Do not call for one or two ordinary words. Wait for one of:

- a finalized phrase boundary;
- a meaningful token threshold;
- a sustained ambiguity interval;
- a strong retake lead-in;
- a critical fidelity candidate.

### 36.3 Cadence

Starting caps:

- Balanced: normally no more than one request every `2.5–5 seconds`, with short bursts for material ambiguity;
- Enhanced: normally no more than one request every `1.5–3 seconds` while speech is active;
- hard global cap per session profile;
- no call while paused, command text is pending, or no new stable transcript exists.

These are scheduling defaults, not product promises. Evaluate actual latency, rate limits, and cost.

### 36.4 Stale responses

Every request includes:

- request ID;
- semantic epoch;
- transcript ledger revision;
- script compile hash;
- section ID;
- candidate-set hash;
- latest accepted semantic-assist sequence.

Discard a response when any relevant authority or context has changed.

### 36.5 Cancellation

Cancel an in-flight request where the SDK/transport permits when:

- a command or manual navigation changes epoch;
- a retake commits to a different context;
- the script/layout session ends;
- the candidate set is no longer valid.

Correctness must not depend on cancellation succeeding; stale checks remain mandatory.

## 37. Candidate-bounded Luna context

Luna operates only on locally eligible locations. There are two semantic-assist paths: ordinary candidate classification and landmark-assisted local recovery.

### 37.1 Ordinary candidate classification

The local aligner supplies a small set of exact candidate spans, normally approximately `3–6`.

Recommended dynamic request content:

- current hard section ID and title;
- current committed sentence and nearby context;
- recent finalized transcript tail;
- a small provisional tail if useful, clearly marked;
- each candidate’s opaque ID and bounded exact script text;
- compact local score bands and distance categories;
- whether each candidate is continuity, forward, hold, boundary, or retake;
- recent behavior such as `following`, `adlib_hold`, or `retake_pending`;
- critical-token mismatch candidates;
- explicit instruction that `unresolved` is valid and preferred to guessing.

Never ask Luna to invent a candidate or return a raw token index.

### 37.2 Landmark-assisted current-section recovery

A substantial paraphrase may provide too little lexical overlap for the normal local indexes to nominate the right exact span. In that case, and only after a sustained local ambiguity trigger, the scheduler may query the prepared semantic landmark map.

The retrieval request contains:

- recent finalized transcript;
- current section and behavior;
- a bounded set of opaque landmark IDs and concise propositions;
- current progress corridor and direction information;
- any critical name/number/negation evidence;
- permission to return zero candidates.

The landmark set is restricted to:

- the current hard section; and
- the ordinary sequential boundary corridor already allowed by the section graph.

For a long section, query paragraph-level landmarks first and sentence-level landmarks second. Do not send unrelated sections merely because they contain a semantic match.

### 37.3 Mandatory two-pass recovery

A landmark result cannot move the stage. It only opens one or more exact candidate windows.

Required sequence:

1. Luna returns up to a small maximum of supplied landmark IDs.
2. Local code verifies IDs, section eligibility, request epoch, and script hash.
3. The candidate generator loads the exact script spans around those IDs.
4. Weighted lexical/phonetic/order alignment runs against the transcript again.
5. If still useful, ordinary Luna candidate classification ranks those exact spans.
6. The semantic filter receives a noisy measurement only when local support and transition gates pass.

This two-pass design lets Luna recover a heavily paraphrased local passage without turning semantic similarity into unrestricted navigation authority.

### 37.4 When landmark recovery is prohibited

Do not run landmark recovery:

- for provisional-only fragments;
- on one or two generic words;
- while command routing is unresolved;
- when an ordinary candidate is already strong;
- more often than the recovery-lane cadence budget;
- after the response can no longer affect the active phrase;
- across an unauthorized section boundary;
- when no valid prepared landmark index exists.

### 37.5 Context size and privacy

Keep both paths compact. The ordinary path should contain exact nearby spans; the recovery path should contain concise current-section landmarks. Do not attach the full script to each request and do not preserve a growing conversation history.

Every request must use opaque IDs, `store: false`, stale-response metadata, and local output validation. A user-selected Local-only mode bypasses both paths.

## 38. Luna API request policy

Use the Responses API with:

- model `gpt-5.6-luna` through the capability registry;
- structured outputs with a strict JSON schema;
- `store: false` unless the product owner explicitly changes the privacy policy;
- no tools;
- no web search;
- low tested reasoning effort suitable for classification;
- a small output-token limit that still leaves enough room for reasoning and the required schema;
- explicit timeout;
- no automatic retry after context has changed;
- usage capture for local cost estimates.

### 38.1 Reasoning effort

Start evaluation with `reasoning.effort: "low"`. Test `none` or `minimal` only if supported by the active model snapshot and if accuracy remains acceptable. Do not use medium/high reasoning for continuous tracking classification by default.

### 38.2 Output size

The output is a compact classification, not an explanation. Do not request chain-of-thought or reasoning summaries. Keep free-text fields out of the schema except an optional short internal diagnostic label with a strict length limit.

## 39. Semantic assist schema

```ts
interface SemanticAssistResult {
  schemaVersion: 1;
  requestId: string;
  semanticEpoch: number;
  transcriptRevision: number;
  candidateSetHash: string;

  relation:
    | 'near_exact'
    | 'paraphrase'
    | 'adlib'
    | 'return_to_script'
    | 'restart'
    | 'self_correction'
    | 'forward_skip'
    | 'unresolved';

  selectedCandidateId: string | null;
  selectedCandidateConfidence: number;
  transcriptCoverage: number;
  candidateCoverage: number;
  shouldInfluenceTracking: boolean;

  criticalMismatch:
    | 'none'
    | 'negation'
    | 'number'
    | 'name'
    | 'meaning_change'
    | 'omitted_clause'
    | 'uncertain';

  coachTipCode:
    | 'none'
    | 'critical_word_changed'
    | 'number_changed'
    | 'name_changed'
    | 'meaningful_omission'
    | 'restart_detected';

  confidence: number;
}
```

All object properties are required under the strict schema; nullable fields use explicit `null` unions. Validate ranges and candidate IDs after schema parsing.

### 39.1 No generated tip copy

Luna returns only a tip code. CandidCue maps it to localized, hardcoded copy and may include a safely escaped script token supplied by the local engine.

### 39.2 Landmark retrieval schema

```ts
interface SemanticLandmarkRetrievalResult {
  schemaVersion: 1;
  requestId: string;
  semanticEpoch: number;
  transcriptRevision: number;
  landmarkSetHash: string;
  relation:
    | 'likely_current_passage'
    | 'likely_forward_within_section'
    | 'likely_retake'
    | 'adlib'
    | 'unresolved';
  candidateLandmarkIds: string[];
  confidence: number;
}
```

The candidate array is bounded, normally to at most `3`. Every returned ID must have appeared in the request. `adlib` and `unresolved` normally return an empty array. The result creates candidate windows only; it does not create an alignment measurement or stage transition.


### 39.3 Landmark preparation schema

```ts
interface SemanticLandmarkPreparationResult {
  schemaVersion: 1;
  requestId: string;
  scriptCompileHash: string;
  sectionId: string;
  annotations: Array<{
    spanId: string;
    proposition: string;
    topicLabels: string[];
    criticalTerms: Array<{
      kind: 'name' | 'number' | 'negation' | 'date' | 'currency' | 'meaning';
      canonical: string;
    }>;
    conversationalAliases: string[];
    exactness: 'flexible' | 'balanced' | 'exact';
  }>;
}
```

The request supplies every `spanId` and exact source span. Local validation requires each returned ID to be known, unique, in the requested section, and represented no more than once. Missing annotations may be retried or left absent; invented IDs are discarded. Token and unit ranges are joined from local compiler data and are never accepted from Luna.


## 40. Semantic score fusion

### 40.1 Bounded influence

Convert Luna output into a bounded score adjustment on an existing eligible hypothesis.

Starting principle:

```text
combinedLogScore = localLogScore + clamp(semanticAdjustment, min, max)
```

The semantic adjustment must be too small to overcome:

- an eligibility failure;
- a command/manual authority boundary;
- a very poor local candidate;
- a strong contradictory critical token;
- stale or provisional-only context.

### 40.2 Minimum local support

A Luna-selected candidate may influence tracking only if the local engine already supplied it based on at least one of:

- lexical anchors;
- phonetic anchors;
- ordered context around the candidate;
- a recent sentence/paragraph checkpoint;
- a valid retake opening;
- an immediate sequential boundary.

### 40.3 Influence by relation

- `near_exact`: moderate positive evidence.
- `paraphrase`: moderate positive evidence, capped by candidate span.
- `adlib`: increase hold/ad-lib branch; do not advance.
- `return_to_script`: strengthen selected local candidate.
- `restart` or `self_correction`: strengthen an eligible retake branch, but final local evidence is still required.
- `forward_skip`: strengthen an eligible within-section skip, subject to final evidence and distance threshold.
- `unresolved`: no positive movement evidence.

### 40.4 Semantic evidence expiry

Semantic evidence has a short lifetime tied to the analyzed transcript span. Do not keep its score active after new contradictory speech arrives.

## 41. Prompt caching and request construction

OpenAI prompt caching depends on exact shared prefixes. Structure the request as:

1. stable system task and hard constraints;
2. strict output schema;
3. stable examples if evaluation proves useful;
4. optional stable current-section context;
5. dynamic candidate and transcript payload last.

Use a script/session-and-operation-scoped `prompt_cache_key` when it improves measured cache hits. Keep candidate classification, landmark retrieval, and preparation on stable but distinct keys when their prefixes differ materially. For high-cadence modes, partition traffic only when necessary and within current OpenAI guidance.

For GPT-5.6-family requests, evaluate an explicit cache breakpoint immediately after the stable instruction/schema prefix. Do this only when the prefix is long enough to be cache-eligible and repeated enough for cache reads to outweigh writes. Do not pad a prompt merely to cross a caching threshold. Keep dynamic transcript/candidate data after the breakpoint.

Log cached-input and cache-write token counts locally in aggregate diagnostics. Compare them by operation and disable an unhelpful caching strategy rather than assuming every repeated request benefits.

Do not send the full script merely to create a large cacheable prefix. Candidate-bounded context is safer, cheaper, and less prone to remote-section guesses.

## 42. Cost controls

### 42.1 User-facing policy

Because this is bring-your-own-key, the user must be able to see:

- whether Luna assist is off, Balanced, or Enhanced;
- an indicative cost description;
- session Luna request count and token usage where returned;
- a configurable session or hourly semantic-assist budget;
- automatic fallback to local-only behavior when the budget is reached.

### 42.2 Budget formula

Calculate estimated semantic cost from actual API usage and the current model price in the capability registry. Do not hard-code a permanent currency estimate into UX copy.

### 42.3 Token discipline

- send only recent transcript context;
- send only eligible candidate spans;
- use compact field names only if readability and schema maintenance remain acceptable;
- keep output tiny;
- do not preserve a growing conversational history;
- prefer one useful batched classification over several sequential calls;
- use local logic for deterministic cases.

### 42.4 Quota and rate limits

A semantic-sidecar quota error must not stop transcription or local tracking. Disable or back off Luna for the remainder of the cooldown and show the issue only in the control window.

---

# Part VIII — Live coaching and helpful tips

## 43. Coaching principles

Coaching is optional and subordinate to reading. It must help without making the presenter monitor another stream of text.

### 43.1 Tip categories

#### Delivery tips

Derived locally:

- microphone clipping;
- no useful microphone signal;
- sustained pace far above the configured comfortable range;
- sustained pace far below the user’s chosen range;
- repeated tracking loss caused by very long silent gaps, if actionable.

#### Fidelity tips

Derived from local alignment and optionally validated by Luna:

- critical negation changed or omitted;
- number/date/currency changed;
- important proper noun pronounced/transcribed differently;
- meaningful clause omitted;
- user appears to have restarted a sentence.

#### Motion-status tips

Use sparingly:

- “Slowing to keep your place”;
- “Finding your place…”;
- “Back to the previous sentence.”

These should generally appear only in control UI. The stage should not narrate normal system behavior.

## 44. Stage coach strip

### 44.1 Placement

Reserve a bottom safe area outside the primary reading path. The strip must not cover script text or Listener eyes.

### 44.2 Visual treatment

- one line where possible;
- small but readable type;
- low-contrast dark translucent background or subtle gradient;
- no modal box;
- no animation beyond a gentle fade;
- mirrored consistently with the stage profile when required;
- maximum width constrained to avoid eye travel.

### 44.3 Timing

Show a stage tip only when:

- coaching is enabled for stage;
- confidence exceeds the category threshold;
- the issue remains stable after final transcript evidence;
- a phrase or silence boundary makes it readable;
- no command acknowledgement is visible;
- no re-anchor is active;
- the cooldown has elapsed.

Starting policy:

- minimum display around `1.5–2.5 seconds`, depending on length;
- maximum one new stage tip every `6–10 seconds`;
- replace only for a higher-priority safety/fidelity issue;
- dismiss automatically;
- never stack tips.

### 44.4 Copy examples

Acceptable:

- `Number changed: “15%”`
- `You may have skipped “not”`
- `Name sounded different: “CandidCue”`
- `Previous sentence restarted`
- `Microphone is clipping`

Avoid:

- long explanations;
- judgmental wording;
- percentages or model confidence;
- “You made a mistake”;
- raw transcript versus script diffs;
- unverified suggestions.

## 45. Fidelity modes

### 45.1 Conversational

- accept paraphrases readily;
- tips only for numbers, negations, names, and large meaning changes;
- omissions of stylistic wording are ignored.

### 45.2 Balanced — default

- tolerate normal conversational variation;
- tip on likely critical changes and meaningful omitted clauses;
- no tip for articles, contractions, or equivalent phrasing.

### 45.3 Exact

- stricter lexical coverage;
- more omission/substitution tips;
- still suppress low-confidence and rapid-fire feedback;
- tracking itself must remain tolerant enough not to fail simply because fidelity mode is strict.

Fidelity mode changes coaching thresholds more than navigation behavior. Do not make Exact mode dangerously jumpy.

## 46. Tip arbitration

Each candidate tip has:

- type and priority;
- confidence;
- transcript revision;
- semantic epoch;
- affected script span;
- earliest display time;
- expiry time;
- control-only or stage-eligible disposition.

Priority order:

1. microphone failure/clipping that threatens the session;
2. critical number or negation change;
3. important proper noun change;
4. meaningful omission;
5. pace guidance;
6. low-value status information.

Deduplicate repeated tips for the same span and take epoch.

---

# Part IX — User controls and live UX

## 47. Follow settings

Do not expose a control-system dashboard in normal settings. Provide understandable controls.

### 47.1 Follow feel

A three- or five-position control:

- **Calm** — slower corrections, longer deadband, lower catch-up acceleration;
- **Balanced** — default;
- **Responsive** — shorter uncertainty grace and quicker local corrections.

This maps to a versioned motion profile. It must not weaken section safety or retake evidence gates.

### 47.2 Reading position

Retain the existing reading-band position setting. Internally it sets the line-start anchor `R` and corridor geometry.

### 47.3 Voice lead

Optional simple control:

- Less lead;
- Balanced;
- More lead.

Clamp it safely. This changes prediction lead, not semantic match location.

### 47.4 Intelligent assist

- Local only;
- Balanced;
- Enhanced.

Explain that Balanced/Enhanced send recent transcript and small nearby script excerpts to GPT-5.6 Luna using the user’s OpenAI key.

### 47.5 Script fidelity

- Conversational;
- Balanced;
- Exact.

### 47.6 Coaching display

- Off;
- Control window only;
- Stage and control.

Default should be conservative; stage coaching may default off until product testing establishes that it helps.

## 48. Live control additions

The Live control window may show:

- tracking state in plain language;
- pace estimate;
- current section and sentence;
- confidence indicator without implying false precision;
- Luna assist active/off/backed off;
- last coach event;
- a compact “Why did it move?” diagnostic in developer mode;
- buttons to accept one of local candidates when lost;
- “Re-find me here” manual action.

Do not expose the full hypothesis beam in normal mode.

## 49. Visual active-state treatment

The text itself may use subtle state cues:

- already delivered text slightly dimmer after final confirmation;
- current and near-future lines at full contrast;
- distant future text slightly reduced if desired;
- during uncertainty, do not flash or change color dramatically;
- during retake, restore destination text to full unread state atomically.

Active-word karaoke highlighting is not required and may conflict with the calm visual goal. If implemented later, it must use the same continuous semantic coordinate and remain optional.

---

# Part X — Application architecture changes

## 50. New and changed modules

### 50.1 Control frontend

Add or extend:

- `tracking/alignment-v2` — hypothesis beam, candidate generation, scoring, transitions;
- `tracking/semantic-filter` — continuous position/velocity estimator;
- `tracking/pace-estimator` — robust short/baseline pace;
- `tracking/section-graph` — hard eligibility transitions;
- `tracking/semantic-assist-scheduler` — Luna trigger, lane arbitration, and stale handling;
- `tracking/semantic-landmark-index` — prepared landmark cache and hierarchical current-section retrieval;
- `tracking/coach-engine` — deterministic and semantic tip arbitration;
- `tracking/playback-harness` — deterministic event replay;
- `stores/SmoothFollowStore` — user-visible state and controls.

### 50.2 Rust core

Extend `openai` with:

- `prepare_semantic_landmarks`;
- `retrieve_semantic_landmarks`;
- `classify_semantic_tracking_window`;
- strict preparation, retrieval, and classification request/response types;
- timeout and cancellation support;
- usage extraction;
- model capability checks;
- no request body logging;
- `store: false` policy;
- prompt-cache metadata;
- rate/quota classification.

Add optional `session_clock` support in the coordinator if the frontend clock synchronization approach is insufficient.

### 50.3 Stage frontend

Add:

- `RenderedLineMapBuilder`;
- `SemanticFrameReceiver`;
- `LineHandoffPlanner`;
- `JerkLimitedScrollController`;
- `StageTransitionController`;
- `CoachStrip`;
- `StageMotionDiagnostics`;
- layout generation invalidation.

### 50.4 Worker placement

The hypothesis aligner, semantic filter, and scheduler logic run outside the stage UI thread, preferably in the existing tracking worker. Luna network calls go through Rust. The stage frame controller remains in the stage window because it owns final layout and animation timing.

## 51. End-to-end event order

For each transcript update:

1. Realtime transport emits a provider event.
2. Transcript reconciler updates the item ledger.
3. Command router gets first opportunity to mask command speech.
4. Tracking worker receives alignable transcript state.
5. Hypothesis aligner predicts, retrieves indexed candidates, scores, and prunes.
6. Section graph rejects ineligible transitions before semantic assistance.
7. Semantic filter consumes the resulting measurement.
8. Pace estimator updates from valid finalized spans.
9. Scheduler may create or update an ordinary candidate-classification request.
10. After sustained lexical failure, the separate recovery lane may query current-section semantic landmarks.
11. A valid landmark response opens exact local candidate windows; it never moves the cursor directly.
12. Worker emits `SemanticMotionFrame` from currently accepted local/semantic evidence.
13. Stage accepts the frame if generations and revisions match.
14. Stage line planner samples the monotone motion path.
15. Frame controller advances visual motion.
16. A later candidate-classification response may update hypothesis weights if still current.
17. A later landmark response may trigger a bounded second alignment pass if still current.
18. Coach engine may enqueue a tip after final validation.

No API response is awaited by the stage frame loop.

## 52. Tracking behavior types

```ts
export type TrackingBehavior =
  | 'acquire'
  | 'normal'
  | 'minor_variation'
  | 'paraphrase'
  | 'adlib'
  | 'return'
  | 'small_skip'
  | 'large_skip'
  | 'retake_candidate'
  | 'retake'
  | 'manual_navigation'
  | 'command_navigation'
  | 'lost';

export type TrackingStateV2 =
  | 'acquiring'
  | 'following'
  | 'coasting'
  | 'uncertain'
  | 'adlib_hold'
  | 'catching_up'
  | 'retake_pending'
  | 'rewinding'
  | 'reanchoring'
  | 'command_pending'
  | 'paused'
  | 'reconnecting'
  | 'lost_local';
```

## 53. Transition directive

```ts
interface StageTransitionDirective {
  id: string;
  type: 'none' | 'settle' | 'catch_up' | 'rewind' | 'reanchor' | 'reset';
  authority: 'ordinary' | 'command' | 'manual';
  fromUnit: number;
  toUnit: number;
  destinationTokenIndex: number;
  destinationLineHint?: string;
  issuedAtMs: number;
  expiresAtMs: number;
  semanticEpoch: number;
  reason:
    | 'large_forward_skip'
    | 'distant_retake'
    | 'command_navigation'
    | 'manual_navigation'
    | 'layout_recovery'
    | 'session_reset';
}
```

Only one transition directive may be active. It is idempotent by ID.

## 54. Stage acknowledgement

The stage should periodically report:

```ts
interface StageMotionAck {
  sessionId: string;
  revision: number;
  epoch: number;
  layoutGeneration: number;
  actualScrollPx: number;
  actualVelocityPxPerSecond: number;
  targetScrollPx: number;
  activeLineId: string | null;
  controllerState: string;
  droppedFrameCountWindow: number;
  renderedAtMs: number;
}
```

Use this for diagnostics and recovery, not as a high-frequency feedback loop to the semantic aligner.

## 55. Profile configuration

Store a versioned profile:

```ts
interface SmoothFollowProfile {
  version: number;
  id: string;

  prediction: {
    normalHorizonMs: number;
    uncertainHorizonMs: number;
    maxCoastUnits: number;
    leadSecondsMin: number;
    leadSecondsMax: number;
  };

  alignment: {
    beamWidth: number;
    continuityBackTokens: number;
    continuityForwardTokens: number;
    sectionSearchLimit: number;
    retakePersistenceTokens: number;
    retakePersistenceMs: number;
    semanticInfluenceMax: number;
  };

  motion: {
    dampingRatio: number;
    naturalFrequency: number;
    maxForwardVelocityPxS: number;
    maxBackwardVelocityPxS: number;
    maxAccelerationPxS2: number;
    maxJerkPxS3: number;
    catchUpMultiplier: number;
    reverseTravelMaxPx: number;
    reanchorThresholdPx: number;
    restDeadbandPx: number;
  };

  coaching: {
    stageCooldownMs: number;
    controlCooldownMs: number;
    minimumConfidence: number;
  };
}
```

Profiles belong in typed configuration and eval snapshots, not scattered constants.

## 56. Command interaction

Command routing remains ahead of ordinary alignment.

### 56.1 Wake-gated navigation

A valid navigation command:

- increments semantic epoch;
- supplies authoritative target;
- clears ordinary hypotheses;
- resets section eligibility to the target;
- creates a command transition directive;
- updates the semantic filter around the target;
- masks command speech from pace estimation;
- resumes following from subsequent transcript.

### 56.2 Ungated restart language

Phrases such as “let me do that again” may be treated as retake context but not as arbitrary navigation commands. They lower the retake threshold only for eligible recent spans.

### 56.3 False command-like script text

Retain all collision suppression from the primary specification. Luna semantic tracking must not reinterpret rejected command text as navigation.

---

# Part XI — Privacy, reliability, and degraded operation

## 57. Data handling

### 57.1 Local state

Keep locally:

- full compiled script;
- line map;
- hypothesis beam;
- pace and motion estimates;
- tracking diagnostics;
- coach arbitration state.

### 57.2 Luna payload

Send only:

- recent transcript text needed for the classification;
- a bounded set of nearby eligible script excerpts;
- compact state metadata;
- no audio;
- no Listener media;
- no full script unless a separate explicit preparation operation requires it.

### 57.3 Logs

Default logs must not contain script or transcript text. Use hashes, token counts, candidate distances, state transitions, timing, and score ranges. A user may explicitly include text in a diagnostic export.

## 58. Luna unavailable

If Luna times out, errors, reaches budget, or lacks model access:

- continue deterministic tracking;
- do not freeze solely because semantic assist failed;
- discard pending semantic expectations;
- use conservative local behavior;
- suppress semantic-only tips;
- show a non-blocking control-window status;
- retry only according to bounded backoff and current context.

## 59. Transcription interruption

During a Realtime interruption:

- enter `RECONNECTING`;
- decelerate and hold;
- do not extrapolate beyond the coast budget;
- retain current section and semantic position;
- on reconnect, create local candidates around the held position;
- allow within-section reacquisition;
- prohibit remote section movement without authority;
- use re-anchor only when a valid local destination is found.

## 60. Low transcript confidence

When model log probabilities are absent or weak:

- rely more on sequence agreement, rare anchors, VAD quality, and candidate margin;
- increase measurement variance;
- reduce lead;
- avoid coach tips;
- do not treat missing log probabilities as an error.

## 61. Frame-performance degradation

If the stage repeatedly misses its frame budget:

1. disable nonessential visual effects;
2. reduce active styling update frequency;
3. simplify Listener crossfades if necessary;
4. retain controller integration and text motion as highest priority;
5. report diagnostics in control;
6. never switch to event-driven jumps as a silent fallback.

## 62. Invalid line map

If line measurement fails or returns inconsistent token coverage:

- hold stage motion;
- rebuild once;
- validate monotonic token and baseline ordering;
- fall back to block-level geometry only if that fallback is explicitly implemented and tested;
- otherwise expose a recoverable stage-layout error in control;
- never move using guessed line positions.

---

# Part XII — Performance budgets and diagnostics

## 63. Runtime budgets

Initial targets on supported hardware:

- alignment update, local ordinary case: well below one frame budget in the worker;
- hypothesis beam update: bounded and independent of full script length in normal operation;
- stage target calculation and controller integration: comfortably below `1 ms` average per frame on representative hardware;
- no synchronous Rust IPC in the stage frame loop;
- no layout reads in the ordinary frame loop after map creation;
- no full-document DOM query on transcript updates;
- Luna calls asynchronous and off the critical path.

Measure rather than assume.

## 64. Diagnostics timeline

Developer mode should display a synchronized timeline containing:

- audio/VAD activity;
- transcript provisional and final item boundaries;
- best and second hypothesis position;
- section eligibility decisions;
- semantic-filter position and velocity;
- state transitions;
- Luna request/response and disposition;
- target scroll, actual scroll, velocity, acceleration, and jerk estimate;
- line ID and line progress;
- transition directives;
- coach-tip decisions;
- frame hitches.

Provide zoom, pause, and export. Text is redacted by default.

## 65. “Why did it move?” record

For every nontrivial movement transition, store a compact explanation object:

```ts
interface MovementDecisionRecord {
  revision: number;
  sessionTimeMs: number;
  fromUnit: number;
  toUnit: number;
  behavior: TrackingBehavior;
  stateBefore: TrackingStateV2;
  stateAfter: TrackingStateV2;
  localConfidence: number;
  secondBestMargin: number;
  sectionGate: 'allowed' | 'blocked';
  semanticAssistRelation?: string;
  semanticAssistInfluence?: number;
  authority: 'ordinary' | 'command' | 'manual';
  visualDisposition: 'absorbed' | 'catch_up' | 'rewind' | 'reanchor' | 'hold';
}
```

This is essential for tuning false jumps and retakes.

---

# Part XIII — Evaluation and testing

## 66. Deterministic playback harness

Build this before tuning production thresholds.

The harness replays:

- transcript deltas and completions;
- item IDs and commit order;
- local VAD timing;
- simulated provider delay;
- optional token confidence;
- command masks;
- Luna responses with controlled delay or failure;
- layout map fixtures;
- display frame timing, including hitches.

It must run faster than real time for CI and in real time for visual inspection.

### 66.1 Golden outputs

For each fixture, record expected ranges rather than brittle exact floats where appropriate:

- legal section;
- semantic position band over time;
- permitted state transitions;
- whether a retake/skip/re-anchor occurs;
- maximum visual error;
- no prohibited jump;
- motion smoothness bounds;
- accepted or discarded Luna response;
- expected tips.

## 67. Speech corpus expansion

Add the following labeled scenarios at multiple voices, microphones, accents, and speaking rates.

### 67.1 Linear delivery

- `80–100 WPM` careful reading;
- `120–150 WPM` ordinary reading;
- `170–210 WPM` fast delivery;
- deliberate acceleration and deceleration;
- sentence-final pauses;
- no pauses between paragraphs.

### 67.2 Lexical variation

- contractions expanded or contracted;
- articles and filler changed;
- synonyms;
- word-order changes that preserve meaning;
- singular/plural changes;
- product names with ASR substitutions.

### 67.3 Paraphrases

- close paraphrase of one sentence;
- paraphrase spanning two sentences;
- partial paraphrase followed by exact return;
- near-zero lexical-overlap paraphrase recoverable only through a current-section landmark;
- hierarchical landmark recovery inside a very long section;
- generic semantic statement that matches several candidates;
- semantic match to a remote section that must remain prohibited;
- paraphrase containing a contradictory number or negation.

### 67.4 Ad-libs

- one-second aside;
- five-second example;
- 15-second explanation;
- ad-lib followed by exact current phrase;
- ad-lib followed by a later within-section phrase;
- ad-lib containing words from a distant section.

### 67.5 Skips

- skip three words;
- skip a clause;
- skip one sentence;
- skip two paragraphs in the same section;
- phrase identical to a remote chapter;
- sequential crossing into the next section.

### 67.6 Retakes

- restart current sentence after two words;
- restart previous sentence;
- restart current paragraph;
- restart paragraph after an ad-lib;
- repeat a common phrase without intending a retake;
- read a scripted refrain that repeats earlier wording;
- retake across the immediately previous section boundary;
- attempt apparent retake to an unrelated section.

### 67.7 Recognition instability

- provisional wrong proper noun corrected in final;
- provisional candidate flips between two repeated phrases;
- completions arrive out of item order;
- low-confidence audio;
- clipping;
- background speaker;
- dropped/reconnected session.

### 67.8 Commands

- wake-gated distant section navigation;
- script contains wake phrase and command-like words;
- restart language without wake phrase;
- command during ad-lib;
- command followed immediately by script speech.

## 68. Layout corpus

Test the same semantic recordings against:

- narrow teleprompter width;
- wide second monitor;
- large and small fonts;
- multiple line heights;
- mirrored and unmirrored modes;
- headings with large spacing;
- images between paragraphs;
- tables and diagrams;
- Listener enabled and disabled;
- 60 Hz and 120 Hz simulated display;
- device scale factors of `1`, `1.25`, `1.5`, and `2` where available.

The semantic result should remain stable while visual trajectory adapts to layout.

## 69. Alignment metrics

Measure at minimum:

### 69.1 Position error

Distance between estimated semantic position and hand-labeled intended script position, in:

- tokens;
- spoken units;
- rendered lines.

Report median, p90, p95, and worst cases by scenario.

### 69.2 Time to acquire

Time from useful speech to stable initial lock.

### 69.3 Time to return

Time from return-to-script speech after an ad-lib to stable local lock.

### 69.4 Retake latency

Time from sufficient retake evidence to semantic commit and visual arrival.

### 69.5 False retake rate

Incorrect backward transitions per hour and per repeated-phrase scenario.

### 69.6 False skip rate

Incorrect forward skips per hour.

### 69.7 Prohibited section jump rate

Must be exactly zero in automated and release corpus tests. Any uncommanded non-contiguous section jump is a release blocker.

### 69.8 Hold quality

Distance drifted while ad-libbed or lost, measured in lines and spoken units.

## 70. Motion metrics

### 70.1 Target position continuity

At every ordinary line boundary, the calculated target position before and after switching line IDs must differ only within floating-point/measurement tolerance.

### 70.2 Target derivative and rendered velocity continuity

Verify the monotone path’s left and right `dScroll/dUnit` at each ordinary knot. They must match within numerical tolerance before state-specific clamps. Measure frame-to-frame rendered velocity as well; ordinary following must not produce line-boundary spikes.

### 70.3 Acceleration and jerk

Measure distributions and maxima by motion profile. Flag controller saturation and repeated sign changes.

### 70.4 Visual tracking error

Difference between actual scroll position and desired trajectory. Report by state.

### 70.5 Overshoot

The active line must not oscillate around its destination after a correction or retake.

### 70.6 Stop comfort

Measure time and distance from evidence loss to settled hold. Evaluate both objective limits and human preference.

### 70.7 Catch-up comfort

Measure maximum speed multiplier, acceleration, time to reduce error, and whether the active line crosses safety bounds.

### 70.8 Frame stability

- dropped-frame ratio;
- p95 frame controller time;
- long-task count;
- layout read count during active frames;
- visible single-frame position jumps.

## 71. Luna metrics

- request rate by mode;
- p50/p90/p95 latency;
- stale-response discard rate;
- input, cached-input, cache-write, output, and reasoning token usage;
- cost estimate per active hour;
- relation-class accuracy;
- exact candidate selection accuracy;
- landmark-retrieval recall and precision inside the eligible section;
- rate at which landmark retrieval opens the correct exact span;
- rate at which Luna improves an ambiguous decision;
- rate at which bounded Luna evidence would have harmed the local result;
- tips accepted/rejected by final validation;
- availability and fallback rate.

Luna must justify its complexity through evals. If a category does not improve measured behavior, keep it local or remove the call trigger.

## 72. Initial quantitative release gates

Calibrate exact values during Phase 0–7, but the release must satisfy these qualitative-to-quantitative gates:

1. **Zero prohibited uncommanded section jumps** across the full corpus.
2. **No target-position or target-derivative discontinuity at ordinary line wraps** beyond numerical tolerance.
3. **No visible per-transcript-event stepping** during linear reads.
4. **Ad-lib drift remains bounded** and does not consume multiple unsaid lines.
5. **Short retakes are followed reliably** without repeated forward/back oscillation.
6. **Large corrections re-anchor** rather than high-speed traversing a viewport.
7. **Local-only mode remains fully usable** when Luna is unavailable.
8. **Frame controller meets supported-platform performance budget** with Listener video active.
9. **Stage tips do not appear from provisional evidence** and obey cooldown.
10. **Manual and command navigation remain authoritative and deterministic.**

Starting numerical targets for evaluation, not immutable promises:

- linear-read p95 visual semantic error: at or below approximately one rendered line after acquisition;
- ad-lib coast: less than approximately one rendered line from the last credible position;
- false retake rate: effectively zero in clean linear/repeated-phrase test sets;
- ordinary stage controller frame cost: p95 below approximately `1 ms` on reference machines;
- ordinary line-boundary target-position delta: below `0.25 px` or equivalent device-pixel tolerance;
- ordinary line-boundary target-derivative delta: within the monotone spline’s numerical tolerance before clamps;
- no ordinary one-frame rendered jump above a tuned small-pixel threshold;
- Luna stale responses never alter state;
- coach false-positive rate low enough that testers do not disable the feature immediately.

## 73. Human comfort study

Before declaring the feature finished, run a structured comparison between:

- event-driven sentence anchoring from the original baseline;
- continuous line-handoff with local tracking;
- continuous line-handoff with Balanced Luna assist.

Each tester should deliver several scripts containing linear text, paraphrases, ad-libs, and retakes. Collect:

- perceived smoothness;
- ease of keeping eye position;
- whether the text felt ahead or behind;
- distraction from corrections;
- confidence during retakes;
- usefulness and distraction of tips;
- preference ranking;
- observed delivery errors;
- motion discomfort.

Use findings to tune profiles, not to add arbitrary animations.

---

# Part XIV — Implementation plan

## 74. Phase 0 — Instrumented baseline

Before adding Luna or a complex beam:

1. build deterministic transcript playback;
2. instrument current semantic and visual movement;
3. capture baseline stepping and error metrics;
4. add session-relative timestamps;
5. create representative rendered line maps;
6. verify stage frame diagnostics.

Exit criterion: the team can replay one recording and plot transcript evidence, semantic target, actual scroll, velocity, and line boundaries.

## 75. Phase 1 — Rendered line map and continuous target

Implement:

- token rect measurement;
- line grouping;
- layout generation validation;
- spoken-unit-to-line mapping;
- monotone cubic motion knots and shared-slope path;
- continuous line-handoff target and analytic derivative;
- line-boundary position and derivative continuity tests.

Use a synthetic semantic position first. Exit criterion: a fixed-rate virtual reader produces position- and velocity-continuous line transitions across varied layouts.

## 76. Phase 2 — Stage controller

Implement:

- persistent rAF loop;
- feed-forward target velocity;
- damped controller;
- velocity/acceleration/jerk limits;
- frame hitch handling;
- platform rendering benchmark;
- state profile switching.

Exit criterion: synthetic target changes produce smooth motion with no animation restarts or overshoot.

## 77. Phase 3 — Semantic pace filter

Implement:

- speech-unit coordinate;
- robust pace samples;
- prediction horizon;
- uncertainty and coast decay;
- bounded innovation;
- semantic frames.

Exit criterion: linear transcript fixtures continue moving naturally between final events and stop safely after evidence loss.

## 78. Phase 4 — Multi-hypothesis alignment and section graph

Implement:

- beam hypotheses;
- candidate scopes;
- section eligibility graph;
- repeated-passage index;
- transition priors;
- confidence distribution;
- skip and hold branches.

Exit criterion: corpus shows no remote section jumps and improved ambiguity handling over single-best alignment.

## 79. Phase 5 — Retakes and correction classes

Implement:

- retake features;
- retake persistence and epoch;
- nearby rewind;
- distant re-anchor;
- passed-style reset;
- delayed-event suppression.

Exit criterion: labeled retake fixtures pass with no oscillation and no false reverse on repeated forward text.

## 80. Phase 6 — Luna semantic sidecar

Implement:

- Rust structured request;
- strict schema;
- semantic landmark preparation and cache;
- hierarchical current-section landmark recovery;
- candidate-bounded exact-span prompt;
- scheduler lanes and cadence;
- stale/cancel policy;
- bounded fusion;
- usage accounting;
- Local/Balanced/Enhanced modes;
- fallback.

Exit criterion: Luna improves selected paraphrase/ambiguity scenarios without introducing prohibited transitions or critical-path dependence.

## 81. Phase 7 — Coaching

Implement:

- deterministic issue candidates;
- Luna validation where required;
- tip codes and hardcoded copy;
- arbitration, cooldown, and expiry;
- control and optional stage presentation;
- fidelity modes.

Exit criterion: no tip comes from provisional-only evidence and false-positive rate meets test threshold.

## 82. Phase 8 — Tuning and release validation

- tune profiles against corpus;
- run cross-platform stage tests;
- run human comfort study;
- profile with Listener video;
- verify privacy and cost behavior;
- lock versioned default profile;
- add migration/default settings;
- document known limitations.

---

# Part XV — Feature acceptance criteria

## 83. Normal smooth following

Complete only when:

- text moves continuously during a stable read;
- semantic movement continues between transcript events within the prediction budget;
- line handoff has no target jump;
- punctuation causes natural moderation, not repetitive braking;
- pace changes are followed without sudden speed steps;
- final transcript revisions do not visibly twitch the stage;
- behavior is comparable at 60 Hz and 120 Hz.

## 84. Slight deviations and paraphrases

Complete only when:

- common lexical variation is handled locally;
- close paraphrases do not cause unnecessary long freezes in Balanced intelligence;
- generic semantic overlap does not cause a jump;
- semantic advancement stays inside supplied candidate spans;
- local-only mode degrades conservatively rather than failing.

## 85. Ad-libs

Complete only when:

- the stage slows gracefully;
- drift is bounded;
- speech alone does not consume script;
- return to the current passage resumes smoothly;
- return to a later eligible passage uses catch-up or re-anchor correctly;
- distant-section phrases remain blocked.

## 86. Forward skips

Complete only when:

- small omissions are absorbed;
- medium skips catch up without crossing visual safety bounds;
- large skips re-anchor instead of racing;
- final evidence and margin gates are enforced;
- non-contiguous section skips require command/manual authority.

## 87. Retakes

Complete only when:

- current-sentence and previous-sentence restarts are detected reliably;
- nearby reverse motion is controlled and readable;
- distant restarts re-anchor;
- repeated generic phrases do not trigger false retakes;
- delayed old transcript events cannot undo the retake;
- passed styling resets correctly;
- forward progression resumes without being trapped behind the old high-water mark.

## 88. Luna sidecar

Complete only when:

- every preparation, retrieval, and classification response is schema-validated;
- candidate and landmark IDs are validated locally;
- stale responses are harmless;
- no Luna result can violate the section graph;
- timeout/quota errors leave local tracking operational;
- request cadence and token use are visible in diagnostics;
- user can disable it;
- stage motion never waits for it.

## 89. Coaching

Complete only when:

- tips are optional;
- stage tips are concise and rate-limited;
- no arbitrary model text reaches stage;
- critical-number/negation tips require high confidence;
- tips expire when context changes;
- control-only mode works;
- coaching does not alter semantic position directly.

## 90. Definition of done

This enhancement is done when all of the following are true:

1. The algorithm is implemented as a continuous state estimator and controller, not event-triggered scroll animations.
2. The rendered line map and line-handoff equation are tested across supported layouts.
3. The tracking engine maintains multiple plausible local hypotheses and an explicit hard section graph.
4. Non-contiguous section movement cannot occur without command/manual authority.
5. Pace, uncertainty, ad-lib, catch-up, retake, and re-anchor states have deterministic tests.
6. Luna preparation, landmark retrieval, and exact-candidate classification are section-bounded, structured, asynchronous, budgeted, and advisory.
7. Optional coaching uses validated codes and calm UI.
8. Cross-platform frame performance passes with Listener media active.
9. Corpus metrics and comfort testing demonstrate a material improvement over the event-driven baseline.
10. Diagnostics can explain every large or backward move without storing user text by default.

---

# Appendix A — Initial parameter hypotheses

These values are a coherent starting point for evaluation, not final product truth.

## A.1 Semantic prediction

| Parameter | Starting range |
|---|---:|
| Normal prediction horizon | `600–900 ms` |
| Uncertain prediction horizon | `150–400 ms` |
| Maximum coast distance | `< 1 rendered line` |
| Visual lead | `150–600 ms`, confidence-clamped |
| Short-term pace window | approximately `3–8 s` |
| Baseline pace window | approximately `15–45 s` |

## A.2 Alignment

| Parameter | Starting range |
|---|---:|
| Beam width | `8–16` |
| Local transcript tails | `6–12`, `12–24`, `24–50` meaningful tokens |
| Retake persistence | `3–6` meaningful final tokens or equivalent time |
| Ordinary local confidence | tune near original `0.75–0.8` hypothesis |
| Large skip confidence | higher than ordinary local transition |
| Retake confidence | higher than comparable forward transition |
| Non-contiguous section transition | prohibited |
| Luna score contribution | bounded to a modest fraction of total decision margin |

## A.3 Visual corrections

| Rendered distance | Default disposition |
|---|---|
| `< 0.5–1 line` | absorb |
| `~1–3 lines` | catch up |
| `> ~3 lines` or large viewport fraction | re-anchor |
| nearby backward span | rewind |
| distant backward span | re-anchor |

Use actual viewport and line geometry, not only fixed line counts.

## A.4 Luna scheduling

| Mode | Starting behavior |
|---|---|
| Local only | no Live semantic requests |
| Balanced | ambiguity-triggered; usually `2.5–5 s` minimum interval |
| Enhanced | periodic stable-window analysis; usually `1.5–3 s` minimum interval |
| Timeout | short enough that results remain relevant; stale checks mandatory |
| Reasoning effort | start `low`; evaluate lower supported settings |
| Output | strict compact schema, no free-form explanation |

## A.5 Coaching

| Parameter | Starting range |
|---|---:|
| Stage tip cooldown | `6–10 s` |
| Display time | `1.5–2.5 s` |
| Maximum visible tips | `1` |
| Provisional-only tip | prohibited |
| Generated model copy | prohibited |

---

# Appendix B — Core pseudocode

## B.1 Transcript update and hypothesis beam

```ts
function onAlignableTranscript(update: ReconciledTranscriptUpdate): void {
  if (!session.accepts(update)) return;

  const transcript = ledger.getAlignableTail({
    excludeItemIds: commandRouter.consumedItemIds(),
    finalizedHistoryUnits: profile.finalHistoryUnits,
    provisionalTailUnits: profile.provisionalTailUnits,
  });

  const predicted = semanticFilter.predict(update.sessionTimeMs);
  const eligibility = sectionGraph.context({
    sectionId: tracking.sectionId,
    committedUnit: semanticFilter.committedUnit,
    epoch: semanticFilter.epoch,
    authority: tracking.authority,
  });

  const candidates = candidateGenerator.generate({
    transcript,
    predicted,
    beam: hypothesisBeam.current(),
    eligibility,
    history: trackingHistory,
  });

  const nextBeam = hypothesisBeam.advance({
    transcript,
    candidates,
    sessionTimeMs: update.sessionTimeMs,
    finalEvidence: update.final,
    semanticEvidence: semanticAssistCache.currentEvidence(),
  });

  const measurement = measurementBuilder.fromBeam(nextBeam, {
    finalEvidence: update.final,
    transcriptRevision: update.revision,
  });

  const transition = transitionGate.evaluate(measurement, {
    sectionGraph,
    trackingHistory,
    currentEpoch: semanticFilter.epoch,
  });

  semanticFilter.observe(measurement, transition);
  paceEstimator.observe(measurement, transcript, update);
  trackingHistory.apply(measurement, transition);

  semanticAssistScheduler.observe({
    update,
    transcript,
    beam: nextBeam,
    measurement,
    transition,
  });

  emitSemanticMotionFrame();
}
```

## B.2 Hard section gate

```ts
function isEligibleTransition(
  from: ScriptLocation,
  to: ScriptLocation,
  context: SectionTransitionContext,
): boolean {
  if (context.authority === 'command' || context.authority === 'manual') {
    return context.authorizedTargetIds.has(to.targetId);
  }

  if (to.sectionId === from.sectionId) return true;

  if (
    to.sectionId === document.nextSectionId(from.sectionId) &&
    document.isNearSectionEnd(from.unit, context.forwardBoundaryWindowUnits) &&
    document.isNearSectionStart(to.unit, context.forwardBoundaryWindowUnits)
  ) {
    return true;
  }

  if (
    to.sectionId === document.previousSectionId(from.sectionId) &&
    context.recentlyCrossedBoundary &&
    context.retakeEvidenceStrong &&
    document.isNearSectionStart(from.unit, context.backwardBoundaryWindowUnits) &&
    document.isNearSectionEnd(to.unit, context.backwardBoundaryWindowUnits)
  ) {
    return true;
  }

  return false;
}
```

## B.3 Semantic filter sketch

```ts
function observeMeasurement(m: AlignmentMeasurement): void {
  const predicted = predict(m.sessionTimeMs);

  if (m.transitionProposal?.kind === 'prohibited') return;

  const variance = measurementVariance({
    confidence: m.confidence,
    margin: m.secondBestMargin,
    finalEvidence: m.finalEvidence,
    positionVariance: m.positionVariance,
    behavior: m.behavior,
  });

  const innovation = m.bestPosition - predicted.positionUnits;

  if (requiresReanchor(innovation, m)) {
    proposeStageTransition('reanchor', m);
    resetAroundAuthorizedMeasurement(m);
    return;
  }

  if (innovation < 0 && !retakeGate.isCommitted(m)) {
    enterRetakePending(m);
    return;
  }

  kalmanLikeUpdate(predicted, m.bestPosition, variance, {
    innovationClamp: innovationClampFor(m.behavior),
    velocityUpdateWeight: velocityWeightFor(m),
  });

  if (m.finalEvidence && m.committedCandidatePosition !== null) {
    committedUnit = commitAccordingToTransition(m);
  }
}
```

## B.4 Line-handoff target

```ts
function targetForUnit(unit: number, map: RenderedLineMap): LineTarget {
  const pathSample = map.sampleMotionPath(unit);
  if (pathSample) {
    return {
      lineId: pathSample.lineId,
      progress: pathSample.lineProgress,
      scrollPx: pathSample.scrollPx,
      derivativePxPerUnit: pathSample.derivativePxPerUnit,
    };
  }

  // Explicitly tested degraded fallback only. Production Voice Follow should
  // normally have a valid monotone cubic path for every spoken interval.
  const line = map.lineForUnit(unit);
  if (!line) return map.fallbackTarget(unit);

  const denominator = Math.max(
    line.spokenUnitEnd - line.spokenUnitStart,
    0.001,
  );
  const rawProgress = clamp(
    (unit - line.spokenUnitStart) / denominator,
    0,
    1,
  );
  const nextBaseline = line.nextBaselineY ?? line.virtualNextBaselineY;
  const p = fallbackHandoffCurve(rawProgress, settings.handoffSoftness);
  const baselineDelta = paragraphAdjustedDelta(
    line.baselineY,
    nextBaseline,
    line,
  );

  return {
    lineId: line.lineId,
    progress: rawProgress,
    scrollPx:
      line.baselineY - layout.readingLineStartY + p * baselineDelta,
    derivativePxPerUnit:
      fallbackHandoffDerivative(rawProgress, settings.handoffSoftness) *
      baselineDelta /
      denominator,
  };
}
```

## B.5 Stage frame loop

```ts
function frame(nowMs: number): void {
  const dt = clamp((nowMs - lastFrameMs) / 1000, 0, MAX_FRAME_DT_SECONDS);
  lastFrameMs = nowMs;

  const semantic = semanticFramePredictor.predict(nowMs);
  const target = linePlanner.targetForUnit(semantic.displayUnit, lineMap);
  const vTarget = target.derivativePxPerUnit * semantic.velocityUnitsPerSecond;

  const limits = motionProfiles.forState(semantic.state, settings.followFeel);
  const error = target.scrollPx - motion.q;

  let aDesired =
    limits.omega * limits.omega * error -
    2 * limits.zeta * limits.omega * (motion.v - vTarget);

  aDesired = clamp(aDesired, -limits.aMax, limits.aMax);
  motion.a = approach(motion.a, aDesired, limits.jerkMax * dt);
  motion.v = clamp(
    motion.v + motion.a * dt,
    -limits.vBackwardMax,
    limits.vForwardMax,
  );
  motion.q += motion.v * dt;

  if (isRestCondition(motion, target, limits)) {
    motion.q = target.scrollPx;
    motion.v = 0;
    motion.a = 0;
  }

  renderer.applyScrollPosition(motion.q);
  diagnostics.sample({ nowMs, semantic, target, motion });
  requestAnimationFrame(frame);
}
```

## B.6 Luna scheduler

```ts
function considerSemanticAssist(ctx: AssistSchedulingContext): void {
  if (settings.intelligenceMode === 'local_only') return;
  if (!ctx.hasNewFinalMeaningfulSpeech) return;
  if (ctx.commandPending || ctx.sessionPaused) return;
  if (budget.exhausted()) return;

  const trigger = classifyAssistTrigger(ctx);
  if (!trigger.material) return;

  pendingSnapshot = buildCandidateBoundedSnapshot(ctx, trigger);

  if (activeRequest && !trigger.supersedesActive) return;
  if (!cadenceGate.allows(trigger, ctx.sessionTimeMs)) return;

  const snapshot = pendingSnapshot;
  pendingSnapshot = null;
  activeRequest = openAiSemanticService.classify(snapshot);

  activeRequest.then((result) => {
    if (!isCurrentResult(result, snapshot, currentTrackingContext())) return;
    const validated = validateSemanticAssist(result, snapshot.candidateIds);
    semanticAssistCache.accept(validated, snapshot);
    trackingWorker.reconsiderLatestEvidence('semantic_assist');
  }).catch((error) => {
    handleAssistFailure(error);
  }).finally(() => {
    activeRequest = null;
  });
}
```

## B.7 Coach-tip gate

```ts
function maybePublishTip(candidate: CoachTipCandidate): void {
  if (!settings.coachingEnabled) return;
  if (!candidate.finalEvidence) return;
  if (candidate.epoch !== semanticFilter.epoch) return;
  if (candidate.confidence < thresholdFor(candidate.type)) return;
  if (tipHistory.isDuplicate(candidate)) return;
  if (!cooldown.allows(candidate.priority)) return;
  if (stageTransitionController.isBusy()) return;

  const tip = mapToHardcodedTip(candidate);
  if (!tip) return;

  controlTips.publish(tip);
  if (settings.stageCoaching && candidate.stageEligible) {
    stageTips.publish(tip);
  }
}
```

---

# Appendix C — Luna request contract

## C.1 System instruction

Use a concise stable instruction equivalent to:

```text
You classify how a presenter’s recent speech relates to a small set of eligible
nearby teleprompter script candidates. Select only a supplied candidate ID.
Never invent a location. Return unresolved rather than guessing. A candidate
marked retake may be selected only when the speech clearly restarts or corrects
recent material. A candidate marked forward may be selected for a paraphrase or
within-section skip. Classify ad-lib speech without advancing. Identify critical
changes only for negation, numbers, important names, omitted clauses, or meaning.
Return only the required structured result.
```

Do not ask the model to reveal reasoning.

## C.2 Dynamic payload example

```json
{
  "request_id": "assist_184",
  "semantic_epoch": 7,
  "transcript_revision": 993,
  "candidate_set_hash": "7c32...",
  "tracking_state": "uncertain",
  "current_section": {
    "id": "section_launch",
    "title": "Launching the product"
  },
  "recent_final_transcript": "and the easiest way is to start with the people who already trust you",
  "provisional_tail": "then expand",
  "candidates": [
    {
      "id": "cand_a",
      "relation_hint": "continuity",
      "distance": "near_forward",
      "text": "The simplest approach is to begin with customers who already know and trust you, then expand outward."
    },
    {
      "id": "cand_b",
      "relation_hint": "retake",
      "distance": "previous_sentence",
      "text": "Before you spend on acquisition, identify the audience that already trusts the product."
    }
  ],
  "critical_checks": [
    {
      "kind": "none",
      "script_fragment": null,
      "transcript_fragment": null
    }
  ]
}
```

## C.3 Strict JSON Schemas

Use these logical schemas through the current SDK’s strict Structured Outputs wrapper. The Rust request type and post-parse validator remain authoritative even when the SDK generates the wire schema.

### C.3.1 Candidate classification result

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "schemaVersion": { "type": "integer", "enum": [1] },
    "requestId": { "type": "string", "minLength": 1, "maxLength": 128 },
    "semanticEpoch": { "type": "integer", "minimum": 0 },
    "transcriptRevision": { "type": "integer", "minimum": 0 },
    "candidateSetHash": { "type": "string", "minLength": 1, "maxLength": 256 },
    "relation": {
      "type": "string",
      "enum": [
        "near_exact",
        "paraphrase",
        "adlib",
        "return_to_script",
        "restart",
        "self_correction",
        "forward_skip",
        "unresolved"
      ]
    },
    "selectedCandidateId": {
      "anyOf": [
        { "type": "string", "minLength": 1, "maxLength": 128 },
        { "type": "null" }
      ]
    },
    "selectedCandidateConfidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "transcriptCoverage": { "type": "number", "minimum": 0, "maximum": 1 },
    "candidateCoverage": { "type": "number", "minimum": 0, "maximum": 1 },
    "shouldInfluenceTracking": { "type": "boolean" },
    "criticalMismatch": {
      "type": "string",
      "enum": [
        "none",
        "negation",
        "number",
        "name",
        "meaning_change",
        "omitted_clause",
        "uncertain"
      ]
    },
    "coachTipCode": {
      "type": "string",
      "enum": [
        "none",
        "critical_word_changed",
        "number_changed",
        "name_changed",
        "meaningful_omission",
        "restart_detected"
      ]
    },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
  },
  "required": [
    "schemaVersion",
    "requestId",
    "semanticEpoch",
    "transcriptRevision",
    "candidateSetHash",
    "relation",
    "selectedCandidateId",
    "selectedCandidateConfidence",
    "transcriptCoverage",
    "candidateCoverage",
    "shouldInfluenceTracking",
    "criticalMismatch",
    "coachTipCode",
    "confidence"
  ]
}
```

### C.3.2 Landmark retrieval result

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "schemaVersion": { "type": "integer", "enum": [1] },
    "requestId": { "type": "string", "minLength": 1, "maxLength": 128 },
    "semanticEpoch": { "type": "integer", "minimum": 0 },
    "transcriptRevision": { "type": "integer", "minimum": 0 },
    "landmarkSetHash": { "type": "string", "minLength": 1, "maxLength": 256 },
    "relation": {
      "type": "string",
      "enum": [
        "likely_current_passage",
        "likely_forward_within_section",
        "likely_retake",
        "adlib",
        "unresolved"
      ]
    },
    "candidateLandmarkIds": {
      "type": "array",
      "minItems": 0,
      "maxItems": 3,
      "items": { "type": "string", "minLength": 1, "maxLength": 128 }
    },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
  },
  "required": [
    "schemaVersion",
    "requestId",
    "semanticEpoch",
    "transcriptRevision",
    "landmarkSetHash",
    "relation",
    "candidateLandmarkIds",
    "confidence"
  ]
}
```

### C.3.3 Landmark preparation result

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "schemaVersion": { "type": "integer", "enum": [1] },
    "requestId": { "type": "string", "minLength": 1, "maxLength": 128 },
    "scriptCompileHash": { "type": "string", "minLength": 1, "maxLength": 256 },
    "sectionId": { "type": "string", "minLength": 1, "maxLength": 256 },
    "annotations": {
      "type": "array",
      "maxItems": 128,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "spanId": { "type": "string", "minLength": 1, "maxLength": 128 },
          "proposition": { "type": "string", "minLength": 1, "maxLength": 240 },
          "topicLabels": {
            "type": "array",
            "maxItems": 6,
            "items": { "type": "string", "minLength": 1, "maxLength": 64 }
          },
          "criticalTerms": {
            "type": "array",
            "maxItems": 16,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": ["name", "number", "negation", "date", "currency", "meaning"]
                },
                "canonical": { "type": "string", "minLength": 1, "maxLength": 160 }
              },
              "required": ["kind", "canonical"]
            }
          },
          "conversationalAliases": {
            "type": "array",
            "maxItems": 12,
            "items": { "type": "string", "minLength": 1, "maxLength": 160 }
          },
          "exactness": {
            "type": "string",
            "enum": ["flexible", "balanced", "exact"]
          }
        },
        "required": [
          "spanId",
          "proposition",
          "topicLabels",
          "criticalTerms",
          "conversationalAliases",
          "exactness"
        ]
      }
    }
  },
  "required": [
    "schemaVersion",
    "requestId",
    "scriptCompileHash",
    "sectionId",
    "annotations"
  ]
}
```


## C.4 Response validation

After schema parsing:

- request ID must match;
- epoch and revision must match;
- candidate hash must match;
- selected candidate must exist or be null;
- `shouldInfluenceTracking` requires non-null selected candidate;
- relation and candidate direction must be compatible;
- confidences must be finite and in `[0, 1]`;
- a tip code must be compatible with `criticalMismatch`;
- unresolved/ad-lib normally has no selected advancing candidate;
- invalid combinations are discarded, not repaired through a second model call.

---

# Appendix D — Scenario traces

## D.1 Smooth linear read

1. Final phrase matches tokens 100–108.
2. Semantic filter estimates `2.4 units/s`.
3. Stage predicts within the `FOLLOWING` horizon.
4. Current line progress moves from `0.2` to `0.8` between transcript completions.
5. Line-handoff target moves continuously toward the next baseline.
6. New final phrase arrives near prediction; innovation is small.
7. Filter corrects without visible speed change.

Expected result: continuous motion and no line wrap bump.

## D.2 Brief ad-lib

1. Presenter is confidently following at token 220.
2. They add a five-second example.
3. Transcript insertions do not match the local script.
4. `COASTING` lasts only within the prediction and drift budget.
5. Stage decelerates into `ADLIB_HOLD` with token 220 context visible.
6. Presenter says the next scripted phrase near token 224.
7. Local sequence regains confidence; stage resumes with a gentle acceleration.

Expected result: no script consumption during the example.

## D.3 Paraphrase with Luna

1. Local lexical score is moderate for two nearby candidates.
2. Both candidates are inside the current section.
3. Balanced scheduler sends recent final transcript and the two candidate spans.
4. Luna marks `cand_a` as paraphrase with high confidence.
5. Bounded semantic evidence increases `cand_a`; local anchors and continuity already support it.
6. Semantic filter advances through only `cand_a`’s span.
7. Later exact words confirm the path.

Expected result: minimal hold and no arbitrary jump.

## D.4 Distant phrase collision

1. Transcript phrase exactly matches a distinctive sentence in Chapter 5.
2. Current cursor is in Chapter 2, far from a boundary.
3. Diagnostic global index finds the Chapter 5 occurrence.
4. Section graph marks it ineligible.
5. The candidate never enters the executable beam and is never sent to Luna.
6. Stage holds or follows the valid Chapter 2 candidate.

Expected result: zero remote section jump.

## D.5 Previous-sentence retake

1. Presenter has passed sentence B and begun C.
2. After a pause they repeat B’s distinctive opening.
3. A retake branch at B gains finalized anchors.
4. Forward branch remains possible until persistence threshold.
5. Retake commits; epoch increments.
6. Stage decelerates and reverses because B is within the reverse range.
7. Delayed completion from the old C item is rejected by epoch/source history.
8. Forward following resumes through B.

Expected result: one controlled reverse, no bounce.

## D.6 Large within-section skip

1. Presenter jumps four paragraphs ahead.
2. Local continuity fails; stage slows and holds.
3. Rare anchors identify one eligible later passage.
4. Final evidence and margin pass the large-skip gate.
5. Rendered distance exceeds catch-up threshold.
6. Stage re-anchors with a brief fade, then resumes.

Expected result: no rapid traversal through four paragraphs.

## D.7 Voice command to another chapter

1. Wake detector masks “CandidCue, go to chapter five.”
2. Deterministic command parser resolves the chapter.
3. Command authority increments epoch and resets section graph.
4. Stage uses a command re-anchor and optional acknowledgement.
5. Subsequent script speech acquires around Chapter 5.

Expected result: remote navigation is immediate and intentional.

---

# Appendix E — Primary specification override map

| Primary location | Companion treatment |
|---|---|
| §31.1 “Luna must never decide ordinary reading position” | Replace with bounded advisory semantic evidence. Luna never supplies unrestricted position and cannot be sole jump authority. |
| §31.3 candidate windows | Extend with multi-hypothesis beam and hard section eligibility graph. |
| §31.5 local sequence alignment | Retain and extend with multiple tails, hypothesis transitions, and semantic evidence. |
| §31.6 continuity prior | Replace simple distance prior across sections with zero-probability prohibited transitions. |
| §31.8 provisional policy | Tighten: no retake, large skip, remote boundary, or coaching from provisional-only evidence. |
| §31.10 ad-lib | Replace abrupt freeze concept with coast–decelerate–hold schedule and bounded drift. |
| §31.11 forward skip | Add absorb/catch-up/re-anchor classes based on rendered distance. |
| §31.12 retake | Add retake epoch, hysteresis, nearby rewind, distant re-anchor, and stale-event suppression. |
| §31.14 global reacquisition | Restrict executable search to current section and valid adjacent boundary corridor unless command/manual authority exists. |
| §32.1–32.5 | Replace event-oriented target movement with continuous semantic prediction, line-handoff trajectory, and jerk-limited controller. |
| §32.6 fixed/manual modes | Retain; automatic controller applies only to Voice follow and reacquisition into Voice follow. |
| §45.4 tracking worker | Extend with beam, semantic filter, pace estimator, section graph, Luna scheduler, and coach engine. |
| §46 IPC | Add semantic frames, transition directives, line-map generation acknowledgement, stage motion acknowledgements, and Luna classification command. |
| §55–57 testing/acceptance | Extend with motion corpus, prohibited-section invariant, Luna evals, coaching tests, and comfort study. |
| Appendix G.6 | Replace with Appendices B.3–B.5 here. |

---

# Appendix F — Research grounding

The implementation decisions are grounded in the following current platform facts and relevant technical literature. Research informs the architecture but does not substitute for CandidCue-specific evaluation.

## F.1 OpenAI platform

1. **OpenAI Realtime transcription guide** — transcription-only sessions, streaming deltas, `gpt-realtime-whisper`, manual commits when turn detection is omitted/null, latency settings, and transcript event handling.  
   https://developers.openai.com/api/docs/guides/realtime-transcription

2. **GPT-5.6 Luna model page** — text input/output, Responses API support, streaming, structured outputs, pricing, and model capabilities current at the research cut-off.  
   https://developers.openai.com/api/docs/models/gpt-5.6-luna

3. **Structured model outputs guide** — strict JSON-schema output and programmatic parsing/validation.  
   https://developers.openai.com/api/docs/guides/structured-outputs

4. **Reasoning models guide** — Responses API, model-dependent reasoning-effort controls, token budgeting, and latency/cost considerations.  
   https://developers.openai.com/api/docs/guides/reasoning

5. **Prompt caching guide** — exact-prefix caching, cache keys, GPT-5.6 cache writes/reads, and current breakpoint behavior.  
   https://developers.openai.com/api/docs/guides/prompt-caching

6. **Latency optimization guide** — generate fewer tokens, make fewer requests, parallelize, stream/chunk where useful, and do not default to an LLM when classical methods are better.  
   https://developers.openai.com/api/docs/guides/latency-optimization

## F.2 Online alignment and progress estimation

1. Park et al., **Matchmaker: An Open-Source Library for Real-Time Piano Score Following and Systematic Evaluation**. The paper summarizes online dynamic time warping, probabilistic state-space models, Kalman filters, and particle filters as major real-time alignment families. Its domain is music, but the separation between noisy observations, latent progress, tempo, hypotheses, and causal windows is directly relevant.  
   https://arxiv.org/html/2510.10087

2. De Lazzari et al., **Real-time human progress estimation with online dynamic time warping for collaborative robotics**. This work demonstrates open-ended online progress estimation under variable human execution. The application differs, but it reinforces the value of continuous progress estimation rather than discrete event matching.  
   https://www.frontiersin.org/journals/robotics-and-ai/articles/10.3389/frobt.2025.1623884/full

3. Henkel et al., **Real-Time Music Following in Score Sheet Images via Multi-Resolution Prediction**. Score following is another instance of causally synchronizing an imperfect live performance to a known reference.  
   https://www.frontiersin.org/journals/computer-science/articles/10.3389/fcomp.2021.718340/full

These sources motivate the hybrid design; CandidCue still requires a text-specific weighted alignment, hard navigation authority, and its own evaluation corpus.

## F.3 Moving text and eye behavior

Research on drifting and scrolling text reports that readers combine smooth-pursuit and saccadic eye movements when text moves. This does not prove one ideal CandidCue motion profile, but it supports avoiding needless velocity discontinuities and validating comfort empirically.

1. Valsecchi, Gegenfurtner, and Schütz, **Saccadic and smooth-pursuit eye movements during reading of drifting texts**, Journal of Vision, 2013.  
   https://pubmed.ncbi.nlm.nih.gov/23956456/

2. Akthar et al., **A comparison of reading, in people with simulated and actual central vision loss, using static and scrolling text**, Journal of Vision, 2021.  
   https://pmc.ncbi.nlm.nih.gov/articles/PMC8590178/

The product must rely on its teleprompter-specific comfort study rather than claiming that general reading studies dictate exact speed, line width, or anchor values.

---

# Final implementation instruction

Build the feature from the inside out:

1. stable semantic coordinate;
2. hard section authority;
3. continuous line geometry;
4. pace prediction;
5. jerk-limited motion;
6. retake and correction states;
7. Luna as bounded semantic evidence;
8. coaching only after the tracker is reliable.

Do not begin by adding more easing to the existing scroll calls. The required result depends on making position, pace, uncertainty, authority, and rendered motion explicit first-class state.
