# CandidCue Alignment Engine: Technical Design

The system should not treat matching as “find the text most similar to the latest transcript and scroll there.” That will inevitably produce surprising jumps.

The correct architecture is:

> **The matcher proposes. The policy authorizes. The display controller smooths.**

This creates three independent layers:

1. **Inference:** Where is the speaker probably reading?
2. **Decision:** Is the evidence strong enough—and the movement safe enough—to act?
3. **Presentation:** How should the screen move without distracting the speaker?

The engine should represent uncertainty explicitly, maintain several plausible positions, and regard a wrong jump as far more costly than briefly freezing.

---

# 1. The behavioural contract

Before choosing algorithms, define the rules that users will experience.

| Situation                            | Expected behaviour                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| Normal reading                       | Follow continuously and predictably.                                              |
| One or two transcription errors      | Continue following without visible disturbance.                                   |
| Filler words                         | Ignore them for tracking.                                                         |
| Brief ad-lib                         | Hold the current place and keep the next scripted line available.                 |
| Long ad-lib                          | Remain anchored; do not search the whole script and jump.                         |
| Paraphrasing the current sentence    | Preserve the current region, but avoid pretending to know the exact word.         |
| Minor self-correction                | Absorb it without reversing the screen.                                           |
| Deliberate retake                    | Recognize it after enough evidence and scroll back smoothly.                      |
| Nearby skipped sentence              | Catch up when the next distinctive phrase is recognized.                          |
| Phrase spoken from a distant section | Treat it as an untrusted match unless the user explicitly navigated there.        |
| Manual scrolling                     | Suspend visual follow without losing the semantic reading position.               |
| Explicit command                     | Permit the movement that ordinary speech would not be allowed to cause.           |
| Silence                              | Hold. Silence is not loss of position.                                            |
| ASR delay or outage                  | Coast briefly, then hold. Never scroll indefinitely from estimated reading speed. |

The central product principle should be:

> **When evidence is weak, freeze rather than guess.**

A temporary freeze is usually recoverable. A wrong jump makes the speaker lose their place, interrupts delivery, and damages trust in the system.

---

# 2. The overall architecture

```text
                       ┌──────────────────────────┐
                       │      Script compiler     │
                       │ atoms, aliases, indexes  │
                       └─────────────┬────────────┘
                                     │
Audio ──► Realtime STT ──► Transcript ledger ──► Evidence window
                                     │
                                     ▼
                              Command detector
                                     │
                                     ▼
                            Candidate generator
                                     │
                                     ▼
                      Weighted local span aligner
                                     │
                                     ▼
                      Multi-hypothesis beam tracker
                                     │
                                     ▼
                         Confidence calibration
                                     │
                                     ▼
                   Risk-sensitive movement policy
                                     │
                  ┌──────────────────┴──────────────────┐
                  ▼                                     ▼
          Semantic position                    Alignment mode
                  │                                     │
                  └──────────────────┬──────────────────┘
                                     ▼
                     Pace and latency prediction
                                     │
                                     ▼
                        Smooth display controller
                                     │
                                     ▼
                              Teleprompter UI
```

No raw transcript match should ever move the screen directly.

---

# 3. Maintain four different positions

A single “current word index” is not enough. Maintain four positions with different meanings.

## 3.1 Confirmed position

The most conservative semantic anchor.

This is the position the system is willing to defend as correct. It advances only when evidence is stable and should not roll backward because the recognizer revised a provisional word.

```text
confirmedPosition
```

This is used for:

* Recovery after an ad-lib.
* “Return to my place.”
* Candidate-window construction.
* Preventing catastrophic jumps.
* Restoring visual follow after manual scrolling.

## 3.2 Observed position

The best current estimate based on provisional and final transcript evidence.

```text
observedPosition
```

It can move ahead of the confirmed position and can be revised slightly as partial transcription changes.

## 3.3 Display target

A latency-compensated prediction of where the speaker is by the time the screen renders.

```text
displayTarget
```

Because transcription arrives after the audio that caused it, merely rendering `observedPosition` will always feel late. The display target predicts a short distance ahead using the measured transcription delay and recent reading pace.

It must be bounded. Prediction can improve apparent responsiveness, but it must never become an uncontrolled auto-scroll system.

## 3.4 Viewport position

The physical rendered scroll offset.

```text
viewportPosition
```

It is controlled by smoothing, acceleration limits, user scrolling and visual layout. It may temporarily differ from the semantic positions.

This separation solves several otherwise difficult cases:

* The user can manually inspect earlier text without changing their reading position.
* The display can move smoothly even when semantic estimates arrive in steps.
* Provisional transcript corrections need not visually jerk the page.
* Semantic tracking can continue while visual follow is suspended.

---

# 4. Represent the script as spoken “atoms,” not raw words

Raw whitespace tokenization will not handle contractions, numbers, acronyms or spoken forms correctly.

Compile the document into a hierarchy:

```text
Document
  Chapter
    Section
      Paragraph
        Sentence
          Phrase
            ScriptAtom
```

A `ScriptAtom` represents a small unit of spoken content.

```text
ScriptAtom:
    id
    visibleText
    canonicalForms[]
    pronunciationForms[]
    paragraphId
    sentenceId
    phraseId
    sectionId
    chapterId
    informationWeight
    optional
    speakable
    layoutLocation
```

## 4.1 Canonical forms

Each atom should contain controlled spoken equivalents.

Examples:

```text
"we're"
    → ["we're"]
    → ["we", "are"]

"$5 million"
    → ["five", "million", "dollars"]
    → ["five", "million"]

"2027"
    → ["twenty", "twenty", "seven"]
    → ["two", "thousand", "and", "twenty", "seven"]

"API"
    → ["a", "p", "i"]
    → ["API"] where pronounced as an initialism

"Dr."
    → ["doctor"]
```

Support transitions such as:

* 1 transcript token ↔ 1 script atom
* 1 ↔ 2
* 2 ↔ 1
* Selected 1 ↔ 3
* Selected 3 ↔ 1

These cover:

* Contractions.
* Number expansions.
* Acronyms.
* ASR token splitting.
* ASR token merging.

## 4.2 Authored pronunciations and aliases

Allow script authors to annotate difficult terms:

```text
SiteOrigin
spoken-as: site origin

CandidCue
spoken-as:
    candid cue
    candid Q
```

These aliases should be explicit and local to the script or user profile.

Do **not** build a general synonym dictionary into token matching. “Launch,” “release,” “publish” and “ship” can be semantically related, but treating them as interchangeable alignment tokens greatly increases ambiguous and false matches.

## 4.3 Information weights

A rare content word should count more than a common function word.

A reasonable starting formulation is:

```text
informationWeight(token) =
    clamp(
        0.5 + log((totalAtoms + 1) / (documentFrequency(token) + 1)),
        0.5,
        2.5
    )
```

Thus:

* “the”, “and”, “this” contribute little.
* A product name, technical term or unusual verb contributes strongly.
* A rare three-word phrase is powerful evidence.
* A common phrase occurring in six paragraphs remains ambiguous.

Also calculate uniqueness for normalized two- to five-atom spans. This becomes critical when distinguishing repeated passages.

## 4.4 Script indexes

Compile the following indexes:

* Canonical token inverted index.
* Rare token index.
* Normalized two- to five-gram index.
* Phonetic n-gram index.
* Sentence-start index.
* Paragraph-start index.
* Heading and heading-alias index.
* Repeated-span ambiguity map.
* Sentence and paragraph embeddings for local semantic recovery.

The embeddings should be used only for region-level reasoning, not exact word commitment.

---

# 5. Build a revision-safe transcript ledger

Realtime speech recognition is incremental. The newest transcript tail may be incomplete, incorrect and later revised. Stability and correctness are separate quantities: a word can be stable but wrong, or correct so far but likely to change. Research on incremental ASR explicitly distinguishes these two concepts and recommends estimating both rather than trusting raw partial text. ([ACL Anthology][1])

Create a provider-neutral ledger rather than appending strings.

```text
TranscriptEvent:
    streamItemId
    audioSequence
    revisionGeneration
    operation: ADD | REVOKE | REPLACE | FINALIZE
    text
    arrivalTime
    audioTimeRange?
    asrLogProbability?
```

```text
TranscriptToken:
    id
    sourceItemId
    text
    canonicalForms[]
    provisional
    revisionCount
    unchangedDuration
    updateCountSurvived
    asrReliability
    stabilityProbability
    maskedFromAlignment
```

For the current OpenAI Realtime transcription interface, incremental deltas and completion events should be reconciled by `item_id`; completion order across different committed turns is not guaranteed. The current API also exposes a tunable transcription-delay setting and optional log probabilities when supported, while advising applications to provide fallbacks for confidence and timestamp fields. ([OpenAI Developers][2])

## 5.1 Do not append partial text blindly

When an item changes:

1. Compare the new item transcript with its previous version.
2. Find their longest stable common prefix.
3. Revoke the changed tail.
4. Add the replacement tail.
5. Re-run alignment only over a bounded recent window.

This gives the rest of the application explicit revision semantics.

## 5.2 Stable prefix and provisional tail

Maintain:

```text
stablePrefix
provisionalTail
```

A reasonable evidence window is:

* Last 6–8 seconds of speech.
* Maximum approximately 30–40 spoken tokens.
* Last 1–2 seconds treated as provisional.
* Older unchanged or finalized tokens treated as stable.

These are starting values, not universal constants.

## 5.3 Estimate token survival probability

Even without recognizer-provided confidence, estimate whether a token will survive future revisions.

```text
P(token survives) =
    calibrator(
        finalized,
        unchangedDuration,
        numberOfUpdatesSurvived,
        distanceFromTranscriptTail,
        revisionCount,
        ASR log probability,
        neighbouring token stability
    )
```

A simple first implementation can use a logistic model. A purely procedural bootstrap could begin with:

```text
final token                         → 1.00
unchanged for >600 ms              → 0.90
unchanged across 2+ updates        → 0.80
new provisional token              → 0.35
recently revised token             → 0.45
```

The observed position can respond to medium-stability tokens. The confirmed position should require high-survival evidence.

## 5.4 Mask commands

After the command detector recognizes:

> “CandidCue, restart this paragraph”

those words should be marked:

```text
maskedFromAlignment = true
```

Otherwise, the command itself could accidentally match similar text in the script.

---

# 6. The best matching stack

There is no single best algorithm for every part. The strongest system is a layered hybrid.

| Problem                                   | Recommended algorithm                             |
| ----------------------------------------- | ------------------------------------------------- |
| Fast exact anchors                        | Normalized rare n-gram retrieval                  |
| Primary local matching                    | Weighted semi-global dynamic programming          |
| Filler words and ad-lib runs              | Affine insertion gaps                             |
| Missed ASR words and skipped script       | Weighted deletion gaps                            |
| Contractions and tokenization differences | Multi-token span transitions                      |
| Recognition substitutions                 | Phoneme-aware weighted edit similarity            |
| Continuity through time                   | HMM-like bounded beam tracker                     |
| Paraphrasing                              | Local sentence/paragraph embeddings               |
| Explicit navigation                       | Deterministic command grammar and authority token |
| Display prediction                        | Alpha-beta or Kalman-style estimator              |
| Smooth scrolling                          | Jerk-limited motion controller                    |

Phoneme-aware dynamic-programming alignment is useful because it can award partial similarity to acoustically related substitutions rather than treating every non-identical word as equally wrong. Work on speech/text alignment has shown improvements from continuous phoneme-similarity matrices over binary phone equality. ([ACL Anthology][3])

## 6.1 Why not ordinary Levenshtein distance?

Basic edit distance:

* Treats all words as equally informative.
* Treats “CandidCue” → “candid Q” as unrelated.
* Does not understand filler words.
* Does not distinguish one long ad-lib from dozens of unrelated mistakes.
* Has no temporal continuity model.
* Cannot prevent distant jumps.

It remains a useful benchmark, not a production solution.

## 6.2 Why not Smith–Waterman?

Smith–Waterman local alignment is designed to locate the best matching subsequence while ignoring unmatched material around it.

That is dangerous here. It may find a tiny three-word fragment in a distant paragraph and ignore the preceding contradictory transcript.

The teleprompter needs:

> “Find a plausible start in this allowed script window, but explain most of the recent speech evidence and finish near the latest spoken material.”

That is a **semi-global alignment** problem.

## 6.3 Why not embeddings as the primary matcher?

Embeddings are useful for:

* Recognizing that an ad-lib is still about the current paragraph.
* Finding the part “about pricing” after an explicit command.
* Identifying a likely region during operator-assisted recovery.

They are unsafe for exact cursor movement because:

* Semantically similar sentences can occur throughout a script.
* They provide poor word-level position.
* Two different sections can discuss the same concept.
* A natural ad-lib may resemble a later paragraph more than the current literal script.

Embeddings should retrieve or reinforce a region. Lexical and phonetic evidence should commit the precise position.

## 6.4 Why not a large language model in the realtime loop?

An LLM can suggest likely script aliases offline, but realtime cursor control should be deterministic and replayable.

The hot path needs:

* Predictable latency.
* Reproducible decisions.
* Explicit confidence.
* Hard movement restrictions.
* Deterministic testing.
* No possibility that a semantic interpretation bypasses navigation authority.

---

# 7. Candidate generation: search locally before aligning

Do not run full-script dynamic programming after every transcript delta. Generate a small collection of allowed candidate windows.

## 7.1 Candidate scopes

Starting defaults:

### Continuity corridor

```text
confirmedPosition - 24 atoms
to
confirmedPosition + 120 atoms
```

Or dynamically:

```text
backward = clamp(estimatedPace × 8 seconds, 20, 80 atoms)
forward  = clamp(estimatedPace × 15 seconds, 80, 220 atoms)
```

### Visible viewport

The text currently visible, plus roughly one screen above and below.

This matters particularly after manual scrolling.

### Retake corridor

```text
confirmedPosition - 240 atoms
to
confirmedPosition - 8 atoms
```

Restrict this initially to:

* Current paragraph.
* Previous paragraph.
* Current section.
* Very recently visited positions.

### Sequential boundary candidates

Include:

* Nearby sentence starts.
* Nearby paragraph starts.
* Start of the immediately following section.
* First 40–60 atoms following a nearby boundary.

### Explicit navigation target

When a command creates navigation authority, add the specified target range.

### Global shadow candidates

Use rare n-grams, phonetic anchors and headings to retrieve perhaps three to five distant candidates.

These candidates are useful for diagnosis, suggestions and explicit recovery. They must not automatically authorize a jump.

## 7.2 Candidate retrieval

For the newest stable content tokens:

1. Remove fillers and low-information words.
2. Form normalized two- to five-grams.
3. Query the rare n-gram index.
4. Query phonetic shingles when lexical retrieval is weak.
5. Score occurrences by rarity and token survival probability.
6. Merge adjacent hits into candidate windows.
7. Keep only top candidates per scope.

Pseudocode:

```text
function generateCandidates(evidence, context):
    candidates = []

    candidates += continuityWindow(context.confirmedPosition)
    candidates += visibleWindow(context.viewport)
    candidates += nearbyBoundaries(context.confirmedPosition)

    if context.mode may be retake:
        candidates += recentBackwardWindows(context)

    if context.navigationAuthority exists:
        candidates += context.navigationAuthority.targetRange

    anchors = extractDistinctiveNGrams(evidence)
    globalHits = indexes.lookup(anchors)

    for hit in topK(globalHits):
        candidates += ShadowCandidate(windowAround(hit))

    return mergeOverlappingWindows(candidates)
```

---

# 8. Weighted semi-global span alignment

Let:

* `Q` be recent transcript atoms.
* `S` be a candidate script window.

Use three primary dynamic-programming states:

```text
M[i,j] = best alignment ending with transcript and script material matched
I[i,j] = best alignment ending with extra spoken material
D[i,j] = best alignment ending with script material absent from transcript
```

The alignment may begin freely within the candidate script window, but it must explain most of the recent transcript evidence. Its endpoint should be supported by the newest usable transcript atoms.

## 8.1 Match-quality function

For transcript span `q` and script span `s`:

```text
matchQuality(q, s) =
    maximum valid score among:
        exact canonical equivalence
        numeric/date/currency equivalence
        authored alias
        contraction or acronym equivalence
        phonetic similarity
        normalized character similarity
```

Suggested starting values:

```text
Exact/canonical equivalence        1.00
Number/date/currency equivalence   0.98
Authored alias                     0.95
Contraction/acronym expansion      0.92
Strong phonetic similarity         0.75–0.90
Strong character similarity        0.55–0.75
Unrelated                          0.00
```

Semantic similarity should not enter this token-level score.

## 8.2 Evidence score

For a transcript token or span `q` and script atom or span `s`:

```text
evidenceScore(q, s) =
    reliability(q)
    × informationWeight(s)
    × (
        3.0 × matchQuality(q, s)
        -
        1.4 × (1 - matchQuality(q, s))
      )
```

This gives:

* Strong positive evidence for a rare exact match.
* Weak evidence for a common exact word.
* Moderate positive evidence for a plausible ASR substitution.
* A reduced mismatch penalty when the transcript token itself is unreliable.

The exact coefficients should eventually be fitted against your recordings.

## 8.3 Affine gaps

Use separate gap-open and gap-extension costs.

### Extra spoken words

This covers fillers, ad-libs and corrections.

```text
filler insertion:
    open   = -0.10
    extend = -0.03

general spoken insertion:
    open   = -0.80
    extend = -0.20
```

The important property is that a ten-word ad-lib should cost:

```text
one opening penalty + nine small extension penalties
```

not ten unrelated catastrophic mismatches.

### Script words absent from the transcript

This covers both recognizer omissions and real script skipping.

```text
low-information script atom deletion:
    approximately -0.40 to -0.60

distinctive script atom deletion:
    approximately -1.0 to -1.5 × informationWeight
```

A long deletion run may represent a sentence skip. The aligner may propose it, but the movement policy must decide whether such a skip is safe to display.

## 8.4 Span transitions

At every cell, evaluate selected transitions:

```text
1 transcript atom ↔ 1 script atom
1 transcript atom ↔ 2 script atoms
2 transcript atoms ↔ 1 script atom
1 transcript atom ↔ 3 script atoms, controlled
3 transcript atoms ↔ 1 script atom, controlled
```

Only enable larger mappings for known classes such as numbers, acronyms, contractions and authored aliases. Arbitrary 3↔1 fuzzy matching is too permissive.

## 8.5 Conceptual recurrence

```text
for each transcript endpoint i:
    for each script endpoint j:

        M[i,j] =
            max over allowed transcriptSpan, scriptSpan:
                bestPreviousState
                + evidenceScore(transcriptSpan, scriptSpan)
                - spanTransitionCost

        I[i,j] =
            max(
                M[i-1,j] + insertionOpenCost,
                I[i-1,j] + insertionExtendCost
            )

        D[i,j] =
            max(
                M[i,j-1] + deletionOpenCost(script[j]),
                D[i,j-1] + deletionExtendCost(script[j])
            )
```

Semi-global behaviour:

```text
initial script-prefix gaps inside the candidate window are inexpensive
recent transcript evidence cannot be discarded freely
candidate endpoint must be supported by recent evidence
```

## 8.6 Alignment output

Each candidate alignment should return more than a position:

```text
AlignmentResult:
    endpoint
    startpoint
    normalizedScore
    matchedInformationMass
    transcriptCoverage
    scriptCoverage
    exactMatchFraction
    phoneticMatchFraction
    fillerInsertionCount
    generalInsertionRunLength
    deletionRunLength
    newestEvidenceMapped
    uniquenessScore
    repeatedSpanCount
    alignmentPath
```

These become features for the hypothesis tracker and confidence calibrator.

---

# 9. Track a distribution over positions

The system should not immediately collapse to one candidate. Maintain a small beam of competing hypotheses.

Eight hypotheses is a sensible starting width.

```text
Hypothesis:
    scriptPosition
    confirmedThrough
    mode
    velocity
    logScore
    candidateScope
    alignmentStatistics
    evidenceIds
    age
    navigationAuthorityId?
```

Include a **null hypothesis**:

```text
OFF_SCRIPT_OR_UNRESOLVED
```

Without a null hypothesis, the tracker is forced to select the least-bad script position and may become falsely confident during an ad-lib.

## 9.1 Hidden state

Conceptually:

```text
z_t = (
    scriptPosition,
    readingVelocity,
    alignmentMode,
    navigationAuthority
)
```

Update:

```text
P(z_t | observations_1:t)
    ∝
P(observations_t | z_t)
×
Σ P(z_t | z_t-1) P(z_t-1 | observations_1:t-1)
```

You do not need a full probabilistic graphical-model implementation. A bounded beam approximates this efficiently.

## 9.2 Beam score

```text
newLogScore =
    previousLogScore
    + alignmentEmission
    + continuityPrior
    + directionPrior
    + paceConsistency
    + uniquenessBonus
    + transcriptStabilityBonus
    + viewportCompatibility
    + boundarySupport
    + navigationAuthorityBonus
    - ambiguityPenalty
    - movementRiskPenalty
```

## 9.3 Transition priors

### Normal following

Strongly prefer:

* Small forward movement.
* Movement consistent with recent speaking pace.
* Same sentence or next sentence.
* Current or adjacent viewport.

### Short backward repetition

Permit a small probability for:

* Self-correction.
* Repeated phrase.
* Sentence restart.

Do not immediately reverse the confirmed position.

### Large backward movement

Require `RETAKE_CANDIDATE` mode and much stronger evidence.

### Local forward skip

Allow only with:

* Strong lexical evidence.
* Sufficient information mass.
* Nearby or visible target.
* Clear score margin over alternatives.

### Distant movement

Ordinary speech transition probability should effectively be zero unless navigation authority exists.

The distant match may remain in the beam as a shadow candidate, but it cannot become an actionable hypothesis.

## 9.4 Repeated phrases

Suppose the phrase:

> “The important thing to understand is”

occurs six times.

The tracker should:

1. Produce six possible lexical matches.
2. Prefer the one near the current anchor.
3. Retain alternatives briefly.
4. Keep confidence low if surrounding evidence is inconclusive.
5. Wait for a distinctive continuation rather than jumping.

This behaviour will feel intelligent because the system understands that a match can be genuine yet ambiguous.

---

# 10. Confidence must be calibrated

Do not treat a dynamic-programming score or beam softmax as a trustworthy probability.

Train a small calibrator to estimate:

```text
P(best position is within ±2 atoms of gold)
P(best position is within ±5 atoms of gold)
P(proposed mode is correct)
P(current partial transcript survives revision)
P(proposed movement is safe)
```

A logistic regression is an excellent initial model because it is:

* Fast.
* Explainable.
* Deterministic.
* Easy to inspect.
* Easy to calibrate.

If it underfits, use monotonic gradient-boosted trees followed by isotonic calibration.

## 10.1 Confidence features

Use:

```text
top candidate normalized score
top-1 minus top-2 score margin
posterior entropy
credible position interval width
matched information mass
transcript coverage
exact/canonical fraction
phonetic fraction
rare n-gram support
newest-evidence coverage
ASR reliability
transcript survival probability
distance from confirmed position
direction of movement
pace consistency
viewport distance
same sentence / paragraph / section
sentence-boundary support
pause support
repeated-span count
candidate-scope type
insertion-run length
deletion-run length
mode duration
navigation authority
```

## 10.2 Credible interval

Rather than only storing one position, calculate:

```text
positionCredibleInterval = [lowAtom, highAtom]
```

If the top hypotheses span 30 atoms, exact word highlighting is unjustified even if their combined probability is high.

Use interval width to control UI precision:

```text
width ≤ 3 atoms     → word-level display allowed
width ≤ 10 atoms    → phrase or line-level display
width > 10 atoms    → hold confirmed visual state
```

---

# 11. Risk-sensitive commitment

Different movements have radically different consequences. Use a separate confidence threshold for each action.

Starting values:

| Action                                       |                Evidence requirement |
| -------------------------------------------- | ----------------------------------: |
| Update provisional observed position locally |                              ≥ 0.65 |
| Confirm normal forward progress              |                              ≥ 0.85 |
| Skip forward within visible/adjacent text    |                              ≥ 0.92 |
| Reverse beyond a short phrase                |                              ≥ 0.97 |
| Jump to distant hidden section               |             Never without authority |
| Exact word highlighting                      | ≥ 0.80 and narrow credible interval |

These are initial tuning values, not scientifically universal constants.

## 11.1 Use information mass, not only token count

Two rare words can be stronger than six common words.

```text
evidenceMass =
    Σ informationWeight(scriptAtom)
      × matchQuality
      × transcriptStability
```

Suggested initial gates:

```text
normal forward continuation:
    evidenceMass ≥ 2.5
    or two stable content anchors

nearby sentence skip:
    evidenceMass ≥ 4.0
    plus strong margin

backward retake:
    evidenceMass ≥ 6.0
    plus sustained evidence
    plus high confidence

far reanchor:
    explicit authority required
```

## 11.2 Expected-loss formulation

The policy can be expressed as minimizing expected loss:

```text
expectedLoss(action) =
    Σ over hypotheses:
        P(hypothesis | evidence)
        × loss(action, hypothesis)
```

Illustrative relative losses:

```text
correct local movement               0
briefly lagging by 300 ms            1
holding for one second               3
incorrect movement within sentence  15
incorrect paragraph jump            50
incorrect distant jump             100
incorrect visible reversal          70
```

This encodes the product’s actual psychology: a slight lag is much less damaging than losing the speaker’s place.

In implementation, hard gates plus calibrated thresholds are simpler than evaluating the full loss matrix on every event, but the loss matrix should guide those thresholds.

## 11.3 Commit invariant

```text
commit only when:
    confidence ≥ thresholdFor(action)
    AND scoreMargin ≥ requiredMargin
    AND evidenceMass ≥ requiredMass
    AND credibleIntervalWidth ≤ allowedWidth
    AND candidate scope permits action
    AND navigation authority permits destination
```

Otherwise:

```text
hold
```

---

# 12. Two independent state machines

Do not combine all behaviours into a single state enum. Maintain two dimensions.

## 12.1 Viewport authority state

```text
FOLLOW
MANUAL_PEEK
EXPLICIT_NAVIGATION
PAUSED
```

This determines who controls the screen.

## 12.2 Alignment mode

```text
FOLLOWING
COASTING
HOLDING
AD_LIB
REPAIR_CANDIDATE
RETAKE_CANDIDATE
REACQUIRING
LOST
```

This describes what the speaker appears to be doing.

---

# 13. Alignment-mode behaviour

## 13.1 FOLLOWING

Conditions:

* Strong local alignment.
* Low ambiguity.
* Movement compatible with recent pace.
* No authority conflict.

Behaviour:

* Advance observed position.
* Confirm stable progress.
* Predict display target.
* Use word or phrase highlighting according to confidence.

## 13.2 COASTING

Entered when confidence briefly falls because the recognizer is late or revising.

Starting transition:

```text
FOLLOWING → COASTING
when confidence < 0.65 for approximately 200–300 ms
```

Behaviour:

* Keep confirmed position unchanged.
* Permit bounded display prediction from recent pace.
* Do not search globally.
* Do not reverse.
* Maximum coast period around 600–800 ms.

Coasting makes ordinary ASR gaps visually invisible without inventing semantic progress.

## 13.3 HOLDING

Entered when evidence remains weak beyond the short coast window.

Behaviour:

* Freeze or gently settle the screen.
* Keep next script text visible.
* Continue accumulating evidence.
* Preserve the last confirmed anchor.

## 13.4 AD_LIB

Likely when:

```text
speech is active
AND local lexical coverage is low
AND a strong prior anchor exists
AND transcript resembles a long insertion run
AND no allowed alternative position is convincing
```

Behaviour:

* Keep confirmed position at the pre-ad-lib anchor.
* Do not global-search for an exact phrase inside the ad-lib.
* Keep the next script line visible.
* Optionally use a local paragraph embedding to determine whether the speaker remains conceptually close to the current section.
* Show a subtle “Ad-lib” status only in the operator interface.
* Reacquire when literal script evidence returns.

## 13.5 REPAIR_CANDIDATE

This handles:

> “Our product launches in—sorry—ships in September.”

or:

> “The first thing—the most important thing—is…”

Behaviour:

* Treat filler and corrected wording as inserted material.
* Avoid moving backward immediately.
* Keep the current sentence in view.
* Wait for the repair continuation.

Speech-repair research notes that material cannot reliably be identified as a reparandum until the repair itself begins; the earlier words do not provide enough information to know they will be corrected. That supports a delayed candidate state rather than an instant reverse operation. ([ACL Anthology][4])

## 13.6 RETAKE_CANDIDATE

Used for a deliberate larger restart.

Evidence can include:

* A candidate substantially behind confirmed position.
* Five or more distinctive matched content atoms.
* A unique four-gram.
* A pause before restarting.
* A sentence or paragraph boundary.
* Repeated progress from that earlier point.
* Strong contradiction with the current forward hypothesis.

Behaviour sequence:

1. Slow or freeze first.
2. Search the recent backward corridor.
3. Accumulate evidence over several transcript events.
4. Commit only after the high-risk backward threshold is crossed.
5. Scroll back smoothly.
6. Reset pace estimates after the retake.

## 13.7 REACQUIRING

Used after:

* An ad-lib.
* A local skip.
* A recognizer outage.
* A manual reposition.
* A long uncertain passage.

Search in increasing scope:

```text
1. around last confirmed anchor
2. current visible region
3. next paragraph and adjacent boundaries
4. recent backward corridor
5. authority-supplied destination
6. distant shadow retrieval, suggestion only
```

## 13.8 LOST

The engine has no sufficiently plausible allowed position.

Behaviour:

* Do not move.
* Preserve confirmed position.
* Keep operator controls available.
* Continue local and shadow candidate retrieval.
* Allow “Return to my place,” “Continue from here,” or direct navigation.

The stage display should not flash a large “LOST” warning at the speaker.

---

# 14. Scenario-specific algorithms

## 14.1 Missed transcription

Script:

> “Our platform makes complex video production much easier.”

ASR:

> “Our platform makes video production much easier.”

Algorithm:

1. Match “our platform makes.”
2. Take a deletion transition over “complex.”
3. Match the distinctive continuation.
4. Maintain the same local hypothesis.
5. Do not interpret the deletion as a deliberate script skip unless the deletion run becomes much larger.

Distinctive omitted words should cost more than function words, but later context can overcome the omission.

## 14.2 Incorrect transcription

Script:

> “CandidCue keeps your delivery natural.”

ASR:

> “Candid Q keeps your delivery natural.”

Algorithm:

1. Canonical alias or phonetic matcher recognizes `CandidCue ↔ candid Q`.
2. Remaining context strongly supports the same region.
3. The match remains high confidence.
4. No visible disturbance occurs.

## 14.3 Filler words

Script:

> “Today I will explain our new system.”

Spoken:

> “Today, um, I’m just going to explain our new system.”

Algorithm:

1. “Um” receives the cheap filler insertion cost.
2. “I’m just going to” becomes one general insertion run.
3. The affine gap prevents the entire passage from being treated as multiple errors.
4. The current script anchor remains unchanged until matching resumes.
5. Filler events may be recorded for coaching, but never influence navigation.

## 14.4 Brief ad-lib

Spoken:

> “And this is actually something our early customers asked for…”

Algorithm:

1. Local lexical coverage falls.
2. Speech remains active.
3. The best script hypothesis remains the last anchor.
4. Null/off-script probability rises.
5. Mode changes from `COASTING` to `AD_LIB`.
6. The viewport holds the next scripted text.
7. The application does not follow incidental phrases found elsewhere.

## 14.5 Returning from an ad-lib

After the ad-lib, the speaker says:

> “So, the second benefit is lower production cost.”

Algorithm:

1. Search around the anchor and forward corridor.
2. Find “the second benefit is lower production cost.”
3. Require three distinctive anchors or equivalent information mass.
4. Verify that the match is local and ahead.
5. Transition through `REACQUIRING`.
6. Smoothly resume normal follow.

## 14.6 Paraphrasing

Script:

> “This reduces the amount of time required for editing.”

Spoken:

> “So you end up spending much less time in the editor.”

Algorithm:

1. Exact word alignment becomes weak.
2. Local sentence embedding indicates conceptual similarity to the current sentence.
3. Preserve the paragraph-level hypothesis.
4. Do not advance an exact word cursor from semantics alone.
5. Hold or use line-level highlighting.
6. Resume exact tracking when literal script language returns.

This prevents the app from declaring itself lost while also avoiding fake word-level precision.

## 14.7 Small self-correction

Spoken:

> “We released it in June—July of last year.”

Algorithm:

1. Treat “June” as repaired material.
2. Treat “July” as the likely intended script match.
3. Keep semantic position within the same phrase.
4. Do not visibly reverse.
5. Record the correction only for transcript history or coaching.

## 14.8 Deliberate sentence restart

Spoken:

> “Our first objective is— Our first objective is to simplify editing.”

Algorithm:

1. Detect a local repeated prefix.
2. Enter `REPAIR_CANDIDATE`, not full retake.
3. Keep the sentence visible.
4. Treat the repeated prefix as an insertion loop.
5. Continue once the second attempt progresses beyond the first.

## 14.9 Deliberate paragraph retake

Spoken:

> “Let me start that paragraph again. The biggest problem creators face…”

Without an explicit CandidCue command, ordinary speech must still establish evidence.

Algorithm:

1. Detect backward candidate at the paragraph start.
2. Freeze rather than immediately reverse.
3. Require a unique phrase or strong evidence mass.
4. Commit backward only when confidence exceeds the retake threshold.
5. Scroll back smoothly.

With an explicit command:

> “CandidCue, restart this paragraph.”

the command immediately supplies navigation authority.

## 14.10 Nearby forward skip

The speaker skips one sentence and begins the next.

Algorithm:

1. Current alignment accumulates a deletion run.
2. A strong next-sentence candidate appears.
3. Check that the destination is nearby or visible.
4. Require higher confidence than normal forward progress.
5. Commit the skip.
6. Smoothly catch up without snapping.

## 14.11 A phrase from a distant section

Suppose the speaker accidentally says a phrase that appears in Chapter 5 while currently in Chapter 1.

Algorithm:

1. Global retrieval identifies Chapter 5 as a strong lexical match.
2. It is labelled a shadow candidate.
3. Navigation policy rejects it because no authority permits a distant jump.
4. The viewport remains in Chapter 1.
5. The operator may see “Possible match: Chapter 5.”
6. Additional normal speech either restores Chapter 1 or leaves the system holding.

This should be a hard invariant.

## 14.12 Manual scroll

When the user scrolls:

```text
viewportAuthority = MANUAL_PEEK
```

Then:

* Semantic alignment continues in the background.
* Confirmed position remains unchanged.
* Viewport no longer follows display target.
* Do not automatically snap back merely because a timer expires.
* “Return to my place” restores the viewport to the semantic anchor.
* If the user begins speaking text clearly visible at the manually selected region, that region receives temporary candidate authority.
* A strong visible-region match can reanchor semantic tracking.

This supports both meanings users might have:

* “I am looking elsewhere temporarily.”
* “I want to continue from here.”

The system waits for evidence distinguishing them.

## 14.13 ASR outage

Algorithm:

1. Continue bounded display prediction for perhaps 600–800 ms.
2. Reduce display velocity toward zero.
3. Enter `HOLDING`.
4. Never continue scrolling solely from historical words per minute.
5. When transcription resumes, rerun the recent rolling alignment window.
6. Correct semantic state without visually snapping unless necessary.

---

# 15. Explicit navigation authority

Commands should create a temporary object that permits movements normal speech cannot cause.

```text
NavigationAuthority:
    id
    source
    targetRange
    movementType
    allowedDistance
    expiresAt
    consumeOnCommit
```

Examples:

```text
"CandidCue, go to chapter three"
    targetRange = chapter 3 start
    movementType = immediate semantic and visual navigation

"CandidCue, start from 'our second objective'"
    targetRange = matching phrase
    movementType = reanchor and await speech

"CandidCue, scroll down"
    targetRange = none
    movementType = viewport only

"CandidCue, continue from here"
    targetRange = current viewport
    movementType = semantic reanchor

"CandidCue, return to my place"
    targetRange = confirmed position
    movementType = viewport restoration
```

## 15.1 Command recognition

Use a deterministic grammar with phonetic and fuzzy matching:

```text
WAKE_WORD + VERB + TARGET
```

Verb groups:

```text
go / take me / jump
restart / start again
continue / begin / start from
scroll
return
find
pause / resume
```

Target groups:

```text
chapter number
section name
paragraph
sentence
quoted phrase
current viewport
confirmed position
semantic query
```

Resolve targets in this order:

1. Exact structural identifier.
2. Exact heading alias.
3. Unique normalized phrase.
4. Fuzzy or phonetic heading match.
5. Semantic search, only after an explicit “find the part about…” command.

If two targets remain genuinely ambiguous, do not jump. Present the choices in the operator interface.

---

# 16. Display prediction and smoothing

Even a perfect aligner can feel poor if scrolling moves in discrete word-sized steps.

## 16.1 Estimate reading pace

Estimate pace from confirmed alignment points:

```text
pace = robust slope of scriptAtomPosition over audio time
```

Use:

* A weighted median or robust linear fit.
* An exponentially weighted update.
* Exclusion of ad-libs, commands, retakes and pauses.
* Separate short-term and session-level estimates.

```text
shortTermPace
sessionPace
effectivePace =
    0.7 × shortTermPace
    + 0.3 × sessionPace
```

## 16.2 Estimate ASR delay

Measure:

```text
event arrival time - corresponding audio time
```

Use a robust rolling median rather than assuming the provider delay is fixed. OpenAI’s current Realtime transcription settings deliberately trade latency for accuracy, and the documentation recommends benchmarking representative microphones, accents, noise and long sessions rather than relying on a nominal delay value or clean synthetic audio alone. ([OpenAI Developers][2])

## 16.3 Predict display target

```text
predictionHorizon =
    clamp(estimatedASRDelay + renderDelay, 0, 1.5 seconds)

displayTarget =
    observedPosition
    + estimatedPace × predictionHorizon
```

Then bound it:

```text
displayTarget cannot:
    exceed observed by more than about 20 atoms
    pass an uncertain paragraph boundary
    continue advancing during HOLDING
    reverse before retake commitment
```

The prediction changes presentation only. It never confirms semantic position.

## 16.4 Position filter

An alpha-beta filter is probably sufficient:

```text
prediction:
    predictedPosition = position + velocity × dt

measurement update:
    residual = observedPosition - predictedPosition
    position = predictedPosition + alpha(confidence) × residual
    velocity = velocity + beta(confidence) × residual / dt
```

Measurement gain should increase with confidence. A full Kalman filter is appropriate if you explicitly model measurement variance and process variance.

## 16.5 Keep a stable reading zone

Place the active text around 35–45% of the viewport height rather than vertically centred.

This leaves:

* The spoken text above.
* The current phrase near a stable eye position.
* Approximately two seconds of upcoming text below.

## 16.6 Jerk-limited scrolling

Do not set scroll position directly.

```text
error = targetY - viewportY

desiredAcceleration =
    clamp(
        positionGain × error
        - velocityDamping × viewportVelocity,
        -maximumAcceleration,
        maximumAcceleration
    )

acceleration =
    moveToward(
        currentAcceleration,
        desiredAcceleration,
        jerkLimit × dt
    )

viewportVelocity =
    clamp(
        viewportVelocity + acceleration × dt,
        -maximumVelocity,
        maximumVelocity
    )

viewportY += viewportVelocity × dt
```

Add:

* A small deadband.
* Directional hysteresis.
* Boundary-aware slowing.
* A ban on reverse acceleration until a backward semantic movement is authorized.

## 16.7 Confidence-dependent rendering

```text
High confidence:
    exact current word may be highlighted
    normal smooth follow

Medium confidence:
    phrase or line emphasis
    slower movement
    no precise word flicker

Low confidence:
    retain last confirmed emphasis
    hold movement
    keep upcoming text visible
```

The UI should become less precise as uncertainty grows, not more visibly anxious.

---

# 17. Main event-loop pseudocode

```text
function onTranscriptionEvent(event):

    transcriptLedger.apply(event)

    commandResult =
        commandRouter.consume(
            transcriptLedger.newEvidence
        )

    if commandResult.accepted:
        navigationAuthority =
            commandResult.createAuthority()

        transcriptLedger.mask(
            commandResult.consumedTokenIds
        )

    evidence =
        transcriptLedger.buildEvidenceWindow(
            recentSeconds = 8,
            maximumTokens = 40
        )

    candidateScopes =
        candidateGenerator.generate(
            evidence,
            confirmedPosition,
            observedPosition,
            viewportPosition,
            alignmentMode,
            viewportAuthority,
            navigationAuthority,
            scriptIndexes
        )

    candidateAlignments = []

    for scope in candidateScopes:
        results =
            weightedSemiGlobalAlign(
                evidence,
                scriptAtomsWithin(scope)
            )

        candidateAlignments +=
            results.bestEndpoints

    candidateAlignments +=
        createOffScriptNullHypothesis(
            lastConfirmedAnchor
        )

    hypothesisBeam =
        beamTracker.advance(
            previousBeam,
            candidateAlignments,
            paceEstimate,
            alignmentMode,
            viewportAuthority,
            navigationAuthority
        )

    calibratedBelief =
        confidenceCalibrator.evaluate(
            hypothesisBeam,
            evidence,
            context
        )

    alignmentMode =
        modeController.update(
            previousMode,
            calibratedBelief,
            speechActivity,
            elapsedTime
        )

    proposedObservedPosition =
        calibratedBelief.bestAllowedPosition

    observedPosition =
        observationPolicy.update(
            observedPosition,
            proposedObservedPosition,
            calibratedBelief,
            alignmentMode
        )

    confirmedPosition =
        commitPolicy.update(
            confirmedPosition,
            observedPosition,
            calibratedBelief,
            alignmentMode,
            navigationAuthority
        )

    paceEstimate =
        paceEstimator.update(
            confirmedPosition,
            audioTimeline,
            alignmentMode
        )

    displayTarget =
        displayPredictor.predict(
            observedPosition,
            confirmedPosition,
            paceEstimate,
            estimatedASRDelay,
            calibratedBelief,
            alignmentMode
        )

    if viewportAuthority == FOLLOW:
        viewportPosition =
            smoothDisplayController.step(
                displayTarget,
                alignmentMode,
                calibratedBelief
            )

    emit AlignmentSnapshot(
        confirmedPosition,
        observedPosition,
        displayTarget,
        viewportPosition,
        alignmentMode,
        viewportAuthority,
        calibratedBelief
    )
```

---

# 18. Commit-policy pseudocode

```text
function authorizeMovement(current, proposed, belief, context):

    action = classifyMovement(current, proposed)

    if action == DISTANT_JUMP:
        if not context.navigationAuthority.allows(proposed):
            return HOLD

    if context.viewportAuthority == MANUAL_PEEK:
        if not strongMatchInsideVisibleRegion(proposed):
            return SEMANTIC_ONLY

    threshold = thresholdFor(action)

    if belief.positionConfidence < threshold:
        return HOLD

    if belief.scoreMargin < requiredMargin(action):
        return HOLD

    if belief.evidenceMass < requiredEvidence(action):
        return HOLD

    if belief.credibleIntervalWidth > maximumWidth(action):
        return HOLD

    if action == BACKWARD_RETAKE:
        if context.mode != RETAKE_CANDIDATE:
            return HOLD

        if belief.sustainedDuration < requiredRetakeDuration:
            return HOLD

    return COMMIT
```

---

# 19. Hard invariants

These should be property-tested.

1. **No distant semantic jump without navigation authority.**
2. **A transcript revision alone cannot move confirmed position backward.**
3. **Manual scrolling cannot silently change semantic position.**
4. **A “scroll” command changes viewport only.**
5. **A “continue from here” command changes semantic position.**
6. **Display prediction cannot confirm semantic progress.**
7. **The display cannot predict indefinitely during an ASR outage.**
8. **A global shadow match cannot directly control the viewport.**
9. **Coaching measurements cannot influence alignment.**
10. **Command words cannot be treated as script evidence.**
11. **The null/off-script hypothesis must always remain available.**
12. **No visible direction reversal before backward movement is confirmed.**

These invariants are more important than squeezing another fraction of a percentage from average alignment accuracy.

---

# 20. What to measure internally

## 20.1 Alignment-quality features

For each event:

```text
absolute position error
top candidate score
top-two margin
posterior entropy
credible interval width
matched information mass
transcript coverage
exact-match fraction
phonetic-match fraction
insertion-run length
deletion-run length
distance from confirmed
distance from viewport
candidate ambiguity
ASR token stability
```

## 20.2 Mode features

```text
speech active
silence duration
local lexical coverage
semantic similarity to current paragraph
duration since last confirmed match
duration of unresolved speech
presence of repair term
pause before backward candidate
candidate direction
candidate boundary type
```

## 20.3 Display features

```text
semantic-to-display lag
target-to-viewport error
scroll velocity
scroll acceleration
scroll jerk
direction reversals
current-text visibility
next-text visibility
manual correction after automatic motion
```

---

# 21. Evaluation metrics that match user expectations

Standard word error rate is not enough. Two recognizers with similar final WER can behave very differently during streaming because one may emit quickly and revise frequently while another emits later but more stably.

Incremental-ASR research uses measures such as first-occurrence latency, final-decision latency and word-survival rate; incremental-processing research also defines edit overhead as the proportion of intermediate edits that were unnecessary or harmful. ([ACL Anthology][5])

Adapt these concepts to CandidCue.

## 21.1 Position accuracy

```text
AtomError(t) =
    absolute(predictedAtom(t) - goldAtom(t))
```

Report:

* Median atom error.
* P95 atom error.
* P99 atom error.
* Percentage within ±2 atoms.
* Percentage within ±5 atoms.
* Sentence-level accuracy.
* Paragraph-level accuracy.

Only calculate exact position error while the speaker is actually reading scripted text. Ad-lib intervals require mode metrics instead.

## 21.2 First correct occurrence

```text
PositionFO =
    first time the engine proposes the correct position
```

This measures responsiveness.

## 21.3 Final decision

```text
PositionFD =
    first time the correct position is selected
    and never subsequently displaced by a wrong hypothesis
```

## 21.4 Correction time

```text
CorrectionTime = PositionFD - PositionFO
```

A system can find the right position early but remain unstable for too long.

## 21.5 Position survival rate

For each provisional cursor update, measure whether it remains valid after:

```text
100 ms
250 ms
500 ms
1 second
2 seconds
```

This is the cursor analogue of word-survival rate.

## 21.6 Visual edit overhead

```text
VisualEditOverhead =
    unnecessaryOrReversedScrollDistance
    /
    totalAutomaticScrollDistance
```

A system may end at the correct place while producing distracting intermediate movements. This metric captures that.

## 21.7 False jumps

Define:

```text
FalseJump =
    committed semantic movement to an incorrect region
    requiring later correction
```

Report false jumps per hour.

## 21.8 Catastrophic jumps

A useful definition:

```text
CatastrophicJump =
    unauthorized committed movement
    greater than max(80 atoms, one paragraph)
    from the gold region
    persisting for more than 500 ms
```

Release target:

```text
zero on the locked evaluation corpus
```

## 21.9 Authority violations

```text
AuthorityViolation =
    movement outside the destination range
    allowed by the current authority state
```

Target:

```text
zero
```

## 21.10 Recovery latency

Measure separately after:

* One ASR substitution.
* Several omitted words.
* Brief ad-lib.
* Long ad-lib.
* Local sentence skip.
* Deliberate retake.
* Manual scroll and reanchor.
* ASR outage.

```text
RecoveryLatency =
    scenario end
    to first point where confirmed position
    remains within ±2 atoms for at least 500 ms
```

## 21.11 Ad-lib composure

```text
AdLibComposure =
    1 - unauthorizedMovementTime / totalAdLibTime
```

Also record:

* Maximum distance moved during ad-lib.
* Number of shadow candidates promoted incorrectly.
* Time required to reacquire the script afterward.

## 21.12 Next-text availability

This is one of the most user-centred metrics.

```text
NextTextAvailability =
    percentage of scripted speaking time
    where the current gold atom
    and the next approximately two seconds of text
    are visible
```

The screen does not need to know the exact current word continuously if it reliably keeps the needed text available.

## 21.13 Readability outage

```text
ReadabilityOutage =
    continuous duration for which the speaker's required text
    is outside the usable reading area
```

Report:

* Number per session.
* Median duration.
* P95 duration.
* Maximum duration.

## 21.14 Unexpected reverse rate

Count every visible reverse movement that was not:

* A confirmed retake.
* An explicit command.
* A manual scroll.

For a polished teleprompter, this should approach zero.

## 21.15 Manual intervention rate

Measure:

* Manual scrolls per session.
* “Return to my place” commands.
* “Continue from here” commands.
* Pauses caused by loss of place.
* Operator reanchors.
* Manual corrections within two seconds of an automatic movement.

That last measure is a useful behavioural proxy for “the app just did something surprising.”

## 21.16 Confidence calibration

Report:

* Expected calibration error.
* Brier score.
* Reliability plots.
* Credible-interval coverage.

For example, among events labelled 90% confidence, roughly 90% should truly be within the defined position tolerance.

---

# 22. Initial release gates

These are strong starting targets:

```text
Scripted-reading position:
    ≥95% within ±2 atoms
    ≥99% within ±5 atoms

Safety:
    zero authority violations
    zero catastrophic wrong commits on locked corpus
    false jumps <0.05 per hour

Recovery:
    local reacquisition P95 <1.2 seconds
    deliberate retake P95 <2.0 seconds

Display:
    next-text availability >99.5%
    unexpected automatic reverse rate approximately zero

Calibration:
    expected calibration error <0.05

Performance:
    P95 alignment event processing <2 ms
    P99 alignment event processing <5 ms
```

The safety metrics should block release even if average position accuracy is excellent.

---

# 23. Build the evaluation system before tuning

## 23.1 Recorded event format

Store:

```text
raw audio
audio chunk sequence
audio timestamps
speech activity
ASR request/commit events
ASR delta events
ASR completion events
item IDs
arrival timestamps
transcript revisions
alignment snapshots
viewport snapshots
manual input
commands
layout measurements
```

This lets you deterministically replay the exact realtime session.

## 23.2 Gold annotations

Annotate a timeline with:

```text
SCRIPTED_READING(script atom range)
FILLER
AD_LIB
PARAPHRASE
REPAIR
RETAKE
FORWARD_SKIP
COMMAND
SILENCE
MANUAL_SCROLL
ASR_OUTAGE
```

For scripted intervals, map audio to script atoms. Use independent alignment followed by human correction for the release corpus.

## 23.3 Synthetic test generation

Create a `PerformancePlan` describing:

* Script position.
* Exact words read.
* Inserted fillers.
* Omitted words.
* Substitutions.
* Paraphrased sentence.
* Ad-lib duration and content.
* Retake destination.
* Manual scroll event.
* Command.
* Pause duration.

Generate several TTS renderings and stream them through the actual recognizer in approximately 100 ms audio chunks.

Synthetic cases are valuable because their ground truth is exact, but they must be supplemented with real novice speakers, accents, microphones, background noise and long sessions. OpenAI’s own production guidance explicitly recommends representative real audio and tracking empty, truncated and delayed transcripts separately from WER. ([OpenAI Developers][2])

## 23.4 Adversarial scenarios

Include:

* Common phrase repeated in eight sections.
* An ad-lib that quotes a later chapter exactly.
* Rare name omitted by ASR.
* Number recognized in a different spoken form.
* Acronym split into letters.
* Contraction split into two tokens.
* Speaker repeats a phrase rhetorically.
* Speaker restarts after a long pause.
* User scrolls while continuing to speak.
* Wake phrase appears literally in the script.
* Command is partially misrecognized.
* Completion events arrive in a different order.
* Transcript tail is repeatedly revised.
* Recognizer produces no output for two seconds.
* Speaker changes pace abruptly.
* Speaker skips an entire paragraph.
* Two chapter headings have similar names.
* Script contains duplicated paragraphs.

## 23.5 Ablation tests

Run the same corpus with:

* Rarity weighting disabled.
* Phonetic similarity disabled.
* Affine gaps replaced by linear gaps.
* Null hypothesis removed.
* Beam reduced to one hypothesis.
* Authority gate disabled.
* Semantic fallback disabled.
* Semi-global alignment replaced with Smith–Waterman.
* Stable/provisional distinction removed.
* Display prediction disabled.

This will reveal which components improve accuracy and which specifically prevent dangerous behaviour.

---

# 24. Implementation modules

A clean Rust backend could be divided into:

```text
script_compiler
script_normalization
pronunciation_lexicon
script_indexes

asr_adapter
transcript_ledger
token_stability

command_router
navigation_authority
viewport_authority

candidate_generator
span_aligner
phonetic_similarity
hypothesis_tracker
confidence_calibrator
mode_controller
commit_policy

speech_activity
pace_estimator
latency_estimator
display_predictor
scroll_controller

alignment_telemetry
session_recorder
replay_runner
evaluation_metrics
```

The frontend should receive immutable snapshots rather than manipulating alignment state itself.

```text
AlignmentSnapshot:
    confirmedAtom
    observedAtom
    displayTargetAtom
    viewportTargetY
    alignmentMode
    viewportAuthority
    confidence
    credibleRange
    activeSentence
    activeParagraph
    statusForOperator
```

---

# 25. Recommended implementation sequence

## Phase 1: Instrumentation and deterministic replay

Build this first.

* Record complete ASR event streams.
* Record audio and timings.
* Record every alignment decision.
* Build replay at original speed and accelerated speed.
* Establish a baseline with normalized edit distance.

Without deterministic replay, every threshold change becomes subjective.

## Phase 2: Script compiler and transcript ledger

Implement:

* Structural parsing.
* Script atoms.
* Number and contraction variants.
* Information weights.
* Revision-safe transcript events.
* Stable and provisional evidence.

## Phase 3: Primary aligner

Implement:

* Candidate corridors.
* Weighted semi-global DP.
* Affine gaps.
* 1↔1, 1↔2 and 2↔1 transitions.
* Filler classification.
* Phonetic similarity.
* Rich alignment statistics.

## Phase 4: Multi-hypothesis tracking

Implement:

* Eight-hypothesis beam.
* Null/off-script hypothesis.
* Continuity priors.
* Local and shadow candidate separation.
* Confirmed versus observed positions.

## Phase 5: Authority and state machines

Implement:

* Manual peek.
* Explicit navigation authority.
* Following, coasting, holding and ad-lib states.
* Repair and retake candidate states.
* Hard no-global-jump invariant.

## Phase 6: Display controller

Implement:

* Pace and ASR-delay measurement.
* Bounded display prediction.
* Alpha-beta filtering.
* Jerk-limited scrolling.
* Confidence-dependent highlighting.

## Phase 7: Calibration

Using held-out human recordings:

* Fit action confidence.
* Tune evidence-mass thresholds.
* Tune state-transition durations.
* Plot false-jump rate against recovery latency.
* Select a deliberately conservative operating point.

## Phase 8: Local semantics and personalization

Only after the procedural core is strong:

* Current-paragraph semantic similarity.
* “Find the part about…” commands.
* Learned user pronunciation aliases.
* User-specific ASR confusion pairs.
* Session-specific pace and filler profiles.

---

# 26. Safe personalization

The application can learn a small amount without becoming opaque.

## 26.1 Reading pace

Adapt quickly within a session but retain a broad prior between sessions.

## 26.2 Common filler forms

Learn repeated fillers such as:

* “You know.”
* “Basically.”
* “So, yeah.”
* “I mean.”

These receive cheaper insertion costs, but only after repeated evidence.

## 26.3 Pronunciation and recognition aliases

If the recognizer repeatedly converts:

```text
RuinWeave → ruin weave
CandidCue → candid Q
Tauri → towery
```

store controlled aliases after several high-confidence observations.

## 26.4 ASR delay distribution

Maintain separate profiles by:

* Recognizer model.
* Delay setting.
* Microphone.
* Audio configuration.

## 26.5 Safety thresholds should not drift freely

Do not automatically lower distant-jump or backward-retake thresholds merely because a user often jumps around. Those behaviours should remain tied to explicit authority.

---

# 27. How it feels intelligent while remaining procedural

The system will feel intelligent because it exhibits the behaviours people associate with understanding:

### It remembers context

It knows where the speaker was, rather than searching the document from scratch after every word.

### It represents uncertainty

It can distinguish:

* “I know the exact word.”
* “I know the sentence.”
* “I know the paragraph.”
* “The speaker is probably ad-libbing.”
* “I do not know.”

### It understands different kinds of mistakes

A filler word, a recognizer omission, a paraphrase, a correction and a deliberate retake lead to different behaviours.

### It is asymmetric about risk

It is eager to make tiny local corrections and extremely reluctant to make disruptive global ones.

### It understands authority

Ordinary speech means “continue following me.” A wake-word command means “I am deliberately changing the navigation context.”

### It predicts softly and commits conservatively

The display may compensate for latency, while the semantic anchor waits for stronger evidence.

### It degrades gracefully

As confidence drops:

```text
word precision
→ phrase precision
→ line precision
→ stable hold
```

It does not suddenly become erratic.

### It uses semantics in the right place

Semantic similarity helps answer “Am I still in this paragraph?” but cannot independently answer “Which exact word should be highlighted?”

### It is deterministic

Every movement can be reconstructed from:

* Transcript evidence.
* Script evidence.
* Prior position.
* State.
* Confidence.
* Authority.
* Explicit thresholds.

That is the ideal architecture for CandidCue: sophisticated inference, conservative procedural policy, and an exceptionally calm presentation layer.

[1]: https://aclanthology.org/W11-2014.pdf "https://aclanthology.org/W11-2014.pdf"
[2]: https://developers.openai.com/api/docs/guides/realtime-transcription "https://developers.openai.com/api/docs/guides/realtime-transcription"
[3]: https://aclanthology.org/L14-1335/ "https://aclanthology.org/L14-1335/"
[4]: https://aclanthology.org/E17-1031.pdf "https://aclanthology.org/E17-1031.pdf"
[5]: https://aclanthology.org/2020.coling-main.312.pdf "https://aclanthology.org/2020.coling-main.312.pdf"
