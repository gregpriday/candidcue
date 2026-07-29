#!/usr/bin/env bash
#
# Fetch the bundled speech recogniser into src-tauri/models/.
#
# The model is ~161 MB of ONNX graphs. It is NOT in git — binaries that large
# make every clone and every bisect pay for them forever — so the build depends
# on this script having run. `cargo build` succeeds without it and the app fails
# at the top of a take with "the speech model is missing from this
# installation", which is why `SpeechEngine::ensure_loaded` validates the files
# by name before it asks the C library for anything.
#
#   ./scripts/fetch-stt-model.sh        # or: pnpm models:fetch
#
# Idempotent: re-running with the files already present does nothing.

set -euo pipefail

MODEL="sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05"
ARCHIVE="${MODEL}.tar.bz2"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${ARCHIVE}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${REPO_ROOT}/src-tauri/models/x-asr-480ms"

# INT8 encoder and joiner with an FP32 decoder. The test WAVs and the export
# script in the archive are deliberately left behind.
#
# `bpe.model` is the binary SentencePiece model. Kept because it is 116 KB
# against a 148 MB encoder and it is what a hotword pass would be generated
# FROM — but note it is NOT sherpa's `bpe_vocab`, which wants the two-column
# `.vocab` this bundle does not ship. See `ModelFiles::detect`.
FILES=(
  "encoder.int8.onnx"
  "decoder.onnx"
  "joiner.int8.onnx"
  "tokens.txt"
  "bpe.model"
)

have_all=true
for file in "${FILES[@]}"; do
  [[ -f "${DEST}/${file}" ]] || have_all=false
done
if [[ "${have_all}" == true ]]; then
  echo "STT model already present in ${DEST}"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "Downloading ${MODEL} (~134 MB archive, ~161 MB kept)…"
curl -fL "${URL}" -o "${TMP}/${ARCHIVE}"
tar -xjf "${TMP}/${ARCHIVE}" -C "${TMP}"

# Staged, then moved into place one file at a time. `mv` within a filesystem is
# atomic, so an interrupted run leaves a file either absent or complete — never
# present and truncated, which the `-f` check above would then skip forever.
mkdir -p "${DEST}"
for file in "${FILES[@]}"; do
  cp "${TMP}/${MODEL}/${file}" "${DEST}/.${file}.part"
  mv "${DEST}/.${file}.part" "${DEST}/${file}"
done

echo "Installed into ${DEST}:"
du -ch "${DEST}" | tail -1
