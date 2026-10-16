"""Progress accounting and the job registry (07 §2-4)."""

from __future__ import annotations

import queue
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from queue import Queue
from typing import Any

from versesync.server import ApiError

# 07 §4: transcribing dominates; the other phases share the remainder.
PHASE_WEIGHTS: tuple[tuple[str, float], ...] = (
    ("hashing", 0.02),
    ("transcribing", 0.80),
    ("detecting", 0.05),
    ("resolving", 0.10),
    ("timing", 0.03),
)


class Progress:
    """Maps per-phase fractions onto one monotonic 0..1 bar.

    Skipped phases have their weight renormalised away (07 §4), so the bar still
    ends at exactly 1.0.
    """

    def __init__(self, skip: frozenset[str] = frozenset()) -> None:
        kept = [(name, weight) for name, weight in PHASE_WEIGHTS if name not in skip]
        total = sum(weight for _, weight in kept)
        self._spans: dict[str, tuple[float, float]] = {}
        base = 0.0
        for index, (name, weight) in enumerate(kept):
            share = weight / total if total > 0 else 0.0
            # The final phase ends at a literal 1.0 so float drift can't leave 0.9999999.
            end = 1.0 if index == len(kept) - 1 else base + share
            self._spans[name] = (base, end)
            base = end
        self._value = 0.0

    def update(self, phase: str, fraction: float) -> float:
        """Record progress inside ``phase`` and return the overall value (never decreasing)."""
        span = self._spans.get(phase)
        if span is None:
            return self._value
        clamped = min(1.0, max(0.0, fraction))
        start, end = span
        value = end if clamped >= 1.0 else start + (end - start) * clamped
        if value > self._value:
            self._value = value
        return self._value


@dataclass
class Job:
    id: str
    status: str = "queued"
    phase: str | None = None
    progress: float = 0.0
    message: str | None = None
    error: dict[str, Any] | None = None
    cache_hit: bool = False
    created: float = 0.0
    result_path: Path | None = None

    def snapshot(self, now: float | None = None) -> dict[str, Any]:
        """The ``GET /jobs/{id}`` body (07 §2)."""
        elapsed = max(0.0, now - self.created) if now is not None else 0.0
        running = self.status in ("queued", "running")
        eta: float | None = None
        if running and self.progress > 0.0:
            eta = elapsed * (1.0 - self.progress) / self.progress
        return {
            "job_id": self.id,
            "status": self.status,
            "phase": self.phase,
            "progress": self.progress,
            "elapsed_s": round(elapsed),
            "eta_s": round(eta) if eta is not None else None,
            "message": self.message,
            "error": self.error,
        }


_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def new_job_id() -> str:
    """``job_`` plus a 26-char ULID-like string: 10 time chars, 16 random chars."""
    millis = int(time.time() * 1000)
    head = "".join(_CROCKFORD[(millis >> shift) & 31] for shift in range(45, -1, -5))
    tail = "".join(secrets.choice(_CROCKFORD) for _ in range(16))
    return "job_" + head + tail


class JobRegistry:
    def __init__(
        self,
        id_factory: Callable[[], str] = new_job_id,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._id_factory = id_factory
        self._clock = clock
        self._lock = threading.Lock()
        self._jobs: dict[str, Job] = {}
        self._subscribers: dict[str, list[Queue[tuple[str, dict[str, Any]]]]] = {}

    def create(self, **kw: Any) -> Job:
        with self._lock:
            kw.setdefault("created", self._clock())
            job = Job(id=self._id_factory(), **kw)
            self._jobs[job.id] = job
            self._subscribers[job.id] = []
            return job

    def get(self, job_id: str) -> Job:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise ApiError(404, "job_not_found", f"No job with id {job_id}")
        return job

    def subscribe(self, job_id: str) -> Queue[tuple[str, dict[str, Any]]]:
        """A new queue that receives every later ``(event, data)`` for the job."""
        self.get(job_id)
        events: Queue[tuple[str, dict[str, Any]]] = queue.Queue()
        with self._lock:
            self._subscribers[job_id].append(events)
        return events

    def publish(self, job_id: str, event: str, data: dict[str, Any]) -> None:
        self.get(job_id)
        with self._lock:
            listeners = list(self._subscribers[job_id])
        for listener in listeners:
            listener.put((event, data))

    def active_count(self) -> int:
        with self._lock:
            return sum(1 for j in self._jobs.values() if j.status in ("queued", "running"))
