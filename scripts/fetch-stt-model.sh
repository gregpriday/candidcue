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
#   ./scripts/fetch-stt-model.sh --language en
#   ./scripts/fetch-stt-model.sh --model x-asr-480ms
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

# The helper rejects control characters in every field it emits, because a NUL
# smuggled into one would split it in two and shift everything after it — which
# would let the catalogue decide what this script reads as FILE_COUNT. Bash
# expands a variable used in arithmetic recursively, so a command substitution
# landing there would RUN. Checking the framing here means both sides have to
# fail before that is reachable.
HEADER_FIELDS=10
if (( ${#FIELDS[@]} < HEADER_FIELDS )); then
  echo "catalogue helper emitted ${#FIELDS[@]} fields, expected at least ${HEADER_FIELDS}" >&2
  exit 1
fi

# Validated as a literal string BEFORE it is ever used in arithmetic.
if [[ ! "${FIELDS[9]}" =~ ^[1-9][0-9]*$ ]]; then
  echo "file count is not a positive integer: ${FIELDS[9]}" >&2
  exit 1
fi
if (( ${#FIELDS[@]} != HEADER_FIELDS + FIELDS[9] * 3 )); then
  echo "expected $(( HEADER_FIELDS + FIELDS[9] * 3 )) fields, got ${#FIELDS[@]}" >&2
  exit 1
fi

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
FILE_BYTES=()
for ((i = 0; i < FILE_COUNT; i++)); do
  FILE_NAMES+=("${FIELDS[$((HEADER_FIELDS + i * 3))]}")
  FILE_SHAS+=("${FIELDS[$((HEADER_FIELDS + i * 3 + 1))]}")
  FILE_BYTES+=("${FIELDS[$((HEADER_FIELDS + i * 3 + 2))]}")
done

DEST="${MODELS_DIR}/${INSTALL_DIR}"

write_attribution() {
  # Regenerated every run, including the no-download path: a catalogue change
  # that only touches the licence text must still reach the notice on disk.
  mkdir -p "${DEST}"
  node "${HELPER}" attribution --model "${MODEL_ID}" > "${DEST}/.ATTRIBUTION.md.part"
  mv "${DEST}/.ATTRIBUTION.md.part" "${DEST}/ATTRIBUTION.md"

  # And the licence itself, beside the weights it governs — the same file the
  # in-app installer writes (`model_store::write_attribution`), so a model
  # fetched into the source tree and one downloaded by a user look alike.
  local license_id license_src
  license_id="$(node "${HELPER}" license-id --model "${MODEL_ID}")"
  license_src="${REPO_ROOT}/legal/licenses/${license_id}.txt"
  if [[ ! -f "${license_src}" ]]; then
    echo "No committed licence text at ${license_src}." >&2
    echo "A model must not be installable under a licence its own directory cannot show." >&2
    exit 1
  fi
  cp "${license_src}" "${DEST}/LICENSE-${license_id}.txt"
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
  # `--max-filesize` bounds the transfer at the size the catalogue promises, so
  # a host that decides to stream a terabyte fills a temp dir rather than the
  # disk. The size and digest are still checked afterwards — this only stops the
  # bleeding early, and does nothing when the server omits Content-Length.
  # https only, redirects included: a downgrade to http mid-chain is a refusal,
  # not something to notice after the bytes have already been read.
  if ! curl -fL --connect-timeout 20 --retry 2 \
      --proto '=https' --proto-redir '=https' \
      --max-filesize "${ARCHIVE_BYTES}" \
      "${url}" -o "${target}"; then
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

# Only the files the catalogue lists are extracted at all. The digest already
# proves these are the pinned bytes, so this is not about a substituted archive
# — it is that "the archive we pinned" and "an archive safe to unpack whole" are
# different claims. Naming the members means a bundle's test WAVs, export
# scripts, symlinks or anything else never touch the filesystem.
MEMBERS=()
for ((i = 0; i < FILE_COUNT; i++)); do
  MEMBERS+=("${ARCHIVE_ROOT}/${FILE_NAMES[$i]}")
done
tar -xjf "${TMP}/${ARCHIVE_NAME}" -C "${TMP}" "${MEMBERS[@]}"

# Every file is verified BEFORE any of them is moved into place. Verifying and
# moving in one pass would let a mismatch on the last file leave the directory
# holding a new encoder beside an old decoder — a mixed model that still has
# every filename `ModelFiles::detect` looks for.
for ((i = 0; i < FILE_COUNT; i++)); do
  name="${FILE_NAMES[$i]}"
  src="${TMP}/${ARCHIVE_ROOT}/${name}"
  [[ -f "${src}" ]] || { echo "archive has no ${name}" >&2; exit 1; }
  actual_bytes="$(size_of "${src}")"
  if [[ "${actual_bytes}" != "${FILE_BYTES[$i]}" ]]; then
    echo "${name}: expected ${FILE_BYTES[$i]} bytes, got ${actual_bytes}" >&2
    exit 1
  fi
  actual="$(sha256_of "${src}")"
  if [[ "${actual}" != "${FILE_SHAS[$i]}" ]]; then
    echo "${name}: expected sha256 ${FILE_SHAS[$i]}, got ${actual}" >&2
    exit 1
  fi
done

# Staged, then moved into place one file at a time. `mv` within a filesystem is
# atomic, so an interrupted run leaves a file either absent or complete — never
# present and truncated, which the hash check above would then have to catch on
# the next run rather than never seeing at all.
mkdir -p "${DEST}"
for ((i = 0; i < FILE_COUNT; i++)); do
  name="${FILE_NAMES[$i]}"
  cp "${TMP}/${ARCHIVE_ROOT}/${name}" "${DEST}/.${name}.part"
  mv "${DEST}/.${name}.part" "${DEST}/${name}"
done

write_attribution

# Best-effort: the model is installed by this point, and `pipefail` would
# otherwise let an unreadable directory under DEST report the whole fetch as a
# failure over a size line nobody depends on.
echo "Installed ${MODEL_NAME} into ${DEST}:"
du -sh "${DEST}" 2>/dev/null || true
