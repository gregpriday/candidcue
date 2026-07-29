# Bundled speech recognition model

CandidCue transcribes speech on-device using a model it does not own. This file
travels with the model because Apache-2.0 requires attribution to be carried
with redistribution, and the upstream archive ships no licence file of its own.

It lives inside the bundled resource directory deliberately: the model is
fetched rather than committed (`pnpm models:fetch`), so a notice kept anywhere
else would describe an artefact that may not be present, and would not reach a
user who has only the installed app.

## The model

**X-ASR streaming Zipformer transducer** (`480 ms` chunk, INT8, punctuated)

- Upstream: <https://github.com/Gilgamesh-J/X-ASR>
- Distributed via: <https://github.com/k2-fsa/sherpa-onnx> releases, as
  `sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05`
- Authors: Jun Guo, with the X-LANCE Lab, Shanghai Jiao Tong University
- **Licence: Apache License 2.0**

Apache-2.0 permits commercial use and redistribution in closed-source software,
and requires that this attribution and a copy of the licence accompany the
distribution. CandidCue redistributes the model weights unmodified.

## The runtime

Inference runs through **sherpa-onnx** (<https://github.com/k2-fsa/sherpa-onnx>),
also Apache-2.0, linked statically via the `sherpa-onnx` Rust crate, which in
turn embeds **ONNX Runtime** (MIT).

## Apache License 2.0

The full text is at <https://www.apache.org/licenses/LICENSE-2.0>.

A distributed build must include that text. If CandidCue grows a general
third-party licence screen, this entry belongs in it; until then this file is
the record, and it is bundled with the application.
