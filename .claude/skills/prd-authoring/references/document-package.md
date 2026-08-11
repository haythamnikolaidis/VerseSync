# The Document Package — what goes in each file

Read this while writing the package (Phase 6). It covers the content of each document and the
shape of the four repeating units: the requirement, the decision, the risk, and the task.

**Contents**
- [Sizing the package](#sizing-the-package)
- [README.md — the index](#readmemd--the-index)
- [00-prd.md — the product document](#00-prdmd--the-product-document)
- [01-requirements.md](#01-requirementsmd)
- [02-source-audit.md](#02-source-auditmd)
- [03-architecture.md](#03-architecturemd)
- [The problem documents (04…0N)](#the-problem-documents-040n)
- [Contract documents](#contract-documents)
- [10-tasks.md](#10-tasksmd)
- [11-testing.md](#11-testingmd)
- [12-decisions-and-risks.md](#12-decisions-and-risksmd)
- [The four repeating units](#the-four-repeating-units)

---

## Sizing the package

Scale to the work, not to a template. A two-week feature does not need twelve documents; a
multi-quarter product built on two existing systems does.

Drop a document when its content would be three lines — fold those lines into a neighbour.
Add one whenever a single hard problem needs more than about 200 lines of explanation, because
that is the point at which it stops being a section and starts being a thing developers will
open on its own.

The files that survive at every size: the index, the PRD, requirements, decisions-and-risks,
and tasks.

---

## README.md — the index

The orientation document. Someone lands here knowing nothing.

- **One paragraph** on what is being built, written for a non-specialist. If it takes more than
  a paragraph, the scope isn't clear yet.
- **Relationship to existing systems** — a table of what each ancestor contributes and what
  role it plays. State plainly if one of them is being superseded.
- **The confirmed decision table** (D1…Dn) with links to the document carrying each one's blast
  radius.
- **How to read this package** — a table of every file and its purpose, with a suggested order.
- **Glossary.** Define the terms the domain assumes and the ones this project invents. Include
  units and their conversion factors. This is the highest-leverage section for anyone new, and
  the one most often skipped.
- **Definition of done for the whole project** — a numbered list a stakeholder can check off.

---

## 00-prd.md — the product document

The only document a non-engineer needs to read. Keep it free of implementation.

- **The problem**, told as the cost of the current situation. Quantify it — hours per week, error
  rate, whatever is real. A problem statement with no number is a preference.
- **What the product is**, in a few sentences.
- **Who it is for** — a table of user types, their context, and what they actually need. Include
  who it is explicitly *not* for.
- **Goals and non-goals.** Non-goals do more work than goals; they are what stops scope drifting.
- **Success metrics** — see the unit below.
- **User journeys** — the two or three real sequences, written as narrative with the user's
  actions and the system's responses. One should be the everyday case; one should be the
  awkward second-time case (re-running, recovering, changing their mind), because that is where
  products usually fail and specs usually go quiet.
- **Scope**, in and out, with deferrals carrying a "revisit when" trigger.
- **Key risks** — the two or three that could change the product, in prose. The full register
  lives in the risks document.
- **Release plan** — milestones with contents and gates.
- **Open questions**, with what each blocks.

### The success metric unit

Every metric needs four things, or it is decoration:

```
| # | Metric | Target | Why this number |
```

The fourth column is the one that matters. "≥ 90%" is arbitrary; "≥ 90%, because below that the
review step costs more than doing it by hand" is a decision someone can argue with. Also state
how it is measured and against what data — and if that data doesn't exist yet, it is a
deliverable with a milestone.

---

## 01-requirements.md

The contract for "done". Everything else references it.

- Group into **FR-n** (functional) and **NFR-n** (non-functional), sub-numbered `FR-3.2`.
- Order groups to follow the user's path through the product, not the system's internals.
- **Non-functional requirements need numbers.** "Fast" is not a requirement. "≤ 4 minutes for 45
  minutes of input on [named reference hardware]" is. Name the hardware or the conditions, or
  the number means nothing.
- Include an **out of scope** section at the end, mirroring the PRD.

### The requirement unit

One testable statement, in the present tense, describing observable behaviour:

> **FR-4.5** If the provider is unreachable, the item still appears in the list with its
> identifying information, flagged as unavailable, and is excluded from the final action by
> default.

Properties worth checking each one against:
- **Testable** — you can imagine the test.
- **Behavioural** — describes what happens, not how it's implemented.
- **Singular** — one requirement, one ID. If it contains "and", consider splitting.
- **Marked if inherited** — cite the source system's requirement so nobody redesigns it.

---

## 02-source-audit.md

Only when building on existing code. This is what turns "we'll reuse X" into an estimate.

Structure it one part per source system, then a final part for what neither provides.

**Per system:**
- One paragraph on what it is and roughly how big.
- **Reusable table**: asset, where it lives, verdict, and why it must survive unchanged.
- **Must change table**: area, what it does today, what the new system needs, impact.
- **Gaps**, each marked *blocking* or *quality*, with the actual evidence — the function name,
  the line, ideally the code. A gap described abstractly gets argued about; a gap shown as five
  lines of code that throw away the data you need does not.
- **Known issues found** — things you are not fixing but the next developer should know.
- **Prior art** — design docs whose research must not be re-derived.

**Final part:** the capabilities neither system provides, each pointing at the document that
specs it. This is the new product, and naming it explicitly stops the audit reading as though
the work is all integration.

Where the change lands in someone else's repository, summarise it as a list of the specific
edits needed, and keep it minimal and additive — you are asking another team to accept a
change, and a small one gets accepted.

---

## 03-architecture.md

- **A diagram.** ASCII is fine and ages better than an image. Show the process boundaries and
  what crosses them.
- **Why this shape** — one paragraph per major structural choice, including what was forced
  (two runtimes that cannot share a process) versus what was chosen.
- **Lifecycle** — who starts what, who owns whose lifetime, what happens on restart.
- **Data flow** for each journey, numbered.
- **Repository layout**, annotated, marking which files come from where.
- **The contracts table** — each interface, who it's between, where it's specified, how it's
  versioned.
- **Concern ownership** — a table of concern → owning component → where it must *not* live. Write
  the third column for the cases where putting it in the wrong place would be tempting and
  plausible.
- **Failure model** — a table of failure → how it's detected → what the user sees. Finish with
  the invariant that holds no matter what fails.

---

## The problem documents (04…0N)

One per genuinely hard problem — the core algorithm, the tricky model, the integration nobody
has done before. These are where a spec earns its keep, and where most specs go vague.

- **Open by explaining why it's hard**, with real examples of the input. Show the messy reality
  before the clean solution; a reader who doesn't believe the problem is hard will not follow
  the solution.
- **Specify the algorithm in stages**, each with its input, output and rules.
- **Use pseudocode with real constants**, not prose. Name the constants and say where they live.
- **State every threshold with its justification** — and if it needs empirical tuning, say so and
  point at the task that tunes it. A threshold presented as settled when it's a guess is worse
  than one marked as a guess.
- **Include a worked example** with real numbers, traced through every stage to the output.
- **Close with what the design deliberately does not do**, and why.

---

## Contract documents

For each interface between components:

- **Transport, authentication and lifecycle** where relevant.
- **Every endpoint or function**: signature, example request, example response.
- **The error taxonomy** — a fixed set of machine-readable codes, plus human-readable messages
  written the way the end user will read them.
- **The payload schema**, annotated. Explain the non-obvious fields — especially any field whose
  absence or unit is easy to get wrong.
- **Versioning policy** and mismatch behaviour.
- **What is deliberately not in this layer**, particularly for a layer you are keeping thin.

---

## 10-tasks.md

Ordered so dependencies come first, grouped by milestone.

Open with how to read it and what the estimate sizes mean. Close with a **dependency graph** in
ASCII and a note on which chains can run in parallel — that is what makes it schedulable across
more than one person.

### The task unit

```
### T-12 · Short imperative title · Est: M
**Goal:** One sentence — what is true afterwards that isn't now.
**Prereqs:** T-10, T-11.
**Steps:** Numbered, referencing the spec section rather than restating it.
**Files:** Paths that will be created or changed.
**Done when:** An observable, checkable condition.
**Gate:** (spikes only) What outcome would stop the plan, and the fallbacks in order.
```

"Done when" is the field that decides whether a task can be picked up by someone who wasn't in
the room. If it restates the goal, it isn't finished — push it until it names something you
could check.

---

## 11-testing.md

- **A layered picture** — cheap and frequent at the top, expensive and rare at the bottom.
- **Per layer: what is tested and what specifically to assert.** Name the actual cases,
  including the ones that will be forgotten.
- **Negative fixtures.** For anything that matches, recognises or classifies, the cases that
  must *not* match are the ones protecting precision, and they are always under-specified. List
  them explicitly.
- **The data set as a deliverable** — if metrics need labelled data, spec its size, coverage,
  labelling protocol and storage, and schedule it early. A corpus written into the final
  milestone is a corpus that never exists.
- **A manual QA script** — numbered steps with expected results, covering setup, the happy path,
  every edit affordance, and each failure mode. Written so someone else can run it.
- **Release gates** — the table of conditions that must all hold to ship.
- **What is not tested, and why.** Honest, and it stops the same gap being raised repeatedly.

---

## 12-decisions-and-risks.md

Three sections: the decision log, the risk register, the open questions. Then a short list of
what is deferred past v1.

Include the internal engineering decisions alongside the confirmed product ones, marked as such.
Six months later nobody remembers which choices were deliberate, and the ones that look
arbitrary are the ones that get undone first.

### The risk unit

```
### R-3 — One-line statement 🔴 High / technical
Two or three sentences on what could go wrong and what it would cost.
- **Mitigation:** what is already designed to reduce it, pointing at the spec section.
- **Action:** what someone must do, and by when.
- **Owner:** who — especially when it isn't engineering.
```

Severity and *type* both matter. A contractual or organisational risk cannot be engineered away;
labelling it as technical is how it ends up with a mitigation that doesn't mitigate anything.

### The open question unit

```
### Q-A — The question 🔴 Blocking [milestone] / 🟡 Non-blocking
What it decides and what depends on it.
**Until answered:** what to do meanwhile.
```

The last line is what keeps an open question from being a stop-work order. Most of them have a
safe interim path — build against the unrestricted alternative, use the conservative default —
and naming it means the project keeps moving while the answer is found.
