"""Command line: ``python -m versesync.cli`` (07 section 6). No HTTP and no Premiere."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from versesync.bible.base import BibleError, BibleProvider, Translation, TranslationNotLicensed
from versesync.bible.format import format_passage
from versesync.bible.local import LocalProvider
from versesync.config import Config, load_config
from versesync.detect.canon import load_canon
from versesync.detect.detector import detect
from versesync.detect.parse import InvalidReference, parse_reference
from versesync.jobs import Job, JobRegistry, new_job_id, run_job
from versesync.paths import app_home
from versesync.transcribe import Backend, FixtureBackend, TranscriptionError, get_backend
from versesync.types import load_words

EXIT_OK = 0
EXIT_INTERNAL = 1
EXIT_BAD_INPUT = 2


class UsageError(Exception):
    """Bad input from the editor; ``main`` prints the message and exits with code 2."""


def _write_json(payload: Any, out: Path | None) -> None:
    text = json.dumps(payload, indent=1, ensure_ascii=False) + "\n"
    if out is None:
        sys.stdout.write(text)
    else:
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("w", encoding="utf-8", newline="\n") as f:
            f.write(text)


def _load_words(path: Path) -> list[Any]:
    try:
        return load_words(path)
    except OSError as exc:
        raise UsageError(f"Cannot read {path}: {exc.strerror or exc}") from exc
    except (ValueError, KeyError, TypeError) as exc:
        raise UsageError(f"{path} is not a words.json transcript: {exc}") from exc


def _find_translation(provider: BibleProvider, wanted: str) -> Translation:
    """Match ``--translation`` against a translation id or abbreviation, case-insensitively."""
    for translation in provider.list_translations():
        if wanted.lower() in (translation.id.lower(), translation.abbreviation.lower()):
            return translation
    raise TranslationNotLicensed()


def _default_translation(config: Config) -> str:
    return str(config.bible.get("default_translation", "kjv"))


def cmd_detect(args: argparse.Namespace) -> int:
    words = _load_words(args.words)
    canon = load_canon()
    detections = [d.to_json(canon) for d in detect(words, canon)]
    _write_json(detections, args.out)
    return EXIT_OK


def cmd_resolve(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    provider = LocalProvider()
    canon = load_canon()
    try:
        ref = parse_reference(args.reference, canon)
        if ref.verse is None:
            # D12: a chapter alone has no single passage to show.
            raise InvalidReference("Add a verse; a whole chapter can't be shown as one passage.")
        translation = _find_translation(provider, args.translation or _default_translation(config))
        raw = provider.fetch(ref, translation.id)
        passage = format_passage(
            raw,
            translation,
            canon,
            max_verses=int(config.bible.get("max_verses_per_passage", 6)),
            source="local",
        )
    except (InvalidReference, BibleError) as exc:
        raise UsageError(str(exc)) from exc
    _write_json(passage.to_json(), None)
    return EXIT_OK


# 07 section 3 codes that mean the editor's input was wrong rather than VerseSync.
_INPUT_ERROR_CODES = frozenset({"media_not_found", "media_unreadable", "translation_not_licensed"})


def _epoch(generated_at: str) -> float:
    try:
        when = datetime.fromisoformat(generated_at)
    except ValueError as exc:
        raise UsageError(f"--generated-at must be an ISO 8601 time, not {generated_at!r}") from exc
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when.timestamp()


def cmd_analyse(args: argparse.Namespace) -> int:
    """The same ``run_job`` the sidecar runs, with the clock and job id injected."""
    config = load_config(args.config)
    provider = LocalProvider()
    translation = _find_translation(provider, args.translation or _default_translation(config))
    backend: Backend
    if args.input.suffix.lower() == ".json":
        # A transcript replays through the fixture backend, as `transcription.backend: fixture:`.
        backend = FixtureBackend(args.input)
    else:
        try:
            backend = get_backend(config)
        except TranscriptionError as exc:
            raise UsageError(f"{exc.message} {exc.hint or ''}".strip()) from exc
    job_id: str = args.job_id or new_job_id()
    now = _epoch(args.generated_at) if args.generated_at else datetime.now(timezone.utc).timestamp()
    registry = JobRegistry(id_factory=lambda: job_id, clock=lambda: now)
    job: Job = registry.create()
    request = {"media_path": str(args.input), "translation_id": translation.id, "options": {}}
    run_job(
        job,
        request,
        config=config,
        backend=backend,
        provider=provider,
        registry=registry,
        clock=lambda: now,
    )
    if job.status != "done" or job.result_path is None:
        error = job.error or {"code": "internal", "message": job.message or "The job failed."}
        message = str(error["message"])
        if error.get("detail"):
            message += f" ({error['detail']})"
        if error.get("hint"):
            message += f" {error['hint']}"
        raise UsageError(message) if error["code"] in _INPUT_ERROR_CODES else RuntimeError(message)
    result = job.result_path
    doc = json.loads(result.read_text(encoding="utf-8"))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(result, args.out)
    shutil.copyfile(
        result.parent / doc["transcript"]["words_ref"],
        args.out.parent / doc["transcript"]["words_ref"],
    )
    shutil.rmtree(app_home() / "jobs" / job_id, ignore_errors=True)
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="versesync.cli")
    commands = parser.add_subparsers(dest="command", required=True)

    p = commands.add_parser("detect", help="list the references found in a words.json transcript")
    p.add_argument("words", type=Path)
    p.add_argument("--out", type=Path, default=None)
    p.set_defaults(run=cmd_detect)

    p = commands.add_parser("resolve", help="print the Passage for one reference")
    p.add_argument("reference")
    p.add_argument("--translation", default=None)
    p.add_argument("--config", type=Path, default=None)
    p.set_defaults(run=cmd_resolve)

    p = commands.add_parser("analyse", help="run the whole pipeline and write a Cue Document")
    p.add_argument("input", type=Path, help="a media file, or a .words.json transcript")
    p.add_argument("--translation", default=None)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--config", type=Path, default=None)
    p.add_argument("--job-id", default=None)
    p.add_argument("--generated-at", default=None)
    p.set_defaults(run=cmd_analyse)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        code: int = args.run(args)
    except UsageError as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_BAD_INPUT
    except Exception as exc:  # noqa: BLE001 - the CLI must report, not traceback, internal errors
        print(f"VerseSync hit an unexpected problem: {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_INTERNAL
    return code


if __name__ == "__main__":
    sys.exit(main())
