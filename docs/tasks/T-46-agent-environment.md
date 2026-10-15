# T-46 · Agent environment bootstrap

**Executor** agent · **Size** XS · **Prereqs** — · **Status** done

| | |
|---|---|
| **Workstream** | 0 — Agent enablement |
| **Unblocks** | every agent task (it saves tokens on every session) |
| **Spec** | [tasks/AGENT.md §5](AGENT.md) |

## Goal

Every new agent session starts with dependencies installed and has one command that runs every
check CI runs.

## Steps

1. Add `tools/verify.sh`. It runs, in order and failing fast: `ruff check sidecar tools tests`,
   `mypy`, `pytest -q`, `npm run lint`, `npm test`. Make it executable (`chmod +x`). Commit:
   `T-46 [1/3] verify.sh`.
2. Add a SessionStart hook, using the `session-start-hook` skill if it's available. The hook
   runs `pip install -e ".[dev]"` and `npm ci`, quietly, and is safe to run twice. Put it in
   `.claude/settings.json`, with any script it needs under `.claude/hooks/`. Commit:
   `T-46 [2/3] session start hook`.
3. Add a `python-linux` job to `.github/workflows/ci.yml`: `ubuntu-latest`, Python 3.12, the same
   steps as the Windows job. Agents run on Linux, so CI must prove the suite passes there too.
   Commit: `T-46 [3/3] linux CI job`.

## Verify

`./tools/verify.sh`

## Done when

- [x] `tools/verify.sh` passes on a clean checkout once dependencies are installed.
- [x] A fresh session has `pytest` and `eslint` available without installing anything by hand.
- [x] CI runs Python on both Windows and Linux.
