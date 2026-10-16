"""Golden-file tests: pipeline output for each T-41 fixture is pinned (11-testing.md section 4)."""
import difflib
import json

import pytest
from regen_golden import fixture_names, golden_path, render

NAMES = fixture_names()
IGNORED_JOB_KEYS = ("id",)


def _normalise(text: str) -> str:
    doc = json.loads(text)
    doc.pop("generated_at", None)
    for key in IGNORED_JOB_KEYS:
        doc.get("job", {}).pop(key, None)
    return json.dumps(doc, indent=1, ensure_ascii=False) + "\n"


def test_fixtures_are_discovered() -> None:
    assert len(NAMES) >= 4


@pytest.mark.parametrize("name", NAMES)
def test_matches_golden(name: str) -> None:
    path = golden_path(name)
    assert path.is_file(), f"missing {path}; run python tools/regen_golden.py"
    expected = _normalise(path.read_bytes().decode("utf-8"))
    actual = _normalise(render(name))
    if actual != expected:
        diff = "".join(
            difflib.unified_diff(
                expected.splitlines(keepends=True),
                actual.splitlines(keepends=True),
                fromfile=f"golden/{name}.cues.json",
                tofile=f"actual/{name}.cues.json",
            )
        )
        pytest.fail(f"pipeline output changed for {name}:\n{diff}")


def test_output_is_byte_identical_across_runs() -> None:
    first = {name: render(name) for name in NAMES}
    second = {name: render(name) for name in NAMES}
    assert first == second


@pytest.mark.parametrize("name", NAMES)
def test_golden_file_is_exactly_rendered_output(name: str) -> None:
    assert golden_path(name).read_bytes() == render(name).encode("utf-8")
