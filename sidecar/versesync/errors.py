"""The one table of editor-facing error messages and hints (07 section 3).

Every error the sidecar sends is built from an entry here, so the wording an editor reads is
reviewed in one place. A key is a 07 section 3 ``code``, or ``code.variant`` when one code has
several distinct causes (the HTTP status and hint differ per cause). ``message`` and ``hint`` are
``str.format`` templates; ``{reason}`` and the like are filled by the caller, and are always text
written for an editor, never an exception repr or a traceback.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ErrorSpec:
    status: int
    message: str
    hint: str | None = None
    retryable: bool = False


CATALOGUE: dict[str, ErrorSpec] = {
    "bad_request": ErrorSpec(400, "{problem}"),
    "bad_request.invalid_json": ErrorSpec(400, "The request body is not valid JSON."),
    "bad_request.invalid_length": ErrorSpec(400, "The Content-Length header is invalid."),
    "bad_request.body_too_large": ErrorSpec(413, "The request body is too large."),
    "bad_request.method_not_allowed": ErrorSpec(405, "{method} is not allowed here."),
    "bad_request.no_endpoint": ErrorSpec(404, "No such endpoint."),
    "bad_request.body_not_object": ErrorSpec(400, "The request body must be a JSON object."),
    "bad_request.reference_missing": ErrorSpec(400, "A reference (text or object) is required."),
    "bad_request.media_path_missing": ErrorSpec(400, "The request needs a media_path."),
    "bad_request.media_outside_roots": ErrorSpec(
        400,
        "That media file is outside the folders VerseSync may read.",
        "Pick a file from one of the allowed media folders.",
    ),
    "bad_request.translation_missing": ErrorSpec(400, "The request needs a translation_id."),
    "bad_request.options_not_object": ErrorSpec(400, "options must be a JSON object."),
    "unauthorized": ErrorSpec(
        401,
        "VerseSync did not accept this request's credentials.",
        "Restart VerseSync so the panel and the sidecar share a fresh token.",
    ),
    "media_not_found": ErrorSpec(
        404,
        "The media file could not be found: {path}",
        "Check that the drive is connected and the file has not moved.",
    ),
    "media_unreadable": ErrorSpec(
        400,
        "The media file could not be read: {path}",
        "Check that the file is not open in another program and that you can read it.",
    ),
    "model_load_failed": ErrorSpec(
        500,
        "The transcription model could not be loaded: {reason}",
        "Try a smaller model, or switch to CPU.",
        retryable=True,
    ),
    "transcription_failed": ErrorSpec(
        500,
        "The audio could not be transcribed: {reason}",
        "Check that the media file has an audio track, then try again.",
    ),
    "provider_unavailable": ErrorSpec(
        503,
        "{reason}",
        "Check your internet connection, or switch to a local Bible text.",
        retryable=True,
    ),
    "provider_unavailable.not_configured": ErrorSpec(
        503,
        "No Bible text provider is configured.",
        "Choose a Bible text provider in the VerseSync settings.",
        retryable=True,
    ),
    "translation_not_licensed": ErrorSpec(
        400,
        "{reason}",
        "Choose a translation your Bible text provider is licensed to show.",
    ),
    "job_not_found": ErrorSpec(
        404,
        "No job with id {job_id}",
        "Start the analysis again.",
    ),
    "job_not_found.result_gone": ErrorSpec(
        404,
        "The result of that job is no longer available.",
        "Start the analysis again.",
    ),
    "job_not_finished": ErrorSpec(
        409,
        "Job {job_id} is {state}, not done.",
        "Wait for the job to finish.",
        retryable=True,
    ),
    "cancelled": ErrorSpec(200, "The job was cancelled."),
    "internal": ErrorSpec(
        500,
        "Something went wrong inside VerseSync.",
        "Check the VerseSync log for details.",
    ),
    "internal.job": ErrorSpec(
        500,
        "VerseSync hit an unexpected problem while analysing the media.",
        "Check the VerseSync log for details, then try again.",
    ),
}

# The 07 section 3 codes, in the order that section lists them.
CODES: tuple[str, ...] = (
    "bad_request",
    "unauthorized",
    "media_not_found",
    "media_unreadable",
    "model_load_failed",
    "transcription_failed",
    "provider_unavailable",
    "translation_not_licensed",
    "job_not_found",
    "job_not_finished",
    "cancelled",
    "internal",
)


def code_of(key: str) -> str:
    """The wire ``code`` for a catalogue key (``bad_request.no_endpoint`` is ``bad_request``)."""
    return key.partition(".")[0]


def render(
    key: str,
    *,
    message: str | None = None,
    hint: str | None = None,
    detail: str | None = None,
    retryable: bool | None = None,
    **params: Any,
) -> dict[str, Any]:
    """The 07 section 3 inner object for ``key``, plus its default HTTP ``status``.

    ``message`` and ``hint`` replace the table's text when the cause supplies its own editor-ready
    wording (a transcription backend's out-of-memory report, say).
    """
    spec = CATALOGUE[key]
    text = spec.hint.format(**params) if spec.hint else None
    return {
        "status": spec.status,
        "code": code_of(key),
        "message": message if message is not None else spec.message.format(**params),
        "detail": detail,
        "retryable": spec.retryable if retryable is None else retryable,
        "hint": hint if hint is not None else text,
    }
