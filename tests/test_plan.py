"""tools/plan.py: the plan stays machine-valid, and the parser and queue logic behave."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import plan  # noqa: E402


def write(tmp: Path, name: str, text: str) -> None:
    (tmp / name).write_text(text, encoding="utf-8")


def mini_plan(tmp: Path, queue: str, b_prereqs: str = "T-01") -> plan.Plan:
    tasks = tmp / "tasks"
    tasks.mkdir()
    write(
        tasks,
        "T-01-a.md",
        "# T-01 · A\n\n**Executor** agent · **Size** S · **Prereqs** — · **Status** done\n",
    )
    write(
        tasks,
        "T-02-b.md",
        "# T-02 · B epic\n\n"
        "### T-02.1 · B one\n\n"
        f"**Executor** agent · **Size** S · **Prereqs** {b_prereqs} · **Status** todo\n\n"
        "### T-02.H · B human\n\n"
        "**Executor** human · **Size** — · **Prereqs** T-02.1 · **Status** todo\n",
    )
    write(
        tasks,
        "T-03-c.md",
        "# T-03 · C\n\n**Executor** agent · **Size** XS · **Prereqs** T-02 · **Status** todo\n",
    )
    index = tmp / "index.md"
    index.write_text(
        "# x\n\n## Execution queue\n\n| # | ID |\n|---|---|\n" + queue + "\n## Other\n",
        encoding="utf-8",
    )
    return plan.load_plan(tasks, index)


def test_real_plan_is_valid() -> None:
    p = plan.load_plan()
    assert plan.validate(p) == []
    assert len(p.tasks) > 100


def test_every_agent_task_names_verify_and_done_when() -> None:
    # Cards for open agent tasks must be actionable: a Verify command and a Done-when list.
    p = plan.load_plan()
    for task in p.tasks.values():
        if task.executor != "agent" or task.status == "done":
            continue
        text = task.path.read_text(encoding="utf-8").splitlines()[task.line - 1 :]
        end = next(
            (i for i, line in enumerate(text[1:], 1) if plan.HEADING_RE.match(line)), len(text)
        )
        section = "\n".join(text[:end])
        assert "Verify" in section, f"{task.id} has no Verify"
        assert "Done when" in section, f"{task.id} has no Done when"


def test_parse_and_epic_expansion(tmp_path: Path) -> None:
    p = mini_plan(tmp_path, "| 1 | T-02.1 |\n| 2 | T-02.H |\n| 3 | T-03 |\n")
    assert set(p.tasks) == {"T-01", "T-02.1", "T-02.H", "T-03"}
    assert p.epics["T-02"] == ["T-02.1", "T-02.H"]
    assert plan.validate(p) == []
    assert not plan.is_done(p, "T-02")
    assert [t.id for t in plan.ready(p, "agent")] == ["T-02.1"]


def test_validate_catches_order_unknown_and_cycles(tmp_path: Path) -> None:
    p = mini_plan(tmp_path, "| 1 | T-03 |\n| 2 | T-02.1 |\n| 3 | T-02.H |\n", "T-03, T-99")
    errors = "\n".join(plan.validate(p))
    assert "unknown prereq T-99" in errors
    assert "cycle" in errors
    assert "queue order" in errors


def test_queue_takes_first_id_per_row() -> None:
    text = "## Execution queue\n| 1 | [T-05.1](x) | uses T-44 | T-44 |\n| 2 | T-44 |\n"
    assert plan.parse_queue(text) == ["T-05.1", "T-44"]
