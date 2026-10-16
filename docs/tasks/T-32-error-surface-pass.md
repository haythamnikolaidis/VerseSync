# T-32 · Error surface pass

| | |
|---|---|
| **Workstream** | H — Quality |
| **Unblocks** | release |
| **Spec** | [03-architecture.md §8](../03-architecture.md) · [09 §7](../09-ui-spec.md) · [07 §3](../07-sidecar-api.md) |

## Goal

Every failure mode in the spec is implemented, can be reproduced on demand, and produces the
message it's supposed to. **Nothing reaches the timeline unreviewed, and anything that does can
be removed with one Ctrl+Z.**

## Subtasks

### T-32.1 · Sidecar error catalogue

**Executor** agent · **Size** S · **Prereqs** T-20.5 · **Status** done

- **Read:** [07 §3](../07-sidecar-api.md) · [03 §8](../03-architecture.md) (the sidecar rows)
- **Touches:** `sidecar/versesync/errors.py` (new; one table of messages and hints by `code`) ·
  `tests/test_error_catalogue.py` (new) · `docs/qa/error-reproduction.md` (new)
- **Steps:**
  1. Put every [07 §3] code's editor-facing `message` template and `hint` in one table, and
     route every `ApiError` construction through it. Commit.
  2. Write a parameterised test that triggers **each code** through the real server, using the
     fixture backend, `FakeBackend` failures, and bad requests. It asserts that the message
     contains no Python traceback text (`Traceback`, `File "`, `Error:` prefixes) and that a
     hint is present wherever the table defines one. Start `docs/qa/error-reproduction.md`,
     with one row per code: how to trigger it, and the expected message. Commit.
- **Verify:** `pytest tests/test_error_catalogue.py -q`
- **Done when:**
  - [x] Every [07 §3] code is triggered by a test.
  - [x] No message leaks a stack trace.

### T-32.2 · Panel failure states and never-settling promises

**Executor** agent · **Size** S · **Prereqs** T-32.1, T-30.2 · **Status** in-progress

- **Read:** [03 §8](../03-architecture.md) (the panel and host rows) · [09 §7](../09-ui-spec.md)
- **Touches:** `tests/panel/failure-states.test.js` (new) · `docs/qa/error-reproduction.md` ·
  the panel files, only where a gap is found
- **Steps:**
  1. Write one jsdom test per row of [03 §8] and [09 §7], using the mock's `--fail` flags
     through the fake client, the stub bridge's error scenarios, and the fake-DOM host:
     - the sidecar won't launch;
     - the sidecar dies mid-job;
     - the model fails to load;
     - the media is unreadable;
     - the provider is down, which is a **successful job** with a retry banner;
     - no sequence is open;
     - the media isn't in the sequence;
     - the MOGRT has no fields;
     - one `importMGT` fails mid-batch, and the undo log is still a single pair.

     Commit.
  2. **The never-settling audit.** Wrap every bridge and client promise in tests with a 5 s
     watchdog, and fail any test that leaves a spinner visible after its promise settles.
     Grep `panel/js` for `new Promise` and `.then(` without a terminal handler, and fix any
     found. Add every row to `docs/qa/error-reproduction.md`. Commit.
- **Verify:** `node --test tests/panel/failure-states.test.js`
- **Done when:**
  - [ ] Every row can be reproduced by a test and shows the exact message.
  - [ ] No spinner can hang forever.
  - [ ] With the sidecar down, load-and-insert still works.

### T-32.H · Manual failure-mode pass

**Executor** human · **Size** — · **Prereqs** T-32.2, T-30.H · **Status** todo

Run [11 §6](../11-testing.md) steps 27–30 on real Premiere, and record the results in
`docs/qa/error-reproduction.md`.

## Traps

- The silent failure, a promise that never settles, is worse than an error message. Hunt for it.
- A Bible API outage is a **successful job with flagged cues**, not a failure.
