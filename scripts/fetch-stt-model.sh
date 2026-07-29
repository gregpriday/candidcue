#!/usr/bin/env bash
#
# Fetch the bundled speech recogniser into src-tauri/models/.
#
# The model is ~43 MB of ONNX graphs. It is NOT in git — binaries that large
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

MODEL="sherpa-onnx-streaming-zipformer-en-20M-2023-02-17"
ARCHIVE="${MODEL}.tar.bz2"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${ARCHIVE}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${REPO_ROOT}/src-tauri/models/zipformer-en-20m"

# INT8 encoder and joiner with an FP32 decoder — the combination upstream's own
# INT8 example uses. The decoder is 2 MB; quantising it buys nothing. The FP32
# encoder (85 MB), the INT8 decoder, the test WAVs and the export scripts in the
# archive are all deliberately left behind.
FILES=(
  "encoder-epoch-99-avg-1.int8.onnx"
  "decoder-epoch-99-avg-1.onnx"
  "joiner-epoch-99-avg-1.int8.onnx"
  "tokens.txt"
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

echo "Downloading ${MODEL} (~122 MB archive, ~43 MB kept)…"
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
