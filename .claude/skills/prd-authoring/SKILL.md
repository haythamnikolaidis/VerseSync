---
name: prd-authoring
description: Spec a project into a complete, buildable PRD and technical plan — especially when the new product composes or extends existing codebases. Produces a numbered document package (PRD, requirements, source audit, architecture, algorithm specs, contracts, task backlog, testing, risks) that a developer can build from cold. Use this whenever the user asks to spec out a project, write a PRD, plan a product or feature, write requirements, produce a technical plan or design doc, or says something like "we want to build X using Y and Z" — even if they don't say "PRD". Also use it when reviewing or filling gaps in a spec that already exists.
---

# Authoring a PRD

The goal is a document package a developer can pick up cold, on their first day, and build
from — without a meeting, without guessing, and without re-deriving decisions someone already
made.

Most bad specs fail in one of two ways. Either they were written before anyone read the code,
so they describe a system that cannot be built as described. Or they were written to sound
complete, so every hard question was quietly answered with an assumption nobody flagged. This
process is designed against both.

## The core sequence

**Read → audit → identify gaps → ask only what's left → lock decisions → write the package.**

The ordering is the method. Reading before asking dissolves most apparent ambiguity, so the
questions that survive are the ones actually worth a human's time. Reversing it produces
interview questions the code could have answered, and burns the user's patience before you
reach the questions that matter.

---

## Phase 1 — Read the ground truth

Before writing a word of spec, go and look.

**Inventory first, then read.** List the repos, directories, branches, commit history and file
line-counts. Line counts tell you where the mass is and therefore where to spend attention — a
2,000-line module and a 40-line one deserve different treatment.

**Read source, not summaries.** READMEs drift. Architecture docs describe intentions. The code
is what exists. Expect to find places where the documented structure was abandoned for a good
reason, and the reason matters more than the document — if you spec against a stale README you
will re-introduce a problem someone already solved.

**Read the ancestor's design docs anyway** — but as *prior art*, not as truth. Where a previous
team did sourced research (an API's actual behaviour, why one platform was chosen over
another, what turned out to be impossible), cite it and build on it. Re-deriving it wastes days
and risks reaching a worse answer.

**Read enough to be specific.** You should finish this phase able to name functions, constants
and file paths. "The processing layer handles that" is not knowledge. "`run()` keeps only the
text field and discards the timing data the new product depends on" is.

## Phase 2 — Audit, don't summarize

A summary tells the reader what exists. An audit tells them what it costs. Only one of those
supports an estimate.

Classify every relevant asset into exactly three buckets:

| Bucket | Meaning | What to record |
|--------|---------|----------------|
| **Reuse as-is** | Works, correct for the new context, port unchanged | Where it lives, what it does, and *why it must not be rewritten* |
| **Reuse with changes** | The shape is right, the behaviour needs to differ | Exactly what changes, and the blast radius |
| **Gap — must build** | Does not exist anywhere | Which spec document owns it |

Two additions that repay their cost many times over:

**Record the load-bearing conventions.** Codebases accumulate non-obvious rules that look like
noise and are actually scar tissue — a naming convention that exists because a runtime doesn't
hoist declarations, a single-file layout that exists because includes resolve unreliably, an
indexing scheme that exists because two fields share a display name. Write these down with
their reason, and say plainly that they must survive the port. A developer who "cleans them
up" will reintroduce the original bug and have no idea why.

**Record known issues you found but aren't fixing.** Dead duplicate modules, precision limits,
patterns that are correct in the old context and wrong in the new one. These aren't blockers;
they're landmines, and naming them costs a paragraph.

## Phase 3 — Separate blocking gaps from quality gaps

Not all missing things are equal, and conflating them makes a plan unschedulable.

- **Blocking gap** — the product cannot work at all until it is closed. The premise of the
  product depends on data the current code discards, or a capability that only exists behind an
  interface you cannot call.
- **Quality gap** — it works, but badly. Defaults tuned for a different workload, missing
  robustness, an unverified assumption about accuracy.

Mark them differently and order the backlog by them. Blocking gaps belong in the earliest
milestone; quality gaps belong where they can be measured.

## Phase 4 — Ask only the questions that change the architecture

This is the phase people get wrong in both directions: asking nothing and assuming, or asking
everything and outsourcing the thinking.

**The test:** *would different answers produce materially different work?* If the answer is no,
decide it yourself, state the assumption in the spec, and move on. If yes — and if no amount of
further reading resolves it — ask.

Questions that pass the test are usually about: where authoritative data comes from, what the
shipped artifact actually is, where a system boundary falls, and how much human confirmation
sits in the loop. Questions that fail the test are usually about naming, defaults with an
obvious convention, and anything the code already answers.

**How to ask well:**

- **Ask after the audit, not before.** Questions written before reading are vague and often
  already answered.
- **Batch them.** Two to four at once, not a serial interrogation. The user should be able to
  resolve the whole design in one pass.
- **Give real options with honest trade-offs.** Three or four per question, each a genuine
  choice someone might pick. A strawman option wastes a slot and signals you've already decided.
- **State the cost of each option, not just the benefit.** "Fully offline and deterministic, but
  you take on a one-time import step" is useful. "Best option" is not.
- **Recommend one, and say why.** You've done the reading; the user hasn't. Withholding a
  recommendation isn't neutrality, it's abdication.
- **Show your work first.** A short summary of what you found — including the load-bearing
  constraints — makes the answers better, because the user is choosing with the same
  information you have.

**Then say what you decided yourself.** List the judgment calls you made without asking, so the
user can override any of them cheaply. Silent assumptions are the failure mode this whole phase
exists to prevent.

## Phase 5 — Lock decisions with reversal cost

Every confirmed decision goes in a table:

| ID | Decision | Choice | Rationale | Reversal cost |
|----|----------|--------|-----------|---------------|

**Reversal cost is the column that earns the table its place.** It tells the reader which
decisions to argue about now and which to defer — a choice that costs a day to reverse does not
deserve a week of debate, and one that costs a rewrite deserves more scrutiny than it usually
gets. Be honest when a cost is low technically but high contractually; those are different
problems with different owners.

Give decisions stable IDs (`D1`, `D2`…) and reference them from every document that depends on
them, so the blast radius of a change is traceable rather than archaeological.

## Phase 6 — Write the package

Not a document. A **package**: numbered files, one concern each, an index that orients a new
reader, and cross-links between them.

The reason is progressive disclosure for humans. A single 4,000-line document is read by nobody.
A package lets a developer read the two files their task depends on, and lets a stakeholder read
only the PRD.

**Standard shape** (adapt the middle; keep the ends):

| File | Contains |
|------|----------|
| `README.md` | Index, one-paragraph "what we're building", the decision table, glossary, definition of done |
| `00-prd.md` | Problem, users, goals and non-goals, success metrics, scope, user journeys, release plan, open questions |
| `01-requirements.md` | Numbered functional + non-functional requirements |
| `02-source-audit.md` | The Phase 2 audit — only when building on existing code |
| `03-architecture.md` | Components, contracts, data flow, concern ownership, failure model |
| `04…0N` | One document per hard problem: the core algorithm, the timing model, the integration, each API contract, the UI |
| `10-tasks.md` | The backlog, ordered by dependency |
| `11-testing.md` | Test strategy, fixtures, manual QA script, release gates |
| `12-decisions-and-risks.md` | Decision log, risk register, open questions |

If the organisation already has a house style for these documents, match it. A spec that looks
like the last one gets read; a novel format gets skimmed.

For what belongs inside each document — including the shape of a good requirement, risk entry
and task — read `references/document-package.md`.

## Phase 7 — Front-load risk as gated spikes

Find the assumptions that, if wrong, invalidate the design. There are usually two or three, and
they are usually about a dependency's actual behaviour rather than about your own code.

Make each one an explicit spike, put it in the first milestone, and write a **gate**:

> If [specific measured outcome], stop and re-plan. Fallbacks, in order: …

The gate is what makes a spike different from a task. It states in advance what result would
change the plan, so the finding lands as information rather than as a crisis. Pre-costing the
fallbacks is what keeps a failed spike from becoming a stalled project — and often the fallback
is already documented somewhere in the ancestor project's research, which is another reason
Phase 1 pays.

---

## Standards that apply throughout

**Give everything a stable ID.** Requirements, decisions, risks, tasks. IDs are what let a task
say "implements FR-5.2", a test say "covers FR-5.2", and a reviewer check coverage without
reading everything. Ad-hoc prose references rot within a week.

**Mark what is inherited.** When a requirement or constraint carries over unchanged from an
existing system, say so and cite it. It still needs testing; it does not need redesigning, and
flagging it stops a developer spending a day rediscovering a settled answer.

**Give every concern exactly one owner.** A table mapping each concern to the one component
that owns it — and, where it's genuinely tempting, where it must *not* live. Ambiguous ownership
is how the same logic ends up implemented twice, slightly differently.

**Version every contract.** Any interface between two components, and any file format that
persists, carries a version field and a stated policy for mismatches. Failing clearly beats
misbehaving silently.

**Make one thing concrete.** Somewhere in the package, trace a single realistic case end to end
with real numbers, through every transformation, to the final output. This does more for
comprehension than any amount of prose, and it doubles as the first integration test.

**Write "what this deliberately does not do".** For each significant design, list the plausible
alternatives you rejected and why. Without it, readers treat every omission as an oversight and
re-litigate it. With it, they either accept the reasoning or challenge it on the merits.

**Separate risk types.** A technical risk has an engineering mitigation. A contractual,
licensing or organisational risk does not — it needs a named owner, a decision, and a date.
Filing the second kind as though it were the first is how projects discover in month three that
the thing they built cannot ship.

**Leave open questions open.** Anything genuinely unresolved gets its own entry with: what
depends on it, what is blocked until it's answered, and what to do meanwhile. An open question
you can work around is not a blocker; an open question you've silently assumed away is a defect.

**Make metrics gate the release.** A target nobody checks is decoration. State how each is
measured, against what data, and that a regression blocks shipping. If a metric needs labelled
data to measure, the data set is a deliverable with a milestone — not an afterthought.

**Write user-facing text for the user.** Error messages, status strings and warnings in the spec
should be written as they'll be read by the person who sees them, not as developer shorthand.
Specifying them is cheap and it stops each one being improvised badly later.

**Estimate honestly, and say where you're unsure.** A range with a stated uncertainty is more
useful than a confident number that's wrong.

---

## Common failure modes

| Failure | What it looks like | Fix |
|---------|-------------------|-----|
| Speccing before reading | Architecture that can't be built; reinventing solved problems | Phase 1, always |
| Summarizing instead of auditing | "We'll reuse the existing engine" with no idea what that costs | Three-bucket classification with evidence |
| Asking everything | A long interview about things the code answers | Apply the Phase 4 test |
| Asking nothing | A spec full of confident, unmarked assumptions | Say what you assumed, every time |
| Hiding the hard question | The riskiest unknown appears on page 40 as a note | Spike it, gate it, put it first |
| Optimistic sequencing | Deep build work scheduled before its assumptions are validated | Gated spikes in milestone one |
| Uniform risk treatment | A licensing risk with an "engineering mitigation" | Separate technical from contractual |
| Feature list as scope | No non-goals, so scope grows silently | Explicit non-goals and deferrals with revisit triggers |
| Unfalsifiable done | "High accuracy", "good performance" | Numbers, measurement method, release gate |

---

## Working style

Take the reading seriously; it is most of the value. Expect the audit phase to be slower than
feels comfortable and the writing to be faster than expected, because by then you know what to
say.

Write plainly. Prefer a table to a paragraph when the content is structured, and a paragraph to
a table when it isn't. Explain *why* a constraint exists, not only that it does — a developer
who understands the reason handles the case you didn't anticipate.

When the spec is finished, tell the user what you found that they didn't know, what you decided
on their behalf, and what still needs an answer from them. That is the part they can act on.
