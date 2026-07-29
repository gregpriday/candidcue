#!/usr/bin/env python3
"""Render the recogniser swap as one markdown table.

Takes cc-bench result JSONs and prints a column per corpus plus a verdict on
the controlled pair. The controlled pair is the only one that answers the
question: same audio, same gold, same evaluator, only the recogniser differs.

    python3 bench/compare-recognisers.py \
        --frozen  bench/results/baseline-tier-b.json \
        --before  bench/results/inworld-new-tier-b.json \
        --after   bench/results/local-tier-b.json

`--frozen` is optional; it is the historical corpus, kept so the numbers stay
comparable with what is already written down in REPORT.md. It is NOT part of
the verdict, because fal.ai TTS does not render the same performance twice and
its audio is therefore not the audio the other two columns heard.
"""

import argparse
import json


def load(path):
    with open(path) as handle:
        doc = json.load(handle)
    return {row["name"]: row for row in doc["table"]}


def fmt(value, unit):
    if value is None:
        return "—"
    if unit == "count":
        return f"{value:.0f}"
    if unit == "s":
        return f"{value:.2f}"
    return f"{value:.2f}"


def verdict(row_before, row_after):
    """Which way did it move, and does that direction help or hurt?"""
    if row_before is None or row_after is None:
        return "", ""
    before, after = row_before["value"], row_after["value"]
    better = row_before["better"]
    delta = after - before

    if abs(delta) < 1e-9:
        return "0", "="
    sign = "+" if delta > 0 else ""
    # `higher_is_worse_diagnostic` is WER: reported, never scored. It measures
    # the recogniser, not the display, and the whole thesis under test is that
    # the two are allowed to disagree.
    if better == "higher":
        mark = "better" if delta > 0 else "worse"
    elif better == "lower":
        mark = "better" if delta < 0 else "worse"
    else:
        mark = "diagnostic"
    return f"{sign}{delta:.2f}", mark


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--frozen")
    parser.add_argument("--before", required=True)
    parser.add_argument("--after", required=True)
    args = parser.parse_args()

    frozen = load(args.frozen) if args.frozen else {}
    before = load(args.before)
    after = load(args.after)

    names = list(before) + [n for n in after if n not in before]

    header = ["metric", "unit"]
    if frozen:
        header.append("Inworld (frozen audio)")
    header += ["Inworld (same audio)", "local (same audio)", "delta", ""]
    print("| " + " | ".join(header) + " |")
    print("|" + "|".join(["---"] * len(header)) + "|")

    for name in names:
        b, a = before.get(name), after.get(name)
        unit = (b or a)["unit"]
        cells = [f"`{name}`", unit]
        if frozen:
            f = frozen.get(name)
            cells.append(fmt(f["value"], unit) if f else "—")
        cells.append(fmt(b["value"], unit) if b else "—")
        cells.append(fmt(a["value"], unit) if a else "—")
        delta, mark = verdict(b, a)
        cells += [delta, mark]
        print("| " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()
