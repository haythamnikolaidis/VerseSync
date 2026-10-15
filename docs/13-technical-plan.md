# 13 — Technical Delivery Plan

**This document is the build order.** Documents [03](03-architecture.md)–[09](09-ui-spec.md)
say *what* VerseSync is; this one says *who builds what, in what order, and what unblocks
whom*. It exists to get five or six people working at once without waiting on each other.

Per-task detail lives in **[`tasks/`](tasks/)** — one file per task. [10-tasks.md](10-tasks.md)
is the index.

> **2026-10-15: reworked for autonomous execution.** From Wave 1 on, the backlog is built by an
> autonomous coding agent with a limited token budget, one atomic task per session. §§1–9 below
> still explain the *architecture* of the plan: frozen seams, fakes on the far side, and why
> the spikes gate what they gate. The **wave and staffing tables (§5–§7) describe the original
> multi-person plan.** The order an agent actually follows is the execution queue in
> [10-tasks.md](10-tasks.md). The evaluation that drove the rework, and the rules it introduced,
> are in **[§11](#11-autonomous-agent-execution)**.

---

## 1. The problem this plan solves

VerseSync is three subsystems that meet at three seams:

```
   sidecar (Python)  ──HTTP + Cue Document──►  panel (JS)  ──VS.* over evalScript──►  host (JSX)
```

Built naively, the dependency chain is almost entirely serial: transcription → detection →
resolution → timing → Cue Document → panel → review list → insert. That is roughly eleven
weeks of work by one person standing in a queue.

**The whole plan turns on one observation: nobody actually needs the thing upstream of them —
they need its *contract*.** The panel needs a Cue Document, not a working detector. The review
list needs a `VS.getMediaSegments` *response*, not Premiere. The detector needs a word array,
not CUDA.

So we build the contracts and their fakes first, then everything downstream starts at once.

---

## 2. Strategy: freeze the seams, fake the far side

Three seams, three artifacts, built in **Wave 0** and frozen thereafter:

| Seam | Frozen artifact | Fake for the far side | Unblocks |
|------|-----------------|-----------------------|----------|
| sidecar → panel | Cue Document **JSON Schema** + golden fixtures (**T-37**) | **Mock sidecar** (**T-38**) — serves the real HTTP + SSE contract from static fixtures | The entire panel workstream, on day 1, with no Python |
| panel → host | `VS.*` request/response **fixtures** (**T-39**) | **Host stub** — a browser-loadable `VS` returning canned JSON | Review list, time mapping and setup UI, testable in Chrome with no Premiere |
| audio → detection | **Fixture corpus** — word arrays + hand labels (**T-41**) | The fixtures *are* the fake | Detection, resolution and timing, with no GPU and no transcription |

Consequences worth stating plainly:

- **A JS developer with no Premiere licence and no Python can build the review list** — the
  largest single task in the project (T-29, XL) — starting in week 2.
- **A Python developer with no GPU can build the detector and the timing engine** end to end,
  and unit-test them, because the corpus supplies word arrays directly.
- **The mock sidecar is not throwaway.** It stays in the repo as the panel's test double for
  the life of the project, and **T-42** asserts the real sidecar and the mock satisfy the same
  contract tests — which is what stops them drifting.

---

## 3. Revision to the M1 hard gate

[10-tasks.md](10-tasks.md) originally read: *"Nothing else starts until these three spikes
answer their questions."* **That is now scoped down**, because it serialised about a week of
work for no benefit. What the spikes actually gate:

| Spike | Genuinely gates | Does **not** gate |
|-------|-----------------|-------------------|
| **T-02** word-timestamp accuracy | The *default model choice* in T-07, and the M3 anchor tolerance | Detection, resolution, timing, panel, host — all consume fixture word arrays |
| **T-03** `importMGT` overwrite vs. ripple | **T-25** `VS.insertCues` only | Everything else, including the rest of the host layer |
| **T-04** source→sequence mapping | **T-24** `VS.getMediaSegments` only | `timemap.js` (T-28), which is pure math over a segment list whose *shape* is already fixed in [08](08-premiere-host-api.md) §4 |

The spikes are still **top priority and start in Wave 0** — they carry the two highest
technical risks (R-4, R-5) and each can invalidate a design. But they now block two tasks
instead of thirty. If T-03 comes back "ripple", the fallbacks are pre-costed in
[08](08-premiere-host-api.md) §6.1 and only T-25 is rewritten.

**One gate remains absolute:** T-01 (obtain the real `.mogrt` and a real sermon) blocks all
three spikes, and the spikes block release — a red T-02 result changes what we promise, not
just what we build. Escalate on day 1 if the assets are not in hand.

---

## 4. Workstreams

Eight streams. A stream is a unit of ownership: one person (or pair) owns it end to end, and
cross-stream traffic goes through a frozen contract rather than a conversation.

| # | Workstream | Owner profile | Tasks | ≈ dev-days |
|---|-----------|---------------|-------|-----------|
| **0** | **Foundations** | Tech lead + 1 | T-40, T-37, T-38, T-39, T-41, T-01 | 7 |
| **S** | **Spikes** | Anyone with Premiere + GPU | T-02, T-03, T-04 | 3 |
| **B** | **Sidecar platform** | Python — services | T-05, T-06, T-07, T-08, T-20, T-21 | 5.5 |
| **C** | **Detection** | Python — algorithms, NLP-ish | T-09, T-10, T-11, T-12, T-13 | 6.5 |
| **D** | **Bible text** | Python — integrations | T-14, T-15, T-16 | 2.5 |
| **E** | **Timing** | Python — algorithms | T-17, T-18, T-19 | 4 |
| **F** | **Panel** | JS/CSS — the biggest stream | T-22, T-26, T-27, T-28, T-29, T-30 | 12 |
| **G** | **Host (ExtendScript)** | JS + a Premiere workstation | T-23, T-24, T-25 | 5 |
| **H** | **Quality & release** | Whole team | T-31, T-32, T-33, T-34, T-35, T-36, T-42 | 10 |

**Total ≈ 55–60 dev-days.** Stream F is the longest chain at ~12 days and is therefore the
critical path — which is exactly why Wave 0 spends four days making sure it can start
immediately.

### Stream boundaries (the rule that keeps them independent)

Restating [03](03-architecture.md) §7 as an ownership rule: **a concern lives in one stream.**
If you find yourself needing to change another stream's file to finish your task, stop — either
the contract is wrong (raise it, §8) or the task is in the wrong stream.

---

## 5. Wave plan

Waves, not dates. A wave ends when its exit criteria are met.

### Wave 0 — Foundations · ~4 days · 2–3 people ✅ Complete — 2026-10-11

Everything else waits on this and nothing else does. Keep it short and do not gold-plate it.

- **T-40** repo scaffold, CI, lint, test runners for both languages — done, [PR #2](https://github.com/haythamnikolaidis/VerseSync/pull/2) (bundled with T-01/T-02 closeout)
- **T-37** Cue Document JSON Schema + golden fixtures — done, [PR #3](https://github.com/haythamnikolaidis/VerseSync/pull/3)
- **T-38** mock sidecar — done, [PR #4](https://github.com/haythamnikolaidis/VerseSync/pull/4)
- **T-39** host stub + `VS.*` fixtures — done, [PR #5](https://github.com/haythamnikolaidis/VerseSync/pull/5)
- **T-41** fixture corpus bootstrap (word arrays + hand labels) — done, [PR #6](https://github.com/haythamnikolaidis/VerseSync/pull/6)
- **T-01** obtain reference assets — done, see `spikes/README.md`
- **T-02 / T-03 / T-04** spikes — done; **T-02's gate tripped** and was resolved as **D19**
  ([12](12-decisions-and-risks.md)): accept a lower auto-detection rate on pure paraphrases

**Exit criteria:** `npm test` and `pytest` both run green on an empty suite in CI ✅ · the mock
sidecar serves a golden Cue Document over HTTP + SSE and passes schema validation ✅ · the host
stub loads in a browser and answers all eight `VS.*` calls — **met with two corrections**: the
spec defines **seven** `VS.*` calls, not eight (T-39's task text was wrong), and "in a browser"
specifically is unverified since `panel/index.html` doesn't exist until T-22 — verified
behaviourally instead (31 passing `node:test` cases); re-check that specific sub-clause once
T-22 lands · at least three fixture transcripts with hand-labelled reference times are
committed ✅ (four, via T-41).

Also fixed in passing: the `timebase` example in [08](08-premiere-host-api.md) §3 and
[05](05-timing-and-placement.md) §9 was off by 1000x (`8475667` → `8475667200`), caught while
building T-39's frame-rate fixtures and confirmed live against real Premiere sequences — see
[12](12-decisions-and-risks.md)'s Errata section.

**Outstanding, not a blocker:** the "End of Wave 0" integration checkpoint in §8 below
("every stream confirms its fakes are sufficient to start") is a team conversation, not a
task — hold it before Wave 1 work actually starts if it hasn't happened yet.

### Wave 1 — Parallel build · ~2.5 weeks · everyone

Six streams run concurrently. **No stream in this wave depends on another stream in this wave.**

| Stream | Runs | Against |
|--------|------|---------|
| B | T-05 → T-06 → T-07 → T-08 | real audio (needs T-02's model recommendation for defaults only) |
| C | T-09 → T-10 / T-11 → T-12 → T-13 | fixture corpus (T-41) |
| D | T-14 → T-15 → T-16 | public-domain translation only (Q-A unresolved) |
| E | T-17 → T-18 → T-19 | fixture corpus + T-14 passages |
| F | T-22 → T-26 → T-27 → T-28 → **T-29** | mock sidecar (T-38) + host stub (T-39) |
| G | T-23 → T-24 → T-25 | real Premiere; T-24/T-25 wait on their spike |

**Exit criteria:** every stream's unit tests green · T-29 review list demoable in a browser
against the mock sidecar · `VS.insertCues` places 20 cues at 20 absolute times on a real
timeline.

### Wave 2 — Integration · ~1 week · pairs across streams

The seams get exercised for the first time. Expect this to find contract bugs; that is its job.

- **T-20** job orchestration + SSE (joins B, C, D, E into one pipeline)
- **T-21** CLI, with the CLI/HTTP parity test
- **T-42** contract tests — run the same suite against the real sidecar *and* the mock
- **T-30** insert orchestration (joins F and G)
- Swap the panel from the mock sidecar to the real one; swap the host stub for the real host

**Exit criteria:** **Journey A completes end to end on a real sermon on a real workstation.**

### Milestone naming

Earlier documents refer to milestones **M1–M5** (spikes, headless pipeline, panel and host,
re-run and resilience, hardening). Those map onto the waves as: M1 → Wave 0 · M2/M3 → Wave 1 ·
integration → Wave 2 · M4/M5 → Wave 3. Where a document says *"needed before M2 completes"*,
read *"before Wave 1 completes"*.

Note the collision: **M1–M3 are also the names of the accuracy metrics** in
[00-prd.md §5](00-prd.md). In this document and in the task files, M1/M2/M3 always mean the
**metrics** (recall, precision, anchor accuracy).

### Wave 3 — Hardening · ~2 weeks

- **T-31** Journey B (re-run after a recut) · **T-32** error surface pass
- **T-33** accuracy harness → **T-34** threshold tuning *(the long pole; T-33 can start in
  Wave 2 as soon as T-21 lands)*
- **T-35** performance pass · **T-36** install + documentation

**Exit criteria:** the release gates in [11](11-testing.md) §7 (M1–M3 are no longer gated;
see D24), NFR-2 measured on the reference workstation, and the Definition of Done in
[README.md](README.md).

---

## 6. Dependency graph (revised)

Solid arrows are hard dependencies. Everything not connected can run at the same time.

```
WAVE 0 ───────────────────────────────────────────────────────────────────────
  T-40 ─┬─► T-37 ─┬─► T-38 ─────────────────────────────► stream F
        │         └─► (schema) ──────────────────────────► T-19, T-42
        ├─► T-39 ─────────────────────────────────────────► stream F
        └─► T-41 ─────────────────────────────────────────► streams C, E, H

  T-01 ─┬─► T-02 ····(defaults only)···► T-07
        ├─► T-03 ═══(hard gate)════════► T-25
        └─► T-04 ═══(hard gate)════════► T-24

WAVE 1 ───────────────────────────────────────────────────────────────────────
  B:  T-05 ──► T-07 ──► T-08          (T-06 upstream PR, parallel)
  C:  T-09 ─┬► T-10 ─┬► T-12 ──► T-13
            └► T-11 ─┘
  D:  T-14 ──► T-15 ──► T-16
  E:  T-17 ──► T-18 ──► T-19          (T-17 needs T-12 output shape + T-14)
  F:  T-22 ─┬► T-26 ──► T-27 ─┬► T-29
            └► T-28 ──────────┘
  G:  T-23 ─┬► T-24
            └► T-25

WAVE 2 ───────────────────────────────────────────────────────────────────────
  T-08,13,16,19 ──► T-20 ──► T-21 ──► T-42
  T-25, T-29 ─────► T-30

WAVE 3 ───────────────────────────────────────────────────────────────────────
  T-30 ──► T-31 ──► T-32
  T-21 ──► T-33 ──► T-34 ──► T-35 ──► T-36
```

**Critical path:** `T-40 → T-39 → T-22 → T-28 → T-29 → T-30 → T-31` (stream F, ~15 days), with
`T-21 → T-33 → T-34` (tuning) as the second-longest. Protect stream F's start date above
everything else — a day lost in Wave 0 is a day lost on the release.

---

## 7. Staffing

| Team size | How to split | Wall clock |
|-----------|-------------|------------|
| **6** | 0+S lead · B · C+D · E · F · G | ~6 weeks |
| **4** *(recommended)* | lead: 0, S, G, H · py1: B+D · py2: C+E · js1: F | ~8 weeks |
| **2** | py: 0, B, C, D, E · js: F, G — spikes shared | ~14 weeks |
| **1** | Follow the wave order; skip T-38/T-39 (fake nothing, build in dependency order) | ~11 weeks |

Below four people the mocks stop paying for themselves — build in plain dependency order and
skip T-38/T-39. **Note the asymmetry:** stream F is 12 days and stream D is 2.5. Whoever takes
F should take nothing else.

**Skills genuinely required:** one person comfortable in ExtendScript/ES3 (streams G and parts
of F) and one comfortable with alignment/scoring algorithms (streams C and E). Everything else
is ordinary Python and vanilla-JS work — the panel deliberately uses no framework, matching
VerseFlow.

---

## 8. Working agreements

### Definition of Ready
A task is ready when its file in [`tasks/`](tasks/) has: prereqs merged, spec sections linked,
and "Done when" criteria that someone else could verify without asking the author.

### Definition of Done
1. "Done when" checklist fully ticked.
2. Tests written at the level the task file specifies ([11](11-testing.md) §1–2).
3. CI green.
4. Any constant that was *tuned* rather than *specified* carries a comment citing the
   measurement that chose it. Since D24 there's no tuning in v1, so a constant **copied from the
   spec** cites its spec section instead.
5. If the change touched a contract, §8's protocol was followed.

### Branching
One branch per task, named `task/T-NN-short-slug`. One PR per task. PR title starts with the
task ID. Do not batch tasks into a branch — it destroys the parallelism the plan is built on.

### Contract change protocol
The three frozen contracts ([03](03-architecture.md) §6) are what let streams run blind to each
other. Changing one mid-flight is allowed but never quiet:

1. Raise it before writing code — a contract change can invalidate another stream's finished work.
2. Bump the version (`api_version`, `schema_version`, or `hostApi`).
3. **Update the spec doc, the JSON Schema, the golden fixtures, and the mock — in one PR.** A
   contract change that lands without its fixtures silently breaks the stream that trusted it.
4. Announce it to every stream that consumes the contract.

### Code conventions
- **Host (`.jsx`)** — [08](08-premiere-host-api.md) §1 is non-negotiable: one file, ES3,
  `var fn = function(){}`, ASCII only, JSON strings both ways, never throw across the bridge.
- **Panel (`.js`)** — vanilla ES5-compatible JS, no framework, no build step. Matches VerseFlow
  so the two stay mutually readable.
- **Sidecar (`.py`)** — type hints on public functions, no Qt imports anywhere, no Premiere
  concepts (no ticks, no frames, no sequences — see [03](03-architecture.md) §7).

### Integration checkpoints
Three scheduled moments where streams must actually talk. Everything else is async.

| When | Checkpoint | Who |
|------|-----------|-----|
| End of Wave 0 | Contracts frozen; every stream confirms its fakes are sufficient to start | All |
| Mid Wave 1 | Detection output shape (T-12) reviewed by stream E before T-17 hardens against it | C + E |
| Start of Wave 2 | Mock-to-real swap: panel points at the real sidecar, host stub swapped out | F + B + G |

---

## 9. What can go wrong, and what it costs

Beyond the risk register in [12](12-decisions-and-risks.md), these are the risks *to the
schedule* specifically:

| Risk | Impact on the plan | Mitigation |
|------|-------------------|------------|
| **T-01 assets late** | Blocks all three spikes; T-24/T-25 slip; release gate slips | Chase on day 1. Streams B–F are unaffected — they run on fixtures. |
| **T-03 returns "ripple"** | T-25 is rewritten against a fallback; +2–4 days | Fallbacks pre-costed ([08](08-premiere-host-api.md) §6.1). Only T-25 changes. |
| **T-02 p90 > 0.5 s** | The product promise changes, not the code | Widen tolerance + increase lead-in (both config values), or add forced alignment over the read span only. Decide with the client, not in code. |
| **Q-A (licensing) unresolved** | T-15 cannot be finished for the real translations | Everything builds and tests against public domain (D16). Only T-15's final verification waits. Not on the critical path. |
| **T-29 underestimated** | Directly extends the release — it is the critical path | Demo it against the mock in Wave 1, weekly. It is the one task where slippage is visible early and cheaply. |
| **Contract drift between mock and real** | Wave 2 integration turns into a rewrite | **T-42** runs one contract suite against both. Non-negotiable, and it lands in Wave 2, not later. |

---

## 10. Where to start

1. Read [README.md](README.md), then [00-prd.md](00-prd.md), then [03-architecture.md](03-architecture.md).
2. Read your stream's spec document (the table in §4 tells you which).
3. Pick your task file from [`tasks/`](tasks/) and read it — it is self-contained by design.
4. If a task file leaves you guessing, that is a bug in the task file. Fix it in your PR.

---

## 11. Autonomous-agent execution

### 11.1 Evaluation: why the Wave 1+ backlog wasn't agent-buildable

The specification is strong: precise algorithms, frozen contracts, real spike evidence. The
*backlog*, though, was written for a team of humans who share context, own a stream for weeks,
and can walk over to a Premiere workstation. Measured against an agent that starts every session
cold, in a Linux container, with a limited token budget, it had nine structural problems.

| # | Finding | Effect on an autonomous agent | Fix in this rework |
|---|---------|------------------------------|--------------------|
| **E1** | **Tasks are too big.** Six tasks were sized L or XL, T-29 alone was "~1 week", and most M tasks bundled 6–10 steps across several files. | A task can't be finished in one session, and a partial task leaves no recoverable state. | Every remaining task is split into **XS/S subtasks** (≤ ~300 changed lines, one module, ≤ 4 files), each with **Steps** that are individually committable. 33 open tasks became 99 agent subtasks and 11 human ones. |
| **E2** | **No recovery protocol.** The containers are ephemeral, and nothing said how a new session discovers half-finished work. | Lost work, duplicated work, or a confused restart that burns budget re-deriving state. | [AGENT.md §3](tasks/AGENT.md): push after every Step, commit subjects of the form `T-NN.k [i/n]`, a handoff note in every commit body, and `tools/plan.py next`, which reports START or RESUME from the remote branches. |
| **E3** | **Human-only work mixed into buildable tasks.** "Done when" items like *"loads in Premiere"*, *"45-minute file on GPU"*, *"clean Windows machine"* or *"real API key"* sat inside otherwise automatable tasks. | The agent could never mark those tasks done, or would be tempted to claim checks it can't run. | Each one is split into an **agent** task (automated evidence) and a **`.H` human** task (real-hardware verification). Human tasks never block agent tasks. The one exception, T-34's corpus **Gate**, went away when D24 deferred T-34. |
| **E4** | **The host layer was declared untestable** ([11 §5](11-testing.md)). | Six host tasks with no automated verification at all. | **T-45** builds a fake Premiere DOM that reproduces the *measured* spike behaviour, and `VerseSync.jsx` runs in Node under `vm`. T-30.2 even runs a panel-and-host integration test on it. |
| **E5** | **Cross-repo dependencies on private code.** About a dozen tasks say "port VerseFlow's X verbatim", but VerseFlow lives in another repo. | The agent either guesses at the ported code or spends budget on cross-repo exploration in every session. | **T-43 / T-44** vendor the exact files into `reference/` once, at a recorded SHA. |
| **E6** | **Seams within streams left open.** For example, the C→E output shape was to be "agreed in a mid-wave meeting", and the pipeline function that the service and CLI share was unnamed. | Each agent session invents a slightly different interface, and integration fails later. | Cards carry **Interface** blocks: `Word`, `Reference`, `Token`, `BookMatch`, `Candidate`, `Detection`, `Passage`, `Alignment`, `Timing`, `run_pipeline`, and the JS module APIs. The meeting is replaced by the card. |
| **E7** | **Spec gaps an agent would hit and have to stop on:** no owner for resolution (truncation, error→flag mapping, `provider_partial`); no way to fetch `words_ref`; open risk R-13 (the wrong sequence); no CORS story for a `file://` panel calling the sidecar with an `Authorization` header. | A blocked task, or worse, an improvised contract change. | New **T-48** (resolver). **D20 / T-47** (sequence identity). **D21** (Node `http` transport). **D22 / T-50** (transcript endpoint). **D23** (KJV verse counts). All are recorded in [12](12-decisions-and-risks.md). |
| **E8** | **Contradictions between documents.** T-07 said "not distil" while T-02 recommends distil. The launch command `versesync.sidecar` didn't match the documented `__main__.py` location. Test paths like `tests/js/test_*.js` are never run by `npm test`. T-11's tier name "curated" doesn't match the schema enum `alias`. | The agent wastes budget reconciling them, or silently picks the wrong one. | Each one is resolved and listed in [12 Errata](12-decisions-and-risks.md). Conventions are fixed in [AGENT.md §6](tasks/AGENT.md). |
| **E9** | **Read cost.** Cards said "read 04 §4" and "read VerseFlow's research doc". The package is about 3,800 lines. | A large share of each session spent reading. | Every card lists exactly what to **Read** and which files it **Touches**. [AGENT.md §2](tasks/AGENT.md) sets reading discipline, and T-46 adds a SessionStart hook and `tools/verify.sh`, so setup costs no tokens. |

### 11.2 Rules the rework introduces

1. **The atomicity bar.** An agent task touches one module, at most ~300 changed lines
   including tests, and at most 4 files. It has a single Verify command and is finished within
   one session with margin to spare. Every Step leaves CI green.
2. **Automated evidence only.** An agent task's "Done when" must be provable in the container.
   Anything else becomes a `.H` task.
3. **Interfaces are decided in cards.** Changing one means editing the card first, in its own
   PR, before writing code.
4. **Contracts move only through Contract tasks** (T-47 and T-50 are the pattern). An agent
   that finds a contract conflict marks its task **blocked** and doesn't improvise
   ([AGENT.md §4](tasks/AGENT.md)).
5. **The plan is machine-checked.** `tools/plan.py validate` (run in CI by `tests/test_plan.py`)
   checks that IDs are unique, prereqs exist, there are no cycles, and the queue order respects
   every prereq.

### 11.3 Execution order

The phases in [10-tasks.md](10-tasks.md) put the **pure Python pipeline first** (phase 1). It
depends on nothing but fixtures, it carries the most algorithmic risk, and it ends with
`run_pipeline()`, which gives an offline CLI and golden files early. The sidecar service comes
next (phase 2), then the host on the fake DOM (phase 3), then the panel (phase 4). The panel
isn't the critical path any more: with one agent working serially, the order affects risk and
how early there's something to demo, not the total time. With more than one agent, the queue's
phase boundaries are the natural split. Phases 1–2 and phases 3–4 share no files.

### 11.4 What still needs a human

Eleven `.H` tasks ([10-tasks.md](10-tasks.md#human-tasks)), plus **Q-A** (licensing, inside
T-15.H) and the merge policy line in [AGENT.md §7](tasks/AGENT.md). None of these block agent
progress until release.

### 11.5 Rescope: no corpus, no tuning in v1 (D24, 2026-10-15)

Because of stakeholder schedule pressure and the lack of annotator capacity, the labelled
corpus (T-33.H), the accuracy harness (T-33.2) and threshold tuning (T-34) are **deferred**.
That removes the largest human workload from the plan and the only agent task that was waiting
on a human (the old T-34 **Gate**). Spec defaults ship as specified, and M1–M3 become targets
rather than release gates.

The accepted risk is that **detection accuracy, paraphrased scripture especially, is unmeasured
at release.** That's acceptable because nothing reaches the timeline without passing the
review list (D4), and a miss costs one manual add. What remains as cheap evidence:

- fixture checks (T-12.4, T-17.3);
- golden files (T-33.1), so any change in detection output shows up as a reviewable diff;
- a five-count spot-check during the real Journey A run (T-30.H).

`plan.py` enforces the rescope: `deferred` tasks are never offered, and no active task may
depend on one.
