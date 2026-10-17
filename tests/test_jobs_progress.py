import pytest

from versesync.jobs import PHASE_WEIGHTS, Job, JobRegistry, Progress
from versesync.server import ApiError

PHASES = [name for name, _ in PHASE_WEIGHTS]


def run_all(progress: Progress, skip: frozenset[str] = frozenset()) -> list[float]:
    values = []
    for phase in PHASES:
        if phase in skip:
            continue
        for fraction in (0.0, 0.3, 0.7, 1.0):
            values.append(progress.update(phase, fraction))
    return values


def test_progress_never_goes_down() -> None:
    progress = Progress()
    values = run_all(progress)
    assert values == sorted(values)
    assert progress.update("transcribing", 0.1) == values[-1]
    assert progress.update("hashing", 0.5) == values[-1]
    assert progress.update("timing", -3.0) == values[-1]


def test_progress_clamps_fractions() -> None:
    progress = Progress()
    assert progress.update("hashing", 7.0) == pytest.approx(0.02)
    assert progress.update("transcribing", -1.0) == pytest.approx(0.02)


def test_progress_ends_at_exactly_one() -> None:
    progress = Progress()
    assert run_all(progress)[-1] == 1.0


def test_skipped_phase_still_ends_at_one() -> None:
    skip = frozenset({"transcribing"})
    progress = Progress(skip)
    values = run_all(progress, skip)
    assert values == sorted(values)
    assert values[-1] == 1.0
    assert Progress(skip).update("hashing", 1.0) == pytest.approx(0.02 / 0.20)


def test_unknown_or_skipped_phase_is_ignored() -> None:
    progress = Progress(frozenset({"transcribing"}))
    assert progress.update("transcribing", 1.0) == 0.0
    assert progress.update("bogus", 1.0) == 0.0


def test_unknown_job_is_job_not_found() -> None:
    registry = JobRegistry()
    with pytest.raises(ApiError) as info:
        registry.get("job_missing")
    assert info.value.status == 404
    assert info.value.code == "job_not_found"


def test_registry_create_get_and_ids() -> None:
    ids = iter(["job_a", "job_b"])
    registry = JobRegistry(id_factory=lambda: next(ids), clock=lambda: 12.0)
    job = registry.create(status="running")
    assert registry.get("job_a") is job
    assert job.created == 12.0
    assert registry.create().id == "job_b"
    assert registry.active_count() == 2
    job.status = "done"
    assert registry.active_count() == 1


def test_default_id_shape() -> None:
    job = JobRegistry().create()
    assert job.id.startswith("job_")
    assert len(job.id) == len("job_") + 26


def test_publish_reaches_every_subscriber() -> None:
    registry = JobRegistry()
    job = registry.create()
    first, second = registry.subscribe(job.id), registry.subscribe(job.id)
    registry.publish(job.id, "progress", {"phase": "hashing"})
    assert first.get_nowait() == ("progress", {"phase": "hashing"})
    assert second.get_nowait() == ("progress", {"phase": "hashing"})
    with pytest.raises(ApiError):
        registry.subscribe("job_missing")


def test_snapshot_shape() -> None:
    job = Job(id="job_x", status="running", phase="detecting", progress=0.5, created=10.0)
    body = job.snapshot(now=110.0)
    assert body == {
        "job_id": "job_x",
        "status": "running",
        "phase": "detecting",
        "progress": 0.5,
        "elapsed_s": 100,
        "eta_s": 100,
        "message": None,
        "error": None,
    }
