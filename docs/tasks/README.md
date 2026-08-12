# Task Files

One file per task. **Each is self-contained**: a developer with no prior context should be able
to open one, read the linked spec sections, and finish it.

- **Build order and who owns what:** [../13-technical-plan.md](../13-technical-plan.md)
- **Index of every task:** [../10-tasks.md](../10-tasks.md)

## File anatomy

| Field | Means |
|-------|-------|
| **Workstream** | Which stream owns it ([13 §4](../13-technical-plan.md)). One owner per stream. |
| **Wave** | When it runs ([13 §5](../13-technical-plan.md)). |
| **Prereqs** | Must be **merged** before this starts. |
| **Unblocks** | Who is waiting on you. Ship promptly if this list is long. |
| **Spec** | Read these sections before writing code. They are the source of truth; task files summarise but never override them. |
| **Done when** | Verifiable by someone other than the author. |

## Estimates

**S** ≤ half a day · **M** ~1 day · **L** 2–3 days · **XL** ~1 week.

## Conventions

- Branch `task/T-NN-short-slug`, one PR per task, PR title starts with the task ID.
- Definition of Ready / Done: [13 §8](../13-technical-plan.md).
- Changing a frozen contract requires the protocol in [13 §8](../13-technical-plan.md) —
  spec, schema, fixtures and mock all move in one PR.
- Task IDs **T-01…T-36** are referenced by ID from other documents in this package
  ([02](../02-source-project-audit.md), [08](../08-premiere-host-api.md),
  [12](../12-decisions-and-risks.md)). **Do not renumber them.** T-37…T-42 were added later as
  the foundation tasks — they run *first* despite the higher numbers.

## Before you start anything

- Any host (`.jsx`) task → read [08-premiere-host-api.md](../08-premiere-host-api.md) **and**
  VerseFlow's `docs/planning/02-adobe-research.md`.
- Any detection task → read [04-reference-detection.md](../04-reference-detection.md).
- Any timing task → read [05-timing-and-placement.md](../05-timing-and-placement.md).
