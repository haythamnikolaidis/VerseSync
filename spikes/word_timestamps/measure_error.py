#!/usr/bin/env python3
"""
measure_error.py — T-02: score one faster-whisper transcript (from
run_transcription.py) against spikes/word_timestamps/ground_truth.csv.

For each ground-truth row, recovers the original quote's body text from
labels.meta.json (via the "orig #N" reference in the CSV's notes column,
written by from_audacity.js) and matches it — or the spoken reference —
against the transcript's word list using scripture_match.match_label.

Usage:
  python measure_error.py --transcript transcripts/large-v3_vadon_promptnone_condtrue.json \
      --ground-truth ground_truth.csv --meta labels.meta.json \
      --out transcripts/large-v3_vadon_promptnone_condtrue.scored.json
"""

import argparse
import csv
import json
import re
import sys
import statistics


def parse_orig_index(notes):
    m = re.search(r"orig #(\d+)", notes or "")
    return int(m.group(1)) if m else None


def load_ground_truth(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rows.append(row)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--ground-truth", required=True)
    ap.add_argument("--meta", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--window-s", type=float, default=10.0)
    args = ap.parse_args()

    sys.path.insert(0, __file__.rsplit("/", 1)[0] if "/" in __file__ else ".")
    from scripture_match import match_label

    transcript = json.load(open(args.transcript, encoding="utf-8"))
    words = transcript["words"]
    gt_rows = load_ground_truth(args.ground_truth)
    meta = json.load(open(args.meta, encoding="utf-8"))
    meta_by_index = {m["index"]: m for m in meta}

    results = []
    for row in gt_rows:
        orig_idx = parse_orig_index(row.get("notes", ""))
        meta_entry = meta_by_index.get(orig_idx) if orig_idx else None
        body_text = (meta_entry or {}).get("titleGuess") or ""
        reference = row["reference"]
        label_start = float(row["start_seconds"])

        m = match_label(words, label_start, reference, body_text, window_s=args.window_s)
        results.append({
            "index": row["index"],
            "reference": reference,
            "label_start_s": label_start,
            "orig_index": orig_idx,
            "had_body_text": bool(body_text),
            **m,
        })

    matched = [r for r in results if r["matched"]]
    abs_errors = sorted(abs(r["error_s"]) for r in matched)

    def percentile(sorted_vals, p):
        if not sorted_vals:
            return None
        k = (len(sorted_vals) - 1) * (p / 100.0)
        f = int(k)
        c = min(f + 1, len(sorted_vals) - 1)
        if f == c:
            return sorted_vals[f]
        return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)

    summary = {
        "transcript_config": transcript["config"],
        "transcript_wall_s": transcript["transcribe_wall_s"],
        "audio_duration_s": transcript["audio_duration_s"],
        "total_labels": len(results),
        "matched_count": len(matched),
        "match_rate": len(matched) / len(results) if results else None,
        "matched_via_reference": sum(1 for r in matched if r["matched_via"] == "reference"),
        "matched_via_body": sum(1 for r in matched if r["matched_via"] == "body"),
        "p50_abs_error_s": percentile(abs_errors, 50),
        "p90_abs_error_s": percentile(abs_errors, 90),
        "max_abs_error_s": abs_errors[-1] if abs_errors else None,
        "mean_abs_error_s": statistics.mean(abs_errors) if abs_errors else None,
    }

    out = {"summary": summary, "labels": results}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    print(json.dumps(summary, indent=2))
    unmatched = [r for r in results if not r["matched"]]
    if unmatched:
        print(f"\n{len(unmatched)} unmatched label(s):", file=sys.stderr)
        for r in unmatched:
            print(f"  #{r['index']} {r['reference']} @ {r['label_start_s']:.1f}s — {r['reason']}", file=sys.stderr)


if __name__ == "__main__":
    main()
