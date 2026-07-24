# CandidCue Real-Time Speaking Quality Scoring System

**Technical design for a Rust/Tauri coaching rail using raw microphone audio and OpenAI Realtime transcription**  
**Document status:** Standalone coaching-system specification  
**Date:** 24 July 2026

---

## Executive recommendation

CandidCue can produce a useful live speaking score, but it should not attempt to answer the vague question, “How good is this person’s voice?” A reliable system should instead answer a narrower and more actionable question:

> **How closely does the speaker’s current delivery match the selected speaking style, given the evidence currently available?**

The recommended system has three separate outputs:

1. **Delivery score, 0–100** — the main number shown in the coaching rail.
2. **Evidence confidence, 0–1** — used internally to decide whether the score or a coaching prompt is trustworthy enough to display.
3. **Recording quality status** — clipping, background noise, microphone distance, dropouts, and similar technical faults. This should be shown separately and should not unfairly reduce the speaker’s delivery score.

The score should combine seven dimensions:

| Dimension | Weight |
|---|---:|
| Pace and tempo control | 18 |
| Pausing and phrasing | 18 |
| Vocal variety | 18 |
| Emphasis and message landing | 14 |
| Fluency and cleanliness | 18 |
| Clarity and vocal control | 9 |
| Consistency and sentence endings | 5 |
| **Total** | **100** |

The raw-audio path should provide most immediate feedback: voice activity, articulation speed, pause length, pitch movement, loudness movement, phrase endings, and recording quality. Transcription should add word count, lexical fillers, repetitions, script deviations, sentence structure, and script-aware emphasis. This division lets the score remain responsive even when the transcription arrives late.

The live interface should show only:

- the current score;
- one pace value;
- at most one short, actionable coaching instruction;
- one or two compact secondary indicators, such as vocal variety and recent fillers;
- a thin recent-event ribbon.

It should not become a dashboard while the user is recording.

The best first version is an interpretable, deterministic scoring engine with personalized baselines. A learned model can later replace or recalibrate parts of it after CandidCue has collected human-rated examples. A general-purpose language model should not sit in the real-time scoring loop.

---

## 1. Scope and design principles

### 1.1 Intended use

The primary use case is a speaker recording the final take of a scripted or semi-scripted video while reading from CandidCue. The feedback must therefore be:

- fast enough to influence the next sentence;
- stable enough not to distract;
- specific enough to act on;
- conservative enough not to produce false criticism;
- compact enough to fit in a narrow bottom rail;
- independent of the teleprompter’s tracking and scrolling logic.

The coaching subsystem consumes a read-only copy of audio, transcript, script alignment, and tracking state. It must never alter:

- the teleprompter scroll position;
- the semantic cursor;
- the microphone gain;
- the script;
- take/retake state;
- voice-command handling;
- recording pause state.

### 1.2 What the score should mean

A score of 100 should mean that the recent delivery is strongly inside the configured target ranges, not that the user is objectively a perfect orator. A score of 75 should mean that the delivery is broadly usable but has one or more controllable weaknesses. The score is a live instrument, not a permanent judgment of the speaker.

Suggested internal interpretation:

| Score | Interpretation |
|---:|---|
| 90–100 | Polished and strongly on target |
| 80–89 | Strong delivery with minor issues |
| 70–79 | Usable delivery with noticeable room to improve |
| 60–69 | Inconsistent delivery; one or more active problems |
| Below 60 | A clear, sustained delivery issue is present |

These labels need not be shown during recording. They are useful for calibration, testing, and post-take summaries.

### 1.3 What the score should not measure

The core score should not penalize:

- a naturally high or low voice;
- accent or dialect;
- age-related vocal characteristics;
- disability-related speech characteristics;
- vocal gender presentation;
- a quiet microphone preamp or loud recording chain;
- room noise that the speaker cannot immediately control;
- uncommon names or specialist terms that the recognizer transcribes poorly.

Absolute pitch in hertz is particularly unsuitable as a quality measure. Pitch movement should be converted to semitones and interpreted relative to the speaker’s own median and baseline.

### 1.4 “Ideal speaking” is style-dependent

Good speakers tend to sound controlled, intelligible, purposeful, rhythmically varied, and appropriately expressive. However, there is no single universal target. A calm technical explainer should not be pushed toward the delivery of an energetic short-form presenter, and a solemn narrative should not be scored like an advertisement.

CandidCue should eventually support style presets such as:

- **Conversational authority** — recommended default for creator and educational videos;
- **Energetic short-form** — faster, denser, wider vocal contrast;
- **Calm explainer** — slower, measured, lower emphasis density;
- **Storytelling** — wider pacing variation and longer dramatic pauses.

This report specifies initial values for **Conversational authority**. They are product starting points that must be tuned with real recordings, not universal scientific laws.

---

## 2. What makes a speaker pleasant and compelling to listen to

A strong orator does not maximize every acoustic feature. The desirable property is usually **intentional contrast**:

- fast enough to maintain energy, but not so fast that meaning blurs;
- enough silence to separate ideas, but not so much that momentum collapses;
- enough pitch and loudness movement to sound engaged, but not so much that the delivery sounds theatrical;
- enough emphasis to reveal the hierarchy of ideas, but not so much that every word sounds stressed;
- few disfluencies, without becoming unnaturally mechanical;
- controlled endings, without every sentence having the same contour;
- stable energy, with deliberate variation rather than accidental drift.

Research on charismatic and persuasive speech frequently finds associations with prosodic variation, rate, intensity, and voice quality, but the effects vary by language, context, sex, culture, and study design.[3][4][5] The product should therefore treat published findings as feature-selection evidence, not as a universal scoring formula.

The practical definition for CandidCue is:

> **A good delivery makes the structure and importance of the message audible.**

That principle translates directly into measurable features:

- idea boundaries should often coincide with pauses or prosodic resets;
- important words should be distinguishable from surrounding words;
- sentence endings should feel complete rather than rushed or abandoned;
- local tempo should change when meaning changes;
- hesitations should be rare and preferably replaced by silence;
- vocal movement should remain inside a natural range for that speaker.

---

## 3. Data sources and their realistic capabilities

## 3.1 Raw audio

Raw audio is the authoritative source for timing and acoustics. It can support:

- exact sample-level timing;
- speech/non-speech segmentation;
- pause durations;
- pitch and pitch movement;
- loudness and loudness movement;
- articulation-rate estimates from syllable nuclei;
- phrase boundaries;
- clipping and signal-to-noise estimates;
- trailing off;
- rushed endings;
- breath-group length;
- possible acoustic fillers and hesitation sounds;
- spectral voice-quality features, when used cautiously.

Raw audio can therefore generate useful coaching before any transcript is available.

## 3.2 OpenAI Realtime transcription

The current OpenAI Realtime transcription guide describes transcription-only sessions using `gpt-realtime-whisper`, 24 kHz mono PCM input, incremental delta events, and completed transcript events. For this model, turn detection should be omitted or set to `null`, with the application committing audio manually. Completion events across items are not guaranteed to arrive in order, so `item_id` must be used for reconciliation. The API also exposes a latency/accuracy setting, but OpenAI explicitly recommends benchmarking representative audio rather than assuming a fixed delay. Timestamp, confidence, and diarization support must be verified for the selected configuration, with fallbacks where unavailable.[1]

Transcription adds:

- stable word counts;
- detected lexical fillers;
- repetitions and restarts;
- sentence and clause hypotheses;
- script alignment;
- important-word and phrase identification;
- discourse-tic frequency;
- possible token log probabilities, when supported;
- transcript-revision behavior as a weak clarity signal.

### Important limitation: transcript arrival time is not speech time

The timestamp at which a delta reaches the app is affected by buffering, network latency, model delay, and server scheduling. It must not be used as the time at which the word was spoken.

Unless the selected API response provides verified word timestamps, the application should regard each committed audio item as a known time interval and the words inside it as initially untimed. Exact word timing should come from a local alignment stage or a later precision pass.

### Important limitation: filler preservation is not guaranteed

The documentation does not promise verbatim retention of every `um`, `uh`, `er`, or elongated hesitation sound. A transcription model may omit, normalize, or inconsistently render them, especially at low latency. `gpt-realtime-whisper` also does not currently support prompt steering in GA Realtime sessions, so CandidCue should not depend on a prompt such as “include all filler words.”[1]

The correct design is therefore a fused filler detector:

1. transcript evidence;
2. local acoustic evidence;
3. optional delayed precision transcription or forced alignment.

## 3.3 The script as a third contextual input

Although the two primary live data sources are audio and transcription, CandidCue already knows the script. That context materially improves coaching:

- words absent from the script are stronger filler candidates;
- repetitions, skipped words, and restarts are easier to identify;
- punctuation gives expected pause locations;
- sentence importance and keyword salience can be precomputed;
- the system can detect whether emphasis landed on an important word;
- a long pause at a paragraph boundary can be treated differently from a long pause inside a clause.

Script state should remain advisory. Coaching must not become a second tracking system.

---

## 4. Recommended real-time architecture

```text
Microphone / CPAL callback
          |
          v
Lock-free sample ring + monotonic sample counter
          |
          +--------------------+--------------------+
          |                    |                    |
          v                    v                    v
Raw recorder             Local DSP worker      Network audio worker
                              |                    |
                              |                    +--> resample/PCM16/Base64
                              |                    +--> OpenAI Realtime WebSocket
                              |                              |
                              |                              v
                              |                     transcript reconciler
                              |                              |
                              +---------------+--------------+
                                              |
                                              v
                                      metric fusion engine
                                              |
                                              v
                                       score + confidence
                                              |
                                              v
                                       coaching policy
                                              |
                                              v
                                    Tauri event bridge, 5–10 Hz
```

### 4.1 One capture, multiple consumers

The microphone should be opened once. The capture callback writes samples and timing metadata into a bounded single-producer ring. Downstream workers independently consume the same timeline for:

- final recording;
- local acoustic analysis;
- OpenAI streaming;
- optional replay/debug logging.

Opening separate capture streams for recording, transcription, and analysis risks clock drift, different preprocessing, and device contention.

### 4.2 Audio callback rules

The audio callback should:

- perform no heap allocation;
- acquire no contended mutex;
- do no network I/O;
- do no JSON serialization;
- avoid logging per frame;
- copy or reference samples into preallocated ring storage;
- increment a monotonic sample counter.

All expensive work belongs on worker threads.

### 4.3 Authoritative timebase

Every event should ultimately be expressed in the captured-audio timebase:

```text
audio_seconds = sample_index / capture_sample_rate
```

Use sample indices rather than wall-clock receipt times. The core timestamp type should carry both the sample index and source sample rate, or use a normalized integer timebase such as nanoseconds derived from the capture clock.

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct AudioTime {
    pub sample_index: u64,
    pub sample_rate: u32,
}

impl AudioTime {
    pub fn seconds(self) -> f64 {
        self.sample_index as f64 / self.sample_rate as f64
    }
}
```

### 4.4 Manual commit strategy for Realtime transcription

Because the current `gpt-realtime-whisper` configuration requires manual commits, CandidCue should use local voice activity and phrase-boundary evidence to choose commit points.[1]

Recommended initial policy:

- commit after a natural silence of approximately 250–450 ms;
- include a small pre-roll so initial consonants are not clipped;
- if speech continues without a natural boundary, force a commit after approximately 4–6 seconds at the lowest-energy local valley;
- never use network response timing to infer the boundary;
- benchmark alternative segment lengths because commit size affects both latency and recognition quality.

The forced maximum prevents a ten- or twenty-second uninterrupted sentence from withholding all lexical metrics. Segmenting at a low-energy valley is preferable to cutting at an arbitrary sample.

### 4.5 Commit ledger and item reconciliation

For every commit, store:

```rust
pub struct CommitSpan {
    pub local_commit_seq: u64,
    pub audio_start_sample: u64,
    pub audio_end_sample: u64,
    pub committed_at_sample: u64,
    pub server_item_id: Option<String>,
}
```

When the server provides the corresponding item identifier, bind it to this span. All subsequent delta and completed events are routed by `item_id`. Do not assume that completed events arrive in commit order.[1]

### 4.6 Tiered timing accuracy

CandidCue should explicitly support three timing tiers:

| Tier | Availability | Accuracy | Use |
|---|---|---|---|
| A. Immediate acoustic timing | Immediately | Exact for audio events; approximate for words | Live pauses, pitch, energy, articulation rate |
| B. Phrase/item timing | When transcript item arrives | Exact item span, words untimed | WPM, filler rate, repetitions, phrase-level coaching |
| C. Local word alignment | Shortly after item completion or post-take | Word/phoneme-level estimate | Precise filler markers, emphasis alignment, detailed review |

This prevents the rest of the system from pretending that phrase-level timing is word-level timing.

---

## 5. Analysis windows and update rates

Different phenomena require different windows. A single rolling window produces either a twitchy score or a sluggish coach.

| Layer | Suggested window | Update cadence | Purpose |
|---|---:|---:|---|
| Acoustic frame | 20–40 ms, 10 ms hop | 100 Hz internal | Pitch, energy, spectrum, voicing |
| Immediate state | 0.5–2 s | 10–20 Hz | Voice activity, loudness trend, local pitch trend |
| Fast issue detector | 3–6 s | 5–10 Hz | Rushing, sudden flatness, trailing off |
| Coaching detector | 8–12 s | 2–5 Hz | Filler clusters, choppiness, sustained monotony |
| Display score | 20–30 s with recency weighting | 5–10 Hz | Stable 0–100 score |
| Session baseline | 45–90 s and longer | 0.2–1 Hz | Personal normalization and drift |

The display score should use an **exponentially weighted moving average**, likely the term the product concept was reaching for. Recent delivery matters more than older delivery, but old evidence decays smoothly rather than falling out of a hard window.

For half-life `h` and elapsed time `Δt`:

```text
alpha = 1 - 2^(-Δt / h)
smoothed = previous + alpha × (current - previous)
```

Recommended starting values:

- underlying display-score half-life: 7–10 seconds;
- issue detector half-life: 2–3 seconds;
- maximum visible score movement: 2–3 points per second;
- score warm-up: at least 3 seconds of voiced audio and roughly 8 stable words;
- hold the score through short pauses up to about 1.5 seconds;
- after a longer silence, show a pause/listening state rather than allowing the score to collapse.

---

## 6. Complete feature catalogue

This section lists more factors than should be enabled in the first release. Each feature is marked by its best source:

- **A** — raw audio;
- **T** — transcript;
- **S** — script and script alignment;
- **F** — fused from multiple sources.

## 6.1 Pace and tempo

| Feature | Source | Measurement | Coaching value |
|---|---|---|---|
| Speaking rate | T + A | Stable words divided by elapsed span, including pauses | Familiar WPM display |
| Articulation rate | T + A | Stable words or syllables divided by active speech time | Separates fast articulation from excessive pausing |
| Acoustic syllable rate | A | Detected syllable nuclei per second | Immediate fallback before transcript arrives |
| Phrase-local rate | F | Rate per phrase or commit span | Detects local rushing or dragging |
| Pace drift | F | Slope of rate over 20–60 seconds | Detects gradual speeding up as confidence/adrenaline rises |
| Sentence-final acceleration | F | Final third rate versus first two thirds | Detects swallowing or rushing endings |
| Sentence-initial hesitation | F | Long onset delay or slow first phrase | Can indicate uncertain starts |
| Run-on duration | A | Continuous speech without a meaningful phrase pause | Identifies breathless delivery |
| Phrase length | F | Words and seconds per prosodic phrase | Finds phrases too long or too fragmented |
| Words per breath group | F | Words between likely inhalations/major pauses | Breath-control proxy |
| Pace variability | F | Distribution of phrase-local rates | Some variation is desirable; extremes are not |
| Deliberate tempo contrast | F + S | Slower rate around important or complex passages | Measures rhetorical shaping rather than mere consistency |
| Complexity-adjusted pace | T + S | Rate relative to word length, numbers, names, and syntax | Avoids penalizing careful delivery of difficult material |
| Recovery after pause | A | Rate immediately after a long pause | Detects panic acceleration |
| Rate regularity | A | Inter-syllable interval variation | Flags mechanical/metronomic delivery when excessively uniform |

### Recommended distinction

Show **WPM** to the user because it is easy to understand. Internally, rely more heavily on **articulation rate** and phrase-local rate because WPM alone confounds speaking speed with silence.

## 6.2 Pausing and phrasing

| Feature | Source | Measurement | Coaching value |
|---|---|---|---|
| Pause ratio | A | Silent duration divided by recent elapsed duration | Detects too little or too much silence |
| Pause frequency | A | Meaningful pauses per minute | Broad rhythm indicator |
| Pause duration distribution | A | Median, P75, P90, variance | Distinguishes healthy phrasing from occasional stalls |
| Clause-boundary pause | A + S | Silence near comma/phrase boundary | Positive phrasing signal |
| Sentence-boundary pause | A + S | Silence near sentence punctuation | Positive landing/reset signal |
| Paragraph-boundary pause | A + S | Silence near paragraph transition | Allows longer intentional pauses |
| Mid-word or mid-phrase pause | F | Pause inside a strongly connected phrase | Hesitation signal |
| Long unplanned pause | F + S | Silence above threshold away from a valid boundary | Coaching prompt candidate |
| Missing boundary pause | A + S | Repeated punctuation boundaries crossed without separation | Run-on signal |
| Micro-pause density | A | Frequent 100–400 ms gaps | Choppy delivery signal |
| Pause uniformity | A | Low variance across repeated pauses | Can identify unnatural metronomic phrasing |
| Post-key-line landing pause | A + S | Silence after a high-salience statement | Positive rhetorical signal |
| Pre-keyword pause | A + S | Brief separation before an important phrase | Can create anticipation when not overused |
| False-start pause | T + A | Pause after an abandoned fragment | Fluency issue |
| Breath timing | A | Likely inhale at sensible phrase boundary | Breath-control signal |
| Audible gasp | A | High-frequency inhalation with depleted phrase energy | Possible “take the next breath” prompt |
| Silence after filler | F | Filled pause followed by additional silence | Strong hesitation cluster |
| Restart cadence | F | Pause followed by repeated phrase start | Repair signal |

Pauses should be judged by **location as well as length**. An 1100 ms pause after an important sentence may improve delivery; the same pause between an article and noun is likely disruptive.

## 6.3 Pitch and intonation

| Feature | Source | Measurement | Coaching value |
|---|---|---|---|
| Median fundamental frequency | A | Voiced-frame F0 median | Personal baseline only, not quality |
| Pitch range | A | P90–P10 F0 in semitones | Main vocal-variety measure |
| Pitch dispersion | A | Standard deviation/IQR in semitones | Detects flatness or instability |
| Contour diversity | A | Variety of rising, falling, arch, and level phrase contours | More meaningful than range alone |
| Phrase pitch reset | A + S | New phrase begins above/below previous endpoint | Marks structural separation |
| Sentence terminal contour | A + T/S | Rise/fall/level over final voiced portion | Detects repeated upspeak or incomplete endings |
| Question/declarative match | A + T/S | Terminal contour relative to sentence type | Context-sensitive control |
| Emphatic pitch excursion | A + S | Local pitch peak/trough on salient word | Indicates intentional emphasis |
| Monotony fraction | A | Proportion of voiced time within a narrow pitch band | Sustained flatness signal |
| Excessive pitch volatility | A | Very wide rapid movement unsupported by syntax | Flags affected or unstable delivery |
| Pitch declination | A | Gradual phrase-level F0 fall | Normal phrase shape; extreme fall may sound depleted |
| Pitch floor/ceiling contact | A | Repeated clipping at personal extremes | Possible strain or limited control |
| Register drift | A | Median F0 shift over session | Fatigue, tension, or changing performance style |
| Boundary tone repetition | A | Same ending contour across many sentences | Repetitive cadence signal |
| Pitch-accent density | A + S | Number of strong pitch events per content word | Too few sounds flat; too many sounds over-emphasized |

Convert F0 to semitones before measuring movement:

```text
pitch_st = 12 × log2(F0_hz / reference_hz)
```

The reference can be any fixed value because differences in semitones are invariant. For personalization, subtract the speaker’s rolling or calibrated median.

## 6.4 Loudness, energy, and dynamic control

| Feature | Source | Measurement | Coaching value |
|---|---|---|---|
| Relative loudness range | A | P90–P10 log-energy or short-term loudness | Vocal-dynamics measure |
| Phrase energy contour | A | Beginning/middle/end loudness shape | Detects trailing off |
| Loudness peak rate | A | Salient energy peaks per second/phrase | Expressiveness/rhythm cue |
| Emphasis energy | A + S | Local energy increase on salient words | Keyword emphasis cue |
| Energy stability | A | Slow drift after normalization | Detects fading or inconsistent projection |
| Phrase-final drop | A | Final 0.5–0.9 s relative to phrase median | “Finish strongly” cue |
| Phrase-final spike | A | Sudden loud ending | Possible over-punching |
| Dynamic contrast | A + S | Difference between background words and focal words | Indicates hierarchy of meaning |
| Over-compression/AGC pumping | A | Envelope behavior inconsistent with natural dynamics | Recording-quality warning; suppress some scoring |
| Plosive bursts | A | Low-frequency transient peaks | Recording-quality feedback |
| Sibilance excess | A | High-frequency transient energy | Recording-quality feedback |
| Clipping | A | Samples near digital full scale and flat-topped peaks | Urgent recording warning |
| Microphone-distance drift | A | Coupled loudness/spectral shift over time | Recording-quality warning |

Use loudness relative to the speaker’s own recent baseline. Absolute amplitude depends heavily on microphone gain and distance.

## 6.5 Fluency, fillers, and repairs

| Feature | Source | Measurement | Coaching value |
|---|---|---|---|
| Filled pauses | F | `um`, `uh`, `er`, `ah`, language-specific forms | Main filler count |
| Filler position | T + S | Start, boundary, or middle of phrase | Medial fillers can receive greater penalty |
| Filler clusters | F | Two or more likely fillers within a short interval | Strong prompt candidate |
| Filler duration | A + T | Acoustic duration of hesitation | Long fillers are more disruptive |
| Repeated word | T + S | Immediate unigram repetition | Repair/disfluency signal |
| Repeated phrase | T + S | Repeated n-gram or script span | Restart signal |
| False start | T + S | Abandoned phrase followed by reformulation | Fluency signal |
| Self-correction | T + S | “X—sorry—Y” or script repair | Can be flagged in final-take mode |
| Discourse tics | T | Repeated `basically`, `actually`, `you know`, `I mean` | Context-sensitive frequency measure |
| Contextual `like` | T | Discourse-marker use, not verb/preposition use | Avoids false positives |
| Contextual `so` | T | Repeated sentence-opening tic, not every conjunction | Avoids false positives |
| Contextual `and` | T + S | Repeated/inserted conjunction or restart marker | Never count every `and` as a filler |
| Elongated hesitation vowel | A | Long steady vowel outside expected word timing | Catches fillers omitted by transcript |
| Abandoned clause | T + S | Incomplete syntax followed by restart | Fluency signal |
| Script insertion | T + S | Extra words not in script | Candidate filler or improvisation |
| Script omission | T + S | Skipped script span | Separate delivery/accuracy event |
| Script substitution | T + S | Misread word or paraphrase | Post-take or low-weight live metric |
| Repair latency | A + T | Time taken to resume after an error | Severity measure |
| Filler-to-silence substitution | F | Trend toward shorter fillers and cleaner pauses | Positive improvement signal |

Research using controlled synthesized speech found that filled-pause presence and position, speech rate, and F0 all affected perceived confidence, with medial fillers particularly detrimental in that experiment.[6] That is useful evidence for weighting filler location, but it should not be treated as a universal psychological law.

### Why `and` must not be naively counted

`And` is a normal conjunction. A lexical counter would punish perfectly grammatical language. Treat it as a likely tic only when one or more of these conditions hold:

- it is repeated (`and—and—then`);
- it appears where the script has no conjunction and the alignment indicates a restart;
- it repeatedly opens sentences beyond a configurable frequency;
- it is accompanied by a hesitation pause or acoustic repair;
- a classifier identifies discourse-marker rather than syntactic use.

The same rule applies to `so`, `like`, `well`, and `right`.

## 6.6 Emphasis and rhetorical shaping

| Feature | Source | Measurement | Coaching value |
|---|---|---|---|
| Keyword emphasis alignment | A + S | Pitch, energy, and duration prominence on salient words | Core message-landing metric |
| Emphasis selectivity | A + S | Share of content words marked prominent | Avoids flatness and over-emphasis |
| Key-line landing | A + S | Prominence plus controlled terminal contour plus pause | Strong positive signal |
| Contrastive emphasis | A + S | Difference between contrasted script terms | Measures rhetorical clarity |
| List rhythm | A + S | Prosodic parallelism across list items | Useful for enumerations |
| Rule-of-three shape | A + S | Increasing/decreasing contour across three items | Optional advanced feature |
| Paragraph reset | A + S | Pause plus pitch/energy reset at new paragraph | Structural clarity |
| Question setup | A + S | Prosodic rise/contrast before answer | Story/teaching cue |
| Reveal/punchline timing | A + S | Pre-reveal pause and focal prominence | Style-specific advanced feature |
| Important-word slowdown | A + S | Local duration/rate reduction near dense content | Processing-time cue |
| De-emphasis of function words | A + T | Relative prominence of content versus function words | Natural stress-pattern proxy |
| Emphasis repetition | A + S | Same stress pattern across every phrase | Mechanical cadence signal |
| Emotional congruence | A + S | Delivery features relative to script intent | Later learned feature; not reliable enough for v1 |

### Precomputing script salience

Before recording, compute a lightweight salience map from the script. A deterministic first version can assign importance using:

- headings and paragraph endings;
- bold/italic user markup;
- nouns, verbs, adjectives, numbers, names, and contrast terms;
- repeated thesis terms;
- sentence position;
- punctuation such as colon, dash, and question mark;
- user-pinned “land this line” markers.

A language model may optionally generate a richer salience map before the take. It should not be consulted continuously during the live score.

## 6.7 Clarity and vocal control

| Feature | Source | Measurement | Coaching value |
|---|---|---|---|
| Transcript confidence/log probability | T | Token/item confidence where supported | Weak clarity evidence, never sole judgment |
| Transcript revision/churn | T | Degree of partial-text change before completion | Weak evidence of ambiguous audio |
| Low-confidence clusters | T + S | Multiple uncertain common words in sequence | Possible articulation issue |
| Proper-noun exception | T + S | Suppress penalty for names/domain terms | Prevents recognizer bias |
| Vowel/consonant contrast proxy | A | Spectro-temporal modulation features | Advanced articulation proxy |
| High-frequency consonant energy | A | Relative energy in consonant bands | Very microphone-dependent; optional |
| Voicing stability | A | Stable periodicity during voiced segments | Voice-control cue, cautiously used |
| Harmonics-to-noise ratio | A | Periodic versus noise-like energy | Optional personalized voice-quality feature |
| Jitter and shimmer | A | Cycle-to-cycle F0/amplitude variability | Research feature; avoid core live score |
| Spectral tilt | A | Energy slope across spectrum | Optional fullness/breathiness proxy |
| Formant stability | A | Resonance movement/dispersion | Research/advanced feature |
| Breath depletion | A | Falling energy and pitch control late in long phrase | Actionable breath-management cue |
| Articulatory undershoot | F | Fast speech plus rising ASR uncertainty | “Slow slightly” evidence |
| Slurring proxy | F | High rate, low consonant contrast, transcript errors | Only with high confidence and personalization |

The eGeMAPS research feature set provides a useful standardized inventory of acoustic descriptors including F0, jitter, shimmer, loudness, harmonics-to-noise measures, formants, spectral slopes, alpha ratio, and temporal functionals.[2] CandidCue should use this as an engineering reference, not import all features into the score. Many voice-quality features are sensitive to microphones, health, anatomy, and identity.

## 6.8 Consistency and endings

| Feature | Source | Measurement | Coaching value |
|---|---|---|---|
| Sentence-final rate change | F | Ending rate versus sentence body | Detects rushed endings |
| Sentence-final loudness drop | A | Final energy versus phrase median | Detects trailing off |
| Sentence-final pitch repetition | A | Repeated identical terminal contour | Detects repetitive cadence |
| Incomplete ending | F | Flat/weak ending plus transcript/syntax incompleteness | “Finish the sentence” cue |
| Breath exhaustion at ending | A | Long phrase plus depleted energy/voicing | Breath cue |
| Session pace drift | F | Rate change across minutes | Sustained control measure |
| Session energy drift | A | Relative loudness change across minutes | Fatigue/distance measure |
| Session variety drift | A | Pitch/loudness range change across minutes | Fatigue or habituation measure |
| Performance volatility | F | Large dimension-score swings | Overall control measure |
| Recovery quality | F | Return to target after error/pause | Positive control signal |

## 6.9 Recording quality — separate from delivery

| Feature | Source | UI behavior |
|---|---|---|
| Clipping | A | Immediate warning; suppress loudness scoring if severe |
| Very low signal | A | “Move closer to the microphone” |
| Background noise/SNR | A | Quality badge; lower evidence confidence |
| Hum/tonal noise | A | Quality badge or setup warning |
| Reverberation | A | Setup warning; reduce clarity-feature confidence |
| Bluetooth narrowband audio | A/device metadata | Setup warning |
| Dropouts/discontinuities | A | Urgent recording warning |
| Automatic gain pumping | A | Disable or down-weight loudness dynamics |
| Microphone distance drift | A | Quality prompt |
| Plosives | A | Setup/post-take warning |
| Sibilance | A | Setup/post-take warning |
| Channel imbalance | A | Recording warning for stereo inputs |

A noisy recording should not tell the speaker that their delivery is poor. Instead, it should say that the system cannot confidently judge certain dimensions.

---

## 7. Signal-processing design

## 7.1 Capture and normalization

Recommended capture behavior:

- accept the device’s native supported sample rate and format;
- convert samples to `f32` for internal DSP;
- downmix to mono for analysis and transcription while retaining original channels for the recording if desired;
- apply a gentle analysis-only high-pass filter around 60–90 Hz to remove rumble;
- do not apply aggressive denoising or compression before measuring dynamics;
- maintain both raw and analysis signals where preprocessing could alter metrics;
- resample a dedicated branch to 24 kHz mono PCM16 for OpenAI.[1]

Candidate Rust components include CPAL for low-level audio I/O, Rubato for sample-rate conversion, RealFFT/RustFFT for spectral features, and `ort` if small ONNX models are added.[8][9][10][11]

## 7.2 Voice activity detection

Local VAD is central because it controls:

- active-speech time;
- pause measurement;
- phrase boundaries;
- commit decisions;
- pitch-analysis gating;
- silence-aware score behavior.

A robust design can combine:

1. adaptive energy threshold relative to a rolling noise floor;
2. spectral flatness and low-frequency-noise rejection;
3. voicing probability;
4. an optional small neural VAD model run locally.

Use hysteresis:

- speech onset should require several positive frames;
- speech offset should require a longer run of negative frames;
- preserve 100–250 ms of pre-roll and short hangover;
- expose both hard speech state and a continuous confidence.

Local VAD should remain authoritative for CandidCue timing even if future OpenAI configurations support server VAD.

## 7.3 Pitch extraction

Use a YIN, pYIN-like, autocorrelation, or neural pitch estimator. For ordinary creator speech, a classical estimator is likely adequate and cheaper.

Suggested frame configuration:

- 30–50 ms analysis frame;
- 10 ms hop;
- speaker-appropriate search range, initially broad;
- reject frames below a voicing-confidence threshold;
- median-filter isolated octave errors;
- convert valid F0 to semitones;
- summarize with robust percentiles rather than min/max.

Preferred statistics:

- median;
- P10 and P90;
- interquartile range;
- P90–P10 range;
- local slope;
- contour class by phrase;
- percentage of voiced time within ±1 semitone of local median.

## 7.4 Loudness and energy

Use short-term log RMS or a lightweight perceptual loudness approximation. Full broadcast-loudness compliance is not required for live coaching, but frequency weighting can improve robustness.

Suggested processing:

- 20–40 ms frames;
- 10 ms hop;
- analysis-only high-pass filter;
- convert to dB;
- normalize relative to calibrated/session median;
- use P10/P50/P90 and phrase-relative contours;
- detect clipping from the pre-normalized signal;
- detect gain-control pumping before trusting dynamic range.

## 7.5 Syllable-nucleus detection

An immediate pace proxy can be derived from peaks in a smoothed voiced-energy envelope:

1. band-limit toward vowel energy;
2. compute energy envelope;
3. identify peaks above adaptive prominence;
4. reject peaks too close together;
5. gate with VAD and optional voicing;
6. count probable syllable nuclei per active second.

This is not exact, but it responds within hundreds of milliseconds. Once transcript words and a pronunciation/syllable estimate arrive, blend toward the transcript-derived rate.

## 7.6 Phrase segmentation

A phrase boundary probability can combine:

- silence duration;
- pre-boundary syllable lengthening;
- pitch reset;
- phrase-final pitch movement;
- energy decline;
- punctuation/script boundary proximity;
- transcript completion.

This allows the system to distinguish a genuine rhetorical phrase boundary from a momentary low-energy consonant or breath.

## 7.7 Acoustic hesitation/filler detector

A practical local filler detector should be candidate-driven rather than classify every audio frame.

### Candidate generation

Create a candidate when one or more of these occur:

- a 200–1500 ms voiced segment sits between pauses;
- the segment has unusually stable vowel-like energy and F0;
- the transcript contains `um`, `uh`, `er`, or a nearby uncertain token;
- a script alignment gap appears between expected words;
- a repeated/restarted phrase has a short vocalization between attempts.

### Classifier

A small model can classify log-mel patches into classes such as:

- `um/uh/er/ah`;
- lexical vowel/word;
- breath;
- silence/noise;
- non-speech mouth sound.

A compact CNN, CRNN, or audio transformer exported to ONNX should be sufficient. The model should output calibrated probabilities and run only on candidates.

### Fusion

A simple first fusion rule is:

```text
P(filler) = 1 - (1 - P_text) × (1 - P_audio) × (1 - P_alignment)
```

This assumes partially independent evidence and can later be replaced with a calibrated logistic model. Record the evidence sources so the UI can suppress low-confidence markers.

## 7.8 Transcript reconciliation

Maintain a mutable record per transcription item:

```rust
pub struct TranscriptItem {
    pub item_id: String,
    pub audio_start_sample: u64,
    pub audio_end_sample: u64,
    pub partial_text: String,
    pub final_text: Option<String>,
    pub revision_count: u32,
    pub logprob_summary: Option<f32>,
    pub words: Vec<TimedWord>,
}

pub struct TimedWord {
    pub text: String,
    pub start_sample: Option<u64>,
    pub end_sample: Option<u64>,
    pub confidence: f32,
}
```

Do not permanently count a partial token the first time it appears. Suggested stability states:

- **provisional** — newly received;
- **stable partial** — persisted across sufficient updates or clearly delimited;
- **final** — included in completed transcript;
- **aligned** — assigned local word timing.

Only stable partial or final tokens should affect the visible filler count. Final text should reconcile any prior provisional counts without causing a visible score jump larger than the smoothing cap.

## 7.9 Local word alignment

When an item completes, CandidCue knows:

- exact audio interval;
- final item transcript;
- VAD/voiced regions;
- syllable peaks;
- possibly the expected script span.

A staged alignment strategy:

1. tokenize the final transcript;
2. align it to the expected script with weighted edit distance or dynamic time warping;
3. estimate word durations from syllable counts and lexical length;
4. allocate words across voiced islands;
5. refine boundaries using acoustic valleys;
6. optionally run a local CTC/phoneme aligner for higher precision.

Until a real aligner is available, mark timing confidence as approximate. Do not imply sample-level accuracy in the UI.

---

## 8. Default target profile: Conversational Authority

These values are recommended engineering starting points. They should be represented as soft ranges with tolerances, not binary pass/fail rules.

| Metric | Initial target | Soft warning region | Notes |
|---|---:|---:|---|
| Speaking rate | 135–175 WPM | 115–195 WPM | Context and speaker-specific |
| Articulation rate | 3.5–5.5 syllables/s | 3.0–6.2 | Better than WPM for local speed |
| Pace drift | Within ±12% over 30 s | ±12–22% | Exclude intended section changes |
| Sentence-final acceleration | Under +18% | +18–30% | Compare final third to earlier sentence |
| Continuous run-on speech | Under 10–12 s | 12–16 s | Phrase boundaries matter |
| Clause pause | 180–650 ms | 100–900 ms | Not every comma needs silence |
| Sentence pause | 350–1200 ms | 200–1800 ms | Key lines may be longer |
| Interior long pause | Under 1.8 s | 1.8–3.0 s | Suppress at paragraph/key-line boundaries |
| Pause ratio | Roughly 12–28% | 8–35% | Style and script dependent |
| Pitch range, 20 s | About 4–10 semitones | 2.5–13 | Personalize rapidly; do not use absolute Hz |
| Relative loudness range, 20 s | About 6–14 dB | 3–18 dB | Trust only with stable gain |
| Filled pauses, final take | 0–1 per 100 words | 2–4 per 100 | Strong issue above 5 or clustered |
| Restart/repetition rate | 0–1 per 100 words | 2–3 per 100 | Scripted mode can be strict |
| Strong-emphasis density | 10–25% of content words | 5–35% | Depends on script style |
| Phrase-final energy loss | Less than ~6 dB | 6–10 dB | Relative to phrase body |
| Coaching prompt frequency | No more than 4–6/min | — | Product constraint, not speech metric |

Published conversational rate measurements vary with topic, turn length, relationship, age, language, and other factors; one large-corpus study reported topic-level English averages around 152–170 WPM in part of its analysis.[7] That supports using a broad, configurable range rather than a single “correct” WPM.

### 8.1 Fast personalization

After 45–90 seconds of representative speech, adjust:

- pitch target around the user’s healthy range;
- loudness target around their stable microphone level;
- normal phrase length;
- median rate and comfortable rate variation;
- baseline ASR uncertainty for accent and vocabulary;
- typical sentence-ending contour.

Personalization should not simply bless every habit. It should separate **speaker identity** from **controllable deviation**. For example, the center of the pitch distribution is personalized, while an extremely narrow range can still trigger a flatness suggestion.

### 8.2 Explicit user targets

Let users choose or set:

- target WPM;
- delivery preset;
- strictness of filler coaching;
- whether repeated sentence-final rises should be coached;
- whether script deviations count;
- coaching sensitivity.

These settings should alter target bands and prompt thresholds, not create independent ad hoc logic.

---

## 9. Scoring model

## 9.1 Metric representation

Every metric estimate should carry:

```rust
pub struct MetricSample {
    pub metric: MetricId,
    pub at_sample: u64,
    pub value: f32,
    pub confidence: f32,
    pub evidence_span_samples: u64,
    pub source_mask: EvidenceSource,
}
```

A metric without enough evidence should have low confidence rather than a fabricated neutral score.

## 9.2 Scoring a target band

For a metric with preferred range `[L, U]`, calculate distance from the band:

```text
d = 0,                         if L ≤ x ≤ U
    L - x,                     if x < L
    x - U,                     if x > U
```

Then use a smooth penalty:

```text
metric_score = 100 × exp(-0.5 × (d / sigma)^2)
```

` sigma ` determines how quickly the score falls outside the target. This produces a flat desirable region and avoids discontinuities at thresholds.

For a lower-is-better metric such as fillers:

```text
d = max(0, x - U)
metric_score = 100 × exp(-0.5 × (d / sigma)^2)
```

For a higher-is-better metric, mirror the formula around a lower threshold.

## 9.3 Asymmetric penalties

Some metrics need different low-side and high-side tolerances. Speaking too fast may be more damaging than speaking slightly below target in a calm explainer preset. Use `sigma_low` and `sigma_high` rather than forcing symmetry.

```text
if x < L: score with sigma_low
if x > U: score with sigma_high
```

## 9.4 Confidence-weighted dimension scores

For dimension `k` with submetrics `i`:

```text
D_k = sum(w_i × c_i × s_i) / sum(w_i × c_i)
```

where:

- `w_i` is the configured metric weight;
- `c_i` is evidence confidence;
- `s_i` is the metric score.

If the denominator is too small, the dimension is unavailable rather than assumed to be 100.

## 9.5 Recommended submetric weights

### Pace and tempo control — 18 points

| Submetric | Points |
|---|---:|
| WPM target fit | 6 |
| Articulation/acoustic syllable rate | 4 |
| Pace stability and drift | 4 |
| Phrase length, run-ons, and ending acceleration | 4 |

### Pausing and phrasing — 18 points

| Submetric | Points |
|---|---:|
| Overall pause amount | 4 |
| Pause-duration distribution | 4 |
| Semantic placement at clause/sentence boundaries | 6 |
| Choppy versus run-on balance | 4 |

### Vocal variety — 18 points

| Submetric | Points |
|---|---:|
| Pitch range | 5 |
| Contour diversity | 4 |
| Relative loudness range | 4 |
| Phrase pitch resets | 2 |
| Sustained monotony index | 3 |

### Emphasis and message landing — 14 points

| Submetric | Points |
|---|---:|
| Keyword-emphasis alignment | 6 |
| Selective contrast rather than stressing everything | 3 |
| Key-line landing pause and ending | 3 |
| Paragraph/list/rhetorical shaping | 2 |

### Fluency and cleanliness — 18 points

| Submetric | Points |
|---|---:|
| Filled pauses | 7 |
| Repetitions, false starts, and restarts | 5 |
| Context-sensitive discourse tics | 3 |
| Script repairs/deviations in final-take mode | 3 |

### Clarity and vocal control — 9 points

| Submetric | Points |
|---|---:|
| ASR stability/confidence, with exclusions | 4 |
| Likely articulation problems | 2 |
| Breath and energy control | 3 |

### Consistency and sentence endings — 5 points

| Submetric | Points |
|---|---:|
| Sentence-final control | 3 |
| Sustained delivery stability and recovery | 2 |

## 9.6 Overall score

A simple weighted mean can hide one bad dimension. A speaker with excellent variety but unintelligibly fast pace should not receive a very high overall score.

Recommended formula:

```text
mean_score = weighted mean of available dimension scores
weak_score = weighted 25th percentile of available dimension scores
raw_overall = 0.75 × mean_score + 0.25 × weak_score
```

Then:

1. apply temporal smoothing;
2. cap visible change per second;
3. clamp to 0–100;
4. do not add separate penalties for events already represented in dimensions;
5. freeze or suppress when evidence confidence is insufficient.

The weak-dimension component makes a persistent flaw visible without allowing a single noisy metric to dominate.

## 9.7 Evidence confidence

Overall evidence confidence can combine:

```text
C = coverage × signal_quality × transcript_stability × calibration_maturity
```

Possible components:

- **coverage** — enough recent voiced audio and words;
- **signal quality** — VAD/pitch/energy are trustworthy;
- **transcript stability** — final or stable text is available;
- **calibration maturity** — enough personal baseline data exists.

Recommended behavior:

| Confidence | UI behavior |
|---:|---|
| Below 0.35 | Show `Listening…`; no score or prompt |
| 0.35–0.55 | Show subdued/estimated score; only urgent acoustic prompts |
| 0.55–0.75 | Normal score; conservative prompts |
| Above 0.75 | Full coaching policy available |

Confidence should not be shown as another large number. It can control score opacity, a small ring, or whether the score is replaced by an ellipsis.

## 9.8 Avoiding score shock when transcript corrections arrive

A completed item may add or remove a filler, change the word count, or resolve a repetition. To avoid sudden jumps:

- provisional transcript evidence receives a low confidence;
- final evidence increases confidence gradually over 0.5–1.5 seconds;
- corrected event counts replace provisional counts rather than stacking;
- the visible score remains subject to the rate-of-change cap;
- an old prompt is not retracted instantly unless it was based entirely on invalidated evidence.

---

## 10. Real-time coaching policy

The coaching message is more important than the exact score. It converts diagnosis into a controllable action.

## 10.1 One prompt at a time

The rail should never show a list of simultaneous criticisms. Select one prompt using:

```text
priority = severity × confidence × actionability × persistence × novelty
```

Then apply exclusions and cooldowns.

### Suggested priority order

1. urgent recording failure: clipping, no audio, dropout;
2. severe pace or breath problem;
3. severe pause problem;
4. sustained flatness or trailing endings;
5. filler/restart cluster;
6. weak emphasis or rhetorical-shaping suggestion;
7. minor optimization.

Recording problems use a distinct visual status and should not alter the delivery score.

## 10.2 Prompt timing

Do not change the prompt in the middle of a word or during a demanding phrase. Prefer to reveal a new prompt:

- after 160–300 ms of local silence;
- at a phrase boundary;
- after a transcript item completes;
- immediately only for urgent recording faults.

A prompt should remain visible long enough to read, generally 2.5–5 seconds, unless replaced by a more urgent issue.

## 10.3 Hysteresis and cooldown

Each issue should have separate enter and exit thresholds.

Example for fast speech:

- enter when smoothed rate is above the high target by a meaningful margin for 2.5–3.5 seconds;
- clear only after rate is inside the target for 3–5 seconds;
- do not show the same prompt again for 8–12 seconds unless severity becomes critical.

This prevents the rail from alternating between “slow down” and “good pace.”

## 10.4 Prompt wording

Prompts should be two to five words, imperative, and directly controllable:

| Problem | Preferred prompt |
|---|---|
| Mildly fast | `Slow slightly` |
| Very fast | `Give the words more space` |
| Too slow | `Lift the pace` |
| Run-on delivery | `Pause at the next idea` |
| Excessive long gaps | `Keep the thought moving` |
| Choppy phrasing | `Connect the phrase` |
| Flat pitch/loudness | `Add vocal contrast` |
| Weak important line | `Land the key words` |
| Trailing endings | `Finish the sentence strongly` |
| Rushed endings | `Do not rush the ending` |
| Filler cluster | `Replace fillers with silence` |
| Breath depletion | `Take the next breath` |
| Repetitive upspeak | `Let the sentence settle` |
| Over-emphasis | `Stress fewer words` |
| Clipping | `Reduce microphone level` |
| Low signal | `Move closer to the microphone` |

Avoid vague messages such as `Be more engaging`, `Sound confident`, or `Improve tone`.

## 10.5 Suggested issue rules

These are initial product rules, to be calibrated.

### Speaking too fast

Trigger when:

- phrase-local WPM exceeds the preset high band;
- acoustic syllable rate agrees;
- condition persists for roughly 3 seconds;
- confidence exceeds 0.65.

Increase severity when ASR uncertainty also rises or sentence-final acceleration is present.

### Speaking too slowly

Trigger when:

- articulation rate, not merely WPM, is below target for approximately 5 seconds;
- the interval is not a key-line landing pause;
- the script is not unusually difficult;
- confidence exceeds 0.65.

### No meaningful pauses

Trigger when either:

- continuous speech lasts longer than roughly 10–12 seconds without a phrase boundary; or
- three or more expected clause/sentence boundaries are crossed without a pause or prosodic reset.

Prompt: `Pause at the next idea`.

### Excessively long pause

Trigger when:

- silence exceeds roughly 1.8 seconds inside a sentence or phrase;
- it is not a paragraph boundary, marked dramatic pause, retake, or command interval;
- the speaker has not simply finished the section.

Prompt: `Keep the thought moving`.

### Choppy delivery

Trigger when, over about 10 seconds:

- many pauses fall in the 150–450 ms range;
- median phrase length is very short;
- script alignment suggests the pauses are inside connected phrases.

Prompt: `Connect the phrase`.

### Flat delivery

Trigger when, over 10–15 seconds of sufficient voiced audio:

- pitch range and contour diversity are below personalized targets;
- loudness contrast is also low or unavailable;
- the script contains opportunities for emphasis;
- the recording chain is not compressing dynamics.

Prompt: `Add vocal contrast`.

Do not trigger based on low absolute pitch.

### Filler cluster

Trigger when:

- two high-confidence fillers occur within roughly 8–12 seconds; or
- filler rate exceeds the strict final-take threshold;
- transcript and/or acoustic evidence is sufficiently strong.

Prompt: `Replace fillers with silence`.

A single low-confidence `um` should create an event marker, not necessarily a prompt.

### Trailing off

Trigger when:

- phrase-final loudness drops roughly 6–10 dB below phrase body;
- the drop occurs repeatedly across two or more sentences;
- low signal or AGC does not explain it.

Prompt: `Finish the sentence strongly`.

### Rushed ending

Trigger when:

- the final third of a sentence is approximately 20–25% faster than the earlier portion;
- phrase-final pause or boundary lengthening is absent;
- the pattern repeats.

Prompt: `Do not rush the ending`.

### Weak message landing

Trigger when, across several phrases:

- high-salience words fail to align with pitch, loudness, or duration prominence;
- emphasis density is generally low;
- confidence in word timing is adequate.

Prompt: `Land the key words`.

This should be a later-phase feature because it depends on alignment quality.

### Over-emphasis

Trigger when:

- a very high share of content words receive similar prominence;
- pitch/loudness peaks are dense and uniform;
- the system has enough personal calibration.

Prompt: `Stress fewer words`.

## 10.6 Positive reinforcement

Sparse positive feedback can reduce the feeling of constant criticism. Examples:

- `Good pace`;
- `Strong landing`;
- `Clean pause`.

Show positive messages only when:

- no issue deserves the center slot;
- a previously weak dimension has clearly improved;
- the message is not repeated frequently.

The score itself should usually provide enough positive reinforcement.

---

## 11. Compact bottom-rail design

## 11.1 Recommended information architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│  84   Pace 162 ↘      SLOW SLIGHTLY       Variety: Good     Fillers: 1    │
│  ━━━━━●━━━━━━━━━━▲━━━━━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
└────────────────────────────────────────────────────────────────────────────┘
```

Suggested regions:

1. **Score** — large enough to glance at, but not visually dominant.
2. **Pace** — current smoothed WPM plus a trend arrow.
3. **Center coaching instruction** — one short message.
4. **Secondary state** — vocal variety label and recent filler count.
5. **Event ribbon** — 20–30 seconds of tiny markers for filler, rush, pause, or strong landing.

The event ribbon gives temporal context without requiring a graph. It can reveal, for example, that the score fell because two fillers occurred close together.

## 11.2 What not to show live

Do not show all of these simultaneously:

- pitch in hertz;
- decibel values;
- seven dimension scores;
- detailed waveform;
- transcript-confidence percentages;
- a full pause histogram;
- a list of detected problems;
- raw classifier labels.

Those belong in a post-take review.

## 11.3 Score behavior

- Show `—` or `Listening…` during warm-up.
- Do not animate every sub-point change.
- Update numerically at about 2–5 Hz even if internal snapshots run at 10 Hz.
- Cap movement to prevent the number becoming a slot machine.
- Hold through normal pauses.
- If confidence collapses, fade or replace the number rather than showing a false low score.
- A recording fault should appear as a separate badge/message.

## 11.4 Pace display

Recommended display:

```text
Pace 162 ↘
```

The arrow represents smoothed trend, not whether the value is good or bad. The value can receive a subtle target-state treatment internally, but the center instruction should carry the actionable message.

## 11.5 Variety display

Do not show raw semitone range. Use a compact categorical state:

- `Flat`;
- `Low`;
- `Good`;
- `High`;
- `Too animated`.

The label should require 8–12 seconds of evidence and use personalized targets.

## 11.6 Filler display

Show a recent count rather than a lifetime count:

```text
Fillers 1
```

Recommended window: last 60 seconds or current section. A long-session cumulative count can make improvement feel impossible after an early mistake.

## 11.7 Event ribbon

Suggested event codes:

| Event | Marker meaning |
|---|---|
| `F` | High-confidence filler |
| `P` | Long or misplaced pause |
| `R` | Rushed phrase/ending |
| `T` | Trailing ending |
| `E` | Strong key-line emphasis/landing |
| `Q` | Recording-quality event |

The UI can use distinct shapes rather than letters. Markers should be clickable only after the take, not while recording.

---

## 12. Rust/Tauri implementation design

## 12.1 Suggested modules

```text
src-tauri/src/coaching/
├── capture.rs
├── audio_clock.rs
├── ring_buffer.rs
├── resample.rs
├── realtime_client.rs
├── commit_controller.rs
├── transcript_reconciler.rs
├── vad.rs
├── pitch.rs
├── loudness.rs
├── spectrum.rs
├── syllables.rs
├── phrase_segmenter.rs
├── filler_detector.rs
├── script_alignment.rs
├── metrics.rs
├── targets.rs
├── scoring.rs
├── coaching_policy.rs
├── replay.rs
└── events.rs
```

## 12.2 Core data structures

```rust
use std::sync::Arc;

pub struct AudioFrame {
    pub start_sample: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Arc<[f32]>,
}

pub struct SpeechSegment {
    pub start_sample: u64,
    pub end_sample: u64,
    pub confidence: f32,
}

pub struct AcousticFrame {
    pub at_sample: u64,
    pub vad_probability: f32,
    pub rms_db: f32,
    pub peak: f32,
    pub pitch_hz: Option<f32>,
    pub pitch_confidence: f32,
    pub spectral_centroid_hz: f32,
    pub spectral_flatness: f32,
}

pub struct DimensionScore {
    pub value: f32,
    pub confidence: f32,
}

pub struct ScoreSnapshot {
    pub at_sample: u64,
    pub overall: Option<f32>,
    pub evidence_confidence: f32,
    pub pace_wpm: Option<f32>,
    pub pace_trend: f32,
    pub recent_fillers: u16,
    pub dimensions: DeliveryDimensions,
    pub active_tip: Option<CoachTip>,
    pub recording_quality: RecordingQuality,
}
```

## 12.3 Concurrency model

Recommended workers:

1. **Audio callback thread** — writes native samples into a lock-free SPSC ring.
2. **Recorder worker** — writes final audio/video synchronization stream.
3. **DSP worker** — computes frame features, VAD, phrase state, and candidate events.
4. **Network worker** — resamples/encodes audio and handles the OpenAI WebSocket.
5. **Transcript worker** — reconciles items and runs script alignment.
6. **Metric/score worker** — fuses evidence and updates score snapshots.
7. **UI bridge** — emits bounded Tauri events.

Use bounded channels everywhere. If a nonessential analysis consumer falls behind, drop intermediate analysis frames or coalesce snapshots; never block or drop recording audio.

## 12.4 Frontend event rate

Do not emit one Tauri event per 10 ms acoustic frame. Emit:

- score snapshots at 5–10 Hz;
- visible numeric updates at 2–5 Hz if desired;
- prompt changes only when state changes;
- event-ribbon markers when confirmed;
- recording-quality changes immediately.

A compact payload might be:

```rust
#[derive(serde::Serialize)]
pub struct CoachingRailPayload {
    pub score: Option<u8>,
    pub confidence_state: ConfidenceState,
    pub wpm: Option<u16>,
    pub pace_trend: i8,
    pub variety: VarietyState,
    pub fillers_recent: u16,
    pub prompt: Option<String>,
    pub quality_alert: Option<QualityAlert>,
    pub new_events: Vec<RailEvent>,
}
```

## 12.5 Candidate crate stack

At the time of implementation, validate versions and platform behavior, but likely components are:

| Need | Candidate |
|---|---|
| Cross-platform audio capture | `cpal` |
| Lock-free/SPSC audio transport | `rtrb`, `ringbuf`, or custom preallocated SPSC ring |
| Resampling | `rubato` |
| FFT/spectral processing | `realfft` / `rustfft` |
| WebSocket | `tokio-tungstenite` or the project’s existing async client |
| Serialization | `serde`, `serde_json` |
| ONNX inference | `ort` |
| WAV/replay fixtures | `hound` or equivalent |
| Numeric utilities | `ndarray`, small custom rolling-stat structures |

The critical decision is not the exact crate. It is preserving a deterministic audio timebase and keeping the capture path real-time safe.

## 12.6 Rolling-stat implementation

Avoid storing every frame for every metric. Maintain:

- deques for bounded short windows;
- online mean/variance using Welford-style updates;
- approximate or exact rolling percentiles over modest windows;
- EWMAs for trends;
- event queues indexed by sample time;
- robust median/MAD for personal baselines.

For pitch and loudness percentiles over 20–30 seconds, a bounded histogram or quantile sketch can reduce allocations.

## 12.7 Deterministic replay

Every live analysis component should run against a recorded fixture using the same audio timebase. A replay file should contain:

- WAV/PCM audio;
- script;
- committed-audio spans;
- raw Realtime events with arrival times and item IDs;
- expected metric/event ranges;
- optional human labels.

This allows debugging without speaking into the microphone and makes score regressions testable.

---

## 13. Script alignment

## 13.1 Alignment goals

The alignment subsystem should provide coaching with:

- expected current script range;
- matched words;
- inserted transcript words;
- omitted script words;
- repetitions/restarts;
- punctuation and salience near the current phrase.

It should not dictate teleprompter position.

## 13.2 Suggested algorithm

Use a rolling weighted edit-distance or dynamic-programming alignment between stable transcript tokens and a bounded script window.

Costs can be adjusted for:

- common ASR confusions;
- punctuation;
- case;
- contractions;
- filler insertions;
- repeated script words;
- phonetic similarity;
- known names and custom vocabulary.

The alignment output should include confidence. Low-confidence alignment disables script-aware pause and emphasis penalties rather than guessing.

## 13.3 Pause placement from script

Assign expected-boundary strengths:

| Script cue | Boundary strength |
|---|---:|
| Inside ordinary phrase | 0.0 |
| Comma or light clause break | 0.35 |
| Colon/semicolon/dash | 0.55 |
| Sentence end | 0.75 |
| Paragraph end | 1.0 |
| User-marked dramatic pause | 1.0 plus longer target |

The pause score compares observed boundary evidence with expected strength. It should permit prosodic separation without literal silence; a pitch reset and boundary lengthening may be enough.

## 13.4 Emphasis alignment

For every candidate content word, calculate acoustic prominence from:

```text
prominence = a × pitch_excursion
           + b × relative_loudness
           + c × relative_duration
           + d × boundary_proximity
```

Normalize each component within the speaker and local phrase. Compare the rank of acoustic prominence with script salience rather than demanding a fixed dB or semitone increase on every important word.

---

## 14. Filler detection in detail

## 14.1 Lexical layers

Use at least three dictionaries:

1. **Unambiguous vocal fillers** — `um`, `uh`, `erm`, `er`, language equivalents.
2. **Contextual discourse fillers** — `like`, `you know`, `I mean`, `basically`, `actually`, `well`, `right`, `so`.
3. **Repair markers** — repeated `and`, `but`, `so`, partial words, explicit self-correction phrases.

Each entry should define:

- language;
- lexical variants;
- whether context classification is required;
- default severity;
- phrase-position modifier;
- whether it appears in the script;
- minimum transcript confidence.

## 14.2 Context classifier

A deterministic v1 can classify contextual fillers using:

- part-of-speech role;
- immediate neighboring words;
- sentence position;
- repetition;
- script presence/absence;
- nearby pause;
- syntactic removability.

A later small text classifier can predict `semantic word`, `discourse marker`, `repair marker`, or `uncertain` from a short token window.

## 14.3 Severity

Suggested relative event severities:

| Event | Base severity |
|---|---:|
| Boundary `um` before a new thought | 0.6 |
| Medial `um` interrupting a phrase | 1.0 |
| Very short uncertain acoustic filler | 0.3 |
| Repeated discourse tic | 0.4–0.8 |
| Filler plus restart | 1.2 |
| Two fillers within 8 seconds | cluster multiplier 1.4 |

These values affect the fluency metric, not direct point subtraction from the final score.

## 14.4 False-positive controls

Suppress or lower confidence when:

- the token is in the script;
- the recognizer has low confidence;
- the audio classifier disagrees strongly;
- the word has a clear syntactic role;
- the alignment around it is uncertain;
- it occurs during a voice command or non-script interaction;
- another speaker or playback audio may be present.

## 14.5 Delayed correction

If the transcript later removes a suspected filler:

- mark the event retracted internally;
- remove it from the recent rate;
- fade or remove its ribbon marker;
- do not abruptly add points to the score;
- log the correction for detector evaluation.

---

## 15. Separating delivery from recording quality

This separation is essential for user trust.

### Delivery score examples

- WPM too high;
- no pauses at idea boundaries;
- repetitive fillers;
- pitch/loudness movement too limited;
- sentence endings repeatedly rushed;
- important words not differentiated.

### Recording-quality examples

- microphone clipping;
- fan or room noise;
- echo;
- input too quiet;
- automatic gain control destroying dynamics;
- Bluetooth bandwidth limitation;
- sample dropouts.

A recording fault affects **evidence confidence** for dependent metrics:

- severe compression lowers confidence in loudness-range and trailing-off metrics;
- low SNR lowers VAD, pitch, and acoustic-filler confidence;
- clipping lowers pitch and spectral-feature confidence;
- reverberation lowers pause-boundary and articulation-feature confidence.

It should not mechanically subtract, for example, 15 delivery points.

---

## 16. Personalization, fairness, and calibration

## 16.1 Speaker normalization

Normalize features as follows:

- pitch: semitones relative to personal median;
- loudness: dB relative to calibrated/session median;
- range: robust percentiles relative to personal distribution;
- pace: preset target plus user-selected target;
- ASR confidence: relative to user/accent baseline and vocabulary;
- sentence endings: compare patterns within the speaker, not with one gendered norm.

## 16.2 Calibration session

A lightweight calibration can ask the user to read 30–60 seconds in a comfortable voice. It estimates:

- noise floor;
- stable microphone level;
- voiced pitch range;
- likely pitch floor and ceiling;
- baseline speech rate;
- ASR error/confidence baseline;
- room/gain behavior.

The app should continue adapting slowly during normal use, while protecting against a single bad take redefining the baseline.

## 16.3 Avoiding accent bias

ASR confidence and transcript disagreement are partly model-performance signals. They should never be treated as direct proof of poor pronunciation. Mitigations:

- low weight in the total score;
- no penalty for names, technical terms, or custom vocabulary;
- personal baseline;
- fusion with acoustic rate and signal quality;
- evaluation across accents;
- a setting to disable articulation coaching;
- script alignment that tolerates recognizer substitutions.

## 16.4 Language-specific profiles

Prosodic targets differ across languages, especially tonal versus non-tonal languages. A 2026 study of Mandarin public-speaking competition data found different predictive patterns than many English/German-oriented findings and reported sex-specific effects within that dataset.[5] CandidCue should therefore maintain language-specific feature weights and avoid applying English pitch-contour assumptions universally.

---

## 17. Learning a better score later

## 17.1 Why not start with a neural “orator score”

A black-box model would initially have:

- no product-specific labels;
- unclear bias;
- poor explainability;
- difficulty generating precise coaching;
- high risk of learning microphone, accent, speaker identity, or content rather than controllable delivery.

A deterministic engine produces interpretable data and creates the labels needed for a learned model.

## 17.2 Training data

Build a dataset of 8–30 second clips rated by multiple listeners on:

- pace appropriateness;
- clarity;
- fluency;
- vocal variety;
- emphasis/message landing;
- confidence/naturalness;
- overall listenability.

Also annotate concrete events:

- filler;
- long pause;
- misplaced pause;
- rush;
- trailing ending;
- flat passage;
- over-emphasis;
- strong landing.

Use speaker-grouped train/test splits so the model cannot succeed by recognizing speakers.

## 17.3 Suitable models

Good first learned models include:

- ordinal logistic regression;
- gradient-boosted trees;
- calibrated random forest;
- a small temporal model over interpretable features.

Inputs should be measurable feature summaries, not raw identity-rich audio in the first learned version.

## 17.4 Calibration to 0–100

The model output can be mapped to the product scale using:

- isotonic regression;
- Platt-style calibration;
- percentile mapping against rated examples;
- preset-specific calibration.

A 10-point score difference should correspond to a meaningful difference in human ratings or intervention outcomes.

## 17.5 Intervention-based evaluation

The most useful product metric is not merely correlation with raters. It is whether the coaching helps.

For each prompt type, measure:

```text
improvement = target_metric(next 5–15 s) - target_metric(previous 5–15 s)
```

Examples:

- after `Slow slightly`, did articulation rate move toward target without clarity falling?
- after `Replace fillers with silence`, did filler rate decline?
- after `Finish the sentence strongly`, did phrase-final energy improve?
- after `Add vocal contrast`, did pitch/energy prominence become more selective?

Prompts that are accurate but do not improve delivery should be rewritten or removed.

---

## 18. Testing and evaluation

## 18.1 Technical tests

### Audio/timebase

- no dropped capture samples under sustained load;
- one monotonic clock across recorder, DSP, and network branches;
- resampling ratio remains stable;
- local feature timestamps and recorded audio remain within 40 ms over a 10-minute test;
- commit spans do not overlap or leave accidental gaps;
- out-of-order transcript completions reconcile correctly by item ID.

### Real-time behavior

- DSP does not allocate in the capture callback;
- UI event rate remains bounded;
- score update latency for local metrics is below approximately 150 ms;
- network delay cannot stall recording or local coaching;
- disconnect/reconnect does not corrupt commit-to-audio mapping;
- unsupported logprob/timestamp fields fail gracefully.

### Determinism

- replaying the same audio and transcript event log produces the same metric events within numeric tolerance;
- score snapshots are versioned by scoring configuration;
- target-profile changes are reproducible.

## 18.2 Detection tests

Create a labeled evaluation set containing:

- clean scripted speech;
- accents and second-language speakers;
- very fast and very slow delivery;
- deliberate dramatic pauses;
- accidental stalls;
- fillers retained and omitted by ASR;
- grammatical `and`, `so`, and `like` uses;
- discourse-marker uses;
- sentence-final rushing;
- trailing endings;
- flat and highly animated speech;
- clipping, noise, echo, and AGC;
- specialist names and terminology.

Measure:

- event precision and recall;
- prompt false-positive rate;
- time-to-detection;
- prompt persistence and repetition;
- score correlation with human ratings;
- score test-retest stability;
- subgroup performance by accent/language/voice range;
- effect of prompts on subsequent delivery.

## 18.3 Product acceptance targets

Recommended initial engineering targets:

| Target | Initial goal |
|---|---:|
| Local score snapshot latency | Under 150 ms |
| UI snapshot rate | 5–10 Hz |
| Visible score movement | No more than 2–3 points/s |
| Prompt frequency | Normally no more than 4–6/min |
| Prompt repeat cooldown | 8–12 s |
| Audio drops | Zero under supported hardware load |
| Long-session timing drift | Under 40 ms over 10 min |
| Warm-up before score | About 3 s voiced audio + 8 stable words |
| CPU budget | Profile toward a low single-digit share of a modern desktop CPU core |
| Memory | Bounded; no unbounded transcript/audio queues |

Event precision/recall targets should be set after the first labeled dataset. Arbitrary targets before seeing the class ambiguity would create false confidence.

---

## 19. Phased implementation roadmap

## Phase 0 — instrumentation and timing proof

Build before scoring:

- one microphone capture fan-out;
- monotonic sample clock;
- raw recorder;
- DSP-frame logging;
- OpenAI Realtime client;
- manual commit controller;
- item-ID reconciliation;
- deterministic event log and replay tool.

Exit criteria:

- audio and event timing stays aligned over long sessions;
- out-of-order completion handling is proven;
- representative latency is measured for each OpenAI delay setting;
- filler retention is benchmarked on real user speech rather than assumed.

## Phase 1 — useful deterministic live score

Implement:

- local VAD;
- WPM plus acoustic syllable-rate fallback;
- articulation rate;
- pause amount and long-pause/run-on detection;
- pitch range/monotony;
- relative loudness range;
- transcript filler lexicon;
- repetition detection;
- seven-dimension score and confidence;
- compact rail with one prompt;
- clipping/low-signal quality alerts.

This phase is sufficient to create a genuinely useful product.

## Phase 2 — phrase and script intelligence

Add:

- weighted rolling script alignment;
- pause-placement scoring;
- sentence-final acceleration;
- trailing-off detection;
- script-aware fillers and repairs;
- keyword salience;
- phrase-level emphasis matching;
- event ribbon and post-take markers.

## Phase 3 — acoustic filler and personalized profiles

Add:

- local filler candidate model;
- transcript/audio/alignment fusion;
- 45–90 second personal baseline;
- delivery presets;
- language-specific configuration;
- microphone/AGC detection;
- stronger confidence calibration.

## Phase 4 — learned calibration and post-take precision

Add:

- local word/phoneme alignment;
- human-rated clip dataset;
- learned dimension calibration;
- intervention-effect testing;
- detailed post-take timeline and recommendations.

---

## 20. Recommended v1 product specification

For the first shipping version, calculate these live metrics:

1. speaking WPM;
2. articulation-rate estimate;
3. current pace trend;
4. continuous-run duration;
5. pause ratio;
6. long/misplaced pause events;
7. micro-pause/choppiness index;
8. pitch range in semitones;
9. pitch monotony fraction;
10. relative loudness range;
11. phrase-final energy drop;
12. transcript filler count;
13. filler cluster rate;
14. immediate word/phrase repetition;
15. sentence-final acceleration;
16. clipping;
17. low signal/noise confidence;
18. overall evidence confidence.

Use these to populate the seven dimensions, but initially leave advanced emphasis metrics with low or zero weight until alignment is reliable.

The live rail should be:

```text
[Score]  [Pace WPM + trend]  [One coaching prompt]  [Variety]  [Recent fillers]
[Thin 20–30 second event ribbon]
```

Default coaching prompts should be limited to:

- `Slow slightly`;
- `Lift the pace`;
- `Pause at the next idea`;
- `Keep the thought moving`;
- `Connect the phrase`;
- `Add vocal contrast`;
- `Replace fillers with silence`;
- `Finish the sentence strongly`;
- `Do not rush the ending`;
- `Take the next breath`;
- recording-quality alerts.

This restricted prompt vocabulary is an advantage. It is easier to validate, easier to understand at a glance, and less likely to distract the speaker.

---

## 21. Final technical decisions

1. **Use raw audio as the timing authority.** OpenAI event arrival time must never be treated as word timing.
2. **Use local VAD to determine speech spans and manual commit points.** Add a maximum 4–6 second commit duration to preserve lexical responsiveness during run-on speech.
3. **Treat OpenAI transcription as lexical evidence, not a complete acoustic analysis.** Verify filler behavior empirically.
4. **Fuse transcript fillers with a local acoustic detector.** Do not count every `and`, `so`, or `like`.
5. **Show a score only when evidence confidence is adequate.** Low-confidence analysis should become `Listening…`, not a low score.
6. **Separate delivery quality from recording quality.** Noise and clipping reduce metric confidence and create separate alerts.
7. **Normalize pitch and loudness per speaker.** Never grade absolute pitch or raw amplitude.
8. **Use soft target bands and confidence-weighted dimension scores.** Avoid hard thresholds and direct point deductions.
9. **Use an EWMA and visible rate cap.** The score should respond over several seconds, not jump on every word.
10. **Display one actionable instruction.** The live interface should not expose the full diagnostic model.
11. **Keep the coaching subsystem advisory.** It must not influence scrolling, tracking, retakes, commands, or recording state.
12. **Start deterministic, then learn from rated data.** A future small model should predict calibrated dimensions from measurable features, not infer timing or quality from opaque text alone.

---

## Appendix A — Example scoring configuration

```yaml
profile: conversational_authority
version: 1

score:
  smoothing_half_life_seconds: 8.0
  visible_max_delta_per_second: 2.5
  warmup_voiced_seconds: 3.0
  warmup_stable_words: 8
  weak_dimension_blend: 0.25
  minimum_display_confidence: 0.35
  minimum_prompt_confidence: 0.60

pace:
  weight: 18
  wpm:
    target_low: 135
    target_high: 175
    sigma_low: 25
    sigma_high: 20
  articulation_syllables_per_second:
    target_low: 3.5
    target_high: 5.5
    sigma_low: 0.8
    sigma_high: 0.7
  max_run_seconds: 11.0
  ending_acceleration_soft: 0.18
  ending_acceleration_strong: 0.28

pausing:
  weight: 18
  clause_pause_ms: [180, 650]
  sentence_pause_ms: [350, 1200]
  interior_long_pause_ms: 1800
  pause_ratio: [0.12, 0.28]
  choppy_pause_ms: [150, 450]

variety:
  weight: 18
  pitch_range_semitones: [4.0, 10.0]
  loudness_range_db: [6.0, 14.0]
  minimum_voiced_seconds: 6.0
  flatness_evidence_seconds: 10.0

emphasis:
  weight: 14
  strong_content_word_fraction: [0.10, 0.25]
  minimum_alignment_confidence: 0.70

fluency:
  weight: 18
  filler_target_per_100_words: 1.0
  filler_soft_per_100_words: 4.0
  filler_cluster_window_seconds: 10.0
  filler_cluster_count: 2

clarity:
  weight: 9
  asr_weight_cap: 0.04
  exclude_script_entities: true
  require_personal_baseline: true

endings:
  weight: 5
  trailing_drop_db_soft: 6.0
  trailing_drop_db_strong: 10.0

coaching:
  prompt_min_visible_seconds: 2.5
  prompt_max_visible_seconds: 5.0
  same_prompt_cooldown_seconds: 10.0
  target_max_prompts_per_minute: 5
  prefer_phrase_boundaries: true
```

All numeric values in this appendix are versioned starting hypotheses. They should be remotely configurable only if the product architecture permits safe signed configuration; otherwise ship them in a versioned local profile.

---

## Appendix B — Example event model

```rust
pub enum CoachingEventKind {
    FastSpeech,
    SlowSpeech,
    RunOnPhrase,
    LongInteriorPause,
    ChoppyPhrasing,
    FlatDelivery,
    ExcessiveAnimation,
    Filler,
    FillerCluster,
    Repetition,
    FalseStart,
    TrailingEnding,
    RushedEnding,
    WeakEmphasis,
    StrongLanding,
    BreathDepletion,
    Clipping,
    LowSignal,
    HighNoise,
    AudioDropout,
}

pub struct CoachingEvent {
    pub id: u64,
    pub kind: CoachingEventKind,
    pub start_sample: u64,
    pub end_sample: u64,
    pub severity: f32,
    pub confidence: f32,
    pub evidence: Vec<EvidenceRef>,
    pub status: EventStatus,
}

pub enum EventStatus {
    Provisional,
    Confirmed,
    Retracted,
}
```

Keeping provisional and retracted states is important because transcript evidence can change after acoustic evidence has already created an event.

---

## Appendix C — Example score snapshot

```json
{
  "at_sample": 1483200,
  "score": 84,
  "evidence_confidence": 0.82,
  "pace": {
    "wpm": 162,
    "trend": -0.18,
    "state": "slightly_fast"
  },
  "variety": "good",
  "fillers_recent": 1,
  "active_prompt": {
    "code": "slow_slightly",
    "text": "Slow slightly",
    "severity": 0.54
  },
  "recording_quality": {
    "state": "good",
    "alert": null
  },
  "dimensions": {
    "pace": { "score": 74, "confidence": 0.91 },
    "pausing": { "score": 86, "confidence": 0.89 },
    "variety": { "score": 88, "confidence": 0.83 },
    "emphasis": { "score": 81, "confidence": 0.61 },
    "fluency": { "score": 90, "confidence": 0.78 },
    "clarity": { "score": 85, "confidence": 0.72 },
    "endings": { "score": 79, "confidence": 0.75 }
  }
}
```

The frontend need not receive all dimension details during ordinary recording. They can remain available for diagnostics and post-take review.

---

## References

1. OpenAI, **Realtime transcription**, OpenAI API documentation. <https://developers.openai.com/api/docs/guides/realtime-transcription>
2. Florian Eyben et al., **The Geneva Minimalistic Acoustic Parameter Set (GeMAPS) for Voice Research and Affective Computing**, *IEEE Transactions on Affective Computing*, DOI 10.1109/TAFFC.2015.2457417. <https://sail.usc.edu/publications/files/eyben-preprinttaffc-2015.pdf>
3. Andrew Rosenberg and Julia Hirschberg, **Acoustic/Prosodic and Lexical Correlates of Charismatic Speech**. <https://www.cs.columbia.edu/~amaxwell/pubs/charisma-euro05-final.pdf>
4. Oliver Niebuhr, Radek Skarnitzl, and Lea Tylečková, **The acoustic fingerprint of a charismatic voice — Initial evidence from correlations between long-term spectral features and listener ratings**, Speech Prosody 2018, DOI 10.21437/SpeechProsody.2018-73. <https://findresearcher.sdu.dk/ws/files/141173469/25.pdf>
5. Dongmei Lin, Oliver Niebuhr, and Rongjie Shi, **Speaking to Win: How Prosodic Features Predict Success in Mandarin Public Speaking Competitions**, Speech Prosody 2026. <https://www.isca-archive.org/speechprosody_2026/lin26_speechprosody.pdf>
6. Ambika Kirkland et al., **Where’s the uh, hesitation? The interplay between filled pause location, speech rate and fundamental frequency in perception of confidence**, Interspeech 2022. <https://www.isca-archive.org/interspeech_2022/kirkland22_interspeech.pdf>
7. Jiahong Yuan, Mark Liberman, and Christopher Cieri, **Towards an Integrated Understanding of Speaking Rate in Conversation**. <https://languagelog.ldc.upenn.edu/myl/ldc/llog/icslp06_final.pdf>
8. CPAL Rust documentation. <https://docs.rs/cpal/latest/cpal/>
9. Rubato Rust documentation. <https://docs.rs/rubato/latest/rubato/>
10. RealFFT Rust documentation. <https://docs.rs/realfft/latest/realfft/>
11. `ort` Rust binding for ONNX Runtime documentation. <https://docs.rs/ort/latest/ort/>

