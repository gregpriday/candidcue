#!/usr/bin/env bash
# `sx cargo-test`, `sx clippy`: cargo on a runner, with the slot's target
# directories held to a size cap.
#
# A slot keeps ignored files between runs, so src-tauri/target and
# crates/target survive from one run to the next. That is the point (a warm
# slot rebuilds only what changed), but nothing else ever trims them, and every
# worktree that used a VM keeps a slot workspace of its own on its work volume.
# So before building, a slot whose targets have grown past the cap starts
# clean. The environment in .spotexec.toml keeps them small in the first place
# (no incremental data, line tables instead of full debuginfo).
#
#   cargo.sh <cargo subcommand and args> -- run for both workspaces
set -u

cap_gb=${SG_TARGET_CAP_GB:-12}
targets=(src-tauri/target crates/target)

used_kb=$(du -sk "${targets[@]}" 2>/dev/null | awk '{ s += $1 } END { print s + 0 }')
if (( used_kb > cap_gb * 1024 * 1024 )); then
  echo "[cargo] target directories hold $(( used_kb / 1024 / 1024 )) GB, over the ${cap_gb} GB cap: starting clean"
  rm -rf "${targets[@]}"
fi

# --manifest-path is cargo's own flag, so it goes before the first `--`; what
# follows that (`-D warnings`, `--nocapture`) belongs to clippy or the tests.
cargo_args=() rest=()
for (( i = 1; i <= $#; i++ )); do
  if [[ ${!i} == -- ]]; then rest=("${@:i}"); break; fi
  cargo_args+=("${!i}")
done

# Both workspaces, every one even after a failure; the first failure's status.
status=0
for manifest in src-tauri/Cargo.toml crates/Cargo.toml; do
  s=$SECONDS
  cmd=(cargo "${cargo_args[@]}" --manifest-path "$manifest" ${rest[@]+"${rest[@]}"})
  echo "[cargo] ${cmd[*]}"
  "${cmd[@]}"
  code=$?
  echo "[cargo] $manifest exit $code ($(( SECONDS - s ))s)"
  (( code != 0 && status == 0 )) && status=$code
done

used_kb=$(du -sk "${targets[@]}" 2>/dev/null | awk '{ s += $1 } END { print s + 0 }')
echo "[cargo] target directories now $(( used_kb / 1024 )) MB"
exit $status
