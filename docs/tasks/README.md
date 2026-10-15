# Task Files

One **epic file** per task ID. Atomic tasks live in their own file. A task that was too big to
be atomic became an epic, and its subtasks (`T-NN.1`, `T-NN.2`, …, and `T-NN.H` for human
verification) are sections inside that file.

- **Autonomous agents: read [AGENT.md](AGENT.md) first.** It covers the session loop, recovery,
  stop conditions and build conventions.
- **The execution queue and index:** [../10-tasks.md](../10-tasks.md)
- **Why the plan has this shape:** [../13-technical-plan.md §11](../13-technical-plan.md#11-autonomous-agent-execution)
- **What to work on next:** `python tools/plan.py next`

## Card anatomy

Every task, whether it's a whole file or a `###` section, starts with a **status line**.
`tools/plan.py` parses it, so keep the format exact:

```
**Executor** agent · **Size** S · **Prereqs** T-10.3, T-11.1 · **Status** todo
```

| Field | Means |
|-------|-------|
| **Executor** | `agent`: buildable and verifiable in a Linux container with no Premiere, GPU, media or credentials. `human`: needs one of those. |
| **Size** | `XS` is under ~100 changed lines including tests. `S` is ~100–300. Agent tasks are never bigger. |
| **Prereqs** | Must be **merged** (`done`) first. An epic ID means "all of its subtasks". |
| **Status** | `todo` · `in-progress` · `blocked` (with a `> **Blocked:**` line under it) · `done` |

Then the card fields:

| Field | Means |
|-------|-------|
| **Read** | The *only* spec sections and files to read. Everything else is out of budget. |
| **Touches** | The files this task creates or changes. Changing anything else is a smell; see AGENT.md §4. |
| **Interface** | Signatures and shapes that are **decided**. Implement them exactly. Later tasks depend on them. |
| **Steps** | Each Step is one commit, pushed, and leaves the build green. The commit subject is `T-NN.k [i/n] …`. |
| **Verify** | The narrow command that proves the task works. Run it after every Step. |
| **Done when** | Checks that someone other than the author can verify. |

The epic header holds **Goal**, **Context** and **Traps**, which apply to every subtask in it.
Keep them short: an agent reads them for every subtask.

## Writing or changing cards

- **One Step, one idea, one commit.** If a Step can't be finished in a fraction of a session,
  split it.
- **Decide interfaces in the card**, not in the implementation. Seams between tasks are where
  autonomous work goes wrong.
- **Name exact files, exact messages, and exact constants.** "Handle errors nicely" can't be
  verified, but *"`Jude has only 1 chapter.`"* can.
- **Never make an agent task depend on a human task** unless the card says **Gate**.
- Run `python tools/plan.py validate` after any change to a status line, a prereq or the queue.

## Conventions

- Changing a frozen contract needs a dedicated **Contract:** task (see
  [../13-technical-plan.md §8](../13-technical-plan.md)). The spec, the schema, the fixtures,
  the stub and the mock all move together in one PR. T-47 and T-50 are the examples.
- Task IDs **T-01…T-42** are referenced by ID from [02](../02-source-project-audit.md),
  [08](../08-premiere-host-api.md) and [12](../12-decisions-and-risks.md). **Don't renumber
  them.** New work gets the next free number (T-51 and up) or a new subtask.
- Any host (`.jsx`) task: read the relevant [08](../08-premiere-host-api.md) sections and
  `reference/verseflow/docs/planning/02-adobe-research.md` (vendored by T-43). Read only the
  sections the card lists.
