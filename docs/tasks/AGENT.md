# Agent Operating Protocol

**Read this once at the start of every session.** It is how an autonomous coding agent builds
VerseSync one atomic task at a time, and how a fresh session picks up work that a previous one
left half-done. It is written for an agent working with a limited token budget in an ephemeral
Linux container. Humans can follow it too.

---

## 1. The session loop

```
1. orient     python tools/plan.py next              → one task ID, and whether it's START or RESUME
2. read       the task's section in its epic file    → nothing else until step 4 needs it
3. branch     START:  new branch, first commit flips Status to in-progress
              RESUME: check out the branch plan.py named, read its last commit body
4. build      one Step at a time: implement → run Verify → commit → push
5. finish     full checks (§5) → flip Status to done → push → open PR (title starts with the ID)
6. merge      per §7, then back to 1
```

Do **one task per session**, unless the task finishes with plenty of budget left. Then start the
next one, but only from step 1 again.

### Picking work

`python tools/plan.py next` prints the first **agent** task in the execution queue
([10-tasks.md](../10-tasks.md)) whose prereqs are all `done`. If a remote branch already has
commits for a task that isn't `done` yet, it prints `RESUME` with the branch name and the last
step marker. **Always resume before starting anything new.**

Other commands:

| Command | Prints |
|---------|--------|
| `python tools/plan.py status` | Every task with its status. Blocked tasks show their reason. |
| `python tools/plan.py show T-12.2` | Where the task's section starts (`file:line`), so you can read just that part. |
| `python tools/plan.py next --human` | Human tasks that are ready. These are for the repository owner, not for you. |
| `python tools/plan.py validate` | Checks the plan: every ID is unique, prereqs exist, no cycles, every agent task is in the queue. |

---

## 2. Reading discipline (token budget)

Tokens are the scarce resource. These rules exist because the spec package is about 3,800 lines
long, and reading all of it would use up the budget before any code got written.

1. **Read only your task's section.** The epic's *Context* and *Traps* are a few lines long.
   Read those too. Skip the other subtasks' sections.
2. **Read only the spec sections listed under Read.** Spec docs are long. Pull out a single
   section with a range read, for example `sed -n '/^## 4\./,/^## 5\./p' docs/04-reference-detection.md`.
3. **Never `cat` large data files.** That covers fixtures, spike transcripts, the schema and
   vendored sources. Use `head -c 2000`, `python -c` to print one key, `jq`, or a Grep with
   context.
4. **Don't re-derive what the card states.** If the card gives an interface, a constant or a
   file path, it's decided. Use it as written.
5. **Run narrow tests while iterating**, using the card's Verify command. Run the full suite
   once, at the end (§5).
6. **Don't explore the repository.** The card's **Touches** list tells you which files to work
   in. `docs/03-architecture.md` §5 has the layout if you truly need it.

---

## 3. Steps, commits and recovery

Every agent task is broken into **Steps**. One Step is one commit, and the work must be pushed
when the Step is done. The container can be reclaimed at any moment, and anything that wasn't
pushed is lost.

**Commit subject format** (`plan.py` parses it):

```
T-12.2 [2/4] implement P3-P8 keyword forms
T-12.2 [3/4 wip] P10 regex, tests not yet written
T-12.2 [done] mark done
```

**Commit body:** after every Step, end the body with a handoff note. A session that runs out of
budget can't write one later, so write it every time:

```
Next: step 3 — P10 "the ORD chapter of B"; regex drafted in grammar.py:_P10, needs tests.
Notes: P6 needed "and" excluded from book matching; see test_p6_and_not_book.
```

**Rules:**

- **Each commit leaves the build green.** Lint and tests must pass. If you have to stop partway
  through a Step, commit only code that passes, mark it `wip`, and say in the handoff note
  exactly what is missing. Never commit a failing test. Never use `skip` or `xfail` to hide
  unfinished work.
- **Steps are idempotent.** When you resume, re-run the last Step's Verify command before you
  continue. If it fails, the previous session pushed a broken state, and fixing that is your
  first job.
- **Budget check:** before you start a Step, estimate whether you can finish it. If you're
  unsure and more than ~60% of your budget is gone, stop at the current Step boundary. Push, and
  leave a precise handoff note. A clean handoff is worth more than a half-finished Step.

**Branch name:** use the branch your harness assigned, if it assigned one. Otherwise use
`task/<ID>-<short-slug>`, for example `task/T-12.2-grammar-keyword-forms`. `plan.py` finds work
by its **commit subjects**, not by branch name, so either kind of name works.

**Status:** each task has a status line, and that line is the plan's source of truth:

```
**Executor** agent · **Size** S · **Prereqs** T-10.3, T-11.1 · **Status** todo
```

- Your first commit on the branch sets `in-progress`.
- Your last commit sets `done`. The task only counts as done once that commit is **merged to
  `main`**.
- Never edit the status line of a task you aren't working on.

---

## 4. When to stop: blocked tasks

Stop work on the task, and don't improvise, in any of these cases:

| Situation | Do this |
|-----------|---------|
| The task needs Premiere, Windows, a GPU, real sermon media, an API key, or a human decision. | This shouldn't happen for an `agent` task, so it's a plan bug. Mark the task blocked. |
| The spec, the frozen schema or fixtures, and the card disagree in a way that changes a **contract**. | **Do not change the contract.** Mark the task blocked and quote the conflict. Contract changes go through a dedicated contract task ([13 §8](../13-technical-plan.md)). |
| A prereq's output doesn't do what this card says it does. | Mark the task blocked and name the prereq and the gap. |
| `main` is red before you've changed anything. | Fix it first, in a PR titled `hotfix: …`, then go back to the loop. |
| A vendored reference file (`reference/…`) is missing something the card needs. | Mark the task blocked. Don't guess what VerseFlow's code does. |

**How to mark a task blocked:** open a PR that changes only that task's status line to
`blocked`. Under the status line, add a line of the form `> **Blocked:** <one-paragraph
reason>`. Title the PR `T-NN.k blocked: <reason>`. Once it's merged, `plan.py` skips the task
and everything that depends on it.

A **non-contract** ambiguity is not a reason to block. Pick the most conservative reading, write
a comment in the code that cites the spec section, and add the assumption under an
`## Assumptions` heading in the PR body.

---

## 5. Definition of Done (agent tasks)

1. Every Step is committed, and every **Done when** box in the card is satisfied.
2. Run `tools/verify.sh` (created by T-46). It runs ruff, mypy, pytest, eslint and `npm test`.
   It must pass. Until T-46 exists, run those five commands yourself.
3. Re-read your own diff and ask what CI would reject it for. CI runs Python on **Windows**, so
   check paths (`pathlib`, never hard-coded `/`), line endings, and anything that assumes a
   POSIX filesystem.
4. Any constant you *chose* rather than *copied from the spec* has a comment saying why.
5. The PR body lists each Done-when item, with the test that proves it.

---

## 6. Build conventions (decided, don't re-decide)

These settle questions the spec leaves open. Deviating from them costs the next session tokens,
because it then has to discover what you did instead.

### Python (sidecar)

- Package root: `sidecar/versesync/`. Tests: `tests/test_<module>.py`, flat, matching the
  existing files.
- Type hints on public functions. Code must pass `ruff check` and `mypy`. No Qt imports. No
  Premiere concepts, meaning no ticks and no frames ([03 §7](../03-architecture.md)).
- **HTTP:** the standard library's `http.server.ThreadingHTTPServer`, the same as
  `tools/mock_sidecar.py`. No web framework.
- **Runtime dependencies** are added to `pyproject.toml` only by the task that first needs
  them: `PyYAML` (T-05.1), `jsonschema` moved from dev to runtime (T-19.2), `jellyfish`
  (T-11.3). Nothing else without a plan change.
- **Paths:** use `versesync.paths.app_home()` (T-05.1). It honours `$VERSESYNC_HOME`, then
  falls back to `%APPDATA%\VerseSync` on Windows and `~/.local/share/versesync` elsewhere.
  Tests always set `VERSESYNC_HOME` to `tmp_path`, using the `app_home` fixture in
  `tests/conftest.py`.
- **Entry points:** `python -m versesync.sidecar` runs `sidecar/versesync/sidecar.py`.
  `python -m versesync.cli` runs `sidecar/versesync/cli.py`. `cli/versesync_cli.py` is a
  three-line shim that calls `versesync.cli.main()`.
- **Spans are inclusive:** `token_span` and `word_span` are `[first, last]`, matching
  [04 §7](../04-reference-detection.md)'s "tokens 1841–1849".
- **Determinism:** no wall-clock reads, randomness, or set/dict iteration order anywhere in
  detection, alignment or timing ([05 §10](../05-timing-and-placement.md)). `generated_at` and
  job IDs are injected by the caller.

### Panel (JS)

- ES5 only, so no `let`, arrow functions or template strings. `npm run lint` enforces this.
- **Every module is UMD**, so both the panel and Node tests can load it:
  ```javascript
  (function (root) {
    'use strict';
    var Timemap = { /* … */ };
    if (typeof module !== 'undefined' && module.exports) { module.exports = Timemap; }
    else { root.VSTimemap = Timemap; }
  })(this);
  ```
  The browser global is `VS<ModuleName>`. `VS` itself is reserved for the host API.
- Tests: `tests/panel/<module>.test.js`, using `node:test`. They **must** end in `.test.js`, or
  `npm test` won't run them.
- **DOM:** views are split into pure *view-model* functions, which get unit tests, and thin
  render functions, which are tested under `jsdom` (a devDependency added in T-22.1).
- **I/O is injected.** `sidecar.js`, `bridge.js` and every file dialog take their transport (XHR,
  EventSource, `cep.fs`, `child_process`) as a constructor argument. That lets tests pass fakes.
- **Tick math lives in `timemap.js` only** ([05](../05-timing-and-placement.md), risk R-11).
  Ticks cross module boundaries as strings.

### Host (JSX)

- One file, `panel/jsx/VerseSync.jsx`, written in ES3. Use `var fn = function(){}`, ASCII only,
  and keep the JSON polyfill at the top ([08 §1](../08-premiere-host-api.md)).
- Tested in Node with `tests/lib/load-jsx.js` and `tests/lib/fake-premiere.js` (T-45). Tests:
  `tests/host/<fn>.test.js`.
- **The fake can't prove that Premiere behaves this way.** Every host task has a matching check
  in **T-25.H**, done by a human on real Premiere.

### Contracts and fixtures

- **Frozen:** `schemas/cue-document.schema.json`, `tests/fixtures/cue-documents/*`,
  `tests/fixtures/host/*`, `tests/fixtures/transcripts/*`, `panel/js/lib/host-stub.js`,
  `tools/mock_sidecar.py`, and the API shapes in docs 07 and 08. Only a task whose title starts
  with **Contract:** may change them, and it changes all of them together.
- **Reference sources** under `reference/` (T-43, T-44) are read-only copies from other repos.
  They're never deployed, never linted, and never imported. Copy code out of them; don't
  reference them at runtime.

---

## 7. Merging

**Mode A (default): the agent merges.** When CI is green on the PR, squash-merge it and delete
the branch. Then go back to the loop.

**Mode B: a human merges.** Leave the PR open. `plan.py next` won't offer tasks that depend on
it until it's merged. It will offer other ready tasks, so keep working on those. Never stack one
task branch on top of another unmerged one.

The repository owner picks the mode by editing this line:

> **Merge mode: A**

---

## 8. Human tasks

Tasks marked `**Executor** human` need Premiere, Windows, a GPU, real sermon media, credentials,
or a person's judgement. Agents never pick them up. They exist so that:

- the agent tasks they verify can still finish on automated evidence alone, and
- a release can't ship until a human has done the real-hardware checks
  ([11 §7](../11-testing.md)).

A human task blocks an agent task only where the card says **Gate**. There are no active gates
since D24 deferred the corpus and tuning work.

**Deferred tasks** (`**Status** deferred`) are out of scope for now. `plan.py` never offers
them. Don't start one, and don't add an active task that depends on one.
