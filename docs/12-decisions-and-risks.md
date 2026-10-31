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
| D19 | T-02 gate response (p90 > 0.5s, tripped) | **Accept a lower auto-detection rate on pure paraphrases** — no tolerance widening, no forced-alignment pass | `spikes/word_timestamps/RESULTS.md` §4.3 found ~31% of real mentions are narrative paraphrases with zero lexical overlap with the verse text — no ASR-side fix reaches them. The review list (D4) is the backstop. | Low — a forced-alignment pass or wider tolerance can still be added later without touching this decision |
| D20 | Sequence identity across panel calls (R-13) | **`VS.getSequenceInfo` returns `sequenceId`; `getMediaSegments`, `validateTrack` and `insertCues` require it, and refuse if the active sequence differs.** The host never switches sequences itself. | `activeSequence` follows UI focus between `evalScript` calls (T-04), so without this an Insert can silently land in the wrong sequence. Abort-and-explain is the conservative behaviour. | Low. Contract change in **T-47** (host API 1.1). `sequenceID` stability is verified on real Premiere in **T-25.H**. |
| D21 | Panel → sidecar transport | **Node's `http` module** (CEP `--enable-nodejs --mixed-context`), with an explicit `Origin: cep://com.versesync.panel` header. Not XHR or EventSource. | A `file://` CEP page sending `Authorization` triggers a CORS preflight, which neither the mock nor the spec handles. The launch needs `child_process` anyway, and the same transport runs unchanged in Node tests. A browser page can't forge `Origin`, so the allowlist still protects the sidecar. | Low. Confined to `sidecar.js`'s transport. Verified in **T-22.H**. |
| D22 | How the panel gets `transcript.words_ref` | **`GET /jobs/{id}/transcript`** for job results. For a document on disk, resolve it as a sibling file relative to the document. *Save cue document* writes the sibling too. | 07 §5.1 said the panel "fetches" the sibling but defined no endpoint or resolution rule, which left the expanded row's transcript context unbuildable. | Low. Additive endpoint, API stays 1.0. Implemented by **T-50**. |
| D23 | Verse-count authority for the canon table | **KJV**, derived from the bundled public-domain text (T-09.1). | One source for both canon validation (T-13) and the local provider (T-14) means a verse can never be rejected by one and served by the other. | Low. Regenerate `canon.json` from a different text. |
| D24 | Accuracy measurement and threshold tuning | **Deferred past v1.** No labelled corpus beyond T-41's bootstrap fixtures, no accuracy harness, no tuning pass (T-33.2, T-33.H and T-34 are deferred). Spec-default constants ship as specified. M1–M3 are targets, not release gates. T-33.1 golden files stay, as the regression guard. | Stakeholder schedule pressure, and no annotator capacity. The largest known accuracy gap is narrative paraphrase with no lexical overlap, about 31% of mentions in T-02 (D19). No amount of tuning reaches it; the review list (D4) and manual add are the backstop. **Accepted risk:** v1 ships with recall, precision and anchor accuracy unmeasured. | Low technically: the constants are named, the CLI and golden files exist, and reinstating the deferred tasks needs no redesign. The cost is the annotation effort itself. |
| D25 | One-Ctrl+Z batch undo (FR-7.4, G5) | **Not delivered in v1.** Premiere 26.5 has no `app.beginUndoGroup`/`endUndoGroup` (`typeof` is `undefined`, T-25.H), so an insert is N separate undo steps. The host keeps its try-wrapped calls, which are no-ops there. We ship with N presses of Ctrl+Z and decide the fix from user feedback. | The API the design relied on does not exist in the target Premiere. The candidate fixes (a panel-side *Undo last insert* that removes the clips from the insert result, or a UXP re-platform, R-3) are real scope, and users may find N presses acceptable. **Accepted risk:** G5 "one Ctrl+Z" is not met. | Low to defer. The insert result already returns every placed clip's id, so *Undo last insert* can be added later without a contract change. |

---

## Errata

- **Default transcription model.** The original T-07 card said the default should be
  `large-v3-turbo`, "**not** distil". T-02 measured otherwise and recommended
  `distil-large-v3` (`spikes/word_timestamps/RESULTS.md` §1, §5), and the R-5 entry below
  already followed the spike. **The spike wins.** The reworked T-07 card uses `distil-large-v3`,
  which stays configurable.
- **Entry points.** [03 §5](03-architecture.md) put `__main__.py` at `versesync/`, which gives
  `python -m versesync`, while the panel and 07 launch `python -m versesync.sidecar`. Settled:
  `sidecar/versesync/sidecar.py` is the entry point and `__main__.py` delegates to it. Likewise,
  `python -m versesync.cli` is `sidecar/versesync/cli.py`, and `cli/versesync_cli.py` is a shim.
  See [tasks/AGENT.md §6](tasks/AGENT.md).
- **Panel test paths.** The original T-26 to T-29 cards named tests like `tests/js/test_sidecar.js`,
  which `npm test`'s `tests/**/*.test.js` glob never runs. Settled: `tests/panel/<module>.test.js`.
- **Book-match tier names.** The T-11 card called tier 2 "curated", but the schema's
  `book_match.tier` enum is `exact | alias | fuzzy`. Tier 2 is `alias`.

- **`timebase` example was off by 1000x.** [08](08-premiere-host-api.md) §3 and
  [05](05-timing-and-placement.md) §9's worked example gave `8475667` as the 29.97fps
  `sequence.timebase` value. Caught during **T-39** while deriving the 23.976/25fps host-stub
  fixtures from `TICKS_PER_SECOND = 254016000000`: the arithmetic gives `8475667200`, not
  `8475667`. All three values (`29.97 → 8475667200`, `23.976 → 10594584000`,
  `25 → 10160640000`) were then confirmed live against real Premiere sequences, not just
  derived, and both docs were corrected to match.

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
- **Action (revised by D24, 2026-10-15):** the corpus and tuning are **deferred past v1**, and
  this risk is **accepted** for v1, with the paraphrase gap as its largest known component.
  The residual signals are T-41's fixture checks, the golden files (T-33.1), the Journey A
  spot-check (T-30.H), and editors' review edits in production. Reinstate T-33.2, T-33.H and
  T-34 if editors report heavy correction loads.

### R-3 — ExtendScript end-of-support (~September 2026) 🔴 High / strategic *(inherited)*

Adobe supports ExtendScript integrations only through approximately September 2026. A CEP build
works now but will eventually break on a new Premiere version. VerseFlow's risk R1, inherited
whole.

- **Mitigation:** everything touching Premiere sits behind the `VS.*` contract
  ([08](08-premiere-host-api.md)) and is deliberately kept minimal — no time math, no scripture
  knowledge, no persistence. **VerseSync's actual value lives in the sidecar and survives any
  Premiere-side re-platform**, which is a materially better position than VerseFlow was in.
- **Watch item:** re-test UXP's MOGRT text read/write each Premiere release.

### R-4 — `importMGT` may ripple rather than overwrite ✅ Resolved — overwrite confirmed

**Spike T-03 has reported** — see
[`spikes/absolute_insert/RESULTS.md`](../spikes/absolute_insert/RESULTS.md).
`importMGT` overwrites by trimming whichever clip it overlaps, from
whichever edge is encroached, order-independently; verified on a single
overlap, an empty track, past-sequence-end, and a 20-cue overlap stress test
in two insertion orders plus a repeated double-overlap pass. No ripple
observed, on the target track or any other. [08 §6](08-premiere-host-api.md)
proceeds as specified, no fallback needed.

- **New risks surfaced by the spike, tracked separately:** `_setClipDuration`
  does not self-resolve overlaps (silently corrupts the timeline — see
  T-25's traps); a fatal ExtendScript exception (confirmed trigger:
  out-of-range track index) skips `try`/`catch` and can leave an undo group
  stuck open, breaking subsequent edits (see T-25 step 3).

### R-5 — Word-timestamp accuracy may not support ±0.5 s ✅ Resolved — gate tripped, accepted

**Spike T-02 has reported** — see
[`spikes/word_timestamps/RESULTS.md`](../spikes/word_timestamps/RESULTS.md). The ±0.5 s p90
gate is tripped on every configuration tested. On unambiguous mention/reading matches, timestamp
error is mostly well under 0.5 s — the gap is not ASR quality. Two product-level findings
explain it instead: ~31% of real mentions are pure narrative paraphrases with no lexical overlap
with the verse text (no amount of alignment tuning reaches these), and legitimate
mention-vs-reading-vs-graphic timing variance of several seconds is common even on clean matches.

- **Resolved as D19:** accept a lower auto-detection rate on pure paraphrases; no tolerance
  widening, no forced-alignment pass. The review list (D4) is the backstop for what detection
  misses.
- Defaults otherwise per the spike: `distil-large-v3`, `float16`, `vad_filter=True`, scripture
  prompt on, `condition_on_previous_text=True` — these feed T-07.

### R-6 — Source→sequence mapping does not cover real edits ✅ Resolved — characterised

**Spike T-04 has reported** — see
[`spikes/media_segments/RESULTS.md`](../spikes/media_segments/RESULTS.md).
Straight cuts, trims, duplicate media, and detached audio all resolve
cleanly. Speed changes are reliably **detectable** (`speed !== 1.0`) but
their position data is unusable — confirmed, routes straight to
`unsupported`. **Nested sequences and multicam clips produce an identical,
unresolvable signature** (`mediaPath: ""`, `hasProjectItem: true`) with no
way to tell them apart from each other, or from genuinely offline media —
the implementation rule is simply to route any of them to `unsupported`
without trying to distinguish which. Merged clips were not tested
(confirmed with the editor: not used in the client's actual workflow — not
blocking). Walk time: 85ms for 105 clips, no performance concern.

- **Accepted:** v1 does not support speed-changed segments. Documented, flagged, disabled.
- **New risk surfaced by the spike, tracked separately as R-13.**

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

### R-13 — `activeSequence` can silently change between panel calls 🟠 Medium / technical

Discovered during T-04. `app.project.activeSequence` tracks Premiere's UI
tab focus, not panel intent — and a script-side assignment to it does not
persist past the `evalScript` call that made it (confirmed empirically: the
very next, separate call reverts to whatever tab currently has focus). The
panel calls `VS.getMediaSegments` and `VS.insertCues`
([08](08-premiere-host-api.md) §4, §6) as **separate** round-trips, with the
editor free to click a different sequence tab in between (reviewing cues,
deciding whether to insert). If they do, `VS.insertCues` would resolve
`app.project.activeSequence` to the now-focused tab — silently inserting
into the wrong sequence, with no error. This is the same failure shape R-4's
mitigation was built to avoid (a confidently wrong result with no warning),
just at the sequence-identity level rather than the clip-placement level.

- **Mitigation, specified as D20:** re-verify the target sequence's
  identity immediately before `VS.insertCues` runs (e.g. compare against
  the sequence captured when cues were generated) and abort with a clear
  error if it changed, rather than trusting `activeSequence` to still mean
  what it meant earlier in the flow.
- **Action:** decided as **D20**. The contract change is T-47, the host implementation
  T-24/T-25.1, the panel side T-29.4/T-30.2, and real-Premiere verification T-25.H.

### R-12 — Sermon audio privacy 🟢 Low / trust

Sermon audio may be pastorally sensitive. Editors should not have to wonder where it goes.

- **Mitigation:** transcription is entirely local. The **only** outbound traffic is verse
  *references* to the Bible provider — never audio, never transcript text. Stated in the README
  and enforced by the architecture (NFR-4).

---

## Open questions

### Q-A — Which translations, from which provider? 🟡 Partly answered (public domain done)

Drives risk R-1 and the whole of [06](06-bible-text-service.md). Needs:

1. The definitive list of translations that must appear on screen.
2. Confirmed, written access to each from a chosen provider — or a decision to use C2 (local
   store with text the church already licenses) or C3 (public domain).
3. The exact attribution string and caching terms per translation.

**Answered for public domain (T-15.H, 2026-10-17):** API.Bible is live with a real key, and
**KJV, ASV and WEB** are configured in `bible.translations` with each one's own copyright text
and `cache_allowed=True`. No written permission is needed for these three.

**Still open for licensed translations (NKJV, TPT, …):** the key returns NKJV text, but that is
API read access, not the written distribution permission R-1 requires. Until that permission is
in writing, don't add NKJV or TPT to `bible.translations`. No engineering work is blocked.

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

### Q-D — Where does the sermon's audio actually live in the edit? ✅ Answered by T-04

The sermon audio is a **separate lapel-mic recording**
(`03-Pastor Lapel-260927_0935.wav`), detached from the camera footage — not
embedded in a multicam clip or merged clip. Confirmed resolving cleanly as
the "detached audio" construct in
[`spikes/media_segments/RESULTS.md`](../spikes/media_segments/RESULTS.md).
The real edit does also use nested sequences and multicam clips (for
graphics/B-roll, not the primary audio), and speed changes — all
characterised by the same spike; no merged clips in this workflow.

### Q-E — Confidence threshold for the amber flag ✅ Closed for v1 by D24

Specified at 0.55, originally to be tuned by T-34. Tuning is deferred (D24), so **0.55 ships
as specified**. Revisit it if editors find the amber flag too noisy or too quiet.

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
- One-step batch undo: *Undo last insert* or UXP undo grouping (D25).
