# Endpoint timing, and what is still unmeasured

This records the state of CC-114 from the 1.0 readiness review, because part of
it is done in code and part of it needs a microphone and a room.

## What changed

`AlignmentConfig::endpoint_lag_ms` (1400 ms) was inherited from the hosted
recogniser the app used to stream to. Its own documentation said the constant
is the wrong SHAPE for sherpa-onnx, because an utterance can close three ways
and only one of them involves waiting out silence:

| How it closed | Is the final late? | What the constant did |
|---|---|---|
| Endpoint rule on trailing silence | Yes, by roughly the silence required | Correct in shape |
| Utterance-length cap (rule 3) | **No** — the speaker was still talking | Dated the last word 1.4 s early |
| Explicit stop (`finish()`) | **No** — the audio simply stops | Dated the last word 1.4 s early |

The engine could not tell them apart, so it applied the same subtraction to all
three. For the bottom two rows that is not a tuning question, it is a category
error: it moves the last word to before it was said, and a display that thinks
speech stopped earlier than it did settles onto a pause that never happened.

Now:

- `cc_stt::CloseReason` rides on every `SttFrame::Final` — `Silence`,
  `LengthCap`, `ExplicitFinish`, or `Unknown`.
- `SttFrame::Final::acoustic_end_ms` carries the last decoded token's own
  timestamp, separately from `audio_end_ms`, which is a receipt time.
- `CloseReason::acoustic_end` is the single translation from those two into
  "when did speaking stop". Both hosts call it — `src-tauri/src/align` live and
  `cc-bench`'s replay offline — so the harness feeds the engine exactly what
  the app does.
- `cc_align::ledger::Item::acoustic_end_ms` is what the engine consumes. Time
  still enters the engine as explicit audio-clock milliseconds; it knows
  nothing about endpoint rules.

`Unknown` falls back to `endpoint_lag_ms` unchanged, which is what every frame
in the frozen corpora carries — so `bench/runs*/` replays byte-identically and
every recorded baseline still describes the code.

Rule 3 is inferred from utterance length rather than reported: sherpa's
`is_endpoint` is one boolean over three rules and the C API does not say which
fired. A rule-2 endpoint landing within a frame of the cap is indistinguishable
from a rule-3 one. That boundary case is rare, and the two answers differ by at
most one endpoint lag — which is the error being removed from *every* long
utterance rather than one unlucky one.

## What is still unmeasured, and why

**The silence-endpoint constant itself is still 1400 ms and still unmeasured on
this recogniser.** Changing it needs a corpus captured through the shipping
model, and the frozen fixtures cannot answer: they carry the `audioEndMs` they
were captured with, from a different recogniser.

That capture needs a real microphone, a real room, and someone reading — slow,
normal and fast; with pauses, retakes, skips and off-script asides; with
utterances long enough to hit the cap and a stop pressed mid-sentence; with
names, figures and punctuation. It is the "physical acceptance" the readiness
review lists under work an agent cannot do.

Until it exists:

- **do not** read a green suite as evidence about endpoint timing. Every test
  in the tree takes the `Unknown` branch.
- **do not** retune `endpoint_lag_ms`, `partial_lag_ms`, `lead_margin_atoms` or
  the pause constants against the existing corpora and call the result
  measured. They were captured against a recogniser that is gone.
- **do** re-run Tier B and Tier C together once there is a corpus. A later
  evidence clock reads as fresher to `Snapshot::display_at`, so it delays the
  settle onto a pause and holds the display's lead open longer. Right answer,
  re-tuned constants — and no way to tell which way that trades without
  something to measure it on.

## Benchmark integrity

`read_events_jsonl` now refuses a Git LFS pointer, an empty corpus, and a
malformed line, with the fix in the message. `bench/README.md` had always
warned that an unfetched corpus "finds no events rather than failing loudly";
a warning in a README is not a gate, and a benchmark reporting PASS having
replayed nothing is the shape of evidence with none of the substance.
