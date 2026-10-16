"""07 section 6: the CLI and the HTTP service produce the same Cue Document for the same input."""

from __future__ import annotations

import json
import threading
import urllib.request
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from transcript_fixtures import FIXTURES_DIR

from versesync.bible.local import LocalProvider
from versesync.cli import main
from versesync.config import load_config
from versesync.jobs import JobRegistry, JobService
from versesync.server import SidecarServer
from versesync.transcribe import get_backend

TOKEN = "parity-token"
ORIGIN = "cep://com.versesync.panel"
WORDS_FILE = FIXTURES_DIR / "numbers-and-ordinals.words.json"
JOB_ID = "job_parity"
GENERATED_AT = "2026-01-02T03:04:05Z"


def _request(server: SidecarServer, path: str, body: Any = None) -> Any:
    req = urllib.request.Request(
        f"http://127.0.0.1:{server.port}{path}",
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        method="POST" if body is not None else "GET",
        headers={"Authorization": f"Bearer {TOKEN}", "Origin": ORIGIN},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


def _http_document(translation_id: str) -> dict[str, Any]:
    base = load_config()
    config = replace(
        base, transcription={**base.transcription, "backend": f"fixture:{WORDS_FILE}"}
    )
    now = datetime.fromisoformat(GENERATED_AT.replace("Z", "+00:00")).timestamp()
    registry = JobRegistry(id_factory=lambda: JOB_ID, clock=lambda: now)
    service = JobService(
        config=config,
        backend_factory=lambda: get_backend(config),
        provider=LocalProvider(),
        registry=registry,
        clock=lambda: now,
    )
    server = SidecarServer(config, TOKEN)
    server.attach_jobs(service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        started = _request(
            server,
            "/jobs",
            {"media_path": str(WORDS_FILE), "translation_id": translation_id},
        )
        job = registry.get(started["job_id"])
        assert job is not None
        for _ in range(500):
            if job.status in ("done", "failed"):
                break
            threading.Event().wait(0.02)
        assert job.status == "done"
        doc: dict[str, Any] = _request(server, f"/jobs/{started['job_id']}/result")
        return doc
    finally:
        server.shutdown()
        thread.join(timeout=5)


def test_cli_and_http_documents_are_identical(app_home: Path, tmp_path: Path) -> None:
    translation_id = LocalProvider().list_translations()[0].id
    out = tmp_path / "cues.json"
    code = main(
        [
            "analyse",
            str(WORDS_FILE),
            "--translation",
            translation_id,
            "--out",
            str(out),
            "--job-id",
            JOB_ID,
            "--generated-at",
            GENERATED_AT,
        ]
    )
    assert code == 0
    cli_doc = json.loads(out.read_text(encoding="utf-8"))
    http_doc = _http_document(translation_id)
    for doc in (cli_doc, http_doc):
        doc["job"].pop("media_path", None)
    assert cli_doc["cues"]
    assert cli_doc == http_doc
