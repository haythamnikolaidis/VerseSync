# T-40 · Repo scaffold and CI

| | |
|---|---|
| **Workstream** | 0 — Foundations |
| **Wave** | 0 |
| **Estimate** | M |
| **Prereqs** | none — **this is the first task in the project** |
| **Unblocks** | everything |
| **Spec** | [03-architecture.md §5](../03-architecture.md) · [11-testing.md §1–2](../11-testing.md) |

## Goal

The folder structure from [03 §5](../03-architecture.md) exists, both test suites run, and CI
runs them on every PR. Nobody should have to invent project layout while doing real work.

## Context you need

VerseSync is two codebases in one repo: a Python sidecar and a vanilla-JS CEP panel. They have
separate toolchains and separate test runners, and neither has a build step — the panel is
loaded by Premiere as plain files, so **do not add a bundler**.

## Steps

1. Create the tree exactly as [03 §5](../03-architecture.md) specifies (`panel/`, `sidecar/`,
   `cli/`, `tests/`, `tools/`). Empty packages with `__init__.py` are fine; the shape is the
   deliverable.
2. Python: `pyproject.toml` with the sidecar as an installable package, `pytest`, `ruff`,
   `mypy` on `sidecar/` only. Pin to Python 3.11–3.13 to match Faster-Whisper-Transcriber.
3. JS: a test runner that works without a browser or a build step for the pure-logic modules
   (`timemap.js`, `cues.js`, `duration.js`) — Node with plain ES5-compatible modules. Add
   `eslint` with an ES5 profile so panel code stays Premiere-compatible.
4. CI: one workflow, two jobs (python, js), running lint + tests on every PR. Windows runner
   for Python if it is cheap to do so — the sidecar is Windows-only (NFR-1).
5. `.gitignore` covering venvs, `__pycache__`, `node_modules`, and **`assets/test/`** — the
   `.mogrt` and sermon media must never be committed (see T-01).
6. A `CONTRIBUTING.md` stub pointing at [13 §8](../13-technical-plan.md) for conventions.

## Files

- `pyproject.toml`, `.github/workflows/ci.yml`, `.gitignore`, `CONTRIBUTING.md`
- `panel/`, `sidecar/versesync/`, `cli/`, `tests/`, `tools/` skeletons

## Done when

- [ ] `pytest` and the JS test runner both pass on an empty suite, locally and in CI.
- [ ] `ruff`, `mypy` and `eslint` run clean.
- [ ] A deliberately failing test fails the PR check.
- [ ] The tree matches [03 §5](../03-architecture.md).

## Traps

- **No bundler, no transpiler for the panel.** Premiere loads the files as-is. A build step
  here will be silently wrong for the rest of the project.
- ESLint must target ES5, not modern JS — CEP's Chromium is old, and the host is ES3.
