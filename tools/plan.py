"""Plan tool for autonomous (and human) execution of docs/tasks/.

Reads the status line of every task in docs/tasks/T-*.md, and the execution queue in
docs/10-tasks.md, then answers "what do I work on next?". See docs/tasks/AGENT.md.

    python tools/plan.py next [--human] [--no-fetch]
    python tools/plan.py status
    python tools/plan.py show T-12.2
    python tools/plan.py validate

A task is any heading (`# T-NN · …` or `### T-NN.k · …`) followed by a status line:

    **Executor** agent · **Size** S · **Prereqs** T-10.3, T-11.1 · **Status** todo

An epic heading without its own status line is not a task; listing an epic ID as a prereq
means "every subtask of that epic is done". A `deferred` task is out of scope for now: it is
never offered, stays out of the queue, and no active task may depend on it.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TASKS_DIR = ROOT / "docs" / "tasks"
INDEX = ROOT / "docs" / "10-tasks.md"

ID = r"T-\d+(?:\.[0-9A-Z]+)?"
HEADING_RE = re.compile(rf"^(#|###) ({ID}) · (.+)$")
STATUS_RE = re.compile(
    r"^\*\*Executor\*\* (agent|human) · \*\*Size\*\* (\S+) · "
    r"\*\*Prereqs\*\* (.+?) · \*\*Status\*\* (todo|in-progress|blocked|deferred|done)\s*$"
)
ID_RE = re.compile(ID)
SUBJECT_RE = re.compile(rf"^({ID}) \[([^\]]+)\]")
STATUSES = ("todo", "in-progress", "blocked", "deferred", "done")


@dataclass
class Task:
    id: str
    title: str
    executor: str
    size: str
    prereqs: list[str]
    status: str
    path: Path
    line: int
    blocked_reason: str | None = None


@dataclass
class Plan:
    tasks: dict[str, Task] = field(default_factory=dict)
    epics: dict[str, list[str]] = field(default_factory=dict)  # epic id -> subtask ids
    queue: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def parse_task_file(path: Path, plan: Plan) -> None:
    lines = path.read_text(encoding="utf-8").splitlines()
    current: tuple[str, str, int] | None = None  # (id, title, line)
    epic: str | None = None
    for n, line in enumerate(lines, start=1):
        heading = HEADING_RE.match(line)
        if heading:
            level, task_id, title = heading.groups()
            current = (task_id, title.strip(), n)
            if level == "#":
                epic = task_id
            continue
        status = STATUS_RE.match(line)
        if status and current:
            task_id, title, at = current
            executor, size, prereq_text, state = status.groups()
            none = prereq_text.strip() in ("—", "-", "none")
            prereqs = [] if none else ID_RE.findall(prereq_text)
            if task_id in plan.tasks:
                plan.errors.append(f"duplicate task id {task_id} ({path.name}:{at})")
            task = Task(task_id, title, executor, size, prereqs, state, path, at)
            # A blockquote reason directly under a blocked status line.
            if state == "blocked":
                for follow in lines[n : n + 3]:
                    if follow.startswith("> **Blocked:**"):
                        task.blocked_reason = follow.split("**Blocked:**", 1)[1].strip()
            plan.tasks[task_id] = task
            if epic and task_id != epic:
                plan.epics.setdefault(epic, []).append(task_id)
            current = None
        elif line.startswith("**Executor**"):
            plan.errors.append(f"malformed status line at {path.name}:{n}")


def parse_queue(text: str) -> list[str]:
    match = re.search(r"^## Execution queue\s*$(.*?)(?=^## |\Z)", text, re.M | re.S)
    if not match:
        return []
    seen: list[str] = []
    for line in match.group(1).splitlines():
        if not line.startswith("|"):
            continue
        for task_id in ID_RE.findall(line):
            if task_id not in seen:
                seen.append(task_id)
            break  # one task per row: the first ID in the row
    return seen


def load_plan(tasks_dir: Path = TASKS_DIR, index: Path = INDEX) -> Plan:
    plan = Plan()
    for path in sorted(tasks_dir.glob("T-*.md")):
        parse_task_file(path, plan)
    if index.exists():
        plan.queue = parse_queue(index.read_text(encoding="utf-8"))
    return plan


def is_done(plan: Plan, task_id: str) -> bool:
    if task_id in plan.tasks:
        return plan.tasks[task_id].status == "done"
    subtasks = plan.epics.get(task_id, [])
    return bool(subtasks) and all(plan.tasks[s].status == "done" for s in subtasks)


def expand(plan: Plan, task_id: str) -> list[str]:
    """A prereq ID as a list of concrete task IDs (an epic expands to its subtasks)."""
    if task_id in plan.tasks:
        return [task_id]
    return list(plan.epics.get(task_id, []))


def validate(plan: Plan) -> list[str]:
    errors = list(plan.errors)
    for task in plan.tasks.values():
        for prereq in task.prereqs:
            if prereq not in plan.tasks and prereq not in plan.epics:
                errors.append(f"{task.id}: unknown prereq {prereq}")
            if prereq == task.id:
                errors.append(f"{task.id}: depends on itself")
    # Cycles (DFS over expanded prereqs).
    state: dict[str, int] = {}

    def visit(task_id: str, stack: list[str]) -> None:
        state[task_id] = 1
        for prereq in plan.tasks[task_id].prereqs:
            for dep in expand(plan, prereq):
                if state.get(dep) == 1:
                    errors.append("cycle: " + " -> ".join([*stack, task_id, dep]))
                elif dep not in state:
                    visit(dep, [*stack, task_id])
        state[task_id] = 2

    for task_id in plan.tasks:
        if task_id not in state:
            visit(task_id, [])
    # Queue coverage and ordering.
    position = {task_id: i for i, task_id in enumerate(plan.queue)}
    for task_id in plan.queue:
        if task_id not in plan.tasks:
            errors.append(f"queue lists unknown task {task_id}")
    for task in plan.tasks.values():
        if task.status in ("done", "deferred"):
            if task.status == "deferred" and task.id in position:
                errors.append(f"{task.id}: deferred tasks don't belong in the execution queue")
            continue
        for prereq in task.prereqs:
            for dep in expand(plan, prereq):
                if dep in plan.tasks and plan.tasks[dep].status == "deferred":
                    errors.append(f"{task.id}: depends on deferred task {dep}")
        if task.id not in position:
            errors.append(f"{task.id}: not in the execution queue in docs/10-tasks.md")
            continue
        for prereq in task.prereqs:
            for dep in expand(plan, prereq):
                dep_task = plan.tasks.get(dep)
                if dep_task is None or dep_task.status == "done":
                    continue
                if dep not in position:
                    continue  # reported above
                if position[dep] > position[task.id]:
                    errors.append(f"queue order: {task.id} is listed before its prereq {dep}")
    return errors


def git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=False
    )
    return result.stdout if result.returncode == 0 else ""


def remote_progress(base: str) -> dict[str, tuple[str, str]]:
    """task id -> (branch, latest step marker), from commit subjects on remote branches."""
    out = git("log", "--remotes", "--source", "--not", base, "--format=%S%x09%s")
    progress: dict[str, tuple[str, str]] = {}
    for line in out.splitlines():
        if "\t" not in line:
            continue
        ref, subject = line.split("\t", 1)
        match = SUBJECT_RE.match(subject)
        if match and match.group(1) not in progress:  # newest first
            progress[match.group(1)] = (ref, match.group(2))
    return progress


def ready(plan: Plan, executor: str) -> list[Task]:
    order = {task_id: i for i, task_id in enumerate(plan.queue)}
    candidates = [
        t
        for t in plan.tasks.values()
        if t.executor == executor
        and t.status in ("todo", "in-progress")
        and all(is_done(plan, p) for p in t.prereqs)
    ]
    return sorted(candidates, key=lambda t: order.get(t.id, len(order)))


def cmd_next(plan: Plan, args: argparse.Namespace) -> int:
    if args.human:
        tasks = ready(plan, "human")
        if not tasks:
            print("NOTHING-READY")
            return 0
        for t in tasks:
            print(f"HUMAN {t.id} · {t.title}  ({t.path.relative_to(ROOT)}:{t.line})")
        return 0
    if not args.no_fetch and git("remote"):
        subprocess.run(["git", "fetch", "--quiet", "origin"], cwd=ROOT, check=False)
    progress = remote_progress(args.base)
    tasks = ready(plan, "agent")
    awaiting = []
    for t in tasks:
        if t.id in progress:
            branch, marker = progress[t.id]
            if marker == "done":
                awaiting.append(f"AWAITING-MERGE {t.id} on {branch}")
                continue
            print(f"RESUME {t.id} · {t.title}")
            print(f"  branch: {branch}  last step: [{marker}]")
            print(f"  card:   {t.path.relative_to(ROOT)}:{t.line}")
            return 0
    for t in tasks:
        if t.id not in progress:
            print(f"START {t.id} · {t.title}")
            print(f"  card:   {t.path.relative_to(ROOT)}:{t.line}")
            print(f"  size:   {t.size}   prereqs: {', '.join(t.prereqs) or '—'}")
            for line in awaiting:
                print(line)
            return 0
    for line in awaiting:
        print(line)
    blocked = [t for t in plan.tasks.values() if t.status == "blocked"]
    print("NOTHING-READY" + (f" ({len(blocked)} blocked)" if blocked else ""))
    return 0


def cmd_status(plan: Plan, _args: argparse.Namespace) -> int:
    width = max(len(t) for t in plan.tasks)
    counts = {s: 0 for s in STATUSES}
    for task_id in [*plan.queue, *sorted(set(plan.tasks) - set(plan.queue))]:
        t = plan.tasks.get(task_id)
        if t is None:
            continue
        counts[t.status] += 1
        ok = "ready" if all(is_done(plan, p) for p in t.prereqs) else "waiting"
        note = f"  — {t.blocked_reason}" if t.blocked_reason else ""
        print(f"{t.id:<{width}}  {t.executor:<5}  {t.status:<11}  {ok:<7}  {t.title}{note}")
    print("  ".join(f"{s}: {n}" for s, n in counts.items()))
    return 0


def cmd_show(plan: Plan, args: argparse.Namespace) -> int:
    t = plan.tasks.get(args.id)
    if t is None:
        print(f"unknown task {args.id}", file=sys.stderr)
        return 2
    print(f"{t.path.relative_to(ROOT)}:{t.line}")
    return 0


def cmd_validate(plan: Plan, _args: argparse.Namespace) -> int:
    errors = validate(plan)
    for error in errors:
        print(error)
    agent = sum(1 for t in plan.tasks.values() if t.executor == "agent")
    print(f"{len(plan.tasks)} tasks ({agent} agent), {len(errors)} problem(s)")
    return 1 if errors else 0


def main(argv: list[str] | None = None) -> int:
    # Task titles contain → and ·, which a cp1252 Windows console can't encode.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_next = sub.add_parser("next")
    p_next.add_argument("--human", action="store_true")
    p_next.add_argument("--no-fetch", action="store_true")
    p_next.add_argument("--base", default="origin/main")
    sub.add_parser("status")
    p_show = sub.add_parser("show")
    p_show.add_argument("id")
    sub.add_parser("validate")
    args = parser.parse_args(argv)
    plan = load_plan()
    handler = {"next": cmd_next, "status": cmd_status, "show": cmd_show, "validate": cmd_validate}
    return handler[args.cmd](plan, args)


if __name__ == "__main__":
    sys.exit(main())
