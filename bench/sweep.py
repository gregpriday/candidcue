#!/usr/bin/env python3
"""Fast config sweeps against a captured corpus.

Replaying a Tier-B corpus is a pure function of (events, gold, config), so a
config experiment costs seconds — no capture, no network, no audio. This drives
`cc-bench tier-b` over a list of config overrides and prints one row per
variant, so a sweep is readable as a table instead of eighteen scrollbacks.

    python3 bench/sweep.py --runs bench/runs-local \
        --set partial_lag_ms=0,150,300 --set prediction_gain=0.25,0.33

`--set k=a,b,c` sweeps one key at a time against the baseline (a coordinate
sweep, not a full cross product) unless `--cross` is passed.

SAFETY IS A FILTER, NOT A COLUMN. Any variant that puts `false_jumps`,
`catastrophic` or `recovery_failures` above zero is marked UNSAFE and must not
be chosen however good the rest of its row looks — that is the rule the whole
harness is built around.
"""

import argparse
import itertools
import json
import subprocess
import sys
import tempfile
from pathlib import Path

# The columns worth looking at, in the order they matter for this product.
# `within2` is deliberately late: a display that is tight on average but
# sometimes AHEAD of the reader is worse than one that trails consistently,
# because the stage fades text the reader has passed.
COLUMNS = [
    ("live.dim_p50_ms", "dim_p50", "low"),
    ("live.dim_p95_ms", "dim_p95", "low"),
    ("live.within5", "within5", "high"),
    ("live.ahead_time", "ahead%", "low"),
    ("live.ahead_events", "aheadN", "low"),
    ("live.p95_abs", "p95", "low"),
    ("live.first_lock_p50", "lock", "low"),
    ("live.recovery_p95", "recov", "low"),
    ("live.freeze", "freeze", "low"),
]
SAFETY = ["live.false_jumps", "live.catastrophic", "live.recovery_failures"]


def run(runs: Path, config: dict, binary: Path, scripts_root: Path) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(config, handle)
        config_path = handle.name
    out = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False).name
    proc = subprocess.run(
        [
            str(binary), "tier-b",
            "--runs", str(runs.resolve()),
            "--config", config_path,
            "--label", "sweep",
            "--out", out,
        ],
        capture_output=True,
        text=True,
        cwd=scripts_root,
    )
    if proc.returncode != 0:
        sys.exit(f"cc-bench failed:\n{proc.stdout}\n{proc.stderr}")
    with open(out) as handle:
        return {row["name"]: row["value"] for row in json.load(handle)["table"]}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", required=True, type=Path)
    parser.add_argument("--set", action="append", default=[],
                        help="key=v1,v2,v3 — swept one key at a time")
    parser.add_argument("--cross", action="store_true",
                        help="full cross product instead of a coordinate sweep")
    parser.add_argument("--base", type=Path,
                        help="baseline config JSON; defaults to cc-bench's own default")
    parser.add_argument("--binary", type=Path,
                        default=Path("crates/target/release/cc-bench"))
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    binary = (root / args.binary).resolve()
    runs = args.runs if args.runs.is_absolute() else root / args.runs

    if args.base:
        base = json.loads(args.base.read_text())
    else:
        # Take the default straight from a baseline run so the sweep and the
        # app cannot drift apart.
        probe = run(runs, {}, binary, root / "crates")
        del probe
        base = json.loads(
            subprocess.run(
                [str(binary), "tier-b", "--runs", str(runs.resolve()),
                 "--label", "probe", "--out", "/dev/stdout"],
                capture_output=True, text=True, cwd=root / "crates",
            ).stdout.split("wrote")[0]
        )["config"]

    variants = []
    parsed = []
    for spec in args.set:
        key, _, values = spec.partition("=")
        parsed.append((key, [float(v) for v in values.split(",")]))

    if args.cross:
        for combo in itertools.product(*[[(k, v) for v in vs] for k, vs in parsed]):
            cfg = dict(base)
            cfg.update(dict(combo))
            variants.append(("  ".join(f"{k}={v:g}" for k, v in combo), cfg))
    else:
        variants.append(("baseline", dict(base)))
        for key, values in parsed:
            for value in values:
                if base.get(key) == value:
                    continue
                cfg = dict(base)
                cfg[key] = value
                variants.append((f"{key}={value:g}", cfg))

    head = f"{'variant':38}" + "".join(f"{label:>9}" for _, label, _ in COLUMNS)
    print(head)
    print("-" * len(head))
    for name, cfg in variants:
        table = run(runs, cfg, binary, root / "crates")
        unsafe = [k for k in SAFETY if table.get(k, 0) > 0]
        row = f"{name:38}" + "".join(f"{table[key]:9.2f}" for key, _, _ in COLUMNS)
        print(row + ("   UNSAFE " + ",".join(unsafe) if unsafe else ""))


if __name__ == "__main__":
    main()
