#!/usr/bin/env python3
"""
run_all.py — T-02 orchestrator. Runs the full spike sequence end to end:

  1. Base matrix: 3 models x {vad on, vad off}, prompt=none, condition_on_previous_text=true.
  2. Pick the winner by lowest p90 abs error (tie-break: lowest p50).
  3. Prompt A/B on the winner: prompt=none (already have it) vs prompt=scripture.
     Decide by book-name mishearing counts first (that's what the prompt is
     for), timestamp error second as a tie-break.
  4. condition_on_previous_text A/B on the winner+chosen-prompt: true (already
     have it) vs false. Decide by repetition-loop count first, timestamp
     error second.
  5. Writes spikes/word_timestamps/all_results_summary.json with everything
     needed to write RESULTS.md — this script does not write RESULTS.md
     itself, so the final judgement calls stay auditable against the raw
     numbers rather than baked into automation.

Resumable: every transcription and scoring step checks for its output file
first and skips the subprocess call if already present, so re-running after
an interruption only does the remaining work.

Run this from spikes/word_timestamps/ with the venv active:
  python run_all.py --audio "D:/.../03-Pastor Lapel-260927_0935.wav"
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TRANSCRIPTS_DIR = os.path.join(HERE, "transcripts")
GROUND_TRUTH = os.path.join(HERE, "ground_truth.csv")
META = os.path.join(HERE, "labels.meta.json")

MODELS = ["large-v3", "large-v3-turbo", "distil-large-v3"]
VAD_SETTINGS = ["on", "off"]


def log(msg):
    print(f"[run_all {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def config_name(model, vad, prompt, cond):
    cond_str = "true" if cond else "false"
    return f"{model}_vad{vad}_prompt{prompt}_cond{cond_str}"


def transcript_path(name):
    return os.path.join(TRANSCRIPTS_DIR, f"{name}.json")


def scored_path(name):
    return os.path.join(TRANSCRIPTS_DIR, f"{name}.scored.json")


def run_transcription(audio, model, vad, prompt, cond, device, compute_type):
    name = config_name(model, vad, prompt, cond)
    out_path = transcript_path(name)
    if os.path.exists(out_path):
        log(f"SKIP transcribe {name} (already exists)")
        return name, out_path

    log(f"RUN transcribe {name} ...")
    t0 = time.time()
    cmd = [
        sys.executable, os.path.join(HERE, "run_transcription.py"),
        "--audio", audio,
        "--model", model,
        "--device", device,
        "--compute-type", compute_type,
        "--vad", vad,
        "--prompt", prompt,
        "--condition-on-previous-text", "true" if cond else "false",
        "--out", out_path,
    ]
    result = subprocess.run(cmd, cwd=HERE)
    elapsed = time.time() - t0
    if result.returncode != 0:
        log(f"FAILED transcribe {name} after {elapsed:.0f}s (exit {result.returncode}) — leaving no output, will retry on next run")
        return name, None
    log(f"DONE transcribe {name} in {elapsed:.0f}s")
    return name, out_path


def run_scoring(name, transcript_file):
    out_path = scored_path(name)
    if os.path.exists(out_path):
        log(f"SKIP score {name} (already exists)")
        with open(out_path, encoding="utf-8") as f:
            return json.load(f)

    log(f"RUN score {name} ...")
    cmd = [
        sys.executable, os.path.join(HERE, "measure_error.py"),
        "--transcript", transcript_file,
        "--ground-truth", GROUND_TRUTH,
        "--meta", META,
        "--out", out_path,
    ]
    result = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True)
    if result.returncode != 0:
        log(f"FAILED score {name}: {result.stderr}")
        return None
    with open(out_path, encoding="utf-8") as f:
        return json.load(f)


BOOK_MISHEARINGS = [
    # (book, correct_substrings, wrong_substrings)
    ("Philippians", ["philippians"], ["philippines"]),
    ("Habakkuk", ["habakkuk"], ["have a cook", "have-a-cook", "have a cuk"]),
    ("Titus", ["titus"], ["tight us", "tight-us"]),
    ("Colossians", ["colossians"], ["collations"]),
]


def count_book_mishearings(transcript_file):
    with open(transcript_file, encoding="utf-8") as f:
        data = json.load(f)
    full_text = " ".join(seg["text"] for seg in data["segments"]).lower()
    full_text = re.sub(r"\s+", " ", full_text)

    counts = {}
    for book, right_subs, wrong_subs in BOOK_MISHEARINGS:
        right_n = sum(full_text.count(s) for s in right_subs)
        wrong_n = sum(full_text.count(s) for s in wrong_subs)
        counts[book] = {"correct": right_n, "misheard": wrong_n}
    return counts


def count_repetition_loops(transcript_file, min_repeats=3):
    """A crude drift/loop detector: the same segment text repeated
    back-to-back min_repeats+ times. condition_on_previous_text=True is
    documented (docs/04 §2) as a risk factor for this over long audio."""
    with open(transcript_file, encoding="utf-8") as f:
        data = json.load(f)
    segs = [s["text"].strip() for s in data["segments"]]

    loop_events = []
    i = 0
    while i < len(segs):
        j = i
        while j < len(segs) and segs[j] == segs[i]:
            j += 1
        run_len = j - i
        if run_len >= min_repeats and segs[i]:
            loop_events.append({"text": segs[i][:80], "repeats": run_len})
        i = j
    return loop_events


def pick_best(scored_list):
    """scored_list: [(name, scored_json), ...]. Lowest p90 wins, tie-break p50.
    None p90 (no matches at all) sorts last."""
    def sort_key(item):
        _, scored = item
        s = scored["summary"]
        p90 = s["p90_abs_error_s"]
        p50 = s["p50_abs_error_s"]
        return (p90 is None, p90 if p90 is not None else float("inf"),
                p50 if p50 is not None else float("inf"))
    return sorted(scored_list, key=sort_key)[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--compute-type", default="float16")
    args = ap.parse_args()

    os.makedirs(TRANSCRIPTS_DIR, exist_ok=True)

    # ---- Step 1-3: base matrix ----
    base_scored = []
    for model in MODELS:
        for vad in VAD_SETTINGS:
            name, tpath = run_transcription(args.audio, model, vad, "none", True,
                                             args.device, args.compute_type)
            if tpath is None:
                continue
            scored = run_scoring(name, tpath)
            if scored is not None:
                base_scored.append((name, scored))

    if not base_scored:
        log("No base-matrix configs produced usable results — stopping.")
        return

    winner_name, winner_scored = pick_best(base_scored)
    log(f"BASE MATRIX WINNER: {winner_name} "
        f"p50={winner_scored['summary']['p50_abs_error_s']} "
        f"p90={winner_scored['summary']['p90_abs_error_s']}")

    winner_cfg = winner_scored["summary"]["transcript_config"]
    win_model, win_vad = winner_cfg["model"], ("on" if winner_cfg["vad_filter"] else "off")

    # ---- Step 4: prompt A/B on the winner ----
    prompt_results = {}
    for prompt in ("none", "scripture"):
        name, tpath = run_transcription(args.audio, win_model, win_vad, prompt, True,
                                         args.device, args.compute_type)
        if tpath is None:
            continue
        scored = run_scoring(name, tpath)
        mishearings = count_book_mishearings(tpath)
        prompt_results[prompt] = {"name": name, "scored": scored, "mishearings": mishearings}

    total_misheard = {
        p: sum(v["misheard"] for v in r["mishearings"].values())
        for p, r in prompt_results.items()
    }
    log(f"PROMPT A/B mishearing totals: {total_misheard}")
    chosen_prompt = min(total_misheard, key=total_misheard.get) if total_misheard else "none"
    # Tie on mishearings -> fall back to timestamp accuracy.
    tied = [p for p, n in total_misheard.items() if n == total_misheard.get(chosen_prompt)]
    if len(tied) > 1:
        chosen_prompt = min(
            tied,
            key=lambda p: (prompt_results[p]["scored"]["summary"]["p90_abs_error_s"] or float("inf"))
        )
    log(f"CHOSEN PROMPT: {chosen_prompt}")

    # ---- Step 5: condition_on_previous_text A/B on winner+chosen prompt ----
    cond_results = {}
    for cond in (True, False):
        name, tpath = run_transcription(args.audio, win_model, win_vad, chosen_prompt, cond,
                                         args.device, args.compute_type)
        if tpath is None:
            continue
        scored = run_scoring(name, tpath)
        loops = count_repetition_loops(tpath)
        cond_results[cond] = {"name": name, "scored": scored, "repetition_loops": loops}

    loop_counts = {c: len(r["repetition_loops"]) for c, r in cond_results.items()}
    log(f"CONDITION A/B repetition-loop counts: {loop_counts}")
    chosen_cond = min(loop_counts, key=loop_counts.get) if loop_counts else True
    tied_c = [c for c, n in loop_counts.items() if n == loop_counts.get(chosen_cond)]
    if len(tied_c) > 1:
        chosen_cond = min(
            tied_c,
            key=lambda c: (cond_results[c]["scored"]["summary"]["p90_abs_error_s"] or float("inf"))
        )
    log(f"CHOSEN condition_on_previous_text: {chosen_cond}")

    summary = {
        "base_matrix": [{"name": n, "summary": s["summary"]} for n, s in base_scored],
        "winner": {"name": winner_name, "model": win_model, "vad": win_vad,
                   "summary": winner_scored["summary"]},
        "prompt_ab": {
            p: {"name": r["name"], "summary": r["scored"]["summary"],
                "mishearings": r["mishearings"]}
            for p, r in prompt_results.items()
        },
        "chosen_prompt": chosen_prompt,
        "condition_ab": {
            str(c): {"name": r["name"], "summary": r["scored"]["summary"],
                     "repetition_loop_count": len(r["repetition_loops"]),
                     "repetition_loop_examples": r["repetition_loops"][:5]}
            for c, r in cond_results.items()
        },
        "chosen_condition_on_previous_text": chosen_cond,
    }

    out_path = os.path.join(HERE, "all_results_summary.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    log(f"WROTE {out_path}")
    log("ALL DONE")


if __name__ == "__main__":
    main()
