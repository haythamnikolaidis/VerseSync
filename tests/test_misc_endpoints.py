from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from versesync.bible.base import ProviderUnavailable, Translation
from versesync.bible.local import LocalProvider
from versesync.config import load_config
from versesync.jobs import JobService
from versesync.server import PROVIDER_CHECK_TTL_S, SidecarServer
from versesync.transcribe import Backend, FakeBackend

TOKEN = "test-token"
ORIGIN = "cep://com.versesync.panel"


def call(
    server: SidecarServer, path: str, *, method: str = "GET", body: Any = None, auth: bool = True
) -> tuple[int, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Authorization": f"Bearer {TOKEN}", "Origin": ORIGIN} if auth else {}
    req = urllib.request.Request(
        f"http://127.0.0.1:{server.port}{path}", data=data, method=method, headers=headers
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as err:
        raw = err.read()
        return err.code, json.loads(raw) if raw else None


class FlakyProvider:
    """A LocalProvider whose list_translations can be switched to fail."""

    id = "flaky"

    def __init__(self) -> None:
        self.inner = LocalProvider()
        self.down = False
        self.calls = 0

    def list_translations(self) -> list[Translation]:
        self.calls += 1
        if self.down:
            raise ProviderUnavailable()
        return self.inner.list_translations()

    def fetch(self, *args: Any) -> Any:
        return self.inner.fetch(*args)

    def fetch_chapter(self, *args: Any) -> Any:
        return self.inner.fetch_chapter(*args)


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class Env:
    def __init__(self, server: SidecarServer, provider: FlakyProvider, clock: Clock) -> None:
        self.server = server
        self.provider = provider
        self.clock = clock


@pytest.fixture
def make_env(app_home: Path) -> Iterator[Any]:
    servers: list[tuple[SidecarServer, threading.Thread]] = []

    def build(device: str = "cuda", backend: Backend | None = None) -> Env:
        base = load_config()
        config = replace(base, transcription={**base.transcription, "device": device})
        provider = FlakyProvider()
        server = SidecarServer(config, TOKEN)
        server.clock = Clock()
        server.attach_jobs(
            JobService(
                config=config, backend_factory=lambda: backend or FakeBackend([]), provider=provider
            )
        )
        server.attach_provider(provider)
        server.mark_ready()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        servers.append((server, thread))
        return Env(server, provider, server.clock)  # type: ignore[arg-type]

    yield build
    for server, thread in servers:
        server.shutdown()
        thread.join(timeout=5)


def test_resolve_romans_8_28(make_env: Any) -> None:
    env = make_env()
    status, passage = call(env.server, "/resolve", method="POST", body={"reference": "Romans 8:28"})
    assert status == 200
    assert passage["body"].startswith("28 And we know")
    assert passage["reference_display"].startswith("Romans 8:28")
    assert passage["translation"]["abbreviation"] == "KJV"


def test_resolve_accepts_canonical_object_and_translation_id(make_env: Any) -> None:
    env = make_env()
    translation_id = env.provider.list_translations()[0].id
    body = {
        "reference": {"book": "Romans", "osis": "Rom", "chapter": 8, "verse": 28},
        "translation_id": translation_id,
    }
    status, passage = call(env.server, "/resolve", method="POST", body=body)
    assert status == 200
    assert passage["body"].startswith("28 And we know")


def test_resolve_invalid_reference_is_bad_request(make_env: Any) -> None:
    env = make_env()
    status, body = call(env.server, "/resolve", method="POST", body={"reference": "Jude 5:1"})
    assert status == 400
    assert body["error"]["code"] == "bad_request"
    assert body["error"]["message"] == "Jude has only 1 chapter."


def test_resolve_unknown_translation_and_missing_reference(make_env: Any) -> None:
    env = make_env()
    status, body = call(
        env.server,
        "/resolve",
        method="POST",
        body={"reference": "John 3:16", "translation_id": "nope"},
    )
    assert (status, body["error"]["code"]) == (400, "translation_not_licensed")
    status, body = call(env.server, "/resolve", method="POST", body={})
    assert (status, body["error"]["code"]) == (400, "bad_request")


def test_resolve_chapter_only_is_bad_request(make_env: Any) -> None:
    env = make_env()
    status, body = call(env.server, "/resolve", method="POST", body={"reference": "Romans 8"})
    assert (status, body["error"]["code"]) == (400, "bad_request")


def test_resolve_provider_down_is_retryable(make_env: Any) -> None:
    env = make_env()
    env.provider.down = True
    status, body = call(env.server, "/resolve", method="POST", body={"reference": "John 3:16"})
    assert status == 503
    assert body["error"]["code"] == "provider_unavailable"
    assert body["error"]["retryable"] is True


def test_translations_lists_provider(make_env: Any) -> None:
    env = make_env()
    status, body = call(env.server, "/translations")
    assert status == 200
    assert body["provider"] == "flaky"
    assert body["translations"] == [t.to_json() for t in env.provider.list_translations()]
    assert set(body["translations"][0]) == {
        "id",
        "abbreviation",
        "name",
        "attribution",
        "cache_allowed",
    }


def test_models_table(make_env: Any) -> None:
    env = make_env()
    env.server.model_downloaded = lambda name: name == "distil-large-v3"
    status, body = call(env.server, "/models")
    assert status == 200
    models = {m["name"]: m for m in body["models"]}
    assert models["distil-large-v3"]["recommended"] is True
    assert models["distil-large-v3"]["downloaded"] is True
    assert models["large-v3-turbo"]["downloaded"] is False
    for model in models.values():
        assert model["word_timestamp_quality"] in ("good", "unverified")
        assert model["supported_quantizations"]["cpu"] == ["float32"]


def test_new_endpoints_need_auth(make_env: Any) -> None:
    env = make_env()
    for path, method in (("/models", "GET"), ("/translations", "GET"), ("/resolve", "POST")):
        status, _ = call(env.server, path, method=method, body={}, auth=False)
        assert status == 401


def test_health_goes_busy_and_back(make_env: Any) -> None:
    release = threading.Event()
    started = threading.Event()

    class SlowBackend:
        def transcribe(
            self, media_path: Any, options: Any, progress: Any, is_cancelled: Any
        ) -> Any:
            started.set()
            release.wait(5)
            return []

    env = make_env(backend=SlowBackend())  # type: ignore[arg-type]
    status, health = call(env.server, "/health", auth=False)
    assert (health["status"], health["active_jobs"]) == ("ready", 0)
    assert health["provider"] == {"id": "flaky", "reachable": True}
    assert health["device"] == "cuda"

    media_file = Path(__file__)  # any readable file: the allowed media roots are empty
    translation_id = env.provider.list_translations()[0].id
    status, started_job = call(
        env.server,
        "/jobs",
        method="POST",
        body={"media_path": str(media_file), "translation_id": translation_id},
    )
    assert status == 202
    assert started.wait(5)
    _, health = call(env.server, "/health", auth=False)
    assert (health["status"], health["active_jobs"]) == ("busy", 1)

    release.set()
    deadline = threading.Event()
    for _ in range(200):
        _, snap = call(env.server, f"/jobs/{started_job['job_id']}")
        if snap["status"] in ("done", "failed", "cancelled"):
            break
        deadline.wait(0.02)
    _, health = call(env.server, "/health", auth=False)
    assert (health["status"], health["active_jobs"]) == ("ready", 0)


def test_health_degraded_when_provider_unreachable_then_recovers(make_env: Any) -> None:
    env = make_env()
    assert call(env.server, "/health", auth=False)[1]["status"] == "ready"
    env.provider.down = True
    # Within the cache window the earlier answer is reused.
    assert call(env.server, "/health", auth=False)[1]["status"] == "ready"
    env.clock.now += PROVIDER_CHECK_TTL_S + 1
    _, health = call(env.server, "/health", auth=False)
    assert health["status"] == "degraded"
    assert health["provider"] == {"id": "flaky", "reachable": False}
    env.provider.down = False
    env.clock.now += PROVIDER_CHECK_TTL_S + 1
    assert call(env.server, "/health", auth=False)[1]["status"] == "ready"


def test_health_provider_check_is_cached(make_env: Any) -> None:
    env = make_env()
    for _ in range(5):
        call(env.server, "/health", auth=False)
    assert env.provider.calls == 1


def test_health_degraded_on_cpu(make_env: Any) -> None:
    env = make_env(device="cpu")
    _, health = call(env.server, "/health", auth=False)
    assert health["status"] == "degraded"
    assert health["device"] == "cpu"
