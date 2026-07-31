#!/usr/bin/env bash
#
# Fetch a speech recogniser named by src-tauri/models/catalogue.json.
#
# The model is ~161 MB of ONNX graphs. It is NOT in git — binaries that large
# make every clone and every bisect pay for them forever — so the build depends
# on this script having run. `cargo build` succeeds without it and the app fails
# at the top of a take with "the speech model is missing from this
# installation", which is why `SpeechEngine::ensure_loaded` validates the files
# by name before it asks the C library for anything.
#
#   ./scripts/fetch-stt-model.sh                # or: pnpm models:fetch
#   ./scripts/fetch-stt-model.sh --language fr
#   ./scripts/fetch-stt-model.sh --model kroko-de
#   ./scripts/fetch-stt-model.sh --force        # re-fetch even if verified
#
# Nothing about the model is written down here. The archive name, its URL, its
# SHA-256, its size, the files to keep and the licence notice all come from the
# catalogue, which the Rust binary compiles in with `include_str!` — so the dev
# path and the shipped path cannot drift into disagreeing about what a model is.
#
# Bytes are verified before they are unpacked. The mirror is tried first and
# upstream is the fallback, because the SHA-256 is the trust root and the host
# is not: a hash-verified fetch from either is equally trustworthy, and the
# mirror exists so an upstream tag that mutates or drops an asset cannot take
# the build down with it.
#
# Idempotent: re-running with the files already present and hashing correctly
# re-writes only the attribution notice.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="${REPO_ROOT}/scripts/model-catalogue.mjs"
MODELS_DIR="${CANDIDCUE_MODELS_DIR:-${REPO_ROOT}/src-tauri/models}"

FORCE=false
SELECTOR=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=true; shift ;;
    --model|--language) SELECTOR+=("$1" "${2:-}"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

for tool in node curl tar; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "${tool} is required" >&2; exit 1; }
done

# macOS ships `shasum`, most Linux images ship `sha256sum`. Neither is
# guaranteed, so pick whichever is here rather than assuming.
if command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
else
  echo "neither shasum nor sha256sum is available" >&2
  exit 1
fi

size_of() { wc -c < "$1" | tr -d '[:space:]'; }

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

# NUL-delimited so a URL or a licence sentence can never be re-read as shell.
node "${HELPER}" fields "${SELECTOR[@]+"${SELECTOR[@]}"}" > "${TMP}/fields"
FIELDS=()
while IFS= read -r -d '' field; do FIELDS+=("${field}"); done < "${TMP}/fields"

MODEL_ID="${FIELDS[0]}"
MODEL_NAME="${FIELDS[1]}"
INSTALL_DIR="${FIELDS[2]}"
ARCHIVE_NAME="${FIELDS[3]}"
ARCHIVE_ROOT="${FIELDS[4]}"
ARCHIVE_SHA="${FIELDS[5]}"
ARCHIVE_BYTES="${FIELDS[6]}"
MIRROR_URL="${FIELDS[7]}"
UPSTREAM_URL="${FIELDS[8]}"
FILE_COUNT="${FIELDS[9]}"

# Files arrive as (name, sha256, bytes) triples after the header.
FILE_NAMES=()
FILE_SHAS=()
for ((i = 0; i < FILE_COUNT; i++)); do
  FILE_NAMES+=("${FIELDS[$((10 + i * 3))]}")
  FILE_SHAS+=("${FIELDS[$((10 + i * 3 + 1))]}")
done

DEST="${MODELS_DIR}/${INSTALL_DIR}"

write_attribution() {
  # Regenerated every run, including the no-download path: a catalogue change
  # that only touches the licence text must still reach the notice on disk.
  mkdir -p "${DEST}"
  node "${HELPER}" attribution --model "${MODEL_ID}" > "${DEST}/.ATTRIBUTION.md.part"
  mv "${DEST}/.ATTRIBUTION.md.part" "${DEST}/ATTRIBUTION.md"
}

# Present AND hashing correctly. The old script trusted file existence, which
# cannot tell a complete file from one that upstream quietly replaced.
installed_and_verified() {
  local i name
  for ((i = 0; i < FILE_COUNT; i++)); do
    name="${FILE_NAMES[$i]}"
    [[ -f "${DEST}/${name}" ]] || return 1
    [[ "$(sha256_of "${DEST}/${name}")" == "${FILE_SHAS[$i]}" ]] || return 1
  done
  return 0
}

if [[ "${FORCE}" != true ]] && installed_and_verified; then
  echo "${MODEL_ID} already present and verified in ${DEST}"
  write_attribution
  exit 0
fi

# Try a URL, and leave the archive in place only if it matches the catalogue.
try_download() {
  local url="$1" label="$2" target="${TMP}/${ARCHIVE_NAME}"
  rm -f "${target}"
  echo "Downloading ${ARCHIVE_NAME} from ${label}…"
  if ! curl -fL --connect-timeout 20 --retry 2 "${url}" -o "${target}"; then
    echo "  ${label}: download failed" >&2
    rm -f "${target}"
    return 1
  fi
  local actual_bytes actual_sha
  actual_bytes="$(size_of "${target}")"
  if [[ "${actual_bytes}" != "${ARCHIVE_BYTES}" ]]; then
    echo "  ${label}: expected ${ARCHIVE_BYTES} bytes, got ${actual_bytes}" >&2
    rm -f "${target}"
    return 1
  fi
  actual_sha="$(sha256_of "${target}")"
  if [[ "${actual_sha}" != "${ARCHIVE_SHA}" ]]; then
    echo "  ${label}: expected sha256 ${ARCHIVE_SHA}, got ${actual_sha}" >&2
    rm -f "${target}"
    return 1
  fi
  echo "  ${label}: verified ${actual_bytes} bytes, sha256 ${actual_sha}"
  return 0
}

got_archive=false
if [[ -n "${MIRROR_URL}" ]]; then
  if try_download "${MIRROR_URL}" "mirror"; then
    got_archive=true
  else
    echo "Mirror miss — falling back to upstream. The hash is checked either way." >&2
  fi
fi
if [[ "${got_archive}" != true ]] && try_download "${UPSTREAM_URL}" "upstream"; then
  got_archive=true
fi
if [[ "${got_archive}" != true ]]; then
  echo "Could not obtain a verified ${ARCHIVE_NAME}. Nothing was unpacked." >&2
  exit 1
fi

tar -xjf "${TMP}/${ARCHIVE_NAME}" -C "${TMP}"

# Staged, then moved into place one file at a time. `mv` within a filesystem is
# atomic, so an interrupted run leaves a file either absent or complete — never
# present and truncated, which the hash check above would then have to catch on
# the next run rather than never seeing at all.
mkdir -p "${DEST}"
for ((i = 0; i < FILE_COUNT; i++)); do
  name="${FILE_NAMES[$i]}"
  src="${TMP}/${ARCHIVE_ROOT}/${name}"
  [[ -f "${src}" ]] || { echo "archive has no ${name}" >&2; exit 1; }
  actual="$(sha256_of "${src}")"
  if [[ "${actual}" != "${FILE_SHAS[$i]}" ]]; then
    echo "${name}: expected sha256 ${FILE_SHAS[$i]}, got ${actual}" >&2
    exit 1
  fi
  cp "${src}" "${DEST}/.${name}.part"
  mv "${DEST}/.${name}.part" "${DEST}/${name}"
done

write_attribution

echo "Installed ${MODEL_NAME} into ${DEST}:"
du -ch "${DEST}" | tail -1
