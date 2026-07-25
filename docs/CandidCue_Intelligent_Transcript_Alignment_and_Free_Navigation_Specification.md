# CandidCue Intelligent Transcript Alignment and Free Navigation

## Implementation specification

**Document status:** Build-ready design specification  
**Version:** 1.0  
**Date:** 25 July 2026  
**Applies to:** CandidCue desktop  
**Primary stack:** Tauri 2, Svelte 5, TypeScript, Rust  
**Relationship to existing specifications:** This document narrows and overrides the navigation policy in `CandidCue_Smooth_Following_and_Intelligent_Alignment_Specification.md`. It does not replace that document's continuous-motion, line-map, pace-estimation, or stage-controller requirements.

---

## 1. Executive summary

CandidCue must track the presenter's *intended place in the script*, not search for an exact transcript string.

The production system should treat a transcript as noisy, incremental evidence. A presenter may omit a word, insert a filler, substitute a synonym, restart a sentence, pronounce an unusual name, receive a bad transcription, skip forward, return to an earlier paragraph, or begin reading at an entirely different place. The tracker must keep several plausible locations, score them using ordered fuzzy evidence, and move only when the evidence is strong enough for the size and risk of the move.

The required solution is a deterministic, low-latency local alignment engine with these layers:

1. Reconcile provisional and final speech-to-text events into a stable rolling token ledger.
2. Normalize script and transcript text into comparable spoken forms.
3. Generate a bounded set of candidate script spans using local continuity, distinctive words, n-grams, aliases, phonetic keys, headings, recent locations, and a document-wide relocation index.
4. Align transcript tails against each candidate using weighted sequence alignment. Insertions, omissions, substitutions, transpositions, transcription errors, and skipped phrases must have different costs.
5. Maintain a beam of plausible locations instead of committing to the highest score from one event.
6. Use a confidence and hysteresis policy that distinguishes ordinary following, local correction, retake, manual navigation, and deliberate document-wide relocation.
7. Convert a confirmed semantic position into a continuous stage trajectory. Speech evidence must never directly write a pixel scroll value.
8. Resolve manual wheel, trackpad, keyboard, outline, and button navigation back to a token index and seed the tracker there.
9. Highlight the best current word or phrase when confidence supports it, and degrade honestly when only a broader region is known.

This is not an LLM-in-the-loop scrolling design. An optional semantic reranker may help distinguish a paraphrase from unrelated speech, but word-level and sequence-level evidence remains authoritative. The core path must keep working offline after transcription has been received, must be deterministic in replay tests, and must not send scripts to an additional service.

---

## 2. Current repository baseline

This specification is written against the current repository, not against the assumption that the application still uses only exact string matching.

The following capabilities already exist and should be retained:

- `src/shared/tracking/normalize.ts` implements text normalization, fillers, number and contraction equivalence, bounded Levenshtein similarity, and a phonetic key.
- `src/shared/tracking/matching.ts` assigns weighted exact, alias, equivalent, fuzzy, phonetic, and weak matches.
- `src/shared/tracking/candidates.ts` builds bounded candidate windows from continuity, retake, section, checkpoint, rare-word, alias, phonetic, fidelity, and n-gram indexes.
- `src/shared/tracking/alignment-v2.ts` maintains a bounded multi-hypothesis beam.
- `src/shared/tracking/engine.ts` owns committed and provisional positions, retake behavior, epochs, pace, and motion-frame emission.
- `src/shared/tracking/section-graph.ts` enforces section eligibility.
- `src/stage/motion/` and `src/stage/renderer/ScriptLayer.svelte` already separate semantic tracking from frame-rate visual motion.
- `src/stage/renderer/InlineNodes.svelte` already renders per-token anchors and a current-word underline.
- Manual token moves already enter the worker through `move_to_token`.

The main gaps this work must close are:

| Gap | Current consequence | Required change |
|---|---|---|
| Non-contiguous speech-only section jumps are prohibited | Starting to read a distant passage cannot relocate the cursor, even with excellent evidence | Add a separately gated document-wide relocation path |
| Manual wheel input sends only `deltaPx` | The stage moves, but the tracking worker is not told which token is now in the reading band | Return a semantic anchor token and seed a manual tracking epoch |
| Word edit matching is boolean | One permitted spelling edit and a very close match receive the same feature value | Produce graded lexical similarity and confusion-aware substitution cost |
| Phonetic matching is a single hand-built English key | Accents, names, compounds, and common ASR confusions can fail candidate generation | Add indexed aliases, configurable language rules, and observed-confusion support |
| The sequence scorer primarily models token matches and gaps | A near-paraphrase or multi-word ASR rewrite may be under-scored | Add phrase equivalence and a tightly bounded semantic reranker |
| Current-word UI implies exact certainty | During coasting or ambiguous alignment, the underline can overstate what is known | Separate exact word, phrase, region, and unknown highlight states |
| Global search is a widened candidate search, not a deliberate relocation protocol | Distant matches either remain blocked or risk becoming too permissive if the existing gate is simply removed | Introduce explicit relocation hypotheses, persistence, distinctiveness, and cooldown |

This work should extend the existing implementation. Replacing the tracker with a generic fuzzy-search library would discard important section, timing, command, retake, and motion behavior.

---

## 3. Product behavior contract

### 3.1 Ordinary reading

When the presenter reads in order, the current word should advance continuously. One or two wrong, missing, or additional words must not make the cursor stop. Short transcription revisions must not make it move backward and forward.

### 3.2 Transcription error

If the script says “CandidCue reconciles provisional evidence” and the transcript says “candid queue reconciles provisional evidents,” the system should still align the ordered phrase. Phonetic and edit evidence may rescue the two errors, while the exact surrounding words provide the anchor.

### 3.3 Missed and additional words

If the presenter skips a short phrase, repeats a word, or adds “um,” “actually,” or “you know,” the alignment should use insertion and deletion operations and continue. A skipped negation, number, currency amount, date, or proper noun must carry a greater confidence penalty than skipped filler.

### 3.4 Near-script delivery

If the presenter expresses substantially the same sentence with different wording, the tracker may continue through the local passage when:

- the candidate is inside the current continuity corridor;
- the words that did match remain in the right order;
- enough of the phrase's distinctive content is covered;
- no competing passage explains the speech almost as well; and
- semantic assistance, if enabled, supports but does not solely determine the move.

The tracker should not demand a verbatim performance. It must also not treat any vaguely related speech as proof that a sentence was delivered.

### 3.5 Starting elsewhere by speaking

The presenter may stop, move to a different part of the script, and begin reading there without pressing a command. The system must recognize a deliberate relocation when a distinctive ordered run from the new location persists long enough.

The stage should:

1. slow or hold at the old location while the distant hypothesis is provisional;
2. avoid visibly chasing every remote partial match;
3. confirm the new location using final transcript evidence or a sufficiently stable provisional run;
4. start a new semantic epoch;
5. re-anchor visually to the destination; and
6. continue ordinary following from there.

### 3.6 Returning to an earlier passage

A return to a recently visited sentence is a retake. A return to a distant earlier passage is a relocation. Both are allowed, but the latter requires the stronger document-wide evidence described in Section 12.

### 3.7 Manual navigation

Wheel, trackpad, arrow keys, page keys, control-window buttons, and outline clicks are authoritative. After the user scrolls:

- the text must remain where the user put it;
- automatic following must pause during the gesture and a short grace period;
- the stage must identify the token nearest the reading-band anchor;
- the tracking worker must begin a new manual epoch at that token;
- old transcript completions must not pull the cursor back; and
- new speech should reacquire near the new token first, while still permitting another deliberate spoken relocation.

### 3.8 Honest highlighting

The UI must communicate the granularity the tracker actually knows:

- **word lock:** underline the estimated current word;
- **phrase lock:** use the phrase underlay, without claiming one exact word;
- **region lock:** keep the current paragraph or line in the reading band but show no word underline;
- **unknown/relocating:** hold or fade the word marker until the new location is confirmed.

---

## 4. Goals, non-goals, and invariants

### 4.1 Goals

- Tolerate ordinary ASR substitutions, insertions, omissions, and revisions.
- Follow imperfect reading without requiring exact words.
- Support short skips, retakes, and document-wide speech relocation.
- Preserve a stable current-word or current-phrase indicator.
- Make manual scrolling a semantic navigation action.
- Keep per-update CPU and memory bounded independently of script length after indexing.
- Make every movement decision reproducible from recorded transcript events and configuration.
- Keep the stage visually calm when confidence changes.

### 4.2 Non-goals

- Inferring position from audio without transcription.
- Automatically rewriting the script.
- Treating semantic similarity alone as permission to jump.
- Sending raw audio or the full script to an extra model by default.
- Perfect alignment of completely improvised speech.
- Moving the stage directly in response to each transcript event.
- Allowing one rare word or one heading name to trigger a large jump.

### 4.3 Hard invariants

1. Transcript text never directly sets `scrollPx`.
2. A single weak token never authorizes a distant relocation.
3. Every accepted movement has an authority: `ordinary`, `spoken_relocation`, `command`, or `manual`.
4. Manual and command authority always outrank speech evidence.
5. Provisional transcript revisions may advance a local visual estimate but may not finalize a distant relocation without persistence.
6. A delayed transcript item from an older epoch may not undo a manual move, command, retake, or relocation.
7. Candidate work is capped by profile parameters; normal per-event work must not scan every script token.
8. Diagnostic records must contain scores, indexes, and reason codes, not retained raw transcript or script text unless the user explicitly enables transcript retention.

---

## 5. Coordinate systems and state

The implementation must keep these values separate:

- `scriptTokenIndex`: integer index in the compiled spoken-token stream.
- `spokenUnitPosition`: continuous weighted position used by pace and motion.
- `committedTokenIndex`: last position accepted by the movement policy.
- `provisionalTokenIndex`: best current local estimate.
- `visualActiveTokenIndex`: token whose progress is rendered; may be interpolated between transcript updates.
- `scrollPx`: current stage transform.
- `manualAnchorTokenIndex`: token nearest the reading-band anchor after a manual gesture.
- `epoch`: monotonic semantic navigation generation.
- `transcriptItemEpoch`: epoch active when an item or partial first entered the ledger.

The tracker should expose these high-level states:

```ts
type TrackingStateV3 =
  | 'acquiring'
  | 'following'
  | 'coasting'
  | 'uncertain'
  | 'retake_pending'
  | 'relocation_candidate'
  | 'relocating'
  | 'manual_override'
  | 'command_pending'
  | 'paused'
  | 'reconnecting';
```

`relocation_candidate` is intentionally different from ordinary `searching`. It says that a strong candidate exists outside the ordinary navigation corridor, but has not yet earned authority.

---

## 6. Compile-time document preparation

All expensive document-wide preparation should happen when the script compiles, not on every transcript update.

### 6.1 Spoken-token model

Extend `SpokenToken` or its tracking projection with:

```ts
interface TrackingTokenFeatures {
  normalized: string;
  stem?: string;
  phoneticKeys: string[];
  aliases: string[];
  contentClass:
    | 'filler'
    | 'function'
    | 'content'
    | 'negation'
    | 'number'
    | 'date'
    | 'currency'
    | 'proper_noun';
  rarityWeight: number;
  sectionId: string;
  sentenceId: string;
  blockId: string;
}
```

Do not require stemming to define equality. Stems are a weak feature for candidate retrieval and must be language-specific.

### 6.2 Indexes

Build and retain:

- normalized unigram postings;
- distinctive content bigram, trigram, and four-gram postings;
- alias postings, including multi-word aliases;
- phonetic-key postings;
- number, date, currency, negation, and proper-noun postings scoped by section;
- sentence and paragraph start positions;
- outline and heading positions;
- token-frequency and n-gram document-frequency tables;
- a MinHash or SimHash signature per sentence-sized window for cheap approximate retrieval;
- repeated-passage groups, so boilerplate can be marked ambiguous rather than treated as distinctive;
- optional paraphrase vectors per sentence, stored locally and used only for reranking already retrieved candidates.

The document-wide relocation index must retrieve a small candidate set without performing dynamic programming over the full script. A practical initial target is at most 24 relocation windows, each no larger than 160 spoken tokens.

### 6.3 Distinctiveness

Define:

```text
idf(term) = log((1 + documentWindowCount) / (1 + windowsContainingTerm))
```

Clamp the result to the profile's weight range. Distinctiveness is script-relative: a name repeated in every paragraph is not a global anchor, even if it is rare in ordinary English.

An n-gram may nominate a distant location only when its document frequency is below the configured repeat allowance. Repeated phrases remain useful for local confirmation.

### 6.4 Authored aliases

Keep existing compiler aliases and add an optional authoring surface for difficult names and acronyms. One possible Markdown directive is:

```md
{say="Ndlovu" aliases="and lover|end low voo"}
```

The exact syntax may follow the existing compiler conventions. The compiled form, not the source directive, is what the tracker consumes.

---

## 7. Transcript reconciliation

The transcript ledger remains the sole source of speech evidence.

### 7.1 Item lifecycle

Represent each provider item as:

```ts
interface ReconciledItem {
  itemId: string;
  sessionGeneration: number;
  commitSequence: number;
  firstSeenAtMs: number;
  lastUpdatedAtMs: number;
  audioStartMs?: number;
  audioEndMs?: number;
  epochAtFirstSeen: number;
  provisionalTokens: LedgerToken[];
  finalTokens?: LedgerToken[];
  status: 'provisional' | 'final' | 'failed' | 'masked';
}
```

Rules:

- replace an item's provisional projection; do not append duplicate partial text;
- a final item freezes its text;
- ignore stale deltas after finalization;
- preserve provider confidence and word timestamps when available;
- mask command-consumed items;
- prune by item count and token count, not time alone;
- keep enough history for a retake and relocation evidence window;
- never combine items from different session generations.

### 7.2 Evidence tails

Generate multiple tails from the ledger:

- short: latest 4–7 useful tokens;
- medium: latest 8–16 useful tokens;
- long: latest 17–32 useful tokens;
- sentence-aware: since the last confident silence or final boundary.

The short tail reacts quickly. The long tail disambiguates repeated wording. Score the medium or long tail once over the full candidate set, then rescore only leading candidates with the remaining tails.

### 7.3 Epoch contamination

When `epoch` changes:

- finalize the old cursor state;
- tag all open items from the prior epoch as stale for navigation;
- permit their text to remain in user-visible transcript history;
- exclude late completions from alignment unless they contain audio timestamps wholly after the epoch boundary;
- clear the hypothesis beam and seed the authoritative destination when the move was manual or commanded.

---

## 8. Normalization and fuzzy token comparison

### 8.1 Normalization pipeline

For script and transcript:

1. Unicode NFKC normalization.
2. Locale-aware case folding.
3. Smart quote and dash normalization.
4. Punctuation removal while retaining sentence, clause, and authored-pause metadata separately.
5. Contraction expansion alternatives.
6. Number, ordinal, percentage, currency, date, and time canonicalization.
7. Hyphenated and compound-word alternatives.
8. Conservative filler classification.
9. Optional language-specific stemming and diacritic-folded alternatives.
10. Preservation of negations and fidelity-critical terms.

Normalization should emit alternatives, not destructively replace the surface:

```ts
interface NormalizedAlternatives {
  primary: string;
  equivalents: string[];
  numericValue?: number;
  phoneticKeys: string[];
}
```

### 8.2 Graded lexical distance

Replace boolean `lexicallySimilar()` as the only lexical feature with normalized Damerau-Levenshtein similarity:

```text
lexicalSimilarity(a, b) =
  1 - damerauLevenshtein(a, b) / max(length(a), length(b))
```

Use a bounded implementation that exits once a candidate cannot reach the minimum score. Damerau-Levenshtein is preferred because ASR and typing-style tokenization errors can produce adjacent transpositions.

Initial rules:

- tokens shorter than 4 characters receive no edit-distance rescue unless they are an explicit alias;
- 4–6 character tokens require similarity at least 0.80;
- 7–10 character tokens require at least 0.74;
- longer tokens require at least 0.70;
- a fuzzy match never receives the same score as an exact or authored-alias match.

### 8.3 Phonetic similarity

Retain the current phonetic key as one feature, but allow more than one key per token. For English, a maintained Double Metaphone implementation is preferable to continually extending a custom key. Other languages must select an appropriate profile or disable phonetic matching.

Phonetic equality can nominate a candidate. It should not by itself confirm a distant move.

### 8.4 ASR confusion model

Maintain a small versioned confusion table:

```ts
interface AsrConfusion {
  heard: string[];
  intended: string[];
  cost: number;
  language: string;
  source: 'built_in' | 'authored' | 'local_observed';
}
```

Examples include split/join pairs, homophones, acronym expansion, and recurring proper-name errors. Locally observed confusions may be suggested from repeated high-confidence surrounding alignments, but must be capped, inspectable, removable, and stored without audio.

### 8.5 Match score

One token-pair score should combine independent evidence:

```text
matchScore =
  scriptTokenWeight
  × providerConfidence
  × max(
      exactWeight,
      aliasWeight,
      numericWeight,
      contractionWeight,
      lexicalWeight × lexicalSimilarity,
      phoneticWeight × phoneticSimilarity,
      confusionWeight
    )
```

Do not add every correlated feature. Taking the maximum prevents one misspelling from being counted independently as lexical, phonetic, and confusion evidence.

---

## 9. Weighted sequence alignment

Word matching must preserve order and explicitly model missing and additional words.

### 9.1 Algorithm

Use banded weighted Smith-Waterman or semi-global dynamic programming over each transcript tail and candidate script window.

Required operations:

- exact/equivalent/alias match;
- fuzzy or phonetic substitution;
- transcript insertion: presenter filler or ad-libbed word;
- script deletion: missed or skipped scripted word;
- adjacent transposition;
- split/join: “real time” versus “realtime”;
- phrase alias: a small `m:n` authored or confusion mapping;
- restart: reuse of an earlier local prefix with a new monotonic path.

### 9.2 Initial operation costs

These values are calibration defaults, not permanent constants:

| Operation | Initial cost |
|---|---:|
| Exact content match | +1.00 × token weight |
| Authored alias / numeric equivalent | +0.92 |
| High lexical similarity | +0.70 to +0.88 |
| Phonetic match | +0.62 |
| Exact function-word match | +0.20 |
| Inserted filler | -0.03 |
| Inserted content word | -0.22 |
| Deleted ordinary function word | -0.08 |
| Deleted ordinary content word | -0.28 |
| Deleted negation/number/date/currency | -0.65 |
| Adjacent transposition | -0.18 |
| Unrelated substitution | -0.48 |

The alignment result must include:

```ts
interface RichSequenceAlignment {
  normalizedScore: number;
  coverage: number;
  orderedCoverage: number;
  contentCoverage: number;
  criticalTermCoverage: number;
  longestOrderedRun: number;
  matchedPairs: MatchedPair[];
  insertedTranscriptTokens: number[];
  deletedScriptTokens: number[];
  startTokenIndex: number;
  endTokenIndex: number;
}
```

### 9.3 Position estimate

The current position is not always the final matched script token.

- With word timestamps, interpolate inside the most recent matched pair.
- Without timestamps, start from the last strong ordered match and project by the robust short-term speaking pace.
- Never project past the end of the accepted candidate span.
- During coasting, decay projected velocity to zero.
- If the last two matches are separated by a deletion run, position at the later match only after its evidence is stable.

---

## 10. Candidate generation

Candidate generation is retrieval; sequence alignment is ranking. Keep them separate.

### 10.1 Local candidates

Always include bounded windows around:

- the committed cursor;
- the predicted cursor from pace;
- the current sentence and paragraph;
- recent high-confidence checkpoints;
- recently visited spans;
- the next sequential section boundary;
- the previous paragraph and previous section for retakes.

### 10.2 Anchor candidates

Probe document indexes with:

- distinctive transcript content words;
- transcript bigrams, trigrams, and four-grams;
- authored aliases;
- phonetic keys;
- fidelity-critical terms;
- approximate sentence signatures.

Merge overlapping windows, retain their source explanations, cap their length, and deduplicate candidates that describe the same location.

### 10.3 Relocation candidates

Run the global relocation retriever when any of these is true:

- local confidence has remained below `0.42` for at least `900 ms` while useful speech continues;
- the best remote candidate exceeds the best local candidate by the relocation pre-margin;
- the presenter is in `manual_override` and begins speaking outside the manual corridor;
- the user explicitly requests “find my place” or equivalent command behavior in a future command layer.

Do not wait for the tracker to be fully lost before collecting remote hypotheses. Collection is cheap; execution is gated separately.

### 10.4 Retrieval budget

Initial maximums:

- 12 local windows;
- 12 anchor windows;
- 24 relocation windows;
- 160 script tokens per window;
- 32 transcript tokens per tail;
- 8 hypotheses after merging;
- at most 2 leading candidates sent to optional semantic reranking.

Measure p50, p95, and p99 worker time. The p95 target is below 8 ms per finalized update on the minimum supported hardware.

---

## 11. Multi-hypothesis tracking and confidence

Each hypothesis represents a possible reading trajectory:

```ts
interface LocationHypothesis {
  lineageId: string;
  tokenPosition: number;
  sectionId: string;
  mode: 'local' | 'retake' | 'relocation' | 'hold';
  posterior: number;
  sequenceScore: number;
  continuityPrior: number;
  distinctiveness: number;
  evidenceItemIds: string[];
  supportingFinalTokens: number;
  supportingDurationMs: number;
  lastUpdatedAtMs: number;
}
```

### 11.1 Priors

- Strong forward continuity prior for nearby movement at plausible pace.
- Moderate prior for short skips inside the current paragraph.
- Lower prior for backward retakes.
- Very low prior for document-wide relocation.
- Identity/hold hypothesis at every update.
- Manual and command seeds begin with authoritative posterior 1.0.

### 11.2 Posterior

Use calibrated logistic scoring or normalized log scores. The features must be logged independently:

```text
logScore =
  sequenceEvidence
  + continuityPrior
  + distinctivenessBonus
  + finalEvidenceBonus
  + persistenceBonus
  + optionalSemanticAdjustment
  - distancePenalty
  - ambiguityPenalty
  - repeatedPassagePenalty
  - staleEvidencePenalty
```

Do not present this number to users as an absolute probability until it has been calibrated against a labelled corpus.

### 11.3 Hysteresis

A challenger must beat the active lineage by a margin and persist. If the two leading hypotheses refer to materially different locations and are too close, hold. Never alternate the committed cursor between them on successive partials.

---

## 12. Document-wide spoken relocation

This section overrides the existing rule that ordinary speech can never cross a non-contiguous section boundary.

### 12.1 Separate authority

Add:

```ts
type TransitionAuthority =
  | 'ordinary'
  | 'spoken_relocation'
  | 'command'
  | 'manual';
```

`spoken_relocation` is created only by the relocation gate. The ordinary section graph remains conservative.

### 12.2 Relocation gate

A remote candidate may commit when all of these are true:

1. It is materially outside the ordinary continuity and retake corridors.
2. It contains at least 4 matched content tokens, or 3 exceptionally distinctive content tokens.
3. Its longest ordered run is at least 4 useful tokens.
4. Its content coverage is at least 0.58.
5. At least two anchors are independent; one repeated rare word is insufficient.
6. Its score exceeds the best local candidate by at least `0.16`.
7. Its score exceeds the second-best remote location by at least `0.12`.
8. It persists for either:
   - two finalized transcript items, or
   - at least 1.2 seconds and 7 useful provisional tokens with no material revision.
9. It is not explained by a known repeated-passage group unless later words disambiguate the occurrence.
10. It did not use a command-masked item.

Thresholds must live in `TrackingProfile`, be versioned, and be tuned from the corpus.

### 12.3 Fast path

A highly distinctive phrase may relocate faster when:

- at least 6 useful tokens match in order;
- at least 3 are high-rarity;
- normalized sequence score is at least `0.86`;
- the remote margin is at least `0.22`; and
- the provisional transcript has been stable for at least `450 ms`.

The fast path still may not execute from one isolated token.

### 12.4 Commit behavior

On commit:

1. increment `epoch`;
2. mark open prior-epoch transcript items stale for navigation;
3. clear and seed the hypothesis beam at the destination;
4. record the previous and destination spans in the visited ring;
5. reset short-term pace, retaining only a bounded baseline pace;
6. emit movement `relocation`;
7. emit a stage transition directive:
   - absorb if already within approximately one rendered line;
   - bounded catch-up for a nearby skip;
   - fade re-anchor for a distant destination;
8. suppress another speech-only relocation for `1.5 s` unless the new evidence is overwhelming or the current destination immediately collapses.

### 12.5 False-jump protections

- Quoting an earlier line while still surrounded by current local evidence should remain local.
- A heading title alone cannot relocate.
- Boilerplate and repeated refrains require disambiguating context.
- Background speech with low provider confidence cannot relocate.
- A remote semantic reranker result cannot relocate without lexical/phonetic ordered evidence.
- If the user manually scrolls during a relocation candidate, manual authority cancels it.

---

## 13. Near-paraphrase handling

### 13.1 Deterministic phrase features

Before using embeddings or a model, add:

- lemmatized content-word overlap;
- synonym groups for a small, versioned language dictionary;
- phrase aliases authored in the script;
- preservation of word order by longest common subsequence;
- contradiction-sensitive terms, especially negation and numbers.

These features can advance inside the local corridor. They cannot independently authorize a remote relocation.

### 13.2 Optional semantic reranker

If later product evaluation proves deterministic features insufficient, add a bounded sidecar with this contract:

```ts
interface SemanticRerankRequest {
  transcriptPhrase: string;
  candidates: Array<{
    candidateId: string;
    scriptPhrase: string;
  }>; // maximum 2
}

interface SemanticRerankResult {
  candidateId: string;
  relation:
    | 'near_exact'
    | 'paraphrase'
    | 'partial'
    | 'contradiction'
    | 'unrelated';
  coverage: number;
}
```

Constraints:

- asynchronous and never awaited by the animation path;
- cancelled or discarded when its epoch, script hash, or transcript revision is stale;
- maximum score adjustment of ±0.08;
- cannot create a candidate;
- cannot cross the relocation gate by itself;
- disabled by default if it requires sending script text to another service;
- no generated prose and no unrestricted token index.

---

## 14. Manual scrolling and navigation controls

### 14.1 Current defect

The current stage applies `manualScrollBy(deltaPx)` locally and emits:

```ts
{ kind: 'manual_scroll', deltaPx }
```

Control intentionally does not move the tracking cursor. This creates two truths: pixels are at the user's chosen place, while the tracker still believes the old token is active. Automatic frames can then reassert the old location.

### 14.2 Semantic manual-navigation event

Replace or extend the intent:

```ts
type StageIntent =
  | {
      kind: 'manual_navigation';
      gestureId: string;
      phase: 'start' | 'update' | 'end';
      input: 'wheel' | 'trackpad' | 'keyboard' | 'drag';
      scrollPx: number;
      anchorTokenIndex: number | null;
      direction: 'forward' | 'back' | 'none';
      layoutGeneration: number;
    }
  | { kind: 'manual_step'; direction: 'forward' | 'back'; unit: 'line' | 'paragraph' }
  | { kind: 'toggle_pause' }
  | { kind: 'stage_focused' };
```

The stage derives `anchorTokenIndex` from the rendered line map at the reading-band anchor Y. This is more reliable than hit-testing a DOM word that may be virtualized.

### 14.3 Gesture lifecycle

On `start`:

- stage enters manual override immediately;
- semantic frames remain received and acknowledged but are not applied to motion;
- control tells the worker `begin_manual_override`.

On throttled `update`:

- stage sends current semantic anchor at most every 100 ms;
- control may update its UI, but the worker does not need to rebuild the beam on every pixel.

On `end`, after 150 ms without more input:

- stage sends the final anchor;
- control posts `move_to_token` with movement `manual`;
- worker increments the epoch and seeds the beam;
- motion controller sets the new position as its plant state, avoiding a corrective animation back to the same place;
- automatic follow remains suspended for an initial `900 ms` grace period.

If `anchorTokenIndex` is null because the line map is invalid, retain the pixel position, hold automatic following, and show a recoverable control-window warning. Never guess a token from a broken layout.

### 14.4 Controls

Support these controls consistently:

| Input | Behavior |
|---|---|
| Wheel/trackpad | Free manual scroll, followed by semantic anchoring |
| Up/Down | One rendered-line semantic step |
| Page Up/Page Down | Approximately one viewport, landing on the nearest line anchor |
| Previous/Next sentence | Existing semantic sentence move |
| Previous/Next paragraph | Paragraph boundary move |
| Outline click | Absolute manual token move |
| “Back to where I was” | Optional navigation-history pop using the visited/checkpoint ring |

All control paths end in a token destination and new epoch. Pixel-only navigation is never the lasting source of truth.

---

## 15. Current-word and phrase highlighting

### 15.1 Output contract

Add a highlight projection to the semantic frame or a parallel revisioned event:

```ts
interface HighlightEstimate {
  epoch: number;
  revision: number;
  mode: 'word' | 'phrase' | 'region' | 'none';
  tokenIndex?: number;
  phraseStartTokenIndex?: number;
  phraseEndTokenIndex?: number;
  confidence: number;
  source: 'matched' | 'interpolated' | 'coasting';
}
```

### 15.2 Rules

- `word`: confidence at least `0.72`, with a recent ordered matched pair or safe interpolation.
- `phrase`: confidence `0.52–0.72`, or the tail aligns well but exact within-phrase timing is unavailable.
- `region`: candidate location is useful but ambiguous at word level.
- `none`: relocating, lost, layout invalid, or confidence below `0.36`.

The exact thresholds are tunable profile values.

### 15.3 Rendering

Retain the current underline for `word`. Retain the low-contrast underlay for `phrase`. Do not animate an underline through words the engine did not estimate. During interpolation, cap progress at the last accepted candidate boundary and decay to `phrase` or `region` as evidence ages.

On a distant re-anchor, hide the old marker during fade-out and reveal the new marker only after the new document position is applied.

---

## 16. Worker and protocol changes

### 16.1 Tracking worker input

Extend `TrackingWorkerInput` with:

```ts
| {
    type: 'begin_manual_override';
    gestureId: string;
    nowMs: number;
  }
| {
    type: 'end_manual_override';
    gestureId: string;
    tokenIndex: number;
    layoutGeneration: number;
    nowMs: number;
  }
```

The existing `move_to_token` message may implement the final move internally, but the explicit lifecycle is needed to suspend integration while a gesture is active.

### 16.2 Tracking snapshot

Prefer a schema-version bump rather than silently changing version 1:

```ts
interface TrackingSnapshotV2 {
  schemaVersion: 2;
  // existing fields...
  epoch: number;
  authority: 'ordinary' | 'spoken_relocation' | 'command' | 'manual';
  movement:
    | 'hold'
    | 'advance'
    | 'skip'
    | 'retake'
    | 'relocation'
    | 'command'
    | 'manual';
  highlight: HighlightEstimate;
}
```

Every stage event remains guarded by session generation, stage generation, script compile hash, layout generation, revision, and epoch as applicable.

### 16.3 Decision log

For every nontrivial decision, record:

- from/to token and section indexes;
- authority and movement;
- leading and runner-up scores;
- local-versus-remote margin;
- ordered run, content coverage, and distinctiveness;
- final/provisional evidence counts;
- persistence duration;
- repeated-passage status;
- accepted or blocked reason code;
- visual disposition;
- processing duration and candidate counts.

Use enums for reason codes, including:

```ts
type RelocationReason =
  | 'accepted_standard'
  | 'accepted_fast_path'
  | 'blocked_too_few_anchors'
  | 'blocked_local_margin'
  | 'blocked_remote_ambiguity'
  | 'blocked_repeated_passage'
  | 'blocked_insufficient_persistence'
  | 'blocked_stale_epoch'
  | 'cancelled_manual_authority';
```

---

## 17. Engine update flow

```text
onTranscriptEvent(event):
  update ledger
  if event belongs to stale epoch:
    retain for history, exclude from navigation

  tails = ledger.buildEvidenceTails()
  localWindows = retrieveLocalCandidates(tails, cursor, checkpoints)
  anchorWindows = retrieveAnchorCandidates(tails)
  remoteWindows = retrieveRelocationCandidates(tails)
  windows = mergeAndCap(localWindows, anchorWindows, remoteWindows)

  alignments = alignTailsAgainstWindows(tails, windows)
  hypotheses = beam.advance(alignments, pacePrediction, currentEpoch)

  localLeader = best ordinary/retake hypothesis
  remoteLeader = best relocation hypothesis

  if manual or command authority active:
    keep authoritative seed
  else if relocationGate.accepts(remoteLeader, localLeader):
    commit spoken relocation and increment epoch
  else:
    apply ordinary local/retake decision policy

  update pace only from uncontaminated committed spans
  produce highlight estimate
  emit semantic motion frame
  emit snapshot and decision diagnostics
```

The relocation gate runs after scoring and before commit. It must not be implemented by weakening the section graph globally.

---

## 18. Configuration profile

Add versioned settings under a profile, not user-facing raw sliders:

```ts
interface RelocationProfile {
  enabled: boolean;
  localLowConfidence: number;
  localLostAfterMs: number;
  minContentMatches: number;
  minDistinctiveMatches: number;
  minOrderedRun: number;
  minContentCoverage: number;
  minLocalMargin: number;
  minRemoteMargin: number;
  minFinalItems: number;
  minProvisionalTokens: number;
  minPersistenceMs: number;
  fastPathMinTokens: number;
  fastPathMinRarityMatches: number;
  fastPathScore: number;
  fastPathMargin: number;
  cooldownMs: number;
  manualGraceMs: number;
}
```

Expose only experience-level choices:

- **Conservative:** slower spoken relocation, strongest false-jump protection.
- **Balanced:** defaults in this specification.
- **Responsive:** faster relocation after distinctive phrases, without relaxing hard one-token and ambiguity protections.

The existing follow-feel settings may map to these profiles, but motion feel and alignment risk should remain separately versioned internally.

---

## 19. Performance and failure behavior

### 19.1 Performance budgets

- compile-time index construction: p95 below 300 ms for a 20,000-word script;
- finalized transcript update: p95 below 8 ms in the worker;
- provisional update: p95 below 5 ms;
- memory for indexes: target below 12 MB for a 20,000-word script;
- no main-thread dynamic programming;
- no document-length loop per transcript update;
- no stage DOM measurement per transcript update.

### 19.2 Degradation ladder

If the worker exceeds its budget:

1. stop optional semantic reranking;
2. reduce the remote candidate cap;
3. skip the longest evidence tail;
4. process provisional events at a lower rate while preserving finals;
5. retain ordinary local alignment and manual navigation.

Do not degrade to exact string matching.

### 19.3 Failure modes

- No transcript: decelerate and hold.
- Low-confidence background transcript: keep hold branch; do not relocate.
- Invalid line map: hold semantic position and manual pixel position; warn control.
- Worker crash: stage holds or uses the existing bounded degraded snapshot path.
- Stale semantic result: discard by revision, epoch, and script hash.
- Repeated ambiguity: hold and wait for more words.
- End of document: clamp visual motion, but continue collecting relocation evidence so speech from an earlier passage can return there.

---

## 20. Testing strategy

### 20.1 Deterministic unit tests

Add focused suites for:

- normalized Damerau-Levenshtein thresholds;
- phonetic and authored aliases;
- split/join and transposition operations;
- insertions and deletions;
- critical-term deletion penalties;
- graded provider confidence;
- candidate index caps;
- repeated-passage ambiguity;
- relocation gate acceptance and rejection;
- stale-epoch late completions;
- manual gesture lifecycle;
- highlight mode transitions;
- cost independent of script length.

### 20.2 Scenario corpus

Build replay fixtures with real provider-shaped partial and final events:

1. verbatim reading;
2. one wrong word per sentence;
3. 10%, 20%, and 35% content-word substitutions;
4. fillers and false starts;
5. omitted clauses;
6. skipped sentences;
7. proper-name transcription errors;
8. numbers and negations;
9. contractions and compound splits;
10. paraphrase inside the current paragraph;
11. unrelated ad-lib;
12. short backward retake;
13. distant backward relocation;
14. distant forward relocation;
15. repeated refrain with no disambiguating context;
16. repeated refrain followed by unique context;
17. quote of an earlier line while continuing locally;
18. partial transcript revision;
19. delayed final from a previous epoch;
20. manual scroll followed by continued reading;
21. manual scroll followed by speech from a different destination;
22. noisy background speech containing one rare script word.

### 20.3 Fuzz and property tests

Generate speech variants by probabilistically inserting, deleting, substituting, splitting, joining, and transposing tokens. Assert:

- no out-of-range token indexes;
- monotonic ordinary progress except accepted retakes;
- no remote move below the minimum independent-anchor count;
- manual authority cannot be overridden during its grace period;
- stale epochs cannot move the cursor;
- candidate and DP work remain within configured caps;
- replaying identical inputs produces byte-equivalent decision records.

### 20.4 End-to-end tests

Verify:

- wheel/trackpad input produces `manual_navigation` with a real token anchor;
- the worker snapshot moves to that token;
- the stage does not snap back after the grace period;
- word underline follows snapshots and disappears during relocation ambiguity;
- a distant, distinctive spoken passage triggers a fade re-anchor;
- a repeated phrase alone does not;
- outline and keyboard navigation use the same semantic move path.

### 20.5 Metrics and release gates

Report:

- token-position median absolute error;
- percentage within 1, 3, and 8 tokens;
- relocation success rate;
- relocation median time;
- false relocation rate per hour;
- retake detection rate;
- manual snap-back defects;
- time spent in word, phrase, region, and none highlight modes;
- worker p50/p95/p99 time;
- visible re-anchor count.

Initial release gates:

- at least 97% of ordinary-reading samples within 3 tokens;
- at least 90% of labelled distant relocations acquired within 2.5 seconds;
- false distant relocation below 1 per 10 hours of adversarial and normal corpus speech;
- zero manual snap-backs in the automated gesture suite;
- zero stale-epoch cursor moves;
- p95 worker processing within the budgets in Section 19.

These gates must be evaluated by document and speaker, not only by averaging all events together.

---

## 21. Implementation plan by repository area

### Phase 1: measurement and manual semantic anchoring

- Extend stage intents in `src/shared/contracts/stage.ts`.
- Add reading-band-to-token lookup to `src/stage/motion/lineMap.ts`.
- Emit gesture lifecycle from `src/stage/StageApp.svelte` and `ScriptLayer.svelte`.
- Route final manual anchors through `src/control/stores/session.ts`.
- Add manual override worker messages in `src/shared/tracking/worker-protocol.ts`.
- Ensure `src/shared/tracking/engine.ts` increments epoch, clears old evidence, and seeds the beam.
- Add manual navigation DOM and worker tests.

This phase fixes the pixel/semantic split before changing speech relocation.

### Phase 2: richer fuzzy alignment

- Introduce graded Damerau-Levenshtein output in `normalize.ts`.
- Extend `matching.ts` with graded feature scores and split/join confusion support.
- Extend sequence-alignment output and critical-term penalties in `sequence.ts`.
- Add indexed observed/authored confusions in `document-index.ts`.
- Calibrate against the scenario corpus.

### Phase 3: relocation retrieval and policy

- Add document-wide approximate window retrieval to `document-index.ts` and `candidates.ts`.
- Add relocation hypotheses to `alignment-v2.ts`.
- Extend `TransitionAuthority` without weakening ordinary section eligibility.
- Implement the relocation gate, persistence, cooldown, epoch commit, and reason codes in `engine.ts`.
- Add movement and transition mappings through `behavior.ts`, `motion-frame.ts`, the shared contracts, adapters, stores, and stage.

### Phase 4: honest highlight model

- Add `HighlightEstimate` to shared contracts.
- Produce it in the tracking engine from matched pairs, confidence, evidence age, and pace.
- Update `ScriptLayer.svelte` and `InlineNodes.svelte` to render word, phrase, region, and none states.
- Test re-anchor, coasting, ambiguity, and reduced-motion behavior.

### Phase 5: optional semantic reranking

Implement only if corpus metrics show a material paraphrase gap after deterministic work. Keep the sidecar bounded by the contract in Section 13 and make it independently disableable.

---

## 22. Acceptance examples

### Example A: transcription errors

Script:

> The photovoltaic array stabilizes the microgrid.

Transcript:

> The photo voltaic array stabilises the micro grid.

Expected:

- split/join, spelling, and ordered exact context produce a strong local alignment;
- cursor advances through the sentence;
- no visible correction or re-anchor.

### Example B: missing words

Script:

> Today we will carefully review the three most important findings.

Transcript:

> Today we'll review the three important findings.

Expected:

- contraction equivalence plus script deletions;
- missing “carefully” and “most” reduce confidence but do not stop progress;
- highlight remains word or phrase level.

### Example C: near paraphrase

Script:

> This change gives every team a reliable way to recover.

Transcript:

> With this update, each team has a dependable recovery path.

Expected:

- inside the local corridor, deterministic content and optional bounded semantic evidence support the same passage;
- phrase-level position may advance;
- the engine does not claim exact word timing it does not have.

### Example D: distant spoken relocation

The cursor is in section 2. The presenter begins reading a unique sentence in section 7.

Expected:

- old position coasts briefly and holds;
- section 7 becomes a relocation hypothesis;
- after persistent distinctive ordered evidence, the engine commits `spoken_relocation`;
- epoch increments and the stage fade-reanchors;
- current-word highlighting resumes in section 7.

### Example E: false remote match

The presenter says one distinctive product name that appears in section 7 while continuing to read section 2.

Expected:

- section 7 may be retrieved as a candidate;
- insufficient independent anchors and strong local evidence block relocation;
- no visible jump.

### Example F: manual scroll back

The user scrolls three pages upward and starts reading.

Expected:

- stage moves immediately under manual control;
- final gesture maps to the token in the reading band;
- worker seeds a new manual epoch there;
- late transcripts from the old position are ignored for navigation;
- new speech follows from the manually chosen location;
- no snap back.

---

## 23. Definition of done

The feature is complete when:

- manual scrolling always resolves to and commits a semantic token destination;
- ordinary reading tolerates the corpus error rates without exact-string dependence;
- missing and additional words are represented by sequence operations, not special-case string hacks;
- distant forward and backward spoken relocations work under explicit, tested evidence gates;
- repeated passages and isolated rare words do not cause false relocation;
- current-word highlighting reflects confidence honestly;
- all navigation paths create epochs and reject stale evidence;
- performance remains bounded and measured;
- deterministic, fuzz, DOM, and end-to-end suites pass;
- a real-device session has been completed with a microphone, live Inworld transcription, second display, manual scrolling, a backward relocation, and a forward relocation.

The final real-device exercise is mandatory. Browser and worker tests can prove the decision logic and event contracts, but they cannot prove the experience through teleprompter glass.
