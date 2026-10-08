#!/usr/bin/env python3
"""
run_transcription.py — T-02 spike: one faster-whisper run over the real
sermon audio, with word_timestamps=True, saved to a JSON file for
measure_error.py to score against spikes/word_timestamps/ground_truth.csv.

Deliberately NOT using BatchedInferencePipeline — T-02's own steps only vary
model / vad_filter / initial_prompt / condition_on_previous_text, and mixing
in a different inference path would confound the timestamp-quality
comparison with a batching-strategy difference. Batching is a separate,
later performance optimization (docs/02-source-project-audit.md Gap 6), out
of scope here.

temperature is pinned to 0 throughout per T-02's "Traps" section, so runs
are comparable to each other.

Usage:
  python run_transcription.py --audio <path> --model large-v3 \
      --vad on --prompt none --condition-on-previous-text true \
      --out transcripts/large-v3_vadon_promptnone_condtrue.json
"""

import argparse
import json
import os
import sys
import time


def _add_nvidia_dll_dirs():
    """
    Windows-only: the pip nvidia-cublas-cu12 / nvidia-cudnn-cu12 wheels drop
    their DLLs under site-packages/nvidia/*/bin, which is not on the default
    DLL search path, so ctranslate2's LoadLibrary call for cublas64_12.dll
    fails even though the file is right there. Must run before importing
    ctranslate2/faster_whisper. Mirrors Faster-Whisper-Transcriber's
    core/cuda_setup.py (docs/02-source-project-audit.md §2.1: "CUDA path
    setup... called before any Qt import... Reuse as-is. Ordering matters.")
    — not vendored into this repo, so reimplemented minimally here.
    """
    if os.name != "nt":
        return
    try:
        import nvidia.cublas
        import nvidia.cudnn
        for mod in (nvidia.cublas, nvidia.cudnn):
            for base in mod.__path__:
                bin_dir = os.path.join(base, "bin")
                if os.path.isdir(bin_dir):
                    # os.add_dll_directory alone is not enough here: it only
                    # affects LoadLibraryEx calls made with the
                    # LOAD_LIBRARY_SEARCH_* flags, and ctranslate2's compiled
                    # extension does a plain LoadLibrary for its CUDA deps,
                    # which only honors PATH — confirmed empirically (direct
                    # ctypes.WinDLL load succeeded with add_dll_directory
                    # alone, but ctranslate2's own load still failed until
                    # PATH was also updated).
                    os.add_dll_directory(bin_dir)
                    os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
    except ImportError:
        pass


_add_nvidia_dll_dirs()

from faster_whisper import WhisperModel  # noqa: E402

SCRIPTURE_PROMPT = (
    "A sermon quoting the Bible. Books mentioned may include: "
    "Genesis, Exodus, Leviticus, Numbers, Deuteronomy, Joshua, Judges, Ruth, "
    "1 Samuel, 2 Samuel, 1 Kings, 2 Kings, 1 Chronicles, 2 Chronicles, Ezra, "
    "Nehemiah, Esther, Job, Psalms, Proverbs, Ecclesiastes, Song of Solomon, "
    "Isaiah, Jeremiah, Lamentations, Ezekiel, Daniel, Hosea, Joel, Amos, Obadiah, "
    "Jonah, Micah, Nahum, Habakkuk, Zephaniah, Haggai, Zechariah, Malachi, "
    "Matthew, Mark, Luke, John, Acts, Romans, 1 Corinthians, 2 Corinthians, "
    "Galatians, Ephesians, Philippians, Colossians, 1 Thessalonians, "
    "2 Thessalonians, 1 Timothy, 2 Timothy, Titus, Philemon, Hebrews, James, "
    "1 Peter, 2 Peter, 1 John, 2 John, 3 John, Jude, Revelation. "
    "For example: John 3:16, Romans 8:28, 1 Corinthians 13:4-7."
)
# docs/04-reference-detection.md §2 flags a 224-token prompt window — measure
# before trusting this fits with room to spare.


def parse_bool(s):
    return str(s).strip().lower() in ("1", "true", "on", "yes")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model", required=True,
                     help="e.g. large-v3, large-v3-turbo, distil-large-v3")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--compute-type", default="float16")
    ap.add_argument("--vad", default="on", help="on/off")
    ap.add_argument("--prompt", default="none", help="none/scripture")
    ap.add_argument("--condition-on-previous-text", default="true", help="true/false")
    ap.add_argument("--language", default="en")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    vad_filter = parse_bool(args.vad)
    initial_prompt = SCRIPTURE_PROMPT if args.prompt == "scripture" else None
    condition_on_previous_text = parse_bool(args.condition_on_previous_text)

    if initial_prompt is not None:
        # faster-whisper tokenizes with the model's own tokenizer; this is a
        # cheap proxy (whitespace split) just to flag if we're anywhere near
        # the 224-token window docs/04 §2 warns about.
        approx_tokens = len(initial_prompt.split())
        print(f"[info] initial_prompt ~{approx_tokens} words (budget: 224 tokens)", file=sys.stderr)

    print(f"[info] loading model={args.model} device={args.device} compute_type={args.compute_type}", file=sys.stderr)
    load_t0 = time.time()
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    load_s = time.time() - load_t0
    print(f"[info] model loaded in {load_s:.1f}s", file=sys.stderr)

    print(f"[info] transcribing {args.audio}", file=sys.stderr)
    t0 = time.time()
    segments_gen, info = model.transcribe(
        args.audio,
        language=args.language,
        task="transcribe",
        word_timestamps=True,
        vad_filter=vad_filter,
        temperature=0.0,
        initial_prompt=initial_prompt,
        condition_on_previous_text=condition_on_previous_text,
    )

    words = []
    segments_out = []
    last_logged = 0.0
    for seg in segments_gen:
        segments_out.append({
            "start": seg.start, "end": seg.end, "text": seg.text,
        })
        if seg.words:
            for w in seg.words:
                words.append({
                    "word": w.word, "start": w.start, "end": w.end,
                    "probability": w.probability,
                })
        if seg.end - last_logged > 60:
            elapsed = time.time() - t0
            print(f"[progress] segment end={seg.end:.1f}s audio, {elapsed:.1f}s wall", file=sys.stderr)
            last_logged = seg.end

    wall_s = time.time() - t0

    out = {
        "config": {
            "model": args.model,
            "device": args.device,
            "compute_type": args.compute_type,
            "vad_filter": vad_filter,
            "prompt": args.prompt,
            "condition_on_previous_text": condition_on_previous_text,
            "language": args.language,
            "temperature": 0.0,
        },
        "audio_duration_s": info.duration,
        "detected_language": info.language,
        "language_probability": info.language_probability,
        "model_load_s": load_s,
        "transcribe_wall_s": wall_s,
        "segment_count": len(segments_out),
        "word_count": len(words),
        "segments": segments_out,
        "words": words,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f)

    print(f"[done] {args.out} — {len(words)} words, {wall_s:.1f}s wall "
          f"({info.duration/max(wall_s,1e-9):.2f}x realtime)", file=sys.stderr)


if __name__ == "__main__":
    main()
