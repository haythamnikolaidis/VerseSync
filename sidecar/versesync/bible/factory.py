"""Choose the Bible provider from configuration (06 section 8, T-53.1).

``build_provider`` is the one place that turns ``bible.provider`` into a provider object, and
``urllib_fetch_json`` is the real HTTP transport the API.Bible adapter is given. The API key is
read from the environment variable the config names, handed straight to the adapter, and never
logged, stored on any object here, or put in an exception message.
"""

from __future__ import annotations

import http.client
import json
import logging
import urllib.error
import urllib.request
from collections.abc import Mapping
from typing import Any, NoReturn

from versesync.bible.api_bible import ApiBibleProvider, FetchJson
from versesync.bible.base import BibleProvider, ProviderUnavailable
from versesync.bible.local import LocalProvider
from versesync.config import _BIBLE_DEFAULTS, Config

log = logging.getLogger(__name__)

NO_KEY_MESSAGE = "No API.Bible key: set VERSESYNC_API_BIBLE_KEY and restart Premiere."


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: urllib would resend the api-key header to the new host."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        return None


def _opener() -> urllib.request.OpenerDirector:
    # Built by hand instead of build_opener() so that only http and https can be opened (a
    # file: or ftp: base_url fails with URLError) and so that redirects are not followed.
    opener = urllib.request.OpenerDirector()
    for handler in (
        urllib.request.ProxyHandler(),
        urllib.request.HTTPHandler(),
        urllib.request.HTTPSHandler(),
        _NoRedirect(),
        urllib.request.HTTPDefaultErrorHandler(),
        urllib.request.UnknownHandler(),
        urllib.request.HTTPErrorProcessor(),
    ):
        opener.add_handler(handler)
    return opener


def _json_object(raw: bytes) -> dict[str, Any] | None:
    """Parse ``raw`` as a JSON object; None when it is empty, not JSON, or not an object."""
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except ValueError:  # JSONDecodeError and UnicodeDecodeError are both ValueErrors
        return None
    return parsed if isinstance(parsed, dict) else None


def urllib_fetch_json(
    url: str, headers: Mapping[str, str], timeout: float
) -> tuple[int, dict[str, Any]]:
    """GET ``url`` and return ``(status, json_body)``; the ``FetchJson`` transport.

    HTTP error statuses are returned, not raised. An error body that is not a JSON object
    comes back as ``{}``. Connection failures, timeouts, malformed HTTP and a success response
    that is not a JSON object all raise ``OSError``, which the adapter maps to
    ``ProviderUnavailable``.
    """
    request = urllib.request.Request(url, headers=dict(headers), method="GET")
    try:
        with _opener().open(request, timeout=timeout) as response:
            status = int(response.status)
            raw = response.read()
    except urllib.error.HTTPError as err:
        try:
            raw = err.read()
        except (OSError, http.client.HTTPException):
            raw = b""
        finally:
            err.close()
        return err.code, _json_object(raw) or {}
    except http.client.HTTPException as err:  # not an OSError: truncated or malformed reply
        raise OSError(f"Malformed HTTP response: {type(err).__name__}") from None
    body = _json_object(raw)
    if body is None:
        raise OSError(f"HTTP {status} response was not a JSON object.")
    return status, body


def _no_key_transport(url: str, headers: Mapping[str, str], timeout: float) -> NoReturn:
    raise ProviderUnavailable(NO_KEY_MESSAGE)


def build_provider(config: Config, *, fetch_json: FetchJson | None = None) -> BibleProvider:
    """Build the provider named by ``bible.provider``.

    ``fetch_json`` replaces the real transport (tests only). With no API key in the
    environment, an ``api_bible`` provider is still returned, but every request raises
    ``ProviderUnavailable`` before any transport is called, so a job with no key finishes
    with its cues flagged instead of failing to start.
    """
    name = config.bible.get("provider", _BIBLE_DEFAULTS["provider"])
    if name == "local":
        return LocalProvider()
    if name != "api_bible":
        raise ValueError(f"Unknown bible.provider: {name}")
    api = {**_BIBLE_DEFAULTS["api_bible"], **config.bible.get("api_bible", {})}
    key = config.secret("api_key_env")
    if key is None:
        log.warning("No API.Bible key is set; Bible text requests will be refused.")
        transport: FetchJson = _no_key_transport
        key = ""
    else:
        transport = fetch_json or urllib_fetch_json
    return ApiBibleProvider(
        key,
        str(api["base_url"]),
        transport,
        config.bible.get("translations", _BIBLE_DEFAULTS["translations"]),
        float(api["timeout_s"]),
    )
