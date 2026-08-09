# 12 — Decisions, Risks and Open Questions

---

## Decision log

Decisions **D1–D4** were confirmed by the client on 2026-08-09. The rest are internal
engineering choices recorded here so they can be revisited deliberately rather than
rediscovered.

| ID | Decision | Choice | Rationale | Reversal cost |
|----|----------|--------|-----------|---------------|
| **D1** | Verse text source | **Online Bible API**, provider-adapter abstraction, local cache | Always-current text, no manual preparation per sermon, broad translation catalogue | **Low technically, high contractually** — the adapter makes swapping providers a day's work, but licensing is the real constraint (risk R-1) |
| **D2** | Product shape | **One CEP panel + a local Python sidecar** on loopback HTTP | Python/CUDA and Chromium/ExtendScript cannot share a process; HTTP survives panel reloads, streams progress, and keeps the sidecar independently testable | Medium — swapping to a spawned-CLI model touches `sidecar.js` and `server.py` only |
| **D3** | Audio input and time mapping | **Editor selects the source media file**; source→sequence mapping by walking track items | Correct across cuts and trims, no export wait, no dependency on Adobe Media Encoder | Low — the sequence-export alternative is additive and could be offered as a second mode |
| **D4** | Human confirmation | **Review list, then one-click insert** | ASR errors are certain; converting a detection error from a published mistake into a checkbox is what makes the automation trustworthy (goal G3) | Low — a "skip review" toggle is trivial to add if the editor ever wants it |
| D5 | Where detection, resolution and timing live | **Sidecar (Python)** | Pure computation; testable without Adobe; insulated from the ExtendScript deprecation clock | High — moving it into the panel would lose the CLI, the harness and most of the test suite |
| D6 | Where source→sequence mapping lives | **Panel** | Only Premiere knows the edit. Keeping it panel-side is what makes Journey B a pure recomputation from an unchanged Cue Document | Low |
| D7 | Detection method | **Deterministic grammar + canon validation**, no LLM | Reproducible, instant, offline, auditable; keeps sermon transcripts on the machine | Low — an LLM pass could be added as a recall booster behind a flag |
| D8 | Anchor definition | **Earlier of mention start and read-span start, minus lead-in** | Directly implements the product promise; both orderings occur constantly in real preaching | Low — one function |
| D9 | Default lead-in | **0.5 s** | Covers a typical lower-third animate-in so the graphic is settled as the words land | Trivial — a config value |
| D10 | READ duration model | **Read span + tail pad**, capped at 45 s | The improvement VerseSync can make over VerseFlow; a 38-second reading deserves a 39-second graphic | Low |
| D11 | PARAPHRASE duration model | **VerseFlow's constants verbatim** (160 wpm, +1.5 s, 3–20 s) | Client-approved; the same graphic should behave identically when nothing better is known | Trivial |
| D12 | Chapter-only references | **Flagged and disabled**, not auto-expanded | VerseSync does not know which verse was meant; guessing is worse than asking | Low — the P2 alignment enhancement is specified |
| D13 | Overlap handling | **Truncate the earlier cue**, flag when truncation would go below 2 s | Usually right and invisible; the ambiguous case is genuinely the editor's call | Low |
| D14 | Alternate-track spillover | **Not in v1** | Silently changing the layered look of an edit is the media lead's decision, not the tool's | Low — additive |
| D15 | Host layer file structure | **One `.jsx` file, no `#include`** | VerseFlow found `#include` path resolution unreliable in Premiere 2026 | Trivial |
| D16 | Build `local.py` in v1 despite D1 | **Yes** | About a day of work against the project's largest risk, and it doubles as the offline test fixture | n/a |
| D17 | Transcript caching key | **Content hash** (first 8 MB + last 8 MB + size) | Full-hashing a 4 GB MXF every run is unacceptable; this composite distinguishes edits of the same recording | Low |
| D18 | Curation off for VerseSync jobs | **Yes** | `curate_text` rewrites the transcript after the fact, breaking the word-to-text correspondence every timestamp depends on | Trivial |

---

## Risk register

### R-1 — The needed translations may not be licensable 🔴 High / contractual

**The largest risk in the project, and it is not an engineering problem.** D1 puts verse text
behind a Bible API. VerseFlow's sample data uses **NKJV** and **TPT**. NKJV requires publisher
permission on API.Bible; TPT's API distribution is much narrower and must be verified before it
is promised. A late "no" would strand the product's core data source.

- **Mitigation:** the provider-adapter interface ([06](06-bible-text-service.md) §3) makes a
  provider swap a day's work; `local.py` is built in v1 (D16) so a licensed local text can be
  substituted without a redesign; all development and testing runs against a public-domain
  translation so nothing is blocked while licensing resolves.
- **Action:** open question **Q-A**, needed before M2 completes. **Do not build against NKJV or
  TPT until access is confirmed in writing.**
- **Owner:** product, not engineering.

### R-2 — Detection quality on real sermon audio 🔴 High / technical

Every headline metric depends on Whisper hearing "Philippians" rather than "Philippines", and
on the grammar covering how preachers actually speak. Recall and precision are the product.

- **Mitigation:** decoder biasing with book names ([04](04-reference-detection.md) §2); the
  three-tier book matcher with the number-follows gate; canon validation, which removes a large
  share of false positives at no cost; and structurally, **D4's review list**, which converts a
  detection error into a checkbox rather than a published mistake.
- **Action:** the corpus ([11](11-testing.md) §3) is a **deliverable built during M2**, not an
  M5 afterthought. T-33/T-34 tune against it and the metrics gate the release.

### R-3 — ExtendScript end-of-support (~September 2026) 🔴 High / strategic *(inherited)*

Adobe supports ExtendScript integrations only through approximately September 2026. A CEP build
works now but will eventually break on a new Premiere version. VerseFlow's risk R1, inherited
whole.

- **Mitigation:** everything touching Premiere sits behind the `VS.*` contract
  ([08](08-premiere-host-api.md)) and is deliberately kept minimal — no time math, no scripture
  knowledge, no persistence. **VerseSync's actual value lives in the sidecar and survives any
  Premiere-side re-platform**, which is a materially better position than VerseFlow was in.
- **Watch item:** re-test UXP's MOGRT text read/write each Premiere release.

### R-4 — `importMGT` may ripple rather than overwrite 🟠 Medium–High / technical

VerseFlow only ever placed contiguously from the playhead and inserted its discovery scratch
clip past the end of the sequence, so this was never exercised. VerseSync places into the middle
of a populated timeline. If `importMGT` inserts-and-ripples, every insert shifts the edit.

- **Mitigation:** **spike T-03 is the M1 hard gate.** Fallbacks are pre-costed in
  [08](08-premiere-host-api.md) §6.1 — require an empty track, insert descending, or fall back
  to VerseFlow's Option B (pre-render + `overwriteClip`, which has unambiguous semantics and is
  already fully investigated in VerseFlow's `11-alternative-approaches.md`).

### R-5 — Word-timestamp accuracy may not support ±0.5 s 🟠 Medium–High / technical

M3 targets 90% of anchors within half a second. Faster-Whisper's word timestamps come from
cross-attention alignment, whose accuracy varies by model — and the current default in
`config.yaml` is a **distil** model whose alignment quality for this purpose is unverified.

- **Mitigation:** **spike T-02** measures the error distribution across models before anything
  is built on it; `word_timestamp_quality` metadata lets the panel warn about a poor model
  choice; VAD reduces drift through silence.
- **Fallback if p90 exceeds 0.5 s:** widen the tolerance and increase the lead-in (a graphic
  that arrives slightly early reads as intentional; one that arrives late reads as broken), or
  add a forced-alignment pass over the reference span only.

### R-6 — Source→sequence mapping does not cover real edits 🟡 Medium / technical

Speed changes, merged clips, multicam and nested sequences all threaten the linear mapping in
[05](05-timing-and-placement.md) §5, and `getMediaPath()` behaviour on them is unverified.

- **Mitigation:** **spike T-04** characterises each case; whatever does not resolve is reported
  in `unsupported` and flagged per cue rather than silently mis-mapped; the manual-offset
  fallback covers the single-recording case.
- **Accepted:** v1 does not support speed-changed segments. Documented, flagged, disabled.

### R-7 — MOGRT text write on the real template 🟡 Medium / technical *(inherited)*

VerseFlow's risk R2. The `textEditValue` + `fontTextRunLength` write and the properties
iteration surface vary across Premiere versions.

- **Mitigation:** VerseFlow has working code for this on Premiere 2026 with
  `AV_Quote_04.mogrt`, ported unchanged. T-01 re-verifies the baseline before anything is built
  on it. Substantially de-risked relative to VerseFlow's position.

### R-8 — Duplicate field display names 🟡 Low / technical *(inherited)*

`AV_Quote_04.mogrt` exposes two editable text fields both named `Text`.
`getParamForDisplayName` is ambiguous and would silently target the wrong one.

- **Mitigation:** index-based targeting throughout, group-qualified labels in the UI. Inherited
  from VerseFlow, already solved, must not be "simplified" away.

### R-9 — Sidecar lifecycle friction 🟡 Medium / operational

D2 introduces a second process for a non-technical user. If it fails to start, or a Python
environment breaks, the editor is stuck with a tool that used to be a folder copy.

- **Mitigation:** the panel owns the full lifecycle including launch; every failure state has a
  specified message and a log path ([09](09-ui-spec.md) §2); **the insert path keeps working
  with the sidecar down**, so a saved review can always be placed; the installer follows
  Faster-Whisper-Transcriber's proven pinned-wheel pattern.

### R-10 — Long-audio transcription cost 🟡 Low–Medium / performance

A 45-minute sermon is a much heavier workload than the dictation clips the transcriber was
built for. CPU-only machines may take longer than the sermon itself.

- **Mitigation:** batched inference, VAD, and the transcript cache so the cost is paid once per
  media file. The panel warns before starting a CPU run over 10 minutes of audio. NFR-2 is
  measured on the reference GPU workstation and stated as such.

### R-11 — Tick precision on long timelines 🟢 Low / technical *(inherited)*

Ticks are large; timelines beyond ~2.5 hours exceed `Number.MAX_SAFE_INTEGER` and plain
arithmetic loses precision. VerseFlow's risk R4.

- **Mitigation:** centralise tick math in `timemap.js` and the host's helpers so it can be
  upgraded to string arithmetic. A 45-minute sermon is comfortably inside the safe range, but
  VerseSync computes far more tick values than VerseFlow did.

### R-12 — Sermon audio privacy 🟢 Low / trust

Sermon audio may be pastorally sensitive. Editors should not have to wonder where it goes.

- **Mitigation:** transcription is entirely local. The **only** outbound traffic is verse
  *references* to the Bible provider — never audio, never transcript text. Stated in the README
  and enforced by the architecture (NFR-4).

---

## Open questions

### Q-A — Which translations, from which provider? 🔴 Blocking M2 completion

Drives risk R-1 and the whole of [06](06-bible-text-service.md). Needs:

1. The definitive list of translations that must appear on screen.
2. Confirmed, written access to each from a chosen provider — or a decision to use C2 (local
   store with text the church already licenses) or C3 (public domain).
3. The exact attribution string and caching terms per translation.

**Until answered:** build and test against a public-domain translation; nothing else is blocked.

### Q-B — Project-default translation, or honour a spoken one? 🟡 Non-blocking

v1 fixes the translation per project (FR-1.5). Preachers do sometimes switch mid-sermon ("…the
Passion Translation puts it this way…"). Detecting that and resolving that cue differently is
specified as a P2 enhancement ([06](06-bible-text-service.md) §7) and gated on more than one
translation being licensed — so it loops back to Q-A. **Confirm the v1 shape is right.**

### Q-C — Should a chapter-only reference ever insert automatically? 🟡 Non-blocking

D12 flags and disables them. The P2 enhancement ([05](05-timing-and-placement.md) §6) could
resolve them by aligning the whole chapter against the transcript and using the verses actually
read. Worth building if chapter-only references turn out to be common in the corpus —
**a question the corpus answers**, so it resolves itself during M2.

### Q-D — Where does the sermon's audio actually live in the edit? 🟡 Non-blocking

D3 assumes the editor can point at one media file that contains the sermon audio. If the real
workflow uses a separate audio recorder synced to camera, or a multicam clip, T-04 will say
whether that resolves. **Ask the editor to describe their actual ingest before T-04**, so the
spike tests the right cases.

### Q-E — Confidence threshold for the amber flag 🟢 Resolves during tuning

Specified at 0.55, chosen to be tuned (T-34). Not a decision anyone needs to make in advance —
the corpus decides it.

---

## Deferred to post-v1

- Allusion detection with no spoken reference (needs semantic search; high false-positive risk).
- Automatic chapter-only passage resolution (specified, P2).
- Spoken translation override (specified, P2, gated on Q-A).
- Multiple MOGRT templates in one run.
- Alternate-track spillover for overlapping cues.
- Speaker diarisation.
- Sequence-audio export as an alternative to D3's file selection.
- macOS support.
- UXP re-platform (tracked by R-3).
