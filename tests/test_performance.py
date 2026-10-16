"""NFR-2 budgets that can be measured in the container (01-requirements.md NFR-2).

These are cheap, so they run by default; ``-m perf`` selects only them.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from test_job_endpoints import TOKEN, TRANSLATION_ID, WORDS_FILE, call, wait_for
from transcript_fixtures import FIXTURES_DIR

from versesync.bible.base import Translation
from versesync.bible.local import LocalProvider
from versesync.cache import hash_media
from versesync.config import Config, load_config
from versesync.jobs import JobService
from versesync.pipeline import run_pipeline
from versesync.server import SidecarServer
from versesync.transcribe import get_backend
from versesync.types import Word, load_words

pytestmark = pytest.mark.perf

PIPELINE_BUDGET_S = 15.0  # NFR-2: detect + resolve + time on a 45-minute transcript
HASH_BUDGET_S = 1.0  # NFR-2 implies a multi-GB MXF must not be read whole
CACHE_HIT_BUDGET_S = 5.0  # NFR-2: cached re-run returns the review list
# The card scales the longest fixture x6 to reach about 45 minutes of words.
SCALE = 6
SPARSE_SIZE = 4 * 1024**3
PROVIDER = LocalProvider()
TRANSLATION: Translation = PROVIDER.list_translations()[0]
JOB: dict[str, Any] = {
    "id": "job_PERF",
    "media_path": "D:/Sermons/perf.MXF",
    "media_hash": "sha256:" + "cd" * 32,
    "media_duration_s": 2700.0,
    "model": "distil-large-v3",
    "quantization": "float16",
    "device": "cpu",
    "language": "en",
    "options": {},
}


def _longest_fixture() -> list[Word]:
    candidates = [load_words(p) for p in sorted(FIXTURES_DIR.glob("*.words.json"))]
    return max(candidates, key=len)


def _scaled(words: list[Word], times: int) -> list[Word]:
    span = words[-1].end + 1.0
    return [
        replace(w, start=w.start + i * span, end=w.end + i * span)
        for i in range(times)
        for w in words
    ]


def test_pipeline_on_45_minute_transcript_within_budget() -> None:
    words = _scaled(_longest_fixture(), SCALE)
    started = time.perf_counter()
    doc = run_pipeline(
        words,
        translation=TRANSLATION,
        provider=PROVIDER,
        job=JOB,
        generated_at="2026-09-14T10:00:00Z",
    )
    elapsed = time.perf_counter() - started
    assert doc["cues"]
    assert elapsed <= PIPELINE_BUDGET_S, f"pipeline took {elapsed:.2f}s"


def test_hash_media_on_4gb_sparse_file_is_fast(tmp_path: Path) -> None:
    media = tmp_path / "huge.mxf"
    with media.open("wb") as handle:
        handle.truncate(SPARSE_SIZE)
    assert media.stat().st_size == SPARSE_SIZE
    started = time.perf_counter()
    digest = hash_media(media)
    elapsed = time.perf_counter() - started
    assert digest.startswith("sha256:")
    assert elapsed < HASH_BUDGET_S, f"hash_media took {elapsed:.2f}s"


@pytest.fixture
def server(app_home: Path) -> Iterator[SidecarServer]:
    base = load_config()
    config: Config = replace(
        base,
        transcription={**base.transcription, "backend": f"fixture:{WORDS_FILE}"},
        server={**base.server, "allowed_media_roots": []},
    )
    srv = SidecarServer(config, TOKEN)
    srv.attach_jobs(
        JobService(
            config=config, backend_factory=lambda: get_backend(config), provider=PROVIDER
        )
    )
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv
    srv.shutdown()
    thread.join(timeout=5)


def test_cache_hit_job_over_http_within_budget(server: SidecarServer, tmp_path: Path) -> None:
    media = tmp_path / "sermon.mxf"
    media.write_bytes(b"pretend media" * 50)
    body = {"media_path": str(media), "translation_id": TRANSLATION_ID}
    _, first = call(server, "/jobs", method="POST", body=body)
    wait_for(server, first["job_id"], {"done"})

    started = time.perf_counter()
    _, second = call(server, "/jobs", method="POST", body=body)
    assert second["cache_hit"] is True
    wait_for(server, second["job_id"], {"done"})
    status, doc = call(server, f"/jobs/{second['job_id']}/result")
    elapsed = time.perf_counter() - started
    assert status == 200
    assert doc["cues"]
    assert elapsed < CACHE_HIT_BUDGET_S, f"cache-hit job took {elapsed:.2f}s"
