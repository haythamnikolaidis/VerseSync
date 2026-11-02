"""build_provider and the urllib transport (T-53.1). No test touches the internet or a real key."""

from __future__ import annotations

import json
import logging
import signal
import socket
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from versesync import sidecar
from versesync.bible import factory
from versesync.bible.api_bible import ApiBibleProvider
from versesync.bible.base import BibleProvider, PassageNotFound, ProviderUnavailable
from versesync.bible.factory import NO_KEY_MESSAGE, build_provider, urllib_fetch_json
from versesync.bible.local import LocalProvider
from versesync.config import Config, load_config
from versesync.detect.canon import load_canon
from versesync.types import Reference

KEY_ENV = "VERSESYNC_API_BIBLE_KEY"
KEY = "sk-test-0123456789-secret"
EXPECTED_NO_KEY = "No API.Bible key: set VERSESYNC_API_BIBLE_KEY and restart Premiere."


class Recorder:
    """A fake transport that records its calls."""

    def __init__(self, status: int = 200, body: dict[str, Any] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, str], float]] = []
        self._reply = (status, body if body is not None else {"data": []})

    def __call__(
        self, url: str, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, dict[str, Any]]:
        self.calls.append((url, dict(headers), timeout))
        return self._reply


@pytest.fixture
def config(bare_home: Any, monkeypatch: pytest.MonkeyPatch) -> Config:
    """The built-in default configuration, with a clean environment for the key."""
    monkeypatch.delenv(KEY_ENV, raising=False)
    return load_config()


def _with_bible(config: Config, **changes: Any) -> Config:
    return replace(config, bible={**config.bible, **changes})


@pytest.fixture
def no_network(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    """Fail any socket use, and replace the real transport with a recorder that must stay idle."""

    def refuse(*_a: Any, **_k: Any) -> None:
        raise AssertionError("network access attempted")

    monkeypatch.setattr(socket, "socket", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    recorder = Recorder()
    monkeypatch.setattr(factory, "urllib_fetch_json", recorder)
    return recorder


# --- build_provider -------------------------------------------------------------------------


def test_local_gives_local_provider(config: Config) -> None:
    assert isinstance(build_provider(_with_bible(config, provider="local")), LocalProvider)


def test_api_bible_gives_adapter_with_config_and_real_transport(
    config: Config, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(KEY_ENV, KEY)
    marker = Recorder()
    monkeypatch.setattr(factory, "urllib_fetch_json", marker)
    translations = {"abc-01": {"attribution": "Test.", "cache_allowed": True}}
    custom = _with_bible(
        config,
        translations=translations,
        api_bible={
            **config.bible["api_bible"],
            "base_url": "https://api.example.test/v1/",
            "timeout_s": 7,
        },
    )
    provider = build_provider(custom)
    assert isinstance(provider, ApiBibleProvider)
    # The default transport is the module's own urllib_fetch_json, resolved when called.
    marker.calls.clear()
    provider.list_translations()
    assert marker.calls == [
        ("https://api.example.test/v1/bibles", {"api-key": KEY, "accept": "application/json"}, 7.0)
    ]


def test_default_transport_is_urllib_fetch_json(
    config: Config, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(KEY_ENV, KEY)
    provider = build_provider(config)
    assert isinstance(provider, ApiBibleProvider)
    assert provider._fetch_json is urllib_fetch_json


def test_injected_transport_is_used_when_a_key_is_set(
    config: Config, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(KEY_ENV, KEY)
    fake = Recorder()
    build_provider(config, fetch_json=fake).list_translations()
    assert len(fake.calls) == 1


def test_default_provider_is_api_bible(config: Config) -> None:
    bible = {k: v for k, v in config.bible.items() if k != "provider"}
    assert isinstance(build_provider(replace(config, bible=bible)), ApiBibleProvider)


@pytest.mark.parametrize("value", ["esv", "", "API_BIBLE", "kjv"])
def test_unknown_provider_raises(config: Config, value: str) -> None:
    with pytest.raises(ValueError) as info:
        build_provider(_with_bible(config, provider=value))
    assert str(info.value) == f"Unknown bible.provider: {value}"


# --- no key ---------------------------------------------------------------------------------


def _ref() -> Reference:
    return Reference(load_canon().by_osis("John").name, "John", 3, 16)


@pytest.mark.parametrize("key", [None, ""])
def test_no_key_refuses_every_request_without_a_transport_call(
    config: Config, no_network: Recorder, monkeypatch: pytest.MonkeyPatch, key: str | None
) -> None:
    if key is not None:
        monkeypatch.setenv(KEY_ENV, key)
    injected = Recorder()
    provider = build_provider(config, fetch_json=injected)
    assert isinstance(provider, ApiBibleProvider)
    calls: list[Callable[[], object]] = [
        provider.list_translations,
        lambda: provider.fetch(_ref(), "abc-01"),
        lambda: provider.fetch_chapter("John", 3, "abc-01"),
    ]
    for call in calls:
        with pytest.raises(ProviderUnavailable) as info:
            call()
        assert str(info.value) == EXPECTED_NO_KEY
        assert info.value.message == NO_KEY_MESSAGE == EXPECTED_NO_KEY
    batch = provider.fetch_many([_ref()], "abc-01")
    err = batch[_ref()]
    assert isinstance(err, ProviderUnavailable)
    assert str(err) == EXPECTED_NO_KEY
    assert no_network.calls == []
    assert injected.calls == []


def test_no_key_makes_no_real_socket_use(config: Config, no_network: Recorder) -> None:
    # no_network turns any socket use into AssertionError, which ProviderUnavailable would not
    # mask: an attempt would surface as a different exception type.
    with pytest.raises(ProviderUnavailable):
        build_provider(config).list_translations()


# --- the key stays private ------------------------------------------------------------------


def test_key_is_not_in_repr_log_or_error(
    config: Config, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv(KEY_ENV, KEY)
    caplog.set_level(logging.DEBUG)
    provider = build_provider(config, fetch_json=Recorder(status=500))
    assert KEY not in repr(provider)
    assert KEY not in repr(config)
    with pytest.raises(ProviderUnavailable) as info:
        provider.list_translations()
    with pytest.raises(PassageNotFound) as not_found:
        build_provider(config, fetch_json=Recorder(status=404)).fetch(_ref(), "abc-01")
    assert KEY not in str(info.value) and KEY not in str(not_found.value)
    assert KEY not in caplog.text


def test_key_stays_out_of_the_sidecar_log_and_reprs_through_start_up(
    bare_home: Path, monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    """The real start-up path, ``sidecar.main``, builds the provider from the default config."""
    monkeypatch.setenv(KEY_ENV, KEY)
    # Requests go to a loopback server that only ever fails, never to API.Bible.
    api = serve(lambda path: _json(500 if path.endswith("/bibles") else 404, {"message": "no"}))
    bare_home.mkdir(parents=True)
    (bare_home / "config.yaml").write_text(
        f"bible:\n  api_bible:\n    base_url: {api.url}\n", encoding="utf-8"
    )
    built: list[tuple[Config, BibleProvider]] = []

    def build_and_record(cfg: Config) -> BibleProvider:
        provider = factory.build_provider(cfg)
        built.append((cfg, provider))
        return provider

    monkeypatch.setattr(sidecar, "build_provider", build_and_record)
    # main() returns as soon as it would start serving, and leaves the test run's signal
    # handlers alone.
    monkeypatch.setattr(sidecar._TrackedServer, "serve_forever", lambda self: self.shutdown())
    monkeypatch.setattr(signal, "signal", lambda *_args: None)

    log = logging.getLogger("versesync")
    handlers, level = list(log.handlers), log.level
    try:
        assert sidecar.main([]) == 0
        ((cfg, provider),) = built
        log.setLevel(logging.DEBUG)  # include the per-request debug line
        with pytest.raises(ProviderUnavailable) as failure:
            provider.list_translations()
        with pytest.raises(PassageNotFound) as missing:
            provider.fetch_chapter("John", 99, "abc-01")
    finally:
        for handler in log.handlers[:]:
            if handler not in handlers:
                log.removeHandler(handler)
                handler.close()
        log.setLevel(level)

    assert isinstance(provider, ApiBibleProvider)
    text = (bare_home / "logs" / "sidecar.log").read_text(encoding="utf-8")
    assert "listening" in text and "GET" in text  # the log was written, not empty
    assert KEY not in text
    assert KEY not in repr(provider) and KEY not in repr(cfg) and KEY not in str(cfg)
    assert KEY not in str(failure.value) and KEY not in str(missing.value)


# --- urllib_fetch_json over loopback --------------------------------------------------------


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        server: Any = self.server
        server.seen.append((self.path, dict(self.headers)))
        status, body, extra = server.reply(self.path)
        self.send_response(status)
        for name, value in extra.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: Any) -> None:
        return


Reply = tuple[int, bytes, dict[str, str]]


class Served:
    """A loopback server: its base ``url`` and the ``(path, headers)`` of each request."""

    def __init__(self, url: str, seen: list[tuple[str, dict[str, str]]]) -> None:
        self.url = url
        self.seen = seen


Serve = Callable[[Callable[[str], Reply]], Served]


@pytest.fixture
def serve(monkeypatch: pytest.MonkeyPatch) -> Iterator[Serve]:
    # Proxy settings on the machine must not intercept loopback traffic.
    monkeypatch.setenv("NO_PROXY", "*")
    monkeypatch.setenv("no_proxy", "*")
    servers: list[ThreadingHTTPServer] = []

    def start(reply: Callable[[str], Reply]) -> Served:
        server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        server.daemon_threads = True
        server.seen = []  # type: ignore[attr-defined]
        server.reply = reply  # type: ignore[attr-defined]
        servers.append(server)
        threading.Thread(
            target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
        ).start()
        return Served(f"http://127.0.0.1:{server.server_address[1]}", server.seen)  # type: ignore[attr-defined]

    yield start
    for server in servers:
        server.shutdown()
        server.server_close()


def _json(status: int, body: object) -> Reply:
    return status, json.dumps(body).encode(), {"Content-Type": "application/json"}


def test_200_returns_status_and_json_and_sends_the_request(serve: Serve) -> None:
    server = serve(lambda _p: _json(200, {"data": [{"id": "x"}]}))
    headers = {"api-key": KEY, "accept": "application/json"}
    result = urllib_fetch_json(server.url + "/bibles/x?y=1", headers, 5)
    assert result == (200, {"data": [{"id": "x"}]})
    ((path, seen),) = server.seen
    assert path == "/bibles/x?y=1"
    lowered = {k.lower(): v for k, v in seen.items()}
    assert lowered["api-key"] == KEY
    assert lowered["accept"] == "application/json"


@pytest.mark.parametrize("status", [400, 401, 403, 404, 429, 500, 503])
def test_error_statuses_are_returned_with_their_json_body(serve: Serve, status: int) -> None:
    server = serve(lambda _p: _json(status, {"statusCode": status, "message": "nope"}))
    assert urllib_fetch_json(server.url + "/x", {}, 5) == (
        status,
        {"statusCode": status, "message": "nope"},
    )


@pytest.mark.parametrize(
    "body", [b"", b"<html>Bad Gateway</html>", b"\xff\xfe not utf-8", b"[1, 2]", b"null"]
)
def test_non_json_error_body_gives_empty_dict(serve: Serve, body: bytes) -> None:
    server = serve(lambda _p: (502, body, {"Content-Type": "text/html"}))
    assert urllib_fetch_json(server.url + "/x", {}, 5) == (502, {})


@pytest.mark.parametrize("body", [b"", b"<html>hi</html>", b"[1]"])
def test_success_without_a_json_object_is_an_oserror(serve: Serve, body: bytes) -> None:
    server = serve(lambda _p: (200, body, {}))
    with pytest.raises(OSError):
        urllib_fetch_json(server.url + "/x", {}, 5)


def test_redirects_are_not_followed_and_the_key_is_not_forwarded(
    serve: Serve,
) -> None:
    target_hits: list[str] = []

    def target(path: str) -> Reply:
        target_hits.append(path)
        return _json(200, {"leaked": True})

    other = serve(target)
    origin = serve(lambda _p: (302, b"", {"Location": other.url + "/steal"}))
    status, body = urllib_fetch_json(origin.url + "/bibles", {"api-key": KEY}, 5)
    assert (status, body) == (302, {})
    assert target_hits == []


def test_connection_refused_is_an_oserror() -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    with pytest.raises(OSError):
        urllib_fetch_json(f"http://127.0.0.1:{port}/x", {}, 2)


def test_timeout_is_an_oserror(serve: Serve) -> None:
    def slow(_path: str) -> Reply:
        time.sleep(1.0)
        return _json(200, {})

    server = serve(slow)
    with pytest.raises(OSError):
        urllib_fetch_json(server.url + "/x", {}, 0.2)


def test_dropped_connection_is_an_oserror() -> None:
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]

    def hang_up() -> None:
        conn, _ = listener.accept()
        conn.recv(4096)
        conn.close()

    threading.Thread(target=hang_up, daemon=True).start()
    try:
        with pytest.raises(OSError):
            urllib_fetch_json(f"http://127.0.0.1:{port}/x", {}, 2)
    finally:
        listener.close()


@pytest.mark.parametrize("url", ["file:///etc/hosts", "ftp://127.0.0.1/x", "not a url"])
def test_only_http_and_https_are_opened(url: str) -> None:
    with pytest.raises((OSError, ValueError)):
        urllib_fetch_json(url, {}, 1)


def test_adapter_maps_the_transport_failures(
    serve: Serve, config: Config, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(KEY_ENV, KEY)
    server = serve(lambda _p: _json(404, {"message": "gone"}))
    custom = _with_bible(config, api_bible={**config.bible["api_bible"], "base_url": server.url})
    with pytest.raises(PassageNotFound):
        build_provider(custom).fetch(_ref(), "abc-01")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    dead = _with_bible(
        config, api_bible={**config.bible["api_bible"], "base_url": f"http://127.0.0.1:{port}"}
    )
    with pytest.raises(ProviderUnavailable):
        build_provider(dead).list_translations()
